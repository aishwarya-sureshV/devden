/**
 * Mac-Notes-style list continuation for the notes editor: pressing Enter on a
 * line that starts with a list marker ("1.", "a.", "A)") starts the next line
 * with the incremented marker ("2.", "b.", "B)"), keeping the indent.
 */

// indent, then a number or letters, then "." or ")", then whitespace.
const MARKER = /^(\s*)(\d+|[a-zA-Z]+)([.)])[ \t]+/;

/** "a" -> "b", "z" -> "aa", "A" -> "B" (case preserved on wrap). */
function nextAlpha(letters: string): string {
  const chars = letters.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    const c = chars[i]!;
    if (c.toLowerCase() !== "z") {
      chars[i] = String.fromCharCode(c.charCodeAt(0) + 1);
      return chars.join("");
    }
    chars[i] = c === "Z" ? "A" : "a";
  }
  return (letters[0] === letters[0].toUpperCase() ? "A" : "a").repeat(
    letters.length + 1,
  );
}

/**
 * Text the Enter key should produce instead of a plain newline, or null when
 * the current line has no list marker (let the browser handle it).
 * Enter on a marker line with no content ends the list: the marker is dropped
 * and a blank line remains, like Notes.app.
 */
export function continueList(
  text: string,
  start: number,
  end: number = start,
): { text: string; caret: number } | null {
  if (start !== end) text = text.slice(0, start) + text.slice(end);
  // Numbered lines inside a ``` fence are code, not a list.
  if (inCodeFence(text, start)) return null;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const line = text.slice(lineStart, start);
  const match = MARKER.exec(line);
  if (!match) return null;
  const [, indent, token, punct] = match;
  if (!line.slice(match[0].length).trim()) {
    // Empty item: pressing Enter clears the marker rather than numbering on.
    return {
      text: text.slice(0, lineStart) + "\n" + text.slice(start),
      caret: lineStart + 1,
    };
  }
  const next = /\d/.test(token!)
    ? String(Number(token) + 1) + punct
    : nextAlpha(token!) + punct;
  const insert = "\n" + indent + next + " ";
  return {
    text: text.slice(0, start) + insert + text.slice(start),
    caret: start + insert.length,
  };
}

export type Note = {
  id: string;
  body: string;
  updatedAt: number;
};

/** True when `pos` sits between an unclosed ``` fence and its closer. */
export function inCodeFence(text: string, pos: number): boolean {
  let fences = 0;
  for (const match of text.slice(0, pos).matchAll(/^```/gm)) fences++;
  return fences % 2 === 1;
}

/**
 * Tab indents: when the caret is on a blank line or right after a list
 * marker (the usual spot after Enter), the whole line shifts two spaces;
 * anywhere else (e.g. inside a code block) two spaces land at the caret.
 */
export function indentAt(
  text: string,
  start: number,
  end: number = start,
): { text: string; caret: number } {
  if (start !== end) text = text.slice(0, start) + text.slice(end);
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const beforeCaret = text.slice(lineStart, start);
  if (/^(\s|(\d+|[a-zA-Z]+)[.)] )*\s*$/.test(beforeCaret)) {
    // ponytail: fixed 2-space indent — a per-marker indent width setting
    // has not been asked for.
    return {
      text: text.slice(0, lineStart) + "  " + text.slice(lineStart),
      caret: start + 2,
    };
  }
  return {
    text: text.slice(0, start) + "  " + text.slice(start),
    caret: start + 2,
  };
}

/**
 * Notion-style code block: Enter on a line that is only ``` (plus an
 * optional language) opens a fence with the closing ``` already in place
 * and the caret on the empty line between them. `blockAt` is the offset
 * from this segment where the new code segment will land once the body
 * is re-parsed (0 when the ``` line starts the segment, else 1).
 */
export function startCodeBlock(
  text: string,
  start: number,
  end: number = start,
): { text: string; caret: number; blockAt: 0 | 1 } | null {
  if (start !== end) text = text.slice(0, start) + text.slice(end);
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", start);
  const full = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const match = /^```(\w*)$/.exec(full);
  if (!match) return null;
  const insert = "\n\n```";
  return {
    text: text.slice(0, start) + insert + text.slice(start),
    caret: start + 1,
    blockAt: lineStart > 0 ? 1 : 0,
  };
}

export type StoredImage = { name: string; data: string };

export type Segment = {
  kind: "text" | "code";
  text: string;
  lang?: string;
};

const FENCE_OPEN = /^```(\w*)\s*$/;

/**
 * Split a note body into text and fenced code segments. An unclosed ```
 * line is plain text, not a block — the block only exists once its closer
 * is in the body, so typing ``` does not swallow the line the user is still
 * editing (and Enter on it can trigger startCodeBlock). A trailing text
 * segment always exists so there is a place to keep typing after a code
 * block.
 */
export function parseSegments(body: string): Segment[] {
  const lines = body.split("\n");
  const segments: Segment[] = [];
  let current: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]!);
    if (!open) {
      current.push(lines[i]!);
      continue;
    }
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === "```") {
        close = j;
        break;
      }
    }
    if (close === -1) {
      current.push(lines[i]!);
      continue;
    }
    if (current.length > 0)
      segments.push({ kind: "text", text: current.join("\n") });
    current = [];
    segments.push({
      kind: "code",
      text: lines.slice(i + 1, close).join("\n"),
      lang: open[1] || undefined,
    });
    i = close;
  }
  if (current.length > 0)
    segments.push({ kind: "text", text: current.join("\n") });
  if (segments.length === 0 || segments[segments.length - 1]!.kind === "code")
    segments.push({ kind: "text", text: "" });
  return segments;
}

/**
 * Rebuild a body from segments. The auto-added trailing empty text segment
 * is dropped again, so a body with one blank line after its last fence loses
 * exactly that line — the placeholder has to live somewhere.
 */
export function joinSegments(segments: Segment[]): string {
  const parts = [...segments];
  const last = parts[parts.length - 1];
  if (last?.kind === "text" && last.text === "") parts.pop();
  return parts
    .map((segment) =>
      segment.kind === "code"
        ? "```" + (segment.lang ?? "") + "\n" + segment.text + "\n```"
        : segment.text,
    )
    .join("\n");
}

// Dropped images become a body marker plus an entry in the image store.
const IMAGE_MARKER = /!\[([^\]]*)\]\(image:([0-9a-f-]+)\)/g;

/** Image ids referenced by a note body, in marker order. */
export function imageIds(body: string): string[] {
  return [...body.matchAll(IMAGE_MARKER)].map((match) => match[2]!);
}

/** First line of the body is the card title, like Notes.app. */
export function noteTitle(note: Note): string {
  const first = note.body.split("\n")[0]?.trim() ?? "";
  return first || "New note";
}

/** Up to two body lines (minus the title) for the card preview. */
export function notePreview(note: Note): string {
  return (
    note.body.split("\n").slice(1).join(" ").trim().slice(0, 140) ||
    "No additional text"
  );
}
