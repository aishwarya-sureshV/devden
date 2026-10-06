import type { TimelineItem } from "./timeline";
import { isFileChangeTool, toolPath } from "./toolCards.ts";
import { extractTodos } from "./todos.ts";
import { HANDOFF_NOTICE } from "./handoffBlock.ts";

export interface ExportMeta {
  title: string;
  backend: string;
  model?: string;
  cwd?: string;
  exportedAt?: Date;
  /** Unfinished tasks, so a reader knows what is next without reading it all. */
  todos?: string[];
}

/** Fenced blocks in tool output would otherwise break out of their own fence. */
function fence(body: string): string {
  const longest = [...body.matchAll(/`{3,}/g)].reduce(
    (max, match) => Math.max(max, match[0].length),
    2,
  );
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}\n${body}\n${ticks}`;
}

function trim(text: string, limit = 4000, full = false): string {
  const clean = text.replace(/\s+$/, "");
  return !full && clean.length > limit
    ? `${clean.slice(0, limit)}\n… (${clean.length - limit} more characters)`
    : clean;
}

/**
 * Render a transcript as Markdown: one heading per turn, tool calls collapsed
 * into details blocks so the prose stays readable, and permission decisions
 * kept because "what did I let it do" is half the value of an exported log.
 */
export function timelineToMarkdown(
  items: TimelineItem[],
  meta: ExportMeta,
  { full = false }: { full?: boolean } = {},
): string {
  const cut = (text: string, limit?: number) => trim(text, limit, full);
  const when = meta.exportedAt ?? new Date();
  const lines: string[] = [
    `# ${meta.title}`,
    "",
    `- **Agent:** ${meta.backend}${meta.model ? ` (${meta.model})` : ""}`,
    ...(meta.cwd ? [`- **Workspace:** \`${meta.cwd}\``] : []),
    `- **Exported:** ${when.toISOString()}`,
    "",
    ...(meta.todos?.length
      ? ["## Still to do", "", ...meta.todos.map((task) => `- [ ] ${task}`), ""]
      : []),
    "---",
    "",
  ];

  for (const item of items) {
    if (item.kind === "user") {
      lines.push(`## User`, "", cut(item.text), "");
      continue;
    }
    if (item.kind === "assistant") {
      lines.push(`### Assistant`, "", cut(item.text), "");
      continue;
    }
    if (item.kind === "rationale") {
      lines.push(`<details><summary>Reasoning</summary>`, "", cut(item.text), "", `</details>`, "");
      continue;
    }
    if (item.kind === "tool") {
      const args = JSON.stringify(item.args ?? {}, null, 2);
      lines.push(
        `<details><summary>Tool · ${item.name} (${item.status})</summary>`,
        "",
        fence(cut(args, 1500)),
        "",
        ...(item.output ? [fence(cut(item.output))] : []),
        "",
        `</details>`,
        "",
      );
      continue;
    }
    if (item.kind === "notice") {
      lines.push(`> _${item.tone}_: ${cut(item.text, 500)}`, "");
    }
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** Filesystem-safe, dated filename for the exported transcript. */
export function exportFilename(title: string, at = new Date()): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "session";
  const stamp = at.toISOString().slice(0, 10);
  return `${slug}-${stamp}.md`;
}

/** Stable per-session name, so the auto-save overwrites instead of piling up. */
export function transcriptFilename(
  identity: string,
  title: string,
): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "session";
  const id = identity.replace(/[^a-zA-Z0-9]+/g, "").slice(-12) || "session";
  return `${slug}-${id}.md`;
}

/** Set by a backend switch, consumed by the next prompt (conversationSend). */
export type PendingHandoff = {
  /** Auto-saved full transcript, pointed at for details. */
  path: string | null;
  /** Backend whose turns the timeline last recorded. */
  from: string;
  /** `from`'s native session file, resumed on a switch straight back. */
  sessionPath?: string;
};

/**
 * A switch back to `from` before anything was sent elsewhere resumes its
 * native session (context and prompt cache intact) instead of a blank one.
 * An unconsumed handoff is that signal: its sessionPath is still `from`'s.
 */
export function planSwitch(
  pending: PendingHandoff | null,
  from: string,
  next: string,
  currentSession?: string,
): { back: boolean; sessionPath?: string } {
  return { back: next === from, sessionPath: pending?.sessionPath ?? currentSession };
}

// server/prosecutor.js DEFENSE_OPENER / executorBrief(): a prosecutor round's
// prompt to the executor, and the case record a resume prompt carries.
const DEFENSE_OPENER = "The prosecutor wrote failing tests against your change.";
const CASE_RECORD = "Prosecutor-mode case record so far";
const USER_CHARS = 3000;
const REPLY_CHARS = 2000;
const BUDGET_CHARS = 24000;

const clip = (text: string, max: number) => {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max)} …[clipped]` : clean;
};

type HandoffTurn = {
  user: string;
  earlier?: string;
  reply: string;
  model?: string;
  files: Set<string>;
  defense: boolean;
  switched: string[];
};

function changedPaths(item: Extract<TimelineItem, { kind: "tool" }>): string[] {
  if (item.status === "error") return [];
  const changes = Array.isArray(item.args.changes) ? item.args.changes : [];
  const fromChanges = changes.flatMap((change) =>
    change && typeof change === "object" && typeof (change as { path?: unknown }).path === "string"
      ? [(change as { path: string }).path]
      : [],
  );
  if (fromChanges.length) return fromChanges;
  return isFileChangeTool(item) && toolPath(item.args) ? [toolPath(item.args)] : [];
}

/** The turns (and files) of an earlier handoff, minus its header and footer. */
function earlierTurns(handoff: string): string {
  const start = handoff.search(/^(### Turn|— |Earlier handoff record)/m);
  // The footer after the last turn: a nested record's own footer sits earlier.
  const lastTurn = Math.max(0, handoff.lastIndexOf("\n### Turn "));
  const stop = handoff.slice(lastTurn).search(/^(## Still open|Full transcript with|Continue from here)/m);
  return handoff.slice(Math.max(start, 0), stop >= 0 ? lastTurn + stop : undefined).trim();
}

/** One entry per user message: what was asked, the final reply, files touched. */
function handoffTurns(items: TimelineItem[]): HandoffTurn[] {
  const turns: HandoffTurn[] = [];
  let switched: string[] = [];
  let earlier: string | undefined;
  for (const item of items) {
    if (item.kind === "notice" && item.detail && HANDOFF_NOTICE.test(item.text)) {
      // Ahead of every turn it is the only copy of the turns before that
      // switch (a reload whose carried-over history is missing).
      if (turns.length === 0) earlier = earlierTurns(item.detail);
      else switched.push(item.text.split(" · ")[0]);
      continue;
    }
    if (item.kind === "user") {
      turns.push({
        user: item.text,
        earlier: turns.length ? undefined : earlier,
        reply: "",
        files: new Set(),
        defense: item.text.includes(DEFENSE_OPENER),
        switched,
      });
      switched = [];
      continue;
    }
    const turn = turns.at(-1);
    if (!turn) continue;
    if (item.kind === "tool") changedPaths(item).forEach((path) => turn.files.add(path));
    // Subagent and prosecutor text is nested under their cards: not the reply.
    else if (item.kind === "assistant" && !item.parentToolUseId && item.text.trim()) {
      turn.reply = item.text;
      turn.model = item.modelId;
    }
  }
  return turns;
}

function renderTurn(turn: HandoffTurn, n: number): string {
  const user = turn.defense
    ? "[prosecutor round: failing tests were sent back to the agent]"
    : clip(turn.user, USER_CHARS) || "(attachments only)";
  return [
    ...turn.switched.map((line) => `— ${line} —`),
    ...(turn.earlier ? [`Earlier handoff record (turns before a reload):\n\n${turn.earlier}\n\nAfter that:`] : []),
    `### Turn ${n}`,
    `User: ${user}`,
    `Agent${turn.model ? ` (${turn.model})` : ""}: ${clip(turn.reply, REPLY_CHARS) || "(no reply — interrupted or unfinished)"}`,
    ...(turn.files.size ? [`Files changed: ${[...turn.files].join(", ")}`] : []),
  ].join("\n");
}

