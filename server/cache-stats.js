/**
 * Prompt-cache miss detection, ported from pi's own core/cache-stats.js so
 * every backend gets it, not just pi. A "miss" is prompt content that was in
 * the previous turn's prompt but got re-billed as fresh input instead of read
 * from cache -- an idle gap past the provider's cache TTL, a model switch, or
 * an edit that invalidated the cached prefix.
 *
 * This lives at the publishRuntimeEvent funnel rather than in each adapter:
 * that is the one place every backend's events pass through, so pi, Claude,
 * Codex and Grok are covered by one implementation, and so is the next backend
 * added. Each adapter's job is only to put its usage on the assistant message.
 */

/** Anthropic's default cache TTL; idle gaps past this explain a miss. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Per-turn misses at or below this are cache-breakpoint granularity noise. */
const NOISE_FLOOR_TOKENS = 1024;
/**
 * ponytail: fixed-size LRU instead of hooking session teardown. Evicting a
 * session costs exactly one missed notice on its next turn, so the cheap
 * bound is the right one.
 */
const MAX_TRACKED_SESSIONS = 200;

/** sessionKey -> the previous request's cache-relevant facts. */
const previousBySession = new Map();
/** Guards against an adapter emitting the same message on two event types. */
const counted = new WeakSet();

/**
 * Backends report usage in their own shapes: pi, Codex and Grok in camelCase,
 * Claude straight from the Anthropic API in snake_case. Grok's own field names
 * and its cache-inclusive inputTokens are re-based to this shape by
 * grok-agent.js's usageFrom, so only the two conventions land here.
 *
 * A backend that reports no cache fields at all yields zeros, which correctly
 * reads as "this provider never cached anything" and stays silent.
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const pick = (...keys) => {
    for (const key of keys) {
      const value = Number(usage[key]);
      if (Number.isFinite(value)) return value;
    }
    return 0;
  };
  return {
    input: pick("input", "input_tokens"),
    output: pick("output", "output_tokens"),
    cacheRead: pick("cacheRead", "cache_read_input_tokens"),
    cacheWrite: pick("cacheWrite", "cache_creation_input_tokens"),
    cost: usage.cost && typeof usage.cost === "object" ? usage.cost : undefined,
  };
}

/**
 * The miss on one assistant message relative to the previous request, or
 * undefined when nothing is counted: first turn of a session, a provider that
 * never reports caching, or a miss below the noise floor.
 */
export function detectMiss(prev, message) {
  const usage = normalizeUsage(message?.usage);
  if (!usage) return undefined;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  // A zero-cache turn only counts when cache activity was reported earlier in
  // the session: on a cache-read-only provider that is a total miss, while on
  // a provider that never reports caching it means nothing.
  const noCacheThisTurn = usage.cacheRead + usage.cacheWrite === 0;
  if (!prev || promptTokens <= 0 || (noCacheThisTurn && !prev.reportedCache))
    return undefined;

  const missedTokens =
    Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

  // Extra cost = missed tokens billed at the rate actually paid (input plus
  // the cache-write premium) instead of the cache-read rate. Missed tokens can
  // only land in the input or cacheWrite buckets, so the paid rate comes
  // straight from this message's own cost breakdown. Backends that report no
  // cost breakdown yield 0, and the notice then omits the dollar figure.
  const paidTokens = usage.input + usage.cacheWrite;
  const paidPerToken =
    usage.cost && paidTokens > 0
      ? (Number(usage.cost.input ?? 0) + Number(usage.cost.cacheWrite ?? 0)) /
        paidTokens
      : 0;
  const readPerToken =
    usage.cost && usage.cacheRead > 0
      ? Number(usage.cost.cacheRead ?? 0) / usage.cacheRead
      : 0;

  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
    idleMs: Math.max(0, timestampOf(message) - prev.timestamp),
    modelChanged: modelKeyOf(message) !== prev.modelKey,
  };
}

function timestampOf(message) {
  const value = Number(message?.timestamp);
  return Number.isFinite(value) ? value : Date.now();
}

function modelKeyOf(message) {
  return `${message?.provider ?? ""}/${message?.model ?? ""}`;
}

/** Both spellings, on the event or the message: adapters differ. */
function parentToolUseIdOf(value) {
  const id = value?.parentToolUseId ?? value?.parent_tool_use_id;
  return typeof id === "string" && id ? id : undefined;
}

