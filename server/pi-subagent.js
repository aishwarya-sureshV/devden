/**
 * pi subagent follow.
 *
 * pi has no native subagent tool; `subagent` comes from the pi-subagents
 * extension. Its children are background by default and run inside a detached
 * runner process, so their work never reaches pi's own RPC stream — the parent
 * only ever sees the `subagent` call and an immediate "detached and running"
 * receipt.
 *
 * What the runner does expose (all verified against a live run):
 *
 *   tool_execution_end.result.details.asyncDir  ->  the run's artifact dir
 *   <asyncDir>/status.json                      ->  state + one entry per step
 *   status.steps[].sessionFile                  ->  the child's own pi session
 *
 * `events.jsonl` is *not* the source: for a workflow run (the default) it
 * carries only `subagent.workflow.*` lifecycle rows, no child events. The
 * child's session file is the real transcript, it is a plain pi session log,
 * and it is named in status.json from the very first write — while the step is
 * still running — so tailing it streams the child's tools and narration live,
 * the same way grok-agent.js follows a child session's updates.jsonl.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The pi-subagents spawn tool. */
export function isPiSubagentTool(name) {
  return String(name ?? "").trim().toLowerCase() === "subagent";
}

/** Where the detached runner writes this run's artifacts, when the result says
 *  so directly. A run wrapped in a blocking workflow does not carry this. */
export function asyncDirOf(result) {
  const dir = result?.details?.asyncDir;
  return typeof dir === "string" && dir ? dir : "";
}

