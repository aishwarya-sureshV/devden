/**
 * "This account has no quota left for this turn."
 *
 * A turn that dies on a usage limit is not an ordinary failure: retrying it
 * immediately fails the same way, and the one useful thing the UI can say is
 * which window ran out and when it comes back. The provider's error names no
 * window, so this file pairs the error text with the usage panel's own
 * numbers.
 */
import type { ProviderUsage, UsageWindow } from "./api.ts";
import type { TimelineItem } from "./timeline.ts";

/** The 5-hour "session" window vs the weekly one. */
export type LimitScope = "session" | "weekly" | "other";

/** Which window a provider label means. Grok only ever reports the weekly one. */
export function limitScope(label: string): LimitScope {
  const lower = String(label ?? "").toLowerCase();
  // A multi-day rolling window is the weekly limit by another name (Codex
  // falls back to "7 day limit" outside its 6-to-8-day recognition band).
  if (lower.includes("week") || /\b(?:[2-9]|[1-9]\d)\s*day/.test(lower))
    return "weekly";
  if (lower.includes("session") || lower.includes("hour")) return "session";
  return "other";
}

export function limitScopeLabel(scope: LimitScope): string {
  if (scope === "weekly") return "Weekly limit";
  if (scope === "session") return "5-hour limit";
  return "Usage limit";
}

// Sourced from the four CLIs themselves rather than guessed. Pi ships its own
// classifier (dist/bundle/chunks): NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN
// holds GoUsageLimitError, FreeUsageLimitError, "Monthly usage limit reached",
// "available balance", insufficient_quota, "out of budget", "quota exceeded"
// and "billing", while it calls rate.?limit / "too many requests" / 429
// *retryable*. The retryable family is deliberately absent here: a transient
// 429 clears on its own, so Resume would only repeat it, and a
// "subagent limit reached" is not a quota at all.
// Keep in lockstep with server/usage-limit.js — the queue hold uses that copy.
const LIMIT_ERROR_PATTERNS = [
  // "Usage limit reached · continuing automatically" (Claude),
  // "Monthly usage limit reached" (pi), "usage credit limit reached" (Claude).
  /usage [a-z ]{0,12}limit/i,
  // "Grok Build usage balance exhausted" — the 402 Grok returns.
  /usage balance/i,
  /insufficient_quota/i,
  /exceeded your current quota/i,
  /quota exceeded/i,
  /out of budget/i,
  // "Your credit balance is too low to access the Anthropic API."
  /credit balance is too low/i,
  // "You've hit your usage limit. Upgrade to Pro…" (Codex CLI),
  // "You have hit your ChatGPT usage limit…" (pi driving codex),
  // "You've hit your fast limit · resets in 2h 13m" (Claude),
  // "You've hit your spend cap set by the owner of your workspace" (Codex) —
  // a spend cap never uses the word "limit", so it needs its own branch.
  /hit your [^.]{0,30}(?:limit|spend cap)/i,
];

export function isUsageLimitError(text: string): boolean {
  const value = String(text ?? "");
  return LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Which window the failed turn ran out of. The error never says, so take the
 * fullest one -- with a limit hit that is by definition the window that ran
 * out. When several are maxed, the soonest reset is the one worth showing.
 * A provider that reports no percent at all falls back to its reset instant.
 * ponytail: a heuristic over the numbers; a provider that reports neither gets
 * no reset line rather than a guessed one.
 */
export function exhaustedWindow(
  usage: ProviderUsage | null | undefined,
): UsageWindow | undefined {
  const windows = (usage?.available ? usage.windows : undefined) ?? [];
  if (windows.length === 0) return undefined;
  const scored = windows.filter((window) =>
    Number.isFinite(window.usedPercent),
  );
  const maxed = scored.filter((window) => (window.usedPercent ?? 0) >= 99);
  const byReset = (a: UsageWindow, b: UsageWindow) =>
    (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity);
  if (maxed.length > 0) return [...maxed].sort(byReset)[0];
  if (scored.length > 0)
    return [...scored].sort(
      (a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0),
    )[0];
  // Providers that stopped reporting a percent (Grok's unified billing) still
  // report the reset instant, which is the one thing the banner needs.
  return windows
    .filter((window) => Number.isFinite(window.resetsAt))
    .sort(byReset)[0];
}

export interface LimitTurn {
  /** The user request whose turn died — what Resume carries back to the agent. */
  request: string;
  /** Id of the error notice that armed the pill. */
  noticeId: string;
}

/**
 * A usage-limit notice that ended this user message's turn, or undefined.
 * `end` is the next user message, so a later turn's work cannot look like
 * this one carried on. `started` is assistant or tool output before the wall.
 */
function limitCutoff(
  items: readonly TimelineItem[],
  from: number,
  end: number,
  isLocalCommand: (text: string) => boolean,
): (LimitTurn & { started: boolean }) | undefined {
  const user = items[from];
  if (!user || user.kind !== "user" || isLocalCommand(user.text))
    return undefined;
  let started = false;
  for (let index = from + 1; index < end; index += 1) {
    const item = items[index];
    if (item?.kind === "assistant" || item?.kind === "tool") started = true;
    // Tone is not the signal: a backend that reports its wall on plain stderr
    // lands as a warning, and the text is what says a quota ran out.
    if (item?.kind !== "notice" || !isUsageLimitError(item.text)) continue;
    // Work after the wall means the wall did not end the turn -- Claude's
    // "continuing automatically" rides the window out and carries on. Nothing
    // was cut off, so there is nothing to resume. Keep scanning: a later wall
    // in the same turn may be the one that actually stopped it.
    const carriedOn = items
      .slice(index + 1, end)
      .some((later) => later.kind === "assistant" || later.kind === "tool");
    if (carriedOn) continue;
    return { request: user.text.trim(), noticeId: item.id, started };
  }
  return undefined;
}

/**
 * The turn Resume should pick back up, or undefined.
 *
 * A newer prompt normally closes the earlier turn: the user moved on, and
 * the pill goes with it (send anything, or Resume and let the turn produce
 * output). The exception is a follow-up that was released only because the
 * limit had already killed the previous turn. That prompt never reached a
 * model that could work, so Resume still belongs to the turn that was cut off.
 */
export function pendingLimitTurn(
  items: readonly TimelineItem[],
  isLocalCommand: (text: string) => boolean = () => false,
): LimitTurn | undefined {
  const users: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.kind === "user") users.push(index);
  }
  let chosen: LimitTurn | undefined;
  for (let i = users.length - 1; i >= 0; i -= 1) {
    const end = i + 1 < users.length ? users[i + 1]! : items.length;
    const cut = limitCutoff(items, users[i]!, end, isLocalCommand);
    if (!cut) return chosen;
    chosen = { request: cut.request, noticeId: cut.noticeId };
    // This turn actually started. It is the one the limit cut off.
    if (cut.started) return chosen;
    // No work before the wall: the prompt was handed to a model that was
    // already out of quota. Keep walking back to the turn it interrupted.
  }
  return chosen;
}

/** "6:50 PM" today, "Mon 9:00 AM" beyond it. */
export function formatResetAt(at: number, now = Date.now()): string {
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return new Date(now).toDateString() === date.toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}