/**
 * The record a newly switched-in backend starts from, inlined in its first
 * message: agents skim a pointed-at file (a 345KB transcript was read to
 * line 1460 of 8271, so the newest turns were never seen) and a raw transcript
 * costs more than it tells. Built mechanically from the timeline -- no model
 * summarises -- so it is backend-neutral and chains: the next switch rebuilds
 * it from every turn, whichever backend ran them.
 */
export function handoffPrompt({
  items,
  from,
  cwd,
  transcriptPath,
  sessionFiles = [],
  message = "",
}: {
  items: TimelineItem[];
  from: string;
  cwd?: string;
  transcriptPath?: string | null;
  /** Every file the server recorded changing this session, shell writes included. */
  sessionFiles?: string[];
  /** The message this handoff rides on; its case record is not repeated. */
  message?: string;
}): string {
  let turns = handoffTurns(items);
  // A prosecutor resume carries this case's rounds itself: drop them here.
  if (message.includes(CASE_RECORD) || message.includes(DEFENSE_OPENER)) {
    const caseStart = turns.findLastIndex((turn) => !turn.defense);
    turns = turns.filter((turn, i) => !(turn.defense && i > caseStart));
  }
  // Numbering continues after a carried-forward record's own turns.
  const offset = turns[0]?.earlier?.match(/^### Turn /gm)?.length ?? 0;
  const blocks = turns.map((turn, i) => renderTurn(turn, offset + i + 1));
  // ponytail: over budget keeps the first turn (the original ask) and the
  // newest that fit; the full transcript holds the middle.
  let kept = blocks;
  if (blocks.join("\n\n").length > BUDGET_CHARS) {
    const tail: string[] = [];
    let size = blocks[0].length;
    for (let i = blocks.length - 1; i > 0; i--) {
      if (size + blocks[i].length > BUDGET_CHARS) break;
      size += blocks[i].length;
      tail.unshift(blocks[i]);
    }
    const omitted = blocks.length - 1 - tail.length;
    kept = [blocks[0], `[${omitted} middle turn(s) omitted — see the full transcript]`, ...tail];
  }
  const todos = extractTodos(items, { turnComplete: false })
    .filter((task) => task.status === "pending" || task.status === "in_progress")
    .map((task) => `- [ ] ${task.subject}`);
  return [
    `You are continuing an existing conversation handed off from ${from}. This is not a new session: the record below is the thread you are joining, and the user's new message is above it. You do not need to read anything to catch up.`,
    ...(cwd ? [`Workspace: \`${cwd}\` — the same working tree, already in the state described below.`] : []),
    "",
    "## Session so far (oldest first)",
    "The user's words are standing requirements; a later turn overrides an earlier one. Agent replies are claims about what was done.",
    "",
    kept.join("\n\n"),
    ...(sessionFiles.length
      ? ["", "## Files changed this session (any backend, shell commands included)", sessionFiles.join(", ")]
      : []),
    ...(todos.length ? ["", "## Still open", ...todos] : []),
    "",
    ...(transcriptPath
      ? [`Full transcript with every tool call and output, only if you need a specific detail: \`${transcriptPath}\``]
      : []),
    "Continue from here; do not redo completed work.",
  ].join("\n");
}
