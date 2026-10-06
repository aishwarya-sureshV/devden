/**
 * Prosecutor mode: adversarial review with no human in the loop.
 *
 * The tab's own agent is the executor and writes the fix. After each of its
 * turns a second backend -- the prosecutor -- gets a round whose only job is
 * to break that change by writing a failing test. A failing test goes back
 * to the executor; the diff is accepted only when the prosecutor gives up.
 *
 * The case record is also written to SQLite (prosecutor-store.js), keyed by
 * the session file path, so a restart can offer an explicit resume. Nothing
 * restarts by itself, and no files are restored or discarded.
 *
 * What the prompts ask, the server checks (prosecutor-checks.js): the
 * executor must leave the prosecutor's tests alone, the prosecutor may only
 * touch test files, and an acquittal is accepted only once the workspace's
 * own acceptance gate passes.
 */
import { randomUUID } from "node:crypto";
import { agentIsAlive } from "./agent-methods.js";
import { assistantText } from "./pi-agent.js";
import { interruptCase } from "./prosecutor-store.js";
import { changedSince, takeSnapshot } from "./snapshots.js";
import {
  checkIntegrity,
  describeFlags,
  gateReport,
  gateSummary,
  normalizeConfig,
  parseFindings,
  parseObjections,
  prosecutorChanges,
  reportedTestFiles,
  revertChanges,
  runGate,
} from "./prosecutor-checks.js";

/** Rounds per user prompt before the loop stops and hands back to the user. */
export const MAX_ROUNDS = 5;
const ROUND_TIMEOUT_MS = 20 * 60_000;
/** Round 1 is the broad search; later rounds mostly check fixes. */
const FIRST_ROUND_EFFORT = "high";
const LATER_ROUND_EFFORT = "medium";
/** Effort levels a user may pin for the prosecutor (pi's thinking levels). */
export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh"];
/** Both sides back every test or typecheck claim with the runner's output. */
const PROOF_RULE = `Proof, not claims: whenever you report a test or typecheck result, paste the command and the runner's real output verbatim -- its final summary lines (pass/fail counts) and every failure block. A result reported without its output does not count.`;

/**
 * Read the prosecutor's final reply. "guilty" = it wrote a test that fails,
 * "acquitted" = it gave up, null = no usable verdict (the loop stops).
 */
export function parseVerdict(text) {
  // Last verdict line wins: the reasoning above it may quote the other one.
  // Lenient on the separator and markup ("Verdict - **Not guilty**").
  const matches = [
    ...String(text ?? "").matchAll(/VERDICT\**\s*[:=\-–—]?\s*\**\s*(NOT[ -]GUILTY|GUILTY|ACQUITTED)\b/gi),
  ];
  const last = matches.at(-1)?.[1]?.toLowerCase();
  if (last === "guilty") return "guilty";
  return last ? "acquitted" : null;
}

const VERDICT_FOLLOWUP = `Your report did not end with a verdict line I could read. Reply with exactly one line: VERDICT: GUILTY if any of your tests still fails legitimately, otherwise VERDICT: ACQUITTED.`;

/** Asked of the prosecutor every round: lets the server track each finding. */
const FINDINGS_RULE = `For each failing test also write one line: FINDING F<n> | requirement: "<the task words it enforces>" | test: <file:line> <test name> | command: <command that runs it>. Keep a finding's ID across rounds. Only add or edit test files: the server reverts any other file you change and voids the round.`;

// Both sides judge against the task as written: the prosecutor once chased
// unstated requirements (sub-ms precision, 309-digit inputs) for every round,
// and the executor caved to each one, so neither side ever settled.
const SCOPE_RULES = `What counts as a bug -- the task as written (plus any standing requirements from earlier turns) is the only spec:
- Each test must check behavior the task states, or that any reasonable reading of it requires (an input form it lists, an error case it names).
- Always in scope, even when the task never mentions them: SECURITY issues (injection, path traversal, leaked secrets, missing auth or permission checks, unsafe parsing of untrusted input) and PERFORMANCE problems a real user would hit (work that grows badly on ordinary input sizes, a call that hangs or blocks, memory that grows without bound). Test performance with a generous bound, not a tight timing.
- Unusual or edge inputs are in scope when the requirements support them -- an empty value where the task accepts values, a boundary its stated range includes.
- Not a bug: precision beyond what the task implies, pathological or absurdly large inputs, style, or your own preference about what the task "should" have said.
- But a plain input that comes back visibly wrong IS a bug, whatever the cause -- including floating-point error (a value like x.9999999 where the caller expects a whole number, or a round trip that drifts by a unit). Use ordinary inputs a user would type, not just the ones the task happens to list.
- Never contradict a test you or the executor already accepted.
- Go after obvious bugs a real user of this change would hit: a listed input that gives the wrong answer, a named error case that does not error. Skip one-in-ten-thousand corner cases that need contrived input to trigger: if you have to build an input on purpose to cause trouble (hundreds of digits, exotic unicode, values at the edge of the number range), it is not realistic.
- If every failure you can find needs a requirement you would have to assume, or input nobody would realistically pass, that is an acquittal.`;

// Intake: a prosecutor armed mid-session (or restarted) has never seen the
// turns before this one, and turn 10 may only make sense given turns 1-9.
// It gets each earlier turn as the user's words plus the executor's final
// reply -- no tool calls or reasoning, so it stays small and the defendant's
// justifications stay out of the prosecutor's head.
// ponytail: fixed caps, a token budget if long sessions blow the prompt.
const HISTORY_TURNS = 20;
const PROMPT_CHARS = 2000;
const REPLY_CHARS = 1500;
const DEFENSE_OPENER = "The prosecutor wrote failing tests against your change.";
const CASE_PROMPT_CHARS = 1500;
const CASE_REPORT_CHARS = 6000;
const CASE_REPLY_CHARS = 3000;
// Round 1's prompt verbatim would re-issue its risk-map orders to a successor.
const ROUND_ONE_SUMMARY = "(round 1 brief: map the risks of the change against the task, then write and run a battery of tests)";

const clip = (text, max) =>
  text.length > max ? `${text.slice(0, max)} ...[truncated]` : text;

/** Earlier turns of the executor's session, oldest first, minus this task's. */
export function sessionHistory(messages, task) {
  const turns = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = assistantText(message);
    if (message?.role === "user" && text)
      // Defense prompts are ours, not the user's: keep their replies out too.
      turns.push({ prompt: text, reply: "", ours: text.startsWith(DEFENSE_OPENER) });
    else if (message?.role === "assistant" && text && turns.length)
      turns.at(-1).reply = text;
  }
  const real = turns.filter((turn) => !turn.ours);
  const at = real.findLastIndex((turn) => turn.prompt === task.trim());
  return (at >= 0 ? real.slice(0, at) : real.slice(0, -1)).slice(-HISTORY_TURNS);
}

