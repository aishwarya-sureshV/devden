import type { DiffLine, ToolDiff } from "./toolCards.ts";

export type ReviewRow = {
  kind: DiffLine["kind"] | "gap";
  hunk: number;
  oldNo: string;
  newNo: string;
  text: string;
};

/** Expand unchanged context only when the file still matches this diff. */
export function reviewRows(diff?: ToolDiff, content?: string): ReviewRow[] {
  if (!diff) return [];
  return (content === undefined ? null : expandRows(diff, content)) ?? rowsOf(diff, null)!;
}

/** The whole file with the diff in place, or null when the file has moved on. */
export function expandRows(diff: ToolDiff, content: string): ReviewRow[] | null {
  const file = content ? content.replace(/\n$/, "").split("\n") : [];
  const positioned = diff.lines.some((line) => line.kind === "meta")
    ? diff
    : anchorEdits(diff, file);
  return positioned && rowsOf(positioned, file);
}

/**
 * Edit-tool diffs carry old/new text but no position. Find each edit's new
 * text in the file (in order) and write the @@ header git would have.
 */
export function anchorEdits(diff: ToolDiff, file: string[]): ToolDiff | null {
  const lines: DiffLine[] = [];
  let from = 0;
  let shift = 0; // new line no. minus old line no. so far
  let i = 0;
  while (i < diff.lines.length) {
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (diff.lines[i]?.kind === "remove") removed.push(diff.lines[i++]!);
    while (diff.lines[i]?.kind === "add") added.push(diff.lines[i++]!);
    if (!removed.length && !added.length) return null; // context: not an edit list
    // ponytail: a pure deletion has nothing left in the file to find.
    if (!added.length) return null;
    const at = findBlock(file, added, from);
    if (at < 0) return null;
    const startNew = at + 1;
    // Git points a zero-length old range at the line BEFORE the insertion.
    const startOld = startNew - shift - (removed.length ? 0 : 1);
    lines.push({
      kind: "meta",
      text: `@@ -${startOld},${removed.length} +${startNew},${added.length} @@`,
    });
    lines.push(...removed, ...added);
    shift += added.length - removed.length;
    from = at + added.length;
  }
  return { ...diff, lines };
}

function findBlock(file: string[], block: DiffLine[], from: number): number {
  for (let at = from; at + block.length <= file.length; at += 1)
    if (block.every((line, k) => file[at + k] === line.text)) return at;
  return -1;
}

function rowsOf(diff: ToolDiff, file: string[] | null): ReviewRow[] | null {
  const rows: ReviewRow[] = [];
  let hunk = -1;
  let oldNo = 1;
  let newNo = 1;
  const contextUntil = (end: number) => {
    while (file && newNo < end && newNo <= file.length) {
      rows.push({
        kind: "context",
        hunk: -1,
        oldNo: String(oldNo++),
        newNo: String(newNo),
        text: file[newNo++ - 1]!,
      });
    }
  };
  for (const line of diff.lines) {
    if (line.kind === "meta") {
      const match = line.text.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) continue;
      // A zero-length range points BEFORE the insertion/deletion.
      const startOld = Number(match[1]) + (match[2] === "0" ? 1 : 0);
      const startNew = Number(match[3]) + (match[4] === "0" ? 1 : 0);
      contextUntil(startNew);
      if (!file && hunk >= 0)
        rows.push({
          kind: "gap", hunk: -1, oldNo: "", newNo: "",
          text: "⋯ unchanged lines",
        });
      oldNo = startOld;
      newNo = startNew;
      rows.push({
        kind: "meta", hunk: ++hunk, oldNo: "", newNo: "", text: line.text,
      });
      continue;
    }
    const showOld = line.kind !== "add";
    const showNew = line.kind !== "remove";
    if (file && showNew && file[newNo - 1] !== line.text)
      return null; // Historical diff: the caller keeps its own context.
    rows.push({
      kind: line.kind,
      hunk: -1,
      oldNo: showOld ? String(oldNo++) : "",
      newNo: showNew ? String(newNo++) : "",
      text: line.text,
    });
  }
  contextUntil((file?.length ?? 0) + 1);
  return rows;
}
