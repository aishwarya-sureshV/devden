import type { SessionState } from "./api";
import type { MessageUsage, TimelineItem } from "./timeline";

export interface ContextUsage {
  estimatedTokens: number;
  contextWindow: number;
  percent: number | null;
  /** True when the backend counted the tokens instead of us guessing from characters. */
  exact?: boolean;
  /** Token count at which the backend will auto-compact, when it reports one. */
  autoCompactAt?: number;
  categories?: Array<{ name: string; tokens: number }>;
}

/** A conservative fallback for backends that do not expose context stats. */
export function estimateContext(
  items: TimelineItem[],
  state: SessionState | null,
): ContextUsage {
  const characters = items.reduce((total, item) => {
    if (item.kind === "tool") {
      return (
        total +
        item.output.length +
        JSON.stringify(item.args).length +
        JSON.stringify(item.details).length
      );
    }
    if (item.kind === "terminal") {
      // Terminal output is not part of the model's context.
      return total;
    }
    return total + item.text.length;
  }, 0);
  const estimatedTokens = Math.ceil(characters / 4) + 2_000;
  const contextWindow = state?.model?.contextWindow ?? 1_000_000;
  const percent = Math.max(
    0,
    Math.min(100, Math.round((estimatedTokens / contextWindow) * 100)),
  );
  return { estimatedTokens, contextWindow, percent };
}

export function compactTokens(value: number): string {
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** Monocode's turn-metrics numbers, aggregated over a session: fresh input,
 *  output, cached reads/writes, a cache-hit percent over everything the
 *  provider could have cached, and an output rate over per-turn durations. */
export interface UsageSummary {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  /** cacheRead / (input + cacheRead + cacheWrite) — monocode's exact formula.
   *  Present only when a provider actually reported cache fields; pi reports
   *  them per usage record, grok/codex servers always normalize them in. */
  cacheHitPercent?: number;
  /** output / summed turn duration (user message → last item of that turn).
   *  ponytail: includes failed turns' time, so the rate is a floor; per-turn
   *  timing would need turn ids the timeline doesn't keep. */
  tokensPerSec?: number;
}

/** One provider ledger (Grok's usage.json, already summed across turns). */
export function usageSummaryFromCounts(usage: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  durationMs?: number;
}): UsageSummary | null {
  const input = usage.input || 0;
  const output = usage.output || 0;
  const cached = usage.cacheRead || 0;
  const cacheWrite = usage.cacheWrite || 0;
  if (!input && !output && !cached && !cacheWrite) return null;
  const cacheable = input + cached + cacheWrite;
  const seconds = (usage.durationMs || 0) / 1000;
  const reported = usage.cacheRead != null || usage.cacheWrite != null;
  return {
    input,
    output,
    cached,
    cacheWrite,
    ...(reported && cacheable > 0
      ? { cacheHitPercent: (cached / cacheable) * 100 }
      : {}),
    ...(output > 0 && seconds > 0 ? { tokensPerSec: output / seconds } : {}),
  };
}

/**
 * Usage before the latest real handoff belongs to the previous agent.
 * "Switched back" before any message was sent returns the bill to the
 * agent that actually wrote the transcript. `pendingSince` covers the
 * moment after the switch and before that notice is on the timeline.
 */
export function usageCutoff(items: TimelineItem[], pendingSince = 0): number {
  let since = 0;
  for (const item of items) {
    if (item.kind !== "notice") continue;
    if (item.text.startsWith("Switched from ")) since = item.timestamp || 0;
    else if (item.text.startsWith("Switched back to ")) since = 0;
  }
  return Math.max(since, pendingSince || 0);
}

/** When this item happened. Tool rows use startedAt; everything else uses timestamp. */
export function usageStamp(item: TimelineItem): number {
  if (item.kind === "tool") return item.startedAt || 0;
  return "timestamp" in item ? item.timestamp || 0 : 0;
}

/** Sum the session's per-message usage. Usage is stamped on the first item of
 *  each assistant message only, so summing every carried usage never
 *  double-counts (the same convention liveTokens/spend reducers rely on).
 *  `since` drops stamps from before a backend switch: the transcript stays,
 *  but the previous agent's bill is not this agent's. */
export function usageSummaryOf(
  items: TimelineItem[],
  since = 0,
): UsageSummary | null {
  let input = 0;
  let output = 0;
  let cached = 0;
  let cacheWrite = 0;
  let cacheReported = false;
  let turnSeconds = 0;
  let turnStart: number | null = null;
  let turnEnd: number | null = null;
  for (const item of items) {
    if (since && usageStamp(item) < since) continue;
    if (item.kind === "user") {
      if (turnStart !== null)
        turnSeconds += Math.max(0, (turnEnd ?? turnStart) - turnStart) / 1000;
      turnStart = item.timestamp;
      turnEnd = null;
      continue;
    }
    if (turnStart !== null) {
      // Tool items carry startedAt instead of timestamp.
      const stamp = item.kind === "tool" ? item.startedAt : item.timestamp;
      if (turnEnd === null || stamp > turnEnd) turnEnd = stamp;
    }
    const usage = (item as { usage?: MessageUsage }).usage;
    if (!usage) continue;
    input += usage.input;
    output += usage.output;
    cached += usage.cacheRead ?? 0;
    cacheWrite += usage.cacheWrite ?? 0;
    if (usage.cacheRead !== undefined || usage.cacheWrite !== undefined)
      cacheReported = true;
  }
  if (turnStart !== null)
    turnSeconds += Math.max(0, (turnEnd ?? turnStart) - turnStart) / 1000;
  if (!input && !output && !cached && !cacheWrite) return null;
  const cacheable = input + cached + cacheWrite;
  return {
    input,
    output,
    cached,
    cacheWrite,
    ...(cacheReported && cacheable > 0
      ? { cacheHitPercent: (cached / cacheable) * 100 }
      : {}),
    ...(output > 0 && turnSeconds > 0
      ? { tokensPerSec: output / turnSeconds }
      : {}),
  };
}