export function historyBrief(turns) {
  if (!turns.length) return "";
  const body = turns
    .map(
      (turn, i) =>
        `### Turn ${i + 1}\nUser: ${clip(turn.prompt, PROMPT_CHARS)}\nExecutor: ${clip(turn.reply, REPLY_CHARS) || "(no reply)"}`,
    )
    .join("\n\n");
  return `You are joining this session mid-way. Earlier turns, oldest first -- the user's words, then the executor's final reply:

${body}

How to use this: the user's words are standing requirements, and a later turn overrides an earlier one. The executor's replies are claims about what it did, not requirements -- a decision counts only if the user stated or accepted it. Before testing, write yourself a short "Standing requirements" list from these turns. A change that breaks one of them is a bug (a regression), judged by the same rules as the task.

`;
}

/**
 * What the executor changed, computed by the server: round 1 against the tree
 * before this turn, later rounds against the end of the previous round. Both
 * sides start from this list instead of re-exploring the repository.
 */
export function changeNote(changes, commit, round) {
  if (changes == null || !commit) return "";
  const when = round > 1 ? "since your last round" : "in this turn";
  // Round 1's baseline is taken without blocking the turn, so an empty list
  // there may only mean the executor wrote first: let the prosecutor look.
  // Later baselines are awaited before the executor is prompted.
  if (!changes.trim())
    return round > 1 ? `The executor changed no files ${when}.\n\n` : "";
  const lines = changes.split("\n");
  const shown = lines.slice(0, 80).join("\n");
  const more = lines.length > 80 ? `\n...and ${lines.length - 80} more` : "";
  return `Files the executor changed ${when} (M modified, A added, D deleted):

${shown}${more}

Start from these -- \`git diff ${commit} -- <file>\` for a modified file, the whole file for an added one -- so you don't spend time rediscovering them. Read anything else in the repository you need.

`;
}

/**
 * Prepended to a brief after a restart. The agent rechecks instead of
 * repeating work a killed command may have half-finished.
 */
export function recoveryBrief(changes) {
  const lead =
    "This review was interrupted by a server restart and is resuming only because you asked. Recheck the files and re-run the tests before repeating an edit. Never assume a command that was in progress finished. It may have been cut off.";
  if (typeof changes === "string" && changes.trim())
    return `${lead}\n\nFiles changed since the last checkpoint:\n${changes}\n\n`;
  if (changes === "")
    return `${lead}\n\nThe workspace matches the last checkpoint.\n\n`;
  return `${lead}\n\n`;
}

/**
 * The case so far, from the case record rather than any process: every
 * earlier round's prompt and report, whoever ran it. A prosecutor switched
 * in mid-case (a usage limit on the old model, or the user's choice) reads
 * this instead of starting the case over.
 */
export function caseBrief(log, round) {
  if (!log?.length) return "";
  const body = log
    .map(
      (entry) =>
        `### Round ${entry.round} (${entry.by})${entry.died ? ` -- died: ${clip(entry.died, 300)}` : ""}\nPrompt:\n${entry.round === 1 ? ROUND_ONE_SUMMARY : clip(entry.prompt, CASE_PROMPT_CHARS)}\n\nReport${entry.died ? " (partial)" : ""}:\n${clip(entry.report || "(none)", CASE_REPORT_CHARS)}${entry.reply ? `\n\nExecutor's reply:\n${clip(entry.reply, CASE_REPLY_CHARS)}` : ""}`,
    )
    .join("\n\n");
  return `You are taking over as the PROSECUTOR of a case already in progress -- this is round ${round}. Earlier rounds were run by other prosecutor models; their prompts and reports are YOUR history now:
- every test file they wrote is YOUR test: re-run it, do not rewrite it;
- OBJECTION rulings already made stand;
- a round marked "died" stopped mid-way and may have left test files behind -- finish or reuse them;
- do not start the case over with a new risk map.

${body}

`;
}

/** The same record from the executor's side, for one switched in mid-case. */
export function executorBrief(log) {
  const done = (log ?? []).filter((entry) => !entry.died && entry.report);
  if (!done.length) return "";
  const body = done
    .map(
      (entry) =>
        `### Round ${entry.round} -- prosecutor (${entry.by}) reported:\n${clip(entry.report, CASE_REPORT_CHARS)}${entry.reply ? `\n\nExecutor (${entry.replyBy || "executor"}) answered:\n${clip(entry.reply, CASE_REPLY_CHARS)}` : ""}`,
    )
    .join("\n\n");
  return `Prosecutor-mode case record so far (earlier rounds, possibly answered by other executor models -- treat their fixes and OBJECTIONs as yours):

${body}

---

`;
}

export function prosecutionPrompt(task, round, defense, brief = "", changes = "") {
  if (round > 1)
    return `${brief}Round ${round}. The task as written is still:

"""
${task}
"""

The executor answered your failing tests:

"""
${defense || "(no reply text)"}
"""

${changes}1. Re-run your own test files. You wrote them, so there is usually no need to re-read them. Typecheck and the rest of the suite are the executor's job, and its reply must paste their real output; re-run any of them whenever that output is missing, shows a failure, or you have reason to doubt it. A test that now passes is settled.
2. For each test the executor raised an OBJECTION to, weigh it against the task text alone: if the objection holds, delete that test and never re-file it or a variant of it; if it does not hold, keep the test and say which words of the task require it.
3. Hunt again, starting from the files listed above: write new tests for realistic risks you have not covered yet -- especially behavior the executor's fixes could have broken. Same rules as before:

${SCOPE_RULES}

List EVERY test that still fails legitimately (the task words it enforces, the test as file:line plus its name, its failure output).

${FINDINGS_RULE}

${PROOF_RULE}

End with VERDICT: GUILTY if any stands, otherwise VERDICT: ACQUITTED.`;
  return `You are the PROSECUTOR in an adversarial code review. Another agent just changed this repository to do this task:

"""
${task}
"""

${brief}${changes}Your job is to break that change as thoroughly as you can. Read the change (start from the file list above when there is one; otherwise git diff, git status and any new untracked files) and anything else in the repository you need.

Then, BEFORE writing any test, write a risk map: for every requirement in the task (and every standing requirement), list each realistic way it could break --
- a listed input or action giving the wrong result, or a named error case not handled;
- a dependency failing (network, CLI, disk, a fetch or save that errors or times out);
- timing: two actions racing, replies arriving out of order, a stale value shown as fresh;
- repetition: doing it twice, cancel then retry, undo then redo;
- state left behind, and interactions with behavior that already existed.
Only then write a battery of automated tests in the project's existing test setup covering every realistic item on the map -- one test per distinct risk, no near-duplicates. Do not stop at the first failure. Run them all.

${SCOPE_RULES}

Rules:
- Only add or edit test files. Never touch the code under test.
- A test must fail because the change is wrong, not because the test is broken.
- Show the risk map in your report, marking each item tested -> passed or failed (or skipped, with why).
- ${PROOF_RULE}
- ${FINDINGS_RULE}
- If any test fails legitimately: list EVERY failing test -- the words of the task it enforces, the test as file:line plus its name, and its failure output -- plus the command to run them, then end with the line: VERDICT: GUILTY
- If every test passes, end with the line: VERDICT: ACQUITTED`;
}