// The extension's own ASYNC_DIR (shared/types.ts): PI_SUBAGENTS_TEMP_ROOT, or
// <tmpdir>/pi-subagents-uid-<uid>. pi-web runs as the same user on the same
// host as pi, so recomputing it here lands on the same directory.
function asyncRunsRoot() {
  const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  const root = configured || join(tmpdir(), `pi-subagents-uid-${process.getuid?.() ?? 0}`);
  return join(root, "async-subagent-runs");
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The run's own id, dug out of wherever the result happens to carry it.
 *  `details.runId` is the *tool call* id (`call_…`) for a workflow, while the
 *  real run id sits at `details.workflow.value.runId`; scanning for the first
 *  uuid-shaped `runId` finds it without hard-coding one nesting. */
export function runIdOf(result, depth = 0) {
  const value = depth === 0 ? result?.details : result;
  if (!value || typeof value !== "object" || depth > 6) return "";
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = runIdOf(entry, depth + 1);
      if (found) return found;
    }
    return "";
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "runId" && typeof entry === "string" && RUN_ID.test(entry))
      return entry;
    if (entry && typeof entry === "object") {
      const found = runIdOf(entry, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

/** The artifact directory to follow, however the result chose to name it.
 *  A `subagent` call that spawned nothing (`action: "status"`, a guide read)
 *  resolves to "" and is not followed. */
export function resolveAsyncDir(result) {
  const direct = asyncDirOf(result);
  if (direct) return direct;
  const runId = runIdOf(result);
  if (!runId) return "";
  // A blocking workflow wrapper returns only after its detached child is
  // done, but the child still left a full artifact dir behind — following it
  // replays the child's tools and narration into the panel.
  const dir = join(asyncRunsRoot(), runId);
  return existsSync(join(dir, "status.json")) ? dir : "";
}

/** `subagent` is multiplexed: the same tool answers `action: "status"`,
 *  `"guide"`, `"validate"` and friends, and those results quote the run id of
 *  the run they describe. Only a real spawn — no `action`, and something to
 *  run — may claim a run, or a status poll would mint a second panel for the
 *  same child and collide with its tool ids. */
export function isSpawnArgs(args) {
  if (!args || typeof args !== "object") return false;
  if (typeof args.action === "string" && args.action.trim()) return false;
  return ["agent", "task", "workflow", "workflowScript", "workflowScriptPath"].some(
    (key) => args[key] !== undefined && args[key] !== null && args[key] !== "",
  );
}

/** The spawn receipt pi returns immediately. Used as the spawn card's result
 *  only when the run produced no findings of its own. */
export function receiptTextOf(result) {
  return (result?.content ?? [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

// AsyncStatus["state"], from the extension's own types.ts:
// "queued" | "running" | "complete" | "failed" | "partial" | "paused"
// | "stopped" | "rejected".
const LIVE_STATES = new Set(["queued", "running", "paused"]);
const OK_STATES = new Set(["complete", "partial"]);

/**
 * The run that does the real work behind a blocking workflow wrapper.
 *
 * A spawn lays down *two* run directories: the wrapper (`mode: "workflow"`),
 * which reports `complete` about a second after it starts, and the child
 * (`mode: "single"`, `parentWorkflowRunId` pointing back at the wrapper),
 * which is the one that actually runs for minutes. Both name the same
 * session file, so a follow bound to the wrapper still streams the work —
 * but it read the wrapper's `complete` as the run being over and announced
 * the handover while the child was barely started.
 *
 * The child is written as a sibling of the wrapper, so its own directory is
 * where to look.
 */
export function childRunDir(status, dir) {
  const runId = String(status?.runId ?? "");
  if (!runId || String(status?.mode ?? "") !== "workflow") return "";
  let names = [];
  try {
    names = readdirSync(dirname(dir));
  } catch {
    return "";
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const candidate = join(dirname(dir), name);
    if (candidate === dir) continue;
    try {
      const child = JSON.parse(
        readFileSync(join(candidate, "status.json"), "utf8"),
      );
      if (String(child?.parentWorkflowRunId ?? "") === runId) return candidate;
    } catch {
      // Not a run directory, or its status has not landed yet.
    }
  }
  return "";
}

/**
 * The run's control channel: why a child has gone quiet.
 *
 * `events.jsonl` carries `subagent.control` rows whose inner event says what
 * the runner noticed — `needs_attention` when the child is blocked on a
 * supervisor reply and cannot proceed on its own, `active_long_running` when
 * it is merely slow. Only the blocked one is worth interrupting for: without
 * it the run looks like it is thinking, when really nothing will happen
 * until the parent answers.
 */
export function controlNotices(chunk) {
  const notices = [];
  for (const line of String(chunk ?? "").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.type !== "subagent.control") continue;
    const event = row.event ?? {};
    if (event.type !== "needs_attention") continue;
    const agent = String(event.agent ?? "subagent");
    const message = String(event.message ?? "needs attention");
    notices.push(message.startsWith(agent) ? message : `${agent}: ${message}`);
  }
  return notices;
}

/** undefined while the run is still going. */
export function statusTerminal(status) {
  const state = String(status?.state ?? "");
  if (!state || LIVE_STATES.has(state)) return undefined;
  return OK_STATES.has(state) ? "done" : "failed";
}

/**
 * Turn a child's pi session log into the events pi-web already renders,
 * skipping the `messagesBefore` it has already published.
 *
 * A child session is an ordinary pi log: `assistant` messages carrying
 * text/thinking/toolCall parts, and `toolResult` messages carrying the result.
 * Thinking is dropped — the subagent pane hides it, exactly as the main chat
 * does — and so is the leading `user` message, which is just the task prompt
 * already shown on the spawn card.
 */
export function childSessionEvents(contents, messagesBefore, streamKey, parentToolUseId, textIndex = 0) {
  const messages = [];
  let forkedAt = "";
  for (const line of String(contents ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      // A run started from the parent's session inherits the parent's whole
      // history. The child's file opens with a `session` header naming the
      // session it forked from, and every inherited message predates that
      // header — replaying them put the *parent's* own narration ("I'll
      // spawn a worker subagent…") in the subagent panel, as if the child
      // had said it.
      if (entry?.type === "session" && !forkedAt && entry.parentSession) {
        forkedAt = String(entry.timestamp ?? "");
      }
      if (entry?.type === "message" && entry.message) messages.push(entry.message);
    } catch {
      // A torn trailing line; the next tick re-reads the file whole.
    }
  }
  // The header's timestamp is ISO-8601; a message's own is epoch millis. A
  // message without a readable one is kept: dropping it is worse than
  // showing it.
  const forkedAtMs = forkedAt ? Date.parse(forkedAt) : NaN;
  const own = Number.isFinite(forkedAtMs)
    ? messages.filter((message) => {
        const at = Number(message?.timestamp);
        return !Number.isFinite(at) || at >= forkedAtMs;
      })
    : messages;
  const events = [];
  let index = textIndex;
  for (const message of own.slice(messagesBefore)) {
    const role = String(message?.role ?? "");
    if (role === "assistant") {
      for (const part of message.content ?? []) {
        if (part?.type === "text" && String(part.text ?? "").trim()) {
          events.push({
            type: "message_update",
            streamKey,
            parentToolUseId,
            assistantMessageEvent: {
              type: "text_end",
              contentIndex: index++,
              content: part.text,
            },
          });
        } else if (part?.type === "toolCall") {
          events.push({
            type: "tool_execution_start",
            toolCallId: String(part.id ?? ""),
            toolName: String(part.name ?? "tool"),
            args: part.arguments ?? {},
            parentToolUseId,
          });
        }
      }
    } else if (role === "toolResult") {
      events.push({
        type: "tool_execution_end",
        toolCallId: String(message.toolCallId ?? ""),
        result: { content: message.content ?? [] },
        isError: Boolean(message.isError),
      });
    }
  }
  return { events, messagesSeen: own.length, textIndex: index };
}

/** The child's findings: the last thing it said. Falls back to the caller's
 *  spawn receipt when the child never got far enough to say anything. */
export function childFindings(contents) {
  const { events } = childSessionEvents(contents, 0, "", "");
  const texts = events
    .filter((event) => event.type === "message_update")
    .map((event) => event.assistantMessageEvent.content);
  return texts.at(-1) ?? "";
}

// A run whose status and children both stop changing for this long is treated
// as dead, so the spawn card settles instead of spinning forever.
let stallMs = 5 * 60_000;
// How long a terminal run may take to name its children's session files.
let settleMs = 20_000;
// How long the transcript must be quiet before a terminal run is closed out.
// The child's closing report is written to its session file a beat after its
// last tool call, so a shorter window truncated the findings.
let quietMs = 3_000;

/** Tests only: shrink the stall watchdog so the bail-out is observable. */
export function setStallMsForTesting(ms, settle, quiet) {
  stallMs = ms;
  if (settle !== undefined) settleMs = settle;
  if (quiet !== undefined) quietMs = quiet;
}

/**
 * Tails every live subagent run for one pi session.
 *
 * `emit` receives ready-to-publish pi-web events; `drained()` resolves once the
 * last follow finishes.
 */
export class PiSubagentFollows {
  constructor(emit) {
    this.emit = emit;
    this.follows = new Map();
    /** Run dirs already claimed. A spawn's tool_execution_start and _end do
     *  not always share a tool call id, so the run itself — not the call — is
     *  what must be claimed exactly once, or a later `action: "status"` poll
     *  quoting the same run id would mint a second panel whose nested tool
     *  ids collide with the first's. */
    this.claimed = new Set();
    /** Spawn calls waiting to be matched to a run directory. */
    this.pending = [];
    this.discovery = undefined;
    /** Runs already closed out, kept so a late-written transcript can still
     *  be picked up — see reconcile(). */
    this.recent = [];
    this.onIdle = undefined;
  }

  get size() {
    return this.follows.size + this.pending.length;
  }

  /** True while a run for this spawn is being followed — its terminal
   *  tool_execution_end is not out yet, whichever path armed the follow. */
  isFollowing(parentToolUseId) {
    return this.follows.has(parentToolUseId);
  }

  /**
   * Register a spawn and start hunting for the run it created.
   *
   * Binding cannot go through the spawn's tool_execution_end: that event can
   * arrive under a *different* tool call id than its start (observed live),
   * and its details sometimes carry neither `asyncDir` nor a run id. What is
   * always true is that the runner creates a run directory for this cwd right
   * after the call. So the spawn is matched to the first unclaimed run in its
   * own working directory that started no earlier than it did.
   */
  expect(parentToolUseId, cwd, startedAt) {
    if (this.pending.some((entry) => entry.parentToolUseId === parentToolUseId)) return;
    this.pending.push({ parentToolUseId, cwd, startedAt, at: Date.now() });
    if (!this.discovery) this.discovery = setInterval(() => this.discover(), 200);
    this.discover();
  }

  discover() {
    if (this.pending.length === 0) {
      clearInterval(this.discovery);
      this.discovery = undefined;
      return;
    }
    const root = asyncRunsRoot();
    let dirs = [];
    try {
      dirs = readdirSync(root);
    } catch {
      dirs = [];
    }
    const candidates = [];
    for (const name of dirs) {
      if (name.startsWith(".")) continue;
      const dir = join(root, name);
      if (this.claimed.has(dir)) continue;
      let status;
      try {
        status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
      } catch {
        continue;
      }
      candidates.push({ dir, cwd: String(status.cwd ?? ""), startedAt: Number(status.startedAt ?? 0) });
    }
    candidates.sort((a, b) => a.startedAt - b.startedAt);
    for (const entry of [...this.pending]) {
      // A second of slack: the run's own clock is set just before the tool
      // call is reported here.
      const match = candidates.find(
        (candidate) =>
          !this.claimed.has(candidate.dir) &&
          candidate.cwd === entry.cwd &&
          candidate.startedAt >= entry.startedAt - 1000,
      );
      if (!match) continue;
      this.pending = this.pending.filter((p) => p !== entry);
      this.start(entry.parentToolUseId, match.dir, entry.receiptText ?? "");
    }
    // A spawn that never produced a run (rejected, or capacity refused) must
    // not keep the discovery timer alive forever.
    this.pending = this.pending.filter((entry) => Date.now() - entry.at < 60_000);
  }

  /** Begin following the run a `subagent` call just started.
   *  @returns true when a follow was armed, which means the caller must hold
   *  the spawn's tool_execution_end until the child is actually done. */
  start(parentToolUseId, asyncDir, receiptText) {
    if (!asyncDir || this.follows.has(parentToolUseId)) return false;
    if (this.claimed.has(asyncDir)) return false;
    this.claimed.add(asyncDir);
    const follow = {
      parentToolUseId,
      asyncDir,
      receiptText: String(receiptText ?? ""),
      files: new Map(),
      textIndex: 0,
      eventsOffset: 0,
      notices: new Set(),
      terminalAt: undefined,
      emittedAny: false,
      lastFindings: "",
      lastAdvance: Date.now(),
      timer: undefined,
    };
    this.follows.set(parentToolUseId, follow);
    // Arm the interval before the first pump: a run that is already finished
    // completes on that pump, and finish()'s clearInterval must find a real
    // timer or the interval keeps firing on a deleted follow.
    follow.timer = setInterval(() => this.pump(follow), 200);
    this.pump(follow);
    return true;
  }

  /** Re-read the run's status and replay whatever its children have added
   *  since last time. Returns the status, or undefined if it is unreadable. */
  drainSteps(follow) {
    let status;
    try {
      status = JSON.parse(readFileSync(join(follow.asyncDir, "status.json"), "utf8"));
    } catch {
      return undefined;
    }
    for (const [index, step] of (status.steps ?? []).entries()) {
      this.pumpStep(follow, index, step);
    }
    return status;
  }

  pump(follow) {
    let status;
    try {
      status = JSON.parse(readFileSync(join(follow.asyncDir, "status.json"), "utf8"));
    } catch {
      // status.json lands a moment after the receipt, and is rewritten in
      // place, so a torn read is normal. The stall watchdog is what stops us
      // waiting on a run that never appears at all.
      this.checkStall(follow);
      return;
    }
    // The wrapper is terminal within a second of starting; the run that
    // matters is the child it launched. Hand the follow over to it as soon
    // as it exists, so terminal means *the work* is done.
    const child = childRunDir(status, follow.asyncDir);
    if (child && child !== follow.asyncDir) {
      this.claimed.add(child);
      follow.asyncDir = child;
      follow.terminalAt = undefined;
      follow.eventsOffset = 0; // a different run's log, read from its start
      this.pump(follow);
      return;
    }
    this.pumpControl(follow);
    for (const [index, step] of (status.steps ?? []).entries()) {
      this.pumpStep(follow, index, step);
    }
    const terminal = statusTerminal(status);
    if (terminal) {
      // The run is marked terminal before its steps' `sessionFile` paths are
      // filled in — a follow that stopped here saw `steps: []` on every tick
      // and published nothing, while the same directory replayed fine
      // minutes later. Hold briefly for the transcript to be named.
      if (follow.terminalAt === undefined) follow.terminalAt = Date.now();
      // Finish once the transcript has gone quiet, not on its first line:
      // the child's tool calls are named before its closing narration, and
      // stopping at the first thing it emitted truncated the report.
      // Two separate races, so two conditions: the transcript may not be
      // named yet (wait for it, up to settleMs), and once it is, its closing
      // narration lands after its tool calls (wait for quiet). Either way the
      // settle cap stops a run from hanging on artifacts that never arrive.
      const quiet = Date.now() - follow.lastAdvance > quietMs;
      if ((follow.emittedAny && quiet) || Date.now() - follow.terminalAt > settleMs) {
        this.finish(follow, terminal);
      }
      return;
    }
    this.checkStall(follow);
  }



  /** Publish anything new on the run's control channel. `events.jsonl` runs
   *  to megabytes, so only the bytes added since last time are read, cut at
   *  the last newline so a half-written row is left for the next tick. */
  pumpControl(follow) {
    const path = join(follow.asyncDir, "events.jsonl");
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      return; // the runner has not opened its log yet
    }
    if (size <= follow.eventsOffset) return;
    let chunk = "";
    let fd;
    try {
      fd = openSync(path, "r");
      const length = size - follow.eventsOffset;
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, follow.eventsOffset);
      const end = buffer.lastIndexOf(0x0a, read - 1);
      if (end < 0) return; // no complete row yet
      chunk = buffer.subarray(0, end + 1).toString("utf8");
      follow.eventsOffset += end + 1;
    } catch {
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    for (const text of controlNotices(chunk)) {
      if (follow.notices.has(text)) continue;
      follow.notices.add(text);
      this.emit({
        type: "notice",
        message: text,
        tone: "warning",
        parentToolUseId: follow.parentToolUseId,
      });
    }
  }

  pumpStep(follow, index, step) {
    const sessionFile = step?.sessionFile;
    if (typeof sessionFile !== "string" || !sessionFile) return;
    let contents = "";
    try {
      contents = readFileSync(sessionFile, "utf8");
    } catch {
      return; // the child session file appears a moment after the step does
    }
    const key = String(step.workflowKey ?? step.childId ?? index);
    // Keyed by file, not by step: a step's sessionFile changes when the run
    // forks the parent's session or retries into run-1, and carrying the old
    // file's message count across meant every message of the new file looked
    // already-published and nothing was ever emitted.
    const seenBefore = follow.files.get(sessionFile) ?? 0;
    const { events, messagesSeen, textIndex } = childSessionEvents(
      contents,
      seenBefore,
      `pi-sub-${follow.parentToolUseId}-${key}`,
      follow.parentToolUseId,
      follow.textIndex,
    );
    if (messagesSeen !== seenBefore) follow.lastAdvance = Date.now();
    if (events.length) follow.emittedAny = true;
    follow.files.set(sessionFile, messagesSeen);
    follow.textIndex = textIndex;
    for (const event of events) {
      if (event.type === "message_update")
        follow.lastFindings = event.assistantMessageEvent.content;
      this.emit(event);
    }
  }

  checkStall(follow) {
    if (Date.now() - follow.lastAdvance < stallMs) return;
    this.finish(follow, "failed");
  }

  /** Close the run out: publish the spawn's real result now that the child's
   *  findings exist, and release anything waiting on the last follow. */
  finish(follow, terminal) {
    if (follow.timer) {
      clearInterval(follow.timer);
      follow.timer = undefined;
    }
    if (!this.follows.delete(follow.parentToolUseId)) return; // already finished
    // The run can be marked terminal in one status write and have its
    // children's session files filled in by another, so a follow that stops
    // the moment it sees `complete` can miss the whole transcript. One last
    // drain makes the end state, not the write ordering, what decides.
    this.follows.set(follow.parentToolUseId, follow);
    this.drainSteps(follow);
    this.follows.delete(follow.parentToolUseId);
    const text = follow.lastFindings || follow.receiptText || "Subagent finished.";
    this.emit({
      type: "tool_execution_end",
      toolCallId: follow.parentToolUseId,
      result: { content: [{ type: "text", text }] },
      isError: terminal !== "done",
    });
    follow.terminal = terminal;
    follow.publishedFindings = text;
    this.recent.push(follow);
    if (this.recent.length > 20) this.recent.shift();
    if (this.size === 0) {
      const idle = this.onIdle;
      this.onIdle = undefined;
      idle?.();
    }
  }

  /**
   * Re-read runs that have already been closed out and publish anything that
   * landed afterwards.
   *
   * A run is marked terminal before its child has finished writing its
   * session file, and no fixed wait is reliable against that — the closing
   * report showed up in some runs and not others. Calling this once the
   * parent turn settles, when the child is certainly done, is what makes the
   * transcript complete rather than merely usually complete.
   */
  reconcile() {
    for (const follow of this.recent) {
      this.drainSteps(follow);
      const text = follow.lastFindings || follow.receiptText;
      if (!text || text === follow.publishedFindings) continue;
      follow.publishedFindings = text;
      this.emit({
        type: "tool_execution_end",
        toolCallId: follow.parentToolUseId,
        result: { content: [{ type: "text", text }] },
        isError: follow.terminal !== "done",
      });
    }
  }

  /** Resolves once no run is being followed. */
  drained() {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.onIdle = resolve;
    });
  }

  stopAll() {
    this.recent = [];
    this.pending = [];
    if (this.discovery) {
      clearInterval(this.discovery);
      this.discovery = undefined;
    }
    for (const follow of [...this.follows.values()]) {
      this.finish(follow, "failed");
    }
  }
}
