/** One-line tool call presentation for the conversation transcript. */
import type { TimelineItem } from "./timeline.ts";
import {
  canonicalizeToolName,
  displayToolName,
  getToolDiff,
  toolPath,
  type DiffLine,
} from "./toolCards.ts";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

export interface ResultPart {
  text: string;
  tone: "num" | "dim" | "add" | "del" | "fail" | "quiet" | "wait";
}

export type ThreadKind =
  | "running"
  | "settled"
  | "failed"
  | "stopped"
  | "denied"
  | "waiting";

export type RowDetail = "diff" | "log" | "list" | "file" | "none";

export interface ToolRowModel {
  verb: string;
  accent: boolean;
  tag: string;
  prefix: string;
  main: string;
  suffix: string;
  sans: boolean;
  strike: boolean;
  dimVerb: boolean;
  title: string;
  parts: ResultPart[];
  duration: string;
  thread: ThreadKind;
  /** Where a failed or frozen thread stops, 0–100. */
  breakAt: number;
  note: string;
  tail: string;
  detail: RowDetail;
  list: string[];
  pattern: string;
  diffLines: DiffLine[];
  diffMore: boolean;
  diffLabel: string;
}

export interface RepeatEntry {
  item: ToolItem;
  repeat: number;
}

export type TranscriptBlock =
  | { type: "item"; item: TimelineItem; repeat: number }
  | {
      type: "explored";
      id: string;
      entries: RepeatEntry[];
      calls: number;
      failed: number;
      durationMs: number;
    };

const EXPLORE = new Set(["read", "grep", "ls", "search"]);

export function isExploreTool(item: ToolItem): boolean {
  const name = canonicalizeToolName(item.name);
  if (EXPLORE.has(name)) return true;
  return /search/i.test(item.name) && name !== "edit";
}

function isSearch(item: ToolItem, canonical: string): boolean {
  return canonical === "search" || (canonical !== "edit" && /search/i.test(item.name));
}

export function formatDuration(ms: number, live = false): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (!live && ms < 1000) return "";
  const sec = ms / 1000;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  const minutes = Math.floor(sec / 60);
  const rest = Math.round(sec % 60);
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