// Later rounds' bugs were mostly side effects of the previous fix (a toggle
// accumulating state), so each fix gets checked against the state's readers.
export const SIDE_EFFECT_RULE =
  "For each fix, list what else reads or writes the state you changed (callers, other handlers, persisted or toggled values) and check each one still behaves before replying; put that list under the fix in your ruling.";

export function defensePrompt(task, report) {
  return `${DEFENSE_OPENER} Your task was:

"""
${task}
"""

The prosecutor's report:

${report}

Each failing test is given as file:line, so you can go straight to it instead of reading the whole test file; read anything else in the repository you need. The failure output is already in the report, so there is no need to re-run the tests before fixing.

Before touching any code, rule on each failing test separately: does it check something the task as written requires? A test is OUT of scope if it demands behavior the task never stated (extra precision, absurd or contrived inputs, a preference), or contradicts a test already accepted.

- In scope: fix the code so the test passes and keep the rest of the suite green. Do not edit or delete the test. Fix every in-scope test in this turn.
- Out of scope: do NOT change the code to satisfy it -- bending the code to an unstated requirement is scope creep, not diligence. Leave the test file alone (the prosecutor owns it) and write a line "OBJECTION: <test name> -- <the task text showing why it is out of scope>".

${SIDE_EFFECT_RULE}

After fixing, run once: the prosecutor's test files, the tests for the files you touched, and the typecheck. ${PROOF_RULE} The prosecutor relies on this output instead of re-running them.

End with a ruling list: each failing test's name, then FIXED or OBJECTION. Push back whenever a test is out of scope; agreeing just to end the review is a failure.`;
}

// The prosecutor's work, mirrored into the executor's timeline as the nested
// run of one `prosecutor` tool card per round (SubagentCard/SubagentPanel
// render it). Lifecycle events (agent_start/end, state, turn_result) stay
// out: they would flip the executor's own status and bill its usage.
const FORWARDED = new Set([
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

export function forwardedEvent(event, cardId, seq) {
  if (!FORWARDED.has(event?.type)) return null;
  const tagged = { ...event, parentToolUseId: event.parentToolUseId ?? cardId };
  if (event.type !== "message_update" && event.type !== "message_end")
    return tagged;
  // Text blocks are keyed by streamKey (else the turn counter), which would
  // land the prosecutor's words on the executor's own last reply.
  tagged.streamKey = `${cardId}-${event.streamKey ?? seq.n}`;
  if (event.type === "message_end") {
    if (event.message?.role === "assistant") seq.n += 1;
    // Its tokens are not the executor's context or spend.
    tagged.message = { ...event.message, usage: undefined };
  }
  return tagged;
}

/**
 * Why a turn died, or "" if it finished: pi marks stopReason "error", codex
 * "failed" with errorMessage (rate/usage limits, auth, crashes).
 */
export function turnError(message) {
  if (message?.errorMessage) return String(message.errorMessage);
  return message?.stopReason === "error" || message?.stopReason === "failed"
    ? "the turn failed"
    : "";
}

/** Send one prompt and resolve with the turn's final assistant text. */
function runTurn(agent, message, onEvent) {
  return new Promise((resolve, reject) => {
    let last = "";
    let failed = "";
    const finish = (fn) => {
      clearTimeout(timer);
      unsubscribe();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("prosecutor round timed out"))),
      ROUND_TIMEOUT_MS,
    );
    timer.unref?.();
    // Listen before prompting so a fast turn cannot end unseen. Event shapes
    // match every backend's completion event: message_end (pi/Claude/Grok),
    // turn_end (Codex).
    const unsubscribe = agent.onEvent((event) => {
      onEvent(event);
      if (
        (event?.type === "message_end" || event?.type === "turn_end") &&
        event.message?.role === "assistant"
      ) {
        last = assistantText(event.message) || last;
        failed = turnError(event.message);
      }
      // A prosecutor that ran out of quota mid-round is a failed round, not
      // "no verdict" -- say why.
      if (event?.type === "agent_end" || event?.type === "agent_settled")
        finish(() =>
          failed ? reject(Object.assign(new Error(failed), { partial: last })) : resolve(last),
        );
    });
    Promise.resolve(agent.prompt(message))
      .then((result) => {
        if (result && result.ok === false)
          finish(() => reject(new Error(result.error ?? "prompt failed")));
      })
      .catch((error) => finish(() => reject(error)));
  });
}

const INTEGRITY_NOTE = `Your last repair edited or deleted the prosecutor's test files. Those tests are the prosecutor's: restore them exactly as they were (\`git diff\` shows what you changed), then answer the report below again -- fix the code, or raise an OBJECTION.

`;

