import type { TimelineItem } from "./timeline.ts";

/** Split the transcript on user messages. Each segment is one turn. */
export function splitTurns(items: TimelineItem[]): TimelineItem[][] {
  const segments: TimelineItem[][] = [];
  let current: TimelineItem[] = [];
  for (const item of items) {
    if (item.kind === "user" && current.length) {
      segments.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length) segments.push(current);
  return segments;
}

export function turnKey(turn: TimelineItem[]): string {
  const user = turn.find((item) => item.kind === "user");
  return user?.id ?? turn[0]?.id ?? "";
}

export function turnUserItems(turn: TimelineItem[]): TimelineItem[] {
  return turn.filter((item) => item.kind === "user");
}

export function turnBodyItems(turn: TimelineItem[]): TimelineItem[] {
  return turn.filter((item) => item.kind !== "user");
}

/**
 * Trailing assistant prose after the last tool or rationale. That is what
 * survives the fold; earlier narration and the tool log go behind Worked for.
 */
export function turnSummaryItems(turn: TimelineItem[]): TimelineItem[] {
  let lastWork = -1;
  turn.forEach((item, index) => {
    if (item.kind === "tool" || item.kind === "rationale") lastWork = index;
  });
  return turn.filter(
    (item, index) => item.kind === "assistant" && index > lastWork,
  );
}

export function turnEndedAt(turn: TimelineItem[]): number {
  let latest = 0;
  for (const item of turn) {
    const time =
      item.kind === "tool"
        ? item.startedAt + (item.elapsed ?? 0)
        : (item.timestamp ?? 0);
    if (time > latest) latest = time;
  }
  return latest;
}

export function formatWorkedAt(ts: number, locale?: string): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Immediate parent folder and basename, as the fold card shows them. */
export function splitFilePath(path: string): { dir: string; name: string } {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const name = parts.pop() ?? path;
  const parent = parts.pop();
  return { dir: parent ? `${parent}/` : "", name };
}

function isInterruptedTool(item: TimelineItem): boolean {
  if (item.kind !== "tool") return false;
  if (item.status === "running") return true;
  if (item.status !== "error") return false;
  return /interrupted/i.test(item.output ?? "");
}

function isStopNotice(item: TimelineItem): boolean {
  return (
    item.kind === "notice" &&
    /stopped before answering|interrupted/i.test(item.text)
  );
}

/**
 * A turn is foldable only once it actually finished. Stop, interrupt, a
 * still-running tool, or no trailing answer means the original log stays.
 */
export function isTurnComplete(turn: TimelineItem[]): boolean {
  const body = turnBodyItems(turn);
  if (!body.length) return false;
  if (body.some(isInterruptedTool) || body.some(isStopNotice)) return false;
  if (
    body.some(
      (item) =>
        (item.kind === "assistant" || item.kind === "rationale") && item.live,
    )
  )
    return false;
  return turnSummaryItems(turn).some(
    (item) => item.kind === "assistant" && item.text.trim().length > 0,
  );
}

/**
 * Live and unfinished turns stay open. The last finished turn stays open
 * until the next prompt (isLast) or the user collapses it. Older finished
 * turns fold unless expanded.
 */
export function isTurnLogOpen(opts: {
  live: boolean;
  isLast: boolean;
  complete?: boolean;
  explicit?: boolean;
}): boolean {
  if (opts.live || opts.complete === false) return true;
  if (opts.explicit === true) return true;
  if (opts.explicit === false) return false;
  return opts.isLast;
}