export function formatClock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(sec / 60);
  return `${String(minutes).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

export function formatWorkingClock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(sec / 60);
  return `${minutes}m ${String(sec % 60).padStart(2, "0")}s`;
}

/**
 * Unknown progress: a quick open so the line is moving right away, then a
 * long ease that never steps. Caps at 0.94 until the call actually finishes.
 */
export function unknownProgress(elapsedMs: number): number {
  const s = Math.max(0, elapsedMs) / 1000;
  const open = 1 - Math.exp(-s / 0.35);
  const creep = 1 - Math.exp(-s / 9);
  return Math.min(0.94, 0.04 + open * 0.42 + creep * 0.48);
}

/** Last "12 of 14" or "12/14" in a live log, as a 0–0.98 fraction. */
export function liveFraction(output: string): number | null {
  if (!output) return null;
  let best: number | null = null;
  for (const match of output.matchAll(/(\d+)\s*(?:\/|of)\s*(\d+)/g)) {
    const done = Number(match[1]);
    const total = Number(match[2]);
    if (total > 0 && done <= total) best = done / total;
  }
  return best == null ? null : Math.min(0.98, best);
}

export function splitArgPath(
  path: string,
  cwd = "",
): { tag: string; prefix: string; name: string } {
  const norm = path.replace(/\\/g, "/");
  const root = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  const inside =
    Boolean(root) && (norm === root || norm.startsWith(`${root}/`));
  const rel = inside ? norm.slice(root.length).replace(/^\//, "") : norm;
  if (!inside && (norm.startsWith("/") || /^[A-Za-z]:\//.test(norm))) {
    const tag = /uploads/i.test(norm)
      ? "uploads"
      : norm.startsWith("/tmp/") ||
          norm.includes("/T/") ||
          norm.startsWith("/var/folders/")
        ? "tmp"
        : "";
    const parts = norm.split("/").filter(Boolean);
    const name = parts.pop() ?? norm;
    const parent = parts.pop();
    return { tag, prefix: parent ? `${parent}/` : "", name };
  }
  const parts = rel.split("/").filter(Boolean);
  const name = parts.pop() ?? rel;
  return { tag: "", prefix: parts.length ? `${parts.join("/")}/` : "", name };
}

function linesOf(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function oneLine(text: string): string {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > 220 ? `${line.slice(0, 219)}…` : line;
}

function numSuffix(n: number, suffix: string): ResultPart[] {
  return [
    { text: String(n), tone: "num" },
    { text: suffix, tone: "dim" },
  ];
}

function closestNote(output: string): string {
  const closest = output.match(
    /closest match:?\s*([^\n]+)|did you mean:?\s*([^\n]+)/i,
  );
  const hint = (closest?.[1] ?? closest?.[2] ?? "").trim();
  const reason = oneLine(output);
  if (hint && reason && !reason.includes(hint)) return `${reason} Closest match: ${hint}`;
  return reason;
}

function failureBreak(name: string, output: string): number {
  if (/timed out|timeout|etimedout/i.test(output)) return 94;
  if (/not found|no such file|enoent/i.test(output)) return 32;
  if (/no unique|multiple matches|found multiple/i.test(output)) return 28;
  if (/protected|eacces/i.test(output)) return 24;
  if (/invalid (regular expression|pattern)|unterminated/i.test(output))
    return 18;
  if (canonicalizeToolName(name) === "bash") return 100;
  return 40;
}

function shortFailure(name: string, output: string): string {
  if (/timed out|timeout|etimedout/i.test(output)) return "timed out";
  if (/not found|no such file|enoent/i.test(output)) return "not found";
  if (/no unique|multiple matches|found multiple/i.test(output))
    return "no unique match";
  if (/protected|eacces/i.test(output)) return "protected";
  if (/invalid (regular expression|pattern)|unterminated/i.test(output))
    return "invalid pattern";
  if (canonicalizeToolName(name) === "bash") {
    const of = output.match(/(\d+)\s+of\s+(\d+)\s+fail/i);
    if (of) return `exit 1 · ${of[1]} of ${of[2]} failed`;
    return "exit 1";
  }
  return oneLine(output) || "failed";
}

function threadOf(item: ToolItem, output: string): ThreadKind {
  if (item.status === "running") {
    return canonicalizeToolName(item.name) === "ask" ? "waiting" : "running";
  }
  if (/denied by user|user denied|user rejected|approval denied/i.test(output))
    return "denied";
  if (
    /interrupted|stopped before|aborted by user|turn ended/i.test(output)
  )
    return "stopped";
  if (item.status === "error") return "failed";
  return "settled";
}

function orderedPreview(output: string, failed: boolean): string[] {
  const lines = linesOf(output);
  if (!failed) return lines.slice(0, 20);
  const bad: string[] = [];
  const rest: string[] = [];
  for (const line of lines) {
    if (/error|fail|expected|exception|✗|×/i.test(line)) bad.push(line);
    else rest.push(line);
  }
  return [...bad, ...rest].slice(0, 20);
}

function bashParts(output: string, failed: boolean): ResultPart[] {
  if (failed) return [{ text: shortFailure("bash", output), tone: "fail" }];
  const passed = output.match(/(\d+)\s+pass(?:ed|ing)\b/i);
  if (passed && !/\bfail/i.test(output))
    return numSuffix(Number(passed[1]), " passed");
  const size = output.match(/(\d+(?:\.\d+)?\s*[KMG]B)\b/);
  if (/built\b/i.test(output) && size)
    return [
      { text: "built", tone: "quiet" },
      { text: ` · ${size[1]}`, tone: "dim" },
    ];
  if (!output.trim()) return [{ text: "exit 0", tone: "quiet" }];
  // A short last line is a result ("ok", "DIFF_CHECK_OK"); a long one is just output.
  const last = ([...linesOf(output)].reverse().find((line) => line.trim()) ?? "").trim();
  return [{ text: last.length <= 24 ? last : "done", tone: "quiet" }];
}

function grepParts(output: string): ResultPart[] {
  const rows = linesOf(output).filter(
    (line) => line.trim() && !line.startsWith("--"),
  );
  if (!rows.length) return [{ text: "no matches", tone: "quiet" }];
  const files = new Set(rows.map((line) => line.split(":")[0]));
  return [
    { text: String(rows.length), tone: "num" },
    { text: " matches · ", tone: "dim" },
    { text: String(files.size), tone: "num" },
    { text: files.size === 1 ? " file" : " files", tone: "dim" },
  ];
}

function listParts(output: string): ResultPart[] {
  const rows = linesOf(output).filter((line) => line.trim());
  if (!rows.length) return [{ text: "no matches", tone: "quiet" }];
  const files = rows.every((line) => !line.trim().endsWith("/"));
  return numSuffix(rows.length, files ? (rows.length === 1 ? " file" : " files") : " entries");
}

function searchParts(output: string): ResultPart[] {
  const blocks = output
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const n = blocks.length || linesOf(output).filter((line) => line.trim()).length;
  if (!n) return [{ text: "no matches", tone: "quiet" }];
  return numSuffix(n, n === 1 ? " place" : " places");
}

function readParts(item: ToolItem, output: string): ResultPart[] {
  const ranged = output.match(/(\d[\d,]*)\s+of\s+(\d[\d,]*)\s+lines/i);
  if (ranged) {
    return [
      { text: ranged[1]!.replace(/,/g, ""), tone: "num" },
      { text: " of ", tone: "dim" },
      { text: ranged[2]!.replace(/,/g, ""), tone: "num" },
      { text: " lines", tone: "dim" },
    ];
  }
  const total = linesOf(output).length;
  const limit = Number(item.args.limit ?? item.args.offset ?? 0);
  if (!output.trim() && !limit) return numSuffix(0, " lines");
  return numSuffix(total, " lines");
}

function diffParts(item: ToolItem): ResultPart[] | null {
  const diff = getToolDiff(item);
  if (!diff) return null;
  const edits = Array.isArray(item.args.edits) ? item.args.edits.length : 0;
  const metas = diff.lines.filter((line) => line.kind === "meta").length;
  const hunks = Math.max(edits, metas);
  const parts: ResultPart[] = [];
  if (hunks > 1) {
    parts.push(
      { text: String(hunks), tone: "num" },
      { text: " hunks ", tone: "dim" },
    );
  }
  if (diff.added) parts.push({ text: `+${diff.added}`, tone: "add" });
  if (diff.removed)
    parts.push({
      text: `${parts.length && parts.at(-1)?.tone !== "dim" ? " " : ""}−${diff.removed}`,
      tone: "del",
    });
  const write = canonicalizeToolName(item.name) === "write";
  const overwrite = /overwrite|updated existing|already exists/i.test(item.output);
  if (write && diff.removed === 0 && !overwrite)
    parts.push({ text: " · new file", tone: "dim" });
  return parts.length ? parts : null;
}

function hunkLabel(lines: DiffLine[]): string {
  const meta = lines.find((line) => line.kind === "meta");
  if (!meta) return "";
  return meta.text.split("@@").at(-1)?.trim() ?? "";
}

function todoParts(item: ToolItem): ResultPart[] | null {
  const raw = Array.isArray(item.details.tasks)
    ? item.details.tasks
    : Array.isArray(item.args.todos)
      ? item.args.todos
      : Array.isArray(item.args.tasks)
        ? item.args.tasks
        : null;
  if (!raw) return null;
  let total = 0;
  let done = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    total += 1;
    const status = String((entry as { status?: unknown }).status ?? "");
    if (status === "completed" || status === "done") done += 1;
  }
  if (!total) return null;
  return [
    { text: String(done), tone: "num" },
    { text: " of ", tone: "dim" },
    { text: String(total), tone: "num" },
    { text: " done", tone: "dim" },
  ];
}

function splitUrl(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { host: url, path: "" };
  }
}

function connector(name: string): { verb: string; method: string } | null {
  const match = /^mcp__([A-Za-z0-9-]+)__(.+)$/.exec(name);
  if (!match) return null;
  return {
    verb: match[1]!.toLowerCase(),
    method: match[2]!.replace(/_/g, " "),
  };
}

function where(path: string, cwd: string): string {
  if (!path || path === ".") return "";
  const shown = splitArgPath(path, cwd);
  const rel = `${shown.prefix}${shown.name}`;
  if (!rel) return "";
  const asDir = path.endsWith("/") || !shown.name.includes(".");
  return ` in ${rel}${asDir && !rel.endsWith("/") ? "/" : ""}`;
}

export function describeTool(
  item: ToolItem,
  cwd = "",
  repeat = 1,
): ToolRowModel {
  const output = item.output ?? "";
  const thread = threadOf(item, output);
  const failed = thread === "failed";
  const canonical = canonicalizeToolName(item.name);
  const linked = connector(item.name);
  let verb = linked?.verb ?? displayToolName(item.name);
  if (/delete|remove_file|unlink/i.test(item.name)) verb = "delete";
  else if (/rename|move_file|^move$/i.test(item.name)) verb = "move";
  else if (/^fetch$|web_fetch|open_page/i.test(item.name)) verb = "fetch";
  else if (/browser/i.test(item.name)) verb = "browser";
  const path = toolPath(item.args);
  const shown = path ? splitArgPath(path, cwd) : { tag: "", prefix: "", name: "" };
  let tag = shown.tag;
  let prefix = shown.prefix;
  let main = shown.name;
  let suffix = "";
  let sans = false;
  let detail: RowDetail = "none";
  let list: string[] = [];
  let pattern = "";
  const diff = getToolDiff(item);
  const diffLines = diff
    ? diff.lines.filter((line) => line.kind !== "meta").slice(0, 12)
    : [];
  const diffMore = Boolean(diff && diff.lines.filter((line) => line.kind !== "meta").length > 12);
  const diffLabel = diff ? hunkLabel(diff.lines) : "";

  const command = typeof item.args.command === "string" ? item.args.command : "";
  const query = typeof item.args.query === "string" ? item.args.query : "";
  const pat =
    typeof item.args.pattern === "string"
      ? item.args.pattern
      : typeof item.args.glob === "string"
        ? item.args.glob
        : "";

  if (linked) {
    main = `"${linked.method}"`;
    prefix = "";
    detail = "log";
    list = orderedPreview(output, failed);
  } else if (canonical === "bash") {
    prefix = "$ ";
    main = command || "shell";
    detail = "log";
    list = orderedPreview(output, failed);
  } else if (canonical === "grep") {
    pattern = pat;
    prefix = "";
    main = pat ? `"${pat}"` : path || "pattern";
    suffix = where(path, cwd);
    detail = "list";
    list = linesOf(output)
      .filter((line) => line.trim() && !line.startsWith("--"))
      .slice(0, 20);
  } else if (isSearch(item, canonical)) {
    sans = true;
    prefix = "";
    main = query || pat || path || "search";
    suffix = "";
    detail = "list";
    list = linesOf(output).filter((line) => line.trim()).slice(0, 20);
  } else if (canonical === "ls") {
    const glob = typeof item.args.glob_pattern === "string" ? item.args.glob_pattern : pat;
    if (glob) {
      prefix = "";
      main = glob;
    }
    detail = "list";
    list = linesOf(output).filter((line) => line.trim()).slice(0, 20);
  } else if (canonical === "read") {
    detail = "file";
  } else if (canonical === "edit" || canonical === "write" || diff) {
    detail = "diff";
  } else if (/^fetch$|web_fetch|open_page|web_fetch/i.test(item.name) || canonical === "fetch") {
    const url = typeof item.args.url === "string" ? item.args.url : path;
    const parts = url ? splitUrl(url) : { host: "", path: "" };
    prefix = "";
    main = parts.host || url || "page";
    suffix = parts.path && parts.path !== "/" ? parts.path : "";
    detail = "log";
    list = orderedPreview(output, failed);
  } else if (/delete|remove_file|unlink/i.test(item.name)) {
    detail = "none";
  } else if (/rename|move_file|^move$/i.test(canonical) || /rename|move_file/i.test(item.name)) {
    const to = String(
      item.args.to ?? item.args.destination ?? item.args.new_path ?? item.args.dest ?? "",
    );
    if (to) {
      const dest = splitArgPath(to, cwd);
      prefix = "";
      main = `${shown.name || path} → ${dest.name}`;
    }
  }

  if (!main) {
    const fallback = Object.values(item.args).find(
      (value) => typeof value === "string" && value.trim(),
    );
    main = typeof fallback === "string" ? fallback.replace(/\s+/g, " ") : verb;
  }

  let parts: ResultPart[] = [];
  if (thread === "denied") {
    parts = [{ text: "denied", tone: "quiet" }];
  } else if (thread === "stopped") {
    const ended = /turn ended/i.test(output);
    parts = [
      {
        text: ended ? "turn ended first" : `stopped at ${formatClock(item.elapsed ?? 0)}`,
        tone: "quiet",
      },
    ];
  } else if (failed) {
    const label = shortFailure(item.name, output);
    parts = [{ text: label, tone: "fail" }];
    if (/type error/i.test(output)) {
      const n = output.match(/(\d+)\s+type errors?/i);
      if (n) parts = numSuffix(Number(n[1]), n[1] === "1" ? " type error" : " type errors");
      parts = parts.map((part) =>
        part.tone === "num" || part.tone === "fail" ? { ...part, tone: "wait" } : part,
      );
    }
  } else if (canonical === "bash") {
    parts = bashParts(output, false);
  } else if (canonical === "grep") {
    parts = grepParts(output);
  } else if (canonical === "ls") {
    parts = listParts(output);
  } else if (isSearch(item, canonical)) {
    const web = /web_search|x_keyword_search|x_semantic_search/i.test(item.name);
    if (web) {
      const rows = linesOf(output).filter((line) => line.trim());
      parts = rows.length
        ? numSuffix(rows.length, rows.length === 1 ? " result" : " results")
        : [{ text: "no matches", tone: "quiet" }];
    } else parts = searchParts(output);
  } else if (canonical === "read") {
    parts = readParts(item, output);
  } else if (diffParts(item)) {
    parts = diffParts(item)!;
  } else if (todoParts(item)) {
    parts = todoParts(item)!;
    detail = "list";
  } else if (/^fetch$|web_fetch|open_page/i.test(item.name)) {
    if (failed) parts = [{ text: shortFailure(item.name, output), tone: "fail" }];
    else {
      const code = output.match(/\b(200|201|204|301|302|400|401|403|404|500|502)\b/);
      const size = output.match(/(\d+(?:\.\d+)?\s*[KMG]B)\b/);
      parts = [
        { text: code?.[1] ?? "200", tone: "num" },
        ...(size ? [{ text: ` · ${size[1]}`, tone: "dim" as const }] : []),
      ];
    }
  } else if (/delete|remove_file|unlink/i.test(item.name)) {
    const removed = output.match(/(\d+)\s+lines?/i);
    parts = removed
      ? [{ text: `−${removed[1]}`, tone: "del" }]
      : [{ text: "removed", tone: "quiet" }];
  } else if (linked) {
    const id = output.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
    parts = id
      ? [{ text: id[1]!, tone: "num" }]
      : output.trim()
        ? [{ text: oneLine(output).slice(0, 32), tone: "quiet" }]
        : [];
  } else if (!output.trim() && (canonical === "grep" || canonical === "search" || canonical === "ls")) {
    parts = [{ text: "no matches", tone: "quiet" }];
  }

  if (repeat > 1) parts.push({ text: ` ×${repeat}`, tone: "dim" });
  const attempt = Number(item.details.attempt ?? 0);
  if (attempt > 1) parts.push({ text: ` · ${ordinal(attempt)} attempt`, tone: "dim" });

  const note =
    thread === "failed"
      ? /timed out|timeout/i.test(output)
        ? "No response in time. The agent continued without it."
        : closestNote(output)
      : thread === "stopped"
        ? oneLine(output)
        : "";
  const tail =
    item.status === "running"
      ? ([...linesOf(output)].reverse().find((line) => line.trim()) ?? "")
      : "";

  const elapsed = item.elapsed ?? 0;
  const duration =
    thread === "stopped" || thread === "denied"
      ? ""
      : formatDuration(elapsed, item.status === "running");

  return {
    verb,
    accent: canonical === "agent" || /subagent|spawn_subagent|^task$/i.test(item.name),
    tag,
    prefix,
    main,
    suffix,
    sans,
    strike: thread === "denied" || /delete|remove_file|unlink/i.test(item.name),
    dimVerb: thread === "denied",
    title: [prefix, main, suffix].join("") || command || path,
    parts,
    duration,
    thread,
    breakAt:
      thread === "failed"
        ? failureBreak(item.name, output)
        : Math.round(unknownProgress(elapsed) * 100),
    note,
    tail,
    detail,
    list,
    pattern,
    diffLines,
    diffMore,
    diffLabel,
  };
}

function ordinal(n: number): string {
  const suffix = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffix[(v - 20) % 10] || suffix[v] || suffix[0]}`;
}