/** `configFor(cwd)` is the user's gate config for a workspace (optional). */
export function createProsecutor({ poolFor, publish, store = null, sessionInfo = null, configFor = () => null }) {
  /**
   * executor sessionKey -> the case: { backend, model, effort, task, defense,
   * round, busy, base, failed, paused, log, resuming }. `log` is the record
   * of every round (prompt, report, executor reply) whoever ran it -- the
   * source of truth a switched-in model is briefed from, since the process
   * that ran a round may be dead. `paused` = { side, reason, round } when a
   * turn failed (usage limit, auth, crash): the case waits for a switch or
   * a resume instead of closing. `phase` is the durable next step. The
   * executor handle, busy flag and timers are never written to the store.
   * `status` is what the UI shows: fixing, reviewing, verifying, verified,
   * stopped, inconclusive. `owned` = the prosecutor's test files; `gate` = the
   * acceptance gate, `gate.state` one of verification_pending, verified,
   * gate_failed, not_configured.
   */
  const cases = new Map();
  /** Session file path -> session key. A refreshed tab rebinds the same case. */
  const bySession = new Map();
  /** Session file path -> interrupted case not bound to a tab yet. */
  const restored = new Map();
  const prosecutorKey = (sessionKey) => `${sessionKey}:prosecutor`;
  const notice = (sessionKey, message, tone) =>
    publish(sessionKey, { type: "notice", message, ...(tone ? { tone } : {}) });
  const who = (current) => current.model?.id || current.backend;

  function state(sessionKey, sessionFile = "") {
    adopt(sessionKey, sessionFile);
    const current = cases.get(sessionKey);
    if (!current) return { armed: false };
    const { backend, model, effort, round, paused, status, gate, flags, caseId, verdict } = current;
    // A finding the executor objected to (by ID or test name) shows it.
    const objections = parseObjections(current.log.at(-1)?.reply);
    const findings = (current.findings ?? []).map((finding) => ({
      ...finding,
      objection: objections.find(
        ({ target }) => target.toUpperCase().includes(finding.id) || (finding.test && finding.test.includes(target)),
      )?.reason,
    }));
    return {
      armed: true, backend, model, effort, round, open: Boolean(current.task), paused,
      status: current.task || status !== "fixing" ? status : undefined,
      gate, findings, flags, owned: current.owned, caseId, verdict,
      phase: current.phase || null,
      interrupted: Boolean(current.interrupted),
      changes: current.interrupted ? (current.changes ?? null) : null,
    };
  }
  const announce = (sessionKey) =>
    publish(sessionKey, { type: "prosecutor_state", ...state(sessionKey) });
  const setStatus = (sessionKey, current, status) => {
    current.status = status;
    announce(sessionKey);
  };

  // Tab keys change on refresh. The case object is the identity; the key is
  // wherever that object is bound now.
  function keyOf(owner) {
    if (!owner) return null;
    for (const [key, item] of cases) if (item === owner) return key;
    return null;
  }

  function bind(sessionKey, current) {
    const previousKey = current.sessionId ? bySession.get(current.sessionId) : undefined;
    if (previousKey && previousKey !== sessionKey && cases.get(previousKey) === current)
      cases.delete(previousKey);
    cases.set(sessionKey, current);
    if (current.sessionId) {
      bySession.set(current.sessionId, sessionKey);
      restored.delete(current.sessionId);
    }
  }

  // True when the row was written. False when this write was refused, so a
  // dispatch that depends on it does not run. No store, or no session file
  // yet, is not a failed write.
  function persist(sessionKey, owner = null) {
    if (!store) return true;
    const key = (owner && keyOf(owner)) || sessionKey;
    const current = cases.get(key);
    if (!current?.id || !current.phase) return true;
    if (owner && owner !== current) return false;
    try {
      const info = sessionInfo?.(key) ?? {};
      if (info.sessionId) current.sessionId = info.sessionId;
      if (info.cwd) current.cwd = info.cwd;
      if (info.executorBackend) current.executorBackend = info.executorBackend;
      if (info.executorModel) current.executorModel = info.executorModel;
      if (!current.sessionId) return true;
      const base = current.base;
      if (base && typeof base.then !== "function" && base.commit)
        current.baselineCommit = base.commit;
      store.save(current);
      bind(key, current);
      return true;
    } catch {
      return false;
    }
  }

  function sessionFileOf(sessionKey, sessionFile, executor) {
    let sessionId =
      sessionFile || executor?.sessionFile || executor?.lastState?.sessionFile || "";
    if (!sessionId) {
      try {
        sessionId = sessionInfo?.(sessionKey)?.sessionId || "";
      } catch {
        sessionId = "";
      }
    }
    return sessionId;
  }

  function noteBaseline(sessionKey, current) {
    const base = current.base;
    if (!base || typeof base.then !== "function") {
      if (base?.commit) current.baselineCommit = base.commit;
      return;
    }
    // noteTask must not block on `git add`. The commit lands when it resolves.
    // The tab key may have changed while git ran; the case object is the identity.
    void Promise.resolve(base)
      .then((snap) => {
        const key = keyOf(current);
        if (!key || current.base !== base || !snap?.commit) return;
        current.baselineCommit = snap.commit;
        persist(key, current);
      })
      .catch(() => {});
  }

  function refreshChanges(current) {
    const base = current.base;
    const commit =
      current.baselineCommit ||
      (base && typeof base.then !== "function" ? base.commit : "");
    if (!current.cwd || !commit) {
      current.changes = current.changes ?? null;
      return Promise.resolve(current.changes);
    }
    if (current.changesFlight) return current.changesFlight;
    const flight = changedSince(current.cwd, commit)
      .then((list) => {
        const key = keyOf(current);
        const pending = current.sessionId && restored.get(current.sessionId) === current;
        if (!key && !pending) return list;
        current.changes = list;
        if (key && current.interrupted) announce(key);
        return list;
      })
      .catch(() => null);
    current.changesFlight = flight;
    void flight.finally(() => {
      if (current.changesFlight === flight) current.changesFlight = null;
    });
    return flight;
  }

  // A fresh comparison, not the one cached at startup. Resume awaits this so
  // the brief lists edits made after the server came back, and so a comparison
  // still queued on the scratch index is included instead of skipped.
  function compareWorkspace(current) {
    const base = current.base;
    const commit =
      current.baselineCommit ||
      (base && typeof base.then !== "function" ? base.commit : "");
    if (!current.cwd || !commit) return Promise.resolve(current.changes ?? null);
    return changedSince(current.cwd, commit)
      .then((list) => {
        if (keyOf(current) || (current.sessionId && restored.get(current.sessionId) === current))
          current.changes = list;
        return list;
      })
      .catch(() => null);
  }

  function adopt(sessionKey, sessionFile = "", executor = null) {
    const existing = cases.get(sessionKey);
    // A case already stored on this tab. An armed shell (no id yet) must not
    // hide one keyed by the session file: the file often arrives after the
    // composer re-arms. Learning the file mid-turn still has to bind and
    // save this case -- the file is the durable id.
    if (existing?.id) {
      const sessionId = sessionFileOf(sessionKey, sessionFile, executor);
      const occupant = sessionId ? cases.get(bySession.get(sessionId)) : null;
      if (sessionId && sessionId !== existing.sessionId && (!occupant || occupant === existing)) {
        existing.sessionId = sessionId;
        persist(sessionKey, existing);
      }
      return existing;
    }
    const sessionId = sessionFileOf(sessionKey, sessionFile, executor);
    if (!sessionId) return existing ?? null;
    const liveKey = bySession.get(sessionId);
    const live = liveKey ? cases.get(liveKey) : null;
    if (live) {
      bind(sessionKey, live);
      announce(sessionKey);
      return live;
    }
    let current = restored.get(sessionId) ?? null;
    if (!current && store) {
      try {
        const loaded = store.loadBySession(sessionId);
        current = loaded ? interruptCase(loaded) : null;
      } catch {
        current = null;
      }
      if (current) {
        try {
          store.save(current);
        } catch {
          // Keep the copy in memory; the next save can retry.
        }
      }
    }
    if (!current) return existing ?? null;
    bind(sessionKey, current);
    announce(sessionKey);
    if (current.changes == null) void refreshChanges(current);
    return current;
  }

  async function recover() {
    if (!store) return [];
    let rows = [];
    try {
      rows = store.unfinished();
    } catch {
      return [];
    }
    const loaded = [];
    for (const row of rows) {
      if (!row?.task || !row.sessionId) continue;
      if ([...cases.values()].some((item) => item.id === row.id)) continue;
      if (restored.has(row.sessionId)) continue;
      const current = interruptCase(row);
      if (!current) continue;
      try {
        store.save(current);
      } catch {
        // Still offer the in-memory copy; the next save can retry.
      }
      restored.set(current.sessionId, current);
      loaded.push(current);
    }
    await Promise.all(loaded.map((current) => refreshChanges(current)));
    return loaded.map((current) => {
      const key = bySession.get(current.sessionId);
      return (key && cases.get(key)) || restored.get(current.sessionId) || current;
    });
  }

  function pause(sessionKey, current, side, reason, note = "") {
    current.status = "stopped";
    current.paused = { side, reason: clip(reason, 300), round: current.round + (side === "prosecutor" ? 1 : 0), ...(note ? { note } : {}) };
    current.phase = "paused";
    current.interrupted = false;
    const name = side === "executor" ? "executor" : `prosecutor (${who(current)})`;
    const where =
      current.round === 0 && side === "executor"
        ? "before round 1"
        : side === "executor"
          ? `answering round ${current.round}`
          : `in round ${current.paused.round}`;
    notice(
      sessionKey,
      `The ${name} turn failed ${where} (${current.paused.reason}). Case paused, not closed: switch the ${side} model or effort and press Resume -- or Resume as-is once the limit resets. A new message starts a new case.`,
      "warning",
    );
    announce(sessionKey);
    persist(sessionKey, current);
  }

  function disarm(sessionKey) {
    const current = cases.get(sessionKey);
    if (!current) return;
    // The row stays unfinished: closing the tab is not a verdict. A later
    // open, or a restart, offers resume. A new user task stops the old case.
    cases.delete(sessionKey);
    if (current.sessionId && bySession.get(current.sessionId) === sessionKey)
      bySession.delete(current.sessionId);
    poolFor(current.backend).stop(prosecutorKey(sessionKey));
  }

  /**
   * Pick the prosecutor. Changing it mid-case keeps the case -- round, task,
   * baselines, the round log -- so the next round continues where it was;
   * only the process changes (a new model can't reuse the old one's).
   * Changing only the effort keeps the process and its memory too.
   */
  function arm(sessionKey, { backend, model, effort = null, sessionFile = "" }) {
    const before = cases.get(sessionKey);
    adopt(sessionKey, sessionFile);
    const current = cases.get(sessionKey);
    // A tab attaching to a stored case arms with its own last pick; that is
    // not a choice to switch this case's prosecutor. Only a later pick is.
    if (current?.id && current !== before) return;
    const same =
      current &&
      current.backend === backend &&
      current.model?.provider === model?.provider &&
      current.model?.id === model?.id;
    if (same) {
      if (current.effort !== effort) {
        current.effort = effort;
        announce(sessionKey);
        persist(sessionKey, current);
      }
      return;
    }
    if (!current) {
      cases.set(sessionKey, {
        backend, model, effort, task: "", defense: "", round: 0, busy: false,
        base: null, failed: "", paused: null, log: [], resuming: "", phase: "",
        status: "fixing", owned: [], findings: [], flags: [], gate: null, cwd: "",
        caseId: 0, verdict: null,
      });
      return;
    }
    poolFor(current.backend).stop(prosecutorKey(sessionKey));
    // Same object: the case (its id, repair in flight, pending resume) is
    // unchanged; only the reviewer is. A round still running on the old
    // prosecutor sees `reviewer` moved, drops its verdict, and re-runs here.
    const wasBusy = current.busy;
    Object.assign(current, {
      backend,
      model,
      effort,
      busy: false,
      round: wasBusy ? current.round - 1 : current.round,
      reviewer: (current.reviewer ?? 0) + 1,
    });
    announce(sessionKey);
    persist(sessionKey, current);
    if (wasBusy && current.task && !current.paused) void runRound(sessionKey, current.executor);
  }

  /** A user prompt opens a new case: the task the diff is judged against. */
  function noteTask(sessionKey, message, snapshot) {
    const current = cases.get(sessionKey);
    if (!current || !message.trim()) return;
    // The resume prompt we handed the client (maybe behind a backend-switch
    // handoff) continues the paused case; it is not a new task.
    if (current.resuming && message.includes(current.resuming)) {
      current.resuming = "";
      current.resumeFlight = null;
      current.interrupted = false;
      current.paused = null;
      current.phase = current.round > 0 ? "repair_running" : "executor_running";
      persist(sessionKey, current);
      announce(sessionKey);
      return;
    }
    if (current.id && current.phase && current.phase !== "stopped" && current.phase !== "accepted") {
      current.phase = "stopped";
      current.busy = false;
      persist(sessionKey, current);
    }
    // A new object. A review still running holds the old one and drops its
    // verdict, so an acquittal cannot accept this task.
    const next = {
      backend: current.backend,
      model: current.model,
      effort: current.effort,
      sessionId: current.sessionId,
      cwd: current.cwd,
      executorBackend: current.executorBackend,
      executorModel: current.executorModel,
      id: randomUUID(),
      task: message,
      // The tree before this turn: round 1's "what changed" baseline.
      // It may still be a Promise; the commit is saved when that resolves.
      base: snapshot ?? null,
      baselineCommit: null,
      round: 0,
      defense: "",
      lastReport: "",
      log: [],
      paused: null,
      resuming: "",
      busy: false,
      failed: "",
      interrupted: false,
      recoveryNote: "",
      changes: null,
      phase: "executor_running",
      status: "fixing",
      owned: [],
      findings: [],
      flags: [],
      gate: null,
      gateNote: "",
      // Clients key the round-1 effort floor and the lower-effort nudge on it.
      caseId: (current.caseId ?? 0) + 1,
      verdict: null,
      extra: {},
    };
    cases.set(sessionKey, next);
    if (next.sessionId) bySession.set(next.sessionId, sessionKey);
    noteBaseline(sessionKey, next);
    persist(sessionKey, next);
    // Clients key the round-1 effort floor and the nudge on the new caseId.
    announce(sessionKey);
  }

  /**
   * Continue a paused case on whatever is armed now. Prosecutor side: re-run
   * the round that died. Executor side: hand back the prompt to send it (the
   * client sends it, so a switched backend starts and gets its transcript
   * handoff the usual way) -- the defense it failed on, or the task itself
   * if it failed before round 1, behind the case record.
   */
  function caseLive(current) {
    return Boolean(current) && keyOf(current) != null && current.phase !== "stopped" && current.phase !== "accepted";
  }

  function resume(sessionKey, executor, sessionFile = "") {
    adopt(sessionKey, sessionFile, executor);
    const current = cases.get(sessionKey);
    // A comparison already in flight belongs to this resume. A retry must
    // wait for it, not take the brief from before the diff finished.
    if (current?.resumeFlight) return current.resumeFlight;
    // The repair prompt is handed to the client. Until that prompt comes
    // back through noteTask, the repair has not been dispatched, and a lost
    // send must be able to ask for the same prompt again.
    if (!current?.paused) {
      if (current?.resuming) return { ok: true, side: "executor", prompt: current.resuming };
      return { ok: false, error: "no paused case" };
    }
    // An integrity pause carries a note that goes in front of the repair.
    const { side, note: pausedNote = "" } = current.paused;
    const wasInterrupted = Boolean(current.interrupted);
    if (side === "prosecutor") {
      // The stored rounds are the case. A live executor is optional: its
      // transcript is a shortcut, and after a restart the handle is gone.
      // Paused is cleared now so a second resume does not start a second review.
      current.interrupted = false;
      current.paused = null;
      current.phase = "review_pending";
      current.status = "reviewing";
      persist(sessionKey, current);
      announce(sessionKey);
      const begin = (changes) => {
        // Adoption may have moved the case to a new tab key while the diff ran.
        const key = keyOf(current);
        if (!key || !caseLive(current) || current.busy || current.phase !== "review_pending") return;
        current.recoveryNote = wasInterrupted ? recoveryBrief(changes) : "";
        void runRound(key, executor);
      };
      if (!wasInterrupted) {
        begin(null);
        return { ok: true, side };
      }
      // Edits made after startup replace a cached "workspace matches".
      const promise = compareWorkspace(current).then((list) => {
        begin(list ?? current.changes);
        return caseLive(current)
          ? { ok: true, side }
          : { ok: false, error: "case stopped" };
      });
      return Object.assign(promise, { ok: true, side });
    }
    const compose = (changes) => {
      const note = wasInterrupted ? recoveryBrief(changes) : "";
      const last = current.log.findLast((entry) => !entry.died);
      return (
        (note || "") +
        (current.round > 0 && last
          ? `${executorBrief(current.log.filter((entry) => entry !== last))}${pausedNote}${defensePrompt(current.task, last.report)}`
          : current.task)
      );
    };
    const prompt = compose(current.changes);
    current.failed = "";
    current.resuming = prompt;
    // Next step, saved before the client dispatches the executor.
    // Interrupted and paused stay set until noteTask sees the prompt, so a
    // send that never arrives still offers Resume review.
    current.phase = current.round > 0 ? "repair_pending" : "executor_running";
    current.status = "fixing";
    persist(sessionKey, current);
    announce(sessionKey);
    // Edits made after startup, and a comparison still running, belong in
    // the brief. Callers that read the prompt now get the checkpoint already
    // in hand; awaiting the return value waits for the fresh comparison.
    const flight = wasInterrupted ? compareWorkspace(current) : null;
    if (!flight) return { ok: true, side, prompt };
    const promise = flight.then((list) => {
      if (current.resumeFlight === promise) current.resumeFlight = null;
      // A new task stopped this case while the diff was running.
      if (!caseLive(current)) return { ok: false, error: "case stopped" };
      const fresh = compose(list ?? current.changes);
      current.resuming = fresh;
      return { ok: true, side, prompt: fresh };
    });
    current.resumeFlight = promise;
    return Object.assign(promise, { ok: true, side, prompt });
  }

  async function runRound(sessionKey, executor) {
    const current = cases.get(sessionKey);
    if (!current) return;
    let key = sessionKey;
    const reviewer = current.reviewer ?? 0;
    // The case is gone when a new task replaced the object (it may only have
    // moved to a new tab key). The round is stale when the case is gone or
    // its prosecutor was switched: the verdict is dropped, but a repair this
    // round dispatched still belongs to the case.
    const gone = () => {
      const found = keyOf(current);
      if (!found) return true;
      key = found;
      return false;
    };
    const replaced = () => gone() || (current.reviewer ?? 0) !== reviewer;
    if (executor?.cwd) current.cwd = executor.cwd;
    const sessionFile = executor?.sessionFile || executor?.lastState?.sessionFile;
    if (sessionFile) current.sessionId = sessionFile;
    // Next step before the review is dispatched. The round is not incremented
    // yet, so a crash here re-runs this review at the same number. A refused
    // write is not dispatched.
    current.phase = "review_pending";
    if (!persist(sessionKey, current)) {
      if (!replaced()) pause(key, current, "prosecutor", "could not save the review");
      return;
    }
    current.busy = true;
    current.round += 1;
    current.executor = executor;
    const recovery = current.recoveryNote || "";
    current.recoveryNote = "";
    const by = who(current);
    const cardId = `prosecutor-${Date.now()}`;
    const agent = poolFor(current.backend).get(prosecutorKey(sessionKey));
    // After a restart there is no executor handle; the stored cwd stands in.
    const cwd = executor?.cwd ?? executor?.lastState?.cwd ?? current.cwd ?? process.cwd();
    current.cwd = cwd;
    // Cases saved before the hardening fields existed lack them.
    current.owned ??= [];
    current.flags ??= [];
    const config = normalizeConfig(configFor(cwd));
    const base = await Promise.resolve(current.base).catch(() => null);
    // Test integrity: the repair that just ended must leave the prosecutor's
    // tests exactly as the round-end snapshot has them.
    if (current.round > 1 && base?.ok && current.owned.length) {
      const flags = await checkIntegrity(cwd, base.commit, current.owned).catch(() => null);
      if (replaced()) return;
      if (flags == null)
        notice(key, "Could not check the prosecutor's test files for edits (git failed); continuing unchecked.", "warning");
      if (flags?.length) {
        const text = describeFlags(flags);
        current.flags.push({ round: current.round - 1, side: "executor", text });
        current.round -= 1;
        current.busy = false;
        pause(key, current, "executor", `its repair changed the prosecutor's tests: ${text}`, INTEGRITY_NOTE);
        return;
      }
    }
    setStatus(key, current, "reviewing");
    // A fresh prosecutor process knows nothing of this session: brief it --
    // the session's earlier turns, plus this case's rounds so far.
    const fresh = !agentIsAlive(agent);
    const brief = fresh
      ? historyBrief(
          sessionHistory(
            await Promise.resolve(executor?.getMessages?.()).catch(() => []),
            current.task,
          ),
        ) + caseBrief(current.log, current.round)
      : "";
    const recoveredBrief = `${recovery}${brief}`;
    const changes = base?.ok
      ? await changedSince(cwd, base.commit).catch(() => null)
      : null;
    const note = `${current.gateNote || ""}${changeNote(changes, base?.commit, current.round)}`;
    current.gateNote = "";
    const prompt = prosecutionPrompt(current.task, current.round, current.defense, recoveredBrief, note);
    // The log keeps the round's own prompt, not the brief: a brief recorded
    // in it would nest inside every later successor's brief.
    const logged = recoveredBrief
      ? prosecutionPrompt(current.task, current.round, current.defense, "", note)
      : prompt;
    // The user's pick wins; otherwise round 1 searches broadly, later
    // rounds (on any prosecutor) mostly check fixes.
    const effort =
      current.effort ?? (current.round === 1 ? FIRST_ROUND_EFFORT : LATER_ROUND_EFFORT);
    // The edit boundary's "before": everything the round changes is the prosecutor's.
    const before = await takeSnapshot(
      cwd,
      `prosecutor round ${current.round} start`,
      prosecutorKey(sessionKey),
    ).catch(() => null);
    publish(key, {
      type: "tool_execution_start",
      toolCallId: cardId,
      toolName: "prosecutor",
      args: {
        description: `Round ${current.round}: try to break the change`,
        subagent_type: by,
        effort,
        prompt,
      },
    });
    let outcome = { text: "Round failed", isError: true };
    const seq = { n: 0 };
    const forward = (event) => {
      const forwarded = forwardedEvent(event, cardId, seq);
      if (forwarded) publish(key, forwarded);
    };
    // A finished case: `phase` is the durable record, `status` what the UI shows.
    const close = (status, phase, message, tone) => {
      current.phase = phase;
      current.status = status;
      persist(key, current);
      notice(key, message, tone);
      current.task = "";
      announce(key);
    };
    try {
      if (fresh) {
        const started = await agent.start(cwd, {
          accessMode: "workspace-write",
          agentMode: "standard",
          model: current.model ?? undefined,
        });
        if (started && started.ok === false)
          throw new Error(started.error ?? "could not start the prosecutor");
      }
      // Best effort: a backend that rejects the level keeps its own.
      await Promise.resolve(agent.setThinkingLevel?.(effort)).catch(() => {});
      const turn = runTurn(agent, prompt, forward);
      // prompt() has been issued. A crash now means this round was running
      // and has not counted.
      if (!replaced()) {
        current.phase = "review_running";
        persist(key, current);
      }
      let report = await turn;
      // Disarmed or re-armed with another prosecutor mid-round: drop it.
      if (replaced()) {
        outcome = { text: "Prosecutor changed mid-round; verdict dropped", isError: false };
        return;
      }
      // Edit boundary: its test files become its own; anything else it
      // touched is reverted and the round is void (re-run on resume).
      const split = before?.ok
        ? await prosecutorChanges(cwd, before.commit, config.testPatterns).catch(() => null)
        : null;
      const owned = new Set(current.owned);
      for (const change of split?.tests ?? [])
        change.status === "D" ? owned.delete(change.path) : owned.add(change.path);
      for (const path of reportedTestFiles(report, config.testPatterns)) owned.add(path);
      current.owned = [...owned];
      if (split?.breach.length) {
        const reverted = await revertChanges(cwd, before.commit, split.breach).catch(() => false);
        const files = split.breach.map((change) => `${change.status} ${change.path}`).join(", ");
        const reason = `the prosecutor edited files outside the test patterns (${files}) -- ${reverted ? "reverted, round void" : "could NOT revert them, check by hand"}`;
        current.flags.push({ round: current.round, side: "prosecutor", text: reason });
        throw Object.assign(new Error(reason), { partial: report });
      }
      const findings = parseFindings(report);
      let verdict = parseVerdict(report);
      // A formatting slip is not a stop: structured findings mean guilty,
      // otherwise ask once for the verdict line.
      if (!verdict && /^[\s>*_-]*FINDING\b/im.test(report)) verdict = "guilty";
      if (!verdict) {
        const again = await runTurn(agent, VERDICT_FOLLOWUP, forward).catch(() => "");
        if (replaced()) return;
        verdict = parseVerdict(again);
        if (verdict) report = `${report}\n\n${again}`;
      }
      current.log.push({ round: current.round, by, prompt: logged, report, findings });
      current.lastReport = report;
      current.verdict = verdict;
      // The round has counted: a prosecutor switched in from here on judges
      // the repair, it does not re-run this round.
      current.busy = false;
      outcome =
        verdict === "guilty"
          ? { text: "Guilty: failing test sent back to the executor", isError: true }
          : verdict === "acquitted"
            ? { text: "Acquitted: could not break the change", isError: false }
            : { text: "No verdict", isError: true };
      const rounds = `${current.round} round${current.round === 1 ? "" : "s"}`;
      if (verdict === "acquitted") {
        // Acceptance gate: the server runs the user's own commands; an
        // acquittal alone is not an accepted diff. A restart while it runs
        // re-runs the acquitting round (prosecutor-store interruptCase).
        current.findings = [];
        current.gate = { state: "verification_pending", round: current.round };
        current.phase = "verification_pending";
        persist(key, current);
        setStatus(key, current, "verifying");
        const task = current.task;
        const gate = await runGate(cwd, config, current.owned);
        if (replaced() || current.task !== task) return;
        current.gate = {
          ...gate,
          state: !gate.configured ? "not_configured" : gate.ok ? "verified" : "gate_failed",
          round: current.round,
        };
        if (!gate.configured)
          return close(
            "inconclusive",
            "stopped",
            `Prosecutor (${by}) gave up after ${rounds}, but this workspace has no acceptance gate configured, so the server ran nothing: NOT verified. Add test/typecheck commands in the prosecutor panel.`,
            "warning",
          );
        if (gate.ok) {
          outcome = { text: "Acquitted; acceptance gate passed", isError: false };
          return close("verified", "accepted", `Prosecutor (${by}) gave up after ${rounds}; the server's acceptance gate passed:\n${gateSummary(gate)}\n— diff accepted.`);
        }
        outcome = { text: "Acquitted, but the acceptance gate failed", isError: true };
        if (current.round >= MAX_ROUNDS)
          return close("stopped", "stopped", `Prosecutor (${by}) gave up after ${rounds}, but the server's acceptance gate failed and no rounds are left:\n${gateSummary(gate)}`, "warning");
        report = gateReport(gate);
        current.log.push({ round: current.round, by: "acceptance gate", prompt: "", report });
        current.lastReport = report;
        current.gateNote = `After your last acquittal the server's acceptance gate failed, so the executor was sent back:\n${gateSummary(gate)}\n\n`;
        notice(key, `Prosecutor (${by}) gave up after ${rounds}, but the server's acceptance gate failed — sent back to the executor:\n${gateSummary(gate)}`, "warning");
      } else if (verdict !== "guilty") {
        return close("inconclusive", "stopped", `Prosecutor (${by}) returned no verdict, even when asked again; loop stopped. Review the change yourself.`, "warning");
      } else {
        current.findings = findings;
        if (current.round >= MAX_ROUNDS)
          return close("stopped", "stopped", `Prosecutor (${by}) still breaks the change after ${MAX_ROUNDS} rounds; loop stopped. Last failing test:\n\n${report}`, "warning");
      }
      // Back to the executor with `report`: failing tests, or a failed gate.
      // The report is durable before the repair is dispatched. A crash while
      // the snapshot is taken still resumes this repair instead of dropping it.
      // A refused write is the same as a crash before the save: do not dispatch.
      current.phase = "repair_pending";
      if (!persist(key, current)) {
        if (!gone()) pause(key, current, "executor", "could not save the failing report");
        return;
      }
      // Next round's baseline: the tree now, the prosecutor's new tests
      // included, so its change list is only what the executor does next.
      // Taken before the executor is prompted, or its first edits would race.
      current.base = await takeSnapshot(
        cwd,
        `prosecutor round ${current.round}`,
        prosecutorKey(sessionKey),
      ).catch(() => null);
      if (gone()) return;
      if (current.base?.commit) current.baselineCommit = current.base.commit;
      persist(key, current);
      current.busy = false;
      current.defense = "";
      setStatus(key, current, "fixing");
      if (typeof executor?.prompt !== "function") {
        pause(key, current, "executor", "the executor is not running");
        return;
      }
      // A refusal, rejection, or throw is an executor failure. The guilty
      // review has already counted; do not re-run it as a prosecutor death.
      // Partial output moves the phase to repair_running before prompt()
      // settles. A process exit then resolves {ok:false} with no agent_end,
      // and that failure still pauses the repair. Codex and Grok resolve
      // prompt() after the turn's own end events, which may already have
      // started the next review. That resolution must not write
      // repair_running back over it.
      const repairRound = current.round;
      const repairId = current.id;
      const stillRepair = () =>
        !gone() &&
        current.id === repairId &&
        current.round === repairRound &&
        (current.phase === "repair_pending" || current.phase === "repair_running") &&
        !current.paused;
      const acceptRepair = (dispatched) => {
        if (!stillRepair()) return;
        if (dispatched && dispatched.ok === false) {
          pause(key, current, "executor", dispatched.error || "executor refused the repair");
          return;
        }
        current.phase = "repair_running";
        persist(key, current);
      };
      let dispatched;
      try {
        dispatched = executor.prompt(defensePrompt(current.task, report));
      } catch (error) {
        if (stillRepair()) pause(key, current, "executor", error?.message ?? String(error));
        return;
      }
      if (dispatched && typeof dispatched.then === "function") {
        void Promise.resolve(dispatched).then(
          (value) => acceptRepair(value),
          (error) => {
            if (stillRepair()) pause(key, current, "executor", error?.message ?? String(error));
          },
        );
        return;
      }
      acceptRepair(dispatched);
    } catch (error) {
      const reason = String(error?.message ?? error);
      outcome = { text: `Round failed: ${reason}`, isError: true };
      if (replaced()) return;
      // Keep what it got through, then pause: the round re-runs (same
      // number) on a resume or a switched-in prosecutor.
      current.lastReport = error?.partial ?? current.lastReport ?? "";
      current.log.push({ round: current.round, by, prompt: logged, report: error?.partial ?? "", died: reason });
      current.round -= 1;
      current.busy = false;
      pause(key, current, "prosecutor", reason);
    } finally {
      // A switched-in prosecutor's round may be running on this object now.
      if ((current.reviewer ?? 0) === reviewer) current.busy = false;
      const live = keyOf(current);
      // Clients read the verdict (effort floor, nudge) from this push.
      if (live && !replaced()) announce(live);
      publish(live || key, {
        type: "tool_execution_end",
        toolCallId: cardId,
        isError: outcome.isError,
        result: { content: [{ type: "text", text: outcome.text }] },
      });
    }
  }

  /** Executor event funnel: every settled turn on an open case is prosecuted. */
  function onExecutorEvent(sessionKey, event, executor) {
    const current = cases.get(sessionKey);
    // The executor's own reply (not a forwarded prosecutor or subagent
    // message, which carry parentToolUseId) is the next round's defense.
    if (event?.type === "message_end" || event?.type === "turn_end") {
      if (current && event.message?.role === "assistant" && !event.parentToolUseId) {
        current.defense = assistantText(event.message) || current.defense;
        // A turn that died (rate limit, auth, crash) fixed nothing: don't
        // spend a prosecutor round re-judging the same code.
        current.failed = turnError(event.message);
        if (executor?.cwd) current.cwd = executor.cwd;
        const sessionFile = executor?.sessionFile || executor?.lastState?.sessionFile;
        if (sessionFile) current.sessionId = sessionFile;
        if (!current.executorModel && executor?.lastState?.model)
          current.executorModel = executor.lastState.model;
        // Recorded for executors switched in later in the case.
        const last = current.log.at(-1);
        if (last && !last.died && !current.failed && current.defense) {
          last.reply = current.defense;
          last.replyBy = executor?.lastState?.model?.id || "";
        }
        // prompt() on Codex and Grok stays pending until the turn ends. An
        // assistant message means the repair is already executing, so a crash
        // now resumes it instead of treating it as not yet dispatched.
        if (current.phase === "repair_pending" && !current.failed)
          current.phase = "repair_running";
        // The transcript file is created after the task is accepted. Save
        // the open case once that path is known, before the turn ends.
        if (current.id && current.phase) persist(sessionKey, current);
      }
      return;
    }
    if (event?.type !== "agent_end" && event?.type !== "agent_settled") return;
    // No task = nothing the user asked for in this mode (a goal check-in,
    // or the case already closed); `busy` collapses agent_end+agent_settled.
    if (!current || !current.task || current.busy || current.paused || !executor) return;
    if (current.failed) {
      const reason = current.failed;
      current.failed = "";
      pause(sessionKey, current, "executor", reason);
      return;
    }
    void runRound(sessionKey, executor);
  }

  return { arm, disarm, noteTask, resume, onExecutorEvent, state, recover, armed: (key) => cases.get(key) };
}
