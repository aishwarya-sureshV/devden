import type { TimelineItem } from "./timeline";

export type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

function canonicalName(name: string): string {
  return name.trim().toLowerCase().replace(/[-\s]/g, "_");
}

export type SubagentRun = {
  id: string;
  parent?: ToolItem;
  items: TimelineItem[];
  status: "running" | "done" | "error";
  /** Why the run is stalled, when the runner says it is blocked on a reply
   *  from the parent rather than still working. */
  attention?: string;
};

// Claude Code names the spawn tool `Agent` (older builds and the SDK say
// `Task`); grok says `spawn_subagent`; the pi-subagents extension says
// `subagent`.
const SUBAGENT_NAMES = new Set([
  "task",
  "agent",
  "spawn_subagent",
  "subagent",
]);

export function isSubagentTool(name: string): boolean {
  return SUBAGENT_NAMES.has(canonicalName(name));
}

export function subagentPrompt(args: Record<string, unknown>): string {
  for (const key of ["prompt", "description", "task", "query"]) {
    if (typeof args[key] === "string" && args[key].trim()) {
      return args[key] as string;
    }
  }
  return "";
}

function argText(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Which agent was asked. Claude/grok say `subagent_type`; the pi-subagents
 *  tool says `agent`. */
export function subagentType(parent?: ToolItem): string {
  return parent ? argText(parent.args, ["subagent_type", "agent"]) : "";
}

/** What it was asked to do. Claude/grok say `description`; pi says `task`. */
export function subagentDescription(parent?: ToolItem): string {
  return parent ? argText(parent.args, ["description", "task"]) : "";
}

export function subagentLabel(parent?: ToolItem): string {
  if (!parent) return "Subagent";
  const type = subagentType(parent);
  // pi's `task` is a whole sentence where Claude's `description` is a few
  // words, so the header gets an elided version rather than a wrapped page.
  const full = subagentDescription(parent);
  const description = full.length > 60 ? `${full.slice(0, 57)}…` : full;
  if (type && description) return `${type}: ${description}`;
  if (description) return description;
  if (type) return type;
  return parent.name;
}

function itemParentId(item: TimelineItem): string | undefined {
  if (
    item.kind === "tool" ||
    item.kind === "assistant" ||
    item.kind === "rationale" ||
    item.kind === "notice"
  ) {
    return item.parentToolUseId;
  }
  return undefined;
}

function runStatus(
  parent: ToolItem | undefined,
  children: TimelineItem[],
): SubagentRun["status"] {
  const runningChild = children.some(
    (child) =>
      (child.kind === "tool" && child.status === "running") ||
      ((child.kind === "assistant" || child.kind === "rationale") &&
        child.live),
  );
  // Parent error wins: abort ends the spawn tool while nested calls can
  // still be `running`, and treating that as busy keeps hold-filters on.
  if (parent?.status === "error") return "error";
  if (parent?.status === "running" || runningChild) return "running";
  if (children.some((child) => child.kind === "tool" && child.status === "error"))
    return "error";
  return "done";
}

/** Tools a live subagent is making must not flash through the main transcript.
 *  Grok (and sometimes Claude) first emits nested calls without a parent id;
 *  they complete in the same tick, so holding only `running` still lets the
 *  "1 shell command" chip appear for a frame before the tag arrives.
 *  Only tools after the spawn are held, so the parent's earlier work stays. */
export function isHeldMainTool(
  item: TimelineItem,
  subagentBusy: boolean,
  items: TimelineItem[] = [],
): boolean {
  if (
    !subagentBusy ||
    item.kind !== "tool" ||
    item.parentToolUseId ||
    isSubagentTool(item.name)
  ) {
    return false;
  }
  const spawnIndex = items.findIndex(
    (candidate) =>
      candidate.kind === "tool" && isSubagentTool(candidate.name),
  );
  if (spawnIndex < 0) return item.status === "running";
  const index = items.indexOf(item);
  return index < 0 || index > spawnIndex;
}

function subagentActionArg(item: ToolItem): string {
  const value = item.args?.["action"];
  return typeof value === "string" ? value.trim() : "";
}

/** A call that starts a run, as opposed to one asking after a run already
 *  going: the spawn tool is multiplexed, and only the no-`action` shape
 *  spawns. */
function isSpawnCall(item: TimelineItem): boolean {
  return (
    item.kind === "tool" &&
    isSubagentTool(item.name) &&
    !subagentActionArg(item)
  );
}

/** The inline SubagentCard is a live widget. Once the run settles it must
 *  leave the main transcript — otherwise a streaming flicker collapses the
 *  spawn into a "1 tool call" chip and remounts the card on the handover. */
export function isSettledSpawnTool(
  item: TimelineItem,
  runs: SubagentRun[],
): boolean {
  if (!isSpawnCall(item)) return false;
  return !runs.some((run) => run.id === item.id && run.status === "running");
}

/** The main agent asking after a run it already started: a status poll, a
 *  `subagent_wait`, or a direct read of the runner's own artifacts. */
function isSubagentHousekeeping(item: TimelineItem): boolean {
  if (item.kind !== "tool") return false;
  if (canonicalName(item.name).startsWith("subagent")) return !isSpawnCall(item);
  return /pi-subagents|async-subagent-runs/.test(
    JSON.stringify(item.args ?? {}),
  );
}

/**
 * Untagged main-thread work that is only the model babysitting a subagent it
 * already spawned — the status polls, waits and artifact reads, plus the
 * narration threaded between them ("finished" … "actually still running" …).
 *
 * The window runs from a spawn up to the last housekeeping call that follows
 * it, so what survives is exactly the shape a Task call has in Claude Code's
 * CLI: the spawn, then the handover. It is deliberately positional rather
 * than keyed on "is the run busy right now" — a live-status test un-hides
 * the whole blow-by-blow again the moment the run settles, which is the
 * state the transcript spends most of its life in. A new spawn closes the
 * previous window, so several subagents in one turn each keep their own.
 */
export function isSubagentCheckIn(
  item: TimelineItem,
  items: TimelineItem[],
): boolean {
  if (itemParentId(item)) return false;
  if (item.kind !== "tool" && item.kind !== "assistant") return false;
  if (isSpawnCall(item)) return false;
  const index = items.indexOf(item);
  if (index < 0) return false;
  if (!items.some((candidate, at) => at < index && isSpawnCall(candidate))) {
    return false;
  }
  for (let at = index; at < items.length; at++) {
    const candidate = items[at]!;
    if (at > index && isSpawnCall(candidate)) return false;
    if (isSubagentHousekeeping(candidate)) return true;
  }
  return false;
}

// Vocabulary that only shows up when the model is talking about the run it
// is babysitting rather than doing work of its own.
const CHATTER =
  /\b(sub-?agents?|workflow|supervisor|spawn(ed|ing)?|child run|fan-?out|hand(ing)? (it )?(back|over)|in the background|wait(ing|s)? for\b|still (running|working|active|going)|wake|woken|run id|runId|returned early)\b/i;

function mentionsSubagent(text: string, agents: string[]): boolean {
  const trimmed = text.trim();
  // Nothing has arrived yet — hold, so the first token cannot flash.
  if (!trimmed) return true;
  if (CHATTER.test(trimmed)) return true;
  return agents.some((agent) => {
    if (agent.length < 3) return false;
    const escaped = agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(trimmed);
  });
}

/**
 * Narration to hold while a run is going, because it is the model talking
 * about the run rather than doing work of its own.
 *
 * The positional check only catches a check-in once the tool call it
 * introduces arrives, which leaves the last one before a run finishes with
 * nothing after it to close the window — so this content check has to hold
 * settled text too, not just streaming text. It leans toward holding: a
 * wrong guess costs genuine work its token-by-token reveal, where the other
 * way round puts the machinery on screen. Hence the run's own agent name
 * (`worker`, `scout`) alongside the vocabulary that only shows up when a run
 * is the subject — including the internals pi's spawn receipt teaches it.
 */
export function isSubagentChatter(
  item: TimelineItem,
  runs: SubagentRun[],
): boolean {
  if (item.kind !== "assistant" || item.parentToolUseId) return false;
  const running = runs.filter((run) => run.status === "running");
  if (running.length === 0) return false;
  return mentionsSubagent(
    item.text,
    running.map((run) => subagentType(run.parent)).filter(Boolean),
  );
}

/** Child narration also arrives untagged on the parent ACP stream. */
export function isHeldMainNarration(
  item: TimelineItem,
  subagentBusy: boolean,
): boolean {
  return (
    subagentBusy &&
    item.kind === "assistant" &&
    !item.parentToolUseId &&
    item.live
  );
}

/** Completed untagged copy of nested assistant text. */
export function isSubagentEcho(
  item: TimelineItem,
  items: TimelineItem[],
): boolean {
  if (item.kind !== "assistant" || item.parentToolUseId) return false;
  const text = item.text.trim();
  if (text.length < 40) return false;
  return items.some((other) => {
    if (other === item || other.kind !== "assistant" || !other.parentToolUseId)
      return false;
    const nested = other.text.trim();
    if (nested.length < 20) return false;
    return nested.includes(text) || text.includes(nested);
  });
}

/** Untagged parent-stream copy of a nested tool, including after the run ends. */
export function isSubagentToolEcho(
  item: TimelineItem,
  items: TimelineItem[],
): boolean {
  if (
    item.kind !== "tool" ||
    item.parentToolUseId ||
    isSubagentTool(item.name)
  ) {
    return false;
  }
  const name = canonicalName(item.name);
  const args = JSON.stringify(item.args ?? {});
  return items.some((other) => {
    if (other === item || other.kind !== "tool" || !other.parentToolUseId)
      return false;
    if (canonicalName(other.name) !== name) return false;
    if (other.id === item.id) return true;
    return args !== "{}" && JSON.stringify(other.args ?? {}) === args;
  });
}

/** Group nested subagent work under the Task / spawn_subagent call that owns it. */
export function collectSubagentRuns(items: TimelineItem[]): SubagentRun[] {
  const childrenByParent = new Map<string, TimelineItem[]>();
  const tools = new Map<string, ToolItem>();

  for (const item of items) {
    if (item.kind === "tool") tools.set(item.id, item);
    const parentId = itemParentId(item);
    if (!parentId) continue;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(item);
    childrenByParent.set(parentId, siblings);
  }

  const runs: SubagentRun[] = [];
  const seen = new Set<string>();

  const pushRun = (id: string, parent?: ToolItem) => {
    if (seen.has(id)) return;
    seen.add(id);
    const children = childrenByParent.get(id) ?? [];
    const status = runStatus(parent, children);
    const blocked = [...children]
      .reverse()
      .find((child) => child.kind === "notice" && child.tone === "warning");
    runs.push({
      id,
      parent,
      items: children,
      status,
      ...(status === "running" && blocked?.kind === "notice"
        ? { attention: blocked.text }
        : {}),
    });
  };

  for (const item of items) {
    if (item.kind !== "tool") continue;
    // A spawn earns a run once it has nested work, or while it is still
    // running and that work is on its way. pi's `subagent` is multiplexed —
    // the same tool name also answers `action: "status"` / `"guide"` — so
    // keying purely off the name minted an empty panel tab per query.
    if (childrenByParent.has(item.id)) {
      pushRun(item.id, item);
    } else if (isSubagentTool(item.name) && item.status === "running") {
      pushRun(item.id, item);
    }
  }
  for (const parentId of childrenByParent.keys()) {
    pushRun(parentId, tools.get(parentId));
  }
  return runs;
}
