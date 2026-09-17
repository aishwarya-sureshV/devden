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
 * The most recent turn that ended on a usage-limit error, or undefined.
 *
 * Only the last user message counts. A newer prompt means the user moved on:
 * the earlier turn is closed and its pill is gone (if the new turn also dies on
 * the limit, it arms a fresh one). That is also how the pill is dismissed --
 * send anything, or Resume and let the turn produce output, and it clears.
 */
export function pendingLimitTurn(
  items: readonly TimelineItem[],
  isLocalCommand: (text: string) => boolean = () => false,
): LimitTurn | undefined {
  let lastUser = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === "user") {
      lastUser = index;
      break;
    }
  }
  const user = items[lastUser];
  if (!user || user.kind !== "user" || isLocalCommand(user.text))
    return undefined;
  for (let index = lastUser + 1; index < items.length; index += 1) {
    const item = items[index];
    // Tone is not the signal: a backend that reports its wall on plain stderr
    // lands as a warning, and the text is what says a quota ran out.
    if (item?.kind !== "notice" || !isUsageLimitError(item.text)) continue;
    // Work after the wall means the wall did not end the turn -- Claude's
    // "continuing automatically" rides the window out and carries on. Nothing
    // was cut off, so there is nothing to resume. Keep scanning: a later wall
    // in the same turn may be the one that actually stopped it.
    const carriedOn = items
      .slice(index + 1)
      .some((later) => later.kind === "assistant" || later.kind === "tool");
    if (carriedOn) continue;
    return { request: user.text.trim(), noticeId: item.id };
  }
  return undefined;
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

/**
 * The nudge Resume sends in place of the user having to re-ask. The agent keeps
 * its own session, so its history is already in context -- what it is missing is
 * that the last turn never finished. Mirrors server/co-partner-prompt.js's
 * resumePrompt, which does the same job after a server restart.
 */
export function limitResumePrompt(request: string, scope: LimitScope): string {
  return [
    "[pi-web harness instruction — the account's usage limit cut your last turn off; the user did not send this]",
    `Your previous turn was cut off mid-execution by the ${limitScopeLabel(scope).toLowerCase()}, so it never finished and never reported back.`,
    request ? `The request you were working on was:\n\n${request}\n` : "",
    "Do not start over and do not repeat work that already succeeded.",
    "First check the current state of the workspace — read the files you were editing and re-run the",
    "checks you had run — to establish what actually landed before the interruption.",
    "Then say in one or two lines where things stood, and carry on from exactly that point until the",
    "original request is complete.",
    "[end pi-web harness instruction]",
  ]
    .filter(Boolean)
    .join(" ");
}