function repeatKey(item: ToolItem): string {
  const name = canonicalizeToolName(item.name);
  return [
    name,
    toolPath(item.args),
    typeof item.args.command === "string" ? item.args.command : "",
    typeof item.args.pattern === "string" ? item.args.pattern : "",
    typeof item.args.query === "string" ? item.args.query : "",
    item.status,
  ].join("\0");
}

function collapseRepeats(items: ToolItem[]): RepeatEntry[] {
  const out: RepeatEntry[] = [];
  for (const item of items) {
    const prev = out.at(-1);
    if (
      prev &&
      item.status !== "running" &&
      prev.item.status !== "running" &&
      repeatKey(item) === repeatKey(prev.item)
    ) {
      prev.repeat += 1;
      prev.item = item;
      continue;
    }
    out.push({ item, repeat: 1 });
  }
  return out;
}

function pushEntries(entries: RepeatEntry[], out: TranscriptBlock[]) {
  for (const entry of entries) {
    out.push({ type: "item", item: entry.item, repeat: entry.repeat });
  }
}

/** Fold consecutive reads and searches once a later tool starts. */
export function groupTranscriptRows(items: TimelineItem[]): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  let explore: ToolItem[] = [];
  let same: ToolItem[] = [];

  const flushSame = () => {
    if (!same.length) return;
    pushEntries(collapseRepeats(same), out);
    same = [];
  };

  const flushExplore = (fold: boolean) => {
    if (!explore.length) return;
    const settled = explore.every((item) => item.status !== "running");
    const entries = collapseRepeats(explore);
    if (fold && settled && explore.length >= 2) {
      const start = Math.min(...explore.map((item) => item.startedAt));
      const end = Math.max(
        ...explore.map((item) => item.startedAt + (item.elapsed ?? 0)),
      );
      out.push({
        type: "explored",
        id: explore[0]!.id,
        entries,
        calls: explore.length,
        failed: explore.filter((item) => item.status === "error").length,
        durationMs: Math.max(0, end - start),
      });
    } else {
      pushEntries(entries, out);
    }
    explore = [];
  };

  for (const item of items) {
    if (item.kind === "tool" && isExploreTool(item)) {
      flushSame();
      explore.push(item);
      continue;
    }
    if (item.kind === "tool") {
      flushExplore(true);
      const prev = same.at(-1);
      if (
        prev &&
        item.status !== "running" &&
        prev.status !== "running" &&
        repeatKey(item) === repeatKey(prev)
      ) {
        same.push(item);
      } else {
        flushSame();
        same = [item];
      }
      continue;
    }
    flushExplore(false);
    flushSame();
    out.push({ type: "item", item, repeat: 1 });
  }
  flushExplore(false);
  flushSame();
  return out;
}

export function windowExplored(entries: RepeatEntry[], calls: number): {
  entries: RepeatEntry[];
  hidden: number;
} {
  if (calls <= 50 || entries.length <= 10) return { entries, hidden: 0 };
  const head = entries.slice(0, 5);
  const tail = entries.slice(-5);
  const shown =
    head.reduce((sum, entry) => sum + entry.repeat, 0) +
    tail.reduce((sum, entry) => sum + entry.repeat, 0);
  return { entries: [...head, ...tail], hidden: Math.max(0, calls - shown) };
}
