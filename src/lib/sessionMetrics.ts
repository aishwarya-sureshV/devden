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
  cacheReported?: boolean;
  /** Output / explicitly measured duration; absent when timing is incomplete. */
  tokensPerSec?: number;
  durationKind?: "api" | "turn";
}

/** One provider ledger (Grok's usage.json, already summed across turns). */
export function usageSummaryFromCounts(usage: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  durationMs?: number;
  durationKind?: "api" | "turn";
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
    cacheReported: reported,
    ...(reported && cacheable > 0
      ? { cacheHitPercent: (cached / cacheable) * 100 }
      : {}),
    ...(output > 0 && seconds > 0 && Number.isFinite(seconds)
      ? { tokensPerSec: output / seconds, durationKind: usage.durationKind ?? "api" } : {}),
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
  // The cutoff in force before the first unsent switch: "Switched back"
  // restores it (not 0 -- an earlier handoff still stands). A user message
  // makes the switch real, so nothing is left to restore.
  let restore: number | undefined;
  for (const item of items) {
    if (item.kind === "user") restore = undefined;
    if (item.kind !== "notice") continue;
    if (item.text.startsWith("Switched from ")) {
      restore ??= since;
      since = item.timestamp || 0;
    } else if (item.text.startsWith("Switched back to ")) {
      since = restore ?? 0;
      restore = undefined;
    }
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
  let durationMs = 0;
  let durationKind: "api" | "turn" | undefined;
  let fullyTimed = true;
  let fullyCached = true;
  for (const item of items) {
    if (since && usageStamp(item) < since) continue;
    const usage = (item as { usage?: MessageUsage }).usage;
    if (!usage) continue;
    input += usage.input;
    output += usage.output;
    cached += usage.cacheRead ?? 0;
    cacheWrite += usage.cacheWrite ?? 0;
    const reported = usage.cacheRead !== undefined || usage.cacheWrite !== undefined;
    cacheReported ||= reported;
    fullyCached &&= reported;
    if (usage.input || usage.output || usage.cacheRead || usage.cacheWrite) {
      if (!(usage.durationMs! > 0) || !Number.isFinite(usage.durationMs) || !usage.durationKind ||
          (durationKind && durationKind !== usage.durationKind)) fullyTimed = false;
      durationKind ??= usage.durationKind;
      durationMs += usage.durationMs || 0;
    }
  }
  if (!input && !output && !cached && !cacheWrite) return null;
  const cacheable = input + cached + cacheWrite;
  return {
    input,
    output,
    cached,
    cacheWrite,
    cacheReported: cacheReported && fullyCached,
    ...(cacheReported && fullyCached && cacheable > 0
      ? { cacheHitPercent: (cached / cacheable) * 100 }
      : {}),
    ...(fullyTimed && output > 0 && durationMs > 0
      ? { tokensPerSec: output / (durationMs / 1000), durationKind }
      : {}),
  };
}

/** Labels retain reported zeroes; unknown cache fields stay absent. */
export function formatUsageSummary(usage: UsageSummary, spend = ""): string {
  return [
    usage.cacheHitPercent == null ? "" : `${Math.round(usage.cacheHitPercent)}% cache hit`,
    usage.tokensPerSec == null ? "" : `${usage.tokensPerSec.toFixed(1)} tok/s (${usage.durationKind ?? "api"})`,
    `${compactTokens(usage.input)} input`,
    `${compactTokens(usage.output)} output`,
    usage.cacheReported ? `${compactTokens(usage.cached)} cached` : "",
    usage.cacheWrite ? `${compactTokens(usage.cacheWrite)} cache write` : "",
    spend,
  ].filter(Boolean).join(" · ");
}
