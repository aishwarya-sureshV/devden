import type { ProviderUsage, UsageWindow } from "../lib/api";
import { formatCountdown } from "../lib/time";

function windowFor(
  usage: ProviderUsage,
  pattern: RegExp,
): UsageWindow | undefined {
  return usage.windows.find((window) =>
    pattern.test(window.label.toLowerCase()),
  );
}

function percent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function shortLabel(window: UsageWindow): string {
  const label = window.label.toLowerCase();
  if (label.includes("week")) return "wk";
  if (label.includes("session") || label.includes("hour")) return "5h";
  return window.label.replace(/current\s+/i, "").slice(0, 7);
}

function displayWindows(usage: ProviderUsage): UsageWindow[] {
  const fiveHour = windowFor(usage, /session|hour|24h/);
  const weekly =
    windowFor(usage, /week/) ??
    (usage.windows.length > 1 ? usage.windows[1] : undefined);
  return [fiveHour, weekly].filter(
    (window, index, all): window is UsageWindow =>
      Boolean(window) && all.indexOf(window) === index,
  );
}

/** "Mon 4:30 AM" -- the week turns over on a fixed schedule, so name it. */
function formatClock(at: number): string {
  return new Date(at).toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The week resets on a fixed schedule (Monday 04:30), so the day and time are
 * the useful fact. The rolling session window is never more than 5 hours out,
 * so a countdown is.
 */
function formatResetWhen(window: UsageWindow, at: number, now: number): string {
  return window.label.toLowerCase().includes("week")
    ? formatClock(at)
    : formatCountdown(at, now);
}

function usageTitle(windows: UsageWindow[]): string {
  const now = Date.now();
  return windows
    .map((window) => {
      const reset =
        typeof window.resetsAt === "number"
          ? ` · resets ${formatResetWhen(window, window.resetsAt, now)}`
          : "";
      return `${window.label} ${window.usedText ?? `${percent(window.usedPercent ?? 0)}% used`}${reset}`;
    })
    .join(" · ");
}

/**
 * "resets 5h 1h 35m · wk Sun 4:30 AM": each window that reports one, named by
 * its short label. The session window counts down; the week names its day and
 * time. Reads instants rather than preformatted strings so the countdown keeps
 * ticking instead of freezing at whatever the last poll saw.
 */
export function usageResetLabel(
  usage: ProviderUsage,
  now = Date.now(),
): string | null {
  const parts = usage.windows
    .filter(
      (window): window is UsageWindow & { resetsAt: number } =>
        typeof window.resetsAt === "number",
    )
    .map(
      (window) =>
        `${shortLabel(window)} ${formatResetWhen(window, window.resetsAt, now)}`,
    );
  return parts.length > 0 ? `resets ${parts.join(" · ")}` : null;
}

/** 4a — compact quota next to this session's model picker. */
export function UsageSummary({ usage }: { usage: ProviderUsage }) {
  if (!usage.available) return null;
  const windows = displayWindows(usage);
  if (windows.length === 0 && usage.tokens) {
    return (
      <span
        className="usage-summary"
        title={`${usage.provider ?? "Provider"} session tokens`}
      >
        <span className="usage-summary__label">used</span>
        <span>
          tokens{" "}
          <span className="usage-summary__value">
            {usage.tokens.total.toLocaleString()}
          </span>
        </span>
      </span>
    );
  }
  if (windows.length === 0) return null;
  return (
    <span className="usage-summary" title={usageTitle(windows)}>
      <span className="usage-summary__label">used</span>
      {windows.map((window, index) => (
        <span className="usage-summary__window" key={window.label}>
          {index > 0 && <span className="usage-summary__dot">·</span>}
          <span>
            {shortLabel(window)}{" "}
            <span className="usage-summary__value">
              {window.usedText ?? `${percent(window.usedPercent ?? 0)}%`}
            </span>
          </span>
        </span>
      ))}
    </span>
  );
}