function asPreviousRequest(message, reportedCache) {
  const usage = normalizeUsage(message?.usage);
  if (!usage) return undefined;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (promptTokens <= 0) return undefined;
  return {
    promptTokens,
    modelKey: modelKeyOf(message),
    timestamp: timestampOf(message),
    reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
  };
}

function formatTokens(tokens) {
  return tokens.toLocaleString("en-US");
}

/** Only states observable facts: the miss, and the likeliest reason for it. */
export function formatMiss(miss) {
  let reason = "";
  if (miss.modelChanged) reason = " (model changed)";
  else if (miss.idleMs >= CACHE_TTL_MS)
    reason = ` after ${Math.round(miss.idleMs / 60_000)}m idle`;
  const cost = miss.missedCost > 0 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
  return `Cache miss${reason} — ${formatTokens(miss.missedTokens)} tokens re-billed${cost}`;
}

/** sessionKey -> the current turn's accumulated miss, awaiting that turn's end. */
const pendingBySession = new Map();

/**
 * Whether this event means the turn's output is complete. Every adapter emits
 * at least one: agent_end (pi, Codex, grok), agent_settled (all four), or a
 * __status reporting that the agent died mid-turn.
 */
function isTurnEnd(event) {
  if (event?.type === "agent_end" || event?.type === "agent_settled")
    return true;
  return (
    event?.type === "__status" &&
    (event.status === "error" || event.status === "stopped")
  );
}

/**
 * Fold one runtime event into the session's cache-miss state.
 *
 * Misses accumulate rather than being reported where they happened: a turn
 * with six tool calls pays several, and a notice after each one put a card
 * between every pair of tool calls. This returns the turn's combined notice on
 * the event that ends the turn -- one line at the bottom of the final output --
 * and undefined for everything else.
 *
 * Different adapters land the completed assistant message on different event
 * types -- pi/Claude/Grok on message_end, Codex on turn_end -- so both are
 * inspected and repeats of the same message object are ignored.
 */
export function cacheMissNotice(sessionKey, event) {
  if (isTurnEnd(event)) {
    const pending = pendingBySession.get(sessionKey);
    if (!pending) return undefined;
    pendingBySession.delete(sessionKey);
    return formatMiss(pending);
  }
  if (event?.type !== "message_end" && event?.type !== "turn_end")
    return undefined;
  const message = event.message;
  if (!message || message.role !== "assistant" || counted.has(message))
    return undefined;
  // A subagent runs on its own prompt prefix, interleaved with the parent's
  // on the same session key. Folding it into this session's chain compares
  // two unrelated prompts: the child's small uncached request reads as the
  // parent's cached prefix being re-billed, and every Task spawn reported a
  // miss that never happened.
  if (parentToolUseIdOf(event) || parentToolUseIdOf(message)) return undefined;
  counted.add(message);

  const prev = previousBySession.get(sessionKey);
  const miss = detectMiss(prev, message);
  const next = asPreviousRequest(message, prev?.reportedCache ?? false);
  if (next) {
    // Re-insert so Map iteration order stays least-recently-used first.
    previousBySession.delete(sessionKey);
    previousBySession.set(sessionKey, next);
    if (previousBySession.size > MAX_TRACKED_SESSIONS)
      previousBySession.delete(previousBySession.keys().next().value);
  }
  if (miss) {
    // Each miss is a separate re-billing, so the turn's tokens are a sum, not
    // a max. The reason is the strongest one observed: a model switch explains
    // the turn better than the idle gap that may also have applied.
    const pending = pendingBySession.get(sessionKey) ?? {
      missedTokens: 0,
      missedCost: 0,
      idleMs: 0,
      modelChanged: false,
    };
    pending.missedTokens += miss.missedTokens;
    pending.missedCost += miss.missedCost;
    pending.idleMs = Math.max(pending.idleMs, miss.idleMs);
    pending.modelChanged = pending.modelChanged || miss.modelChanged;
    pendingBySession.delete(sessionKey);
    pendingBySession.set(sessionKey, pending);
    if (pendingBySession.size > MAX_TRACKED_SESSIONS)
      pendingBySession.delete(pendingBySession.keys().next().value);
  }
  return undefined;
}

/** Drop a session's history; a compaction makes the next prompt new content. */
export function resetCacheTracking(sessionKey) {
  previousBySession.delete(sessionKey);
}
