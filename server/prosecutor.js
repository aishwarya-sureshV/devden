/**
 * Prosecutor mode: adversarial review with no human in the loop.
 *
 * The tab's own agent is the executor and writes the fix. After each of its
 * turns a second backend -- the prosecutor -- gets a round whose only job is
 * to break that change by writing a failing test. A failing test goes back
 * to the executor; the diff is accepted only when the prosecutor gives up.
 *
 * In-memory per session key, like /goal: a server restart disarms it, and
 * the composer re-arms on its next render.
 */
import { agentIsAlive } from "./agent-methods.js";
import { assistantText } from "./pi-agent.js";
import { changedSince, takeSnapshot } from "./snapshots.js";

/** Rounds per user prompt before the loop stops and hands back to the user. */
export const MAX_ROUNDS = 5;
const ROUND_TIMEOUT_MS = 20 * 60_000;
/** Round 1 is the broad search; later rounds mostly check fixes. */
const FIRST_ROUND_EFFORT = "high";
const LATER_ROUND_EFFORT = "medium";
/** Both sides back every test or typecheck claim with the runner's output. */
const PROOF_RULE = `Proof, not claims: whenever you report a test or typecheck result, paste the command and the runner's real output verbatim -- its final summary lines (pass/fail counts) and every failure block. A result reported without its output does not count.`;

/**
 * Read the prosecutor's final reply. "guilty" = it wrote a test that fails,
 * "acquitted" = it gave up, null = no usable verdict (the loop stops).
 */
export function parseVerdict(text) {
  // Last verdict line wins: the reasoning above it may quote the other one.
  const matches = [...String(text ?? "").matchAll(/VERDICT:\s*\**\s*(GUILTY|ACQUITTED)\b/gi)];
  const last = matches.at(-1)?.[1]?.toLowerCase();
  return last === "guilty" || last === "acquitted" ? last : null;
}

// Both sides judge against the task as written: the prosecutor once chased
// unstated requirements (sub-ms precision, 309-digit inputs) for every round,
// and the executor caved to each one, so neither side ever settled.
const SCOPE_RULES = `What counts as a bug -- the task as written (plus any standing requirements from earlier turns) is the only spec:
- Each test must check behavior the task states, or that any reasonable reading of it requires (an input form it lists, an error case it names).
- Not a bug: precision beyond what the task implies, pathological or absurdly large inputs, performance, style, or your own preference about what the task "should" have said.
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

export function prosecutionPrompt(task, round, defense, brief = "", changes = "") {
  if (round > 1)
    return `Round ${round}. The task as written is still:

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
- If any test fails legitimately: list EVERY failing test -- the words of the task it enforces, the test as file:line plus its name, and its failure output -- plus the command to run them, then end with the line: VERDICT: GUILTY
- If every test passes, end with the line: VERDICT: ACQUITTED`;
}

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
        finish(() => (failed ? reject(new Error(failed)) : resolve(last)));
    });
    Promise.resolve(agent.prompt(message))
      .then((result) => {
        if (result && result.ok === false)
          finish(() => reject(new Error(result.error ?? "prompt failed")));
      })
      .catch((error) => finish(() => reject(error)));
  });
}

export function createProsecutor({ poolFor, publish }) {
  /** executor sessionKey -> { backend, model, task, round, busy } */
  const cases = new Map();
  const prosecutorKey = (sessionKey) => `${sessionKey}:prosecutor`;
  const notice = (sessionKey, message, tone) =>
    publish(sessionKey, { type: "notice", message, ...(tone ? { tone } : {}) });

  function disarm(sessionKey) {
    const current = cases.get(sessionKey);
    if (!current) return;
    cases.delete(sessionKey);
    poolFor(current.backend).stop(prosecutorKey(sessionKey));
  }

  function arm(sessionKey, { backend, model }) {
    const current = cases.get(sessionKey);
    const same =
      current &&
      current.backend === backend &&
      current.model?.provider === model?.provider &&
      current.model?.id === model?.id;
    if (same) return;
    // A changed prosecutor gets a fresh agent; the old one's memory of
    // earlier rounds belongs to a different model.
    if (current) poolFor(current.backend).stop(prosecutorKey(sessionKey));
    cases.set(sessionKey, {
      backend,
      model,
      task: current?.task ?? "",
      defense: "",
      round: 0,
      busy: false,
    });
  }

  /** A user prompt opens a new case: the task the diff is judged against. */
  function noteTask(sessionKey, message, snapshot) {
    const current = cases.get(sessionKey);
    if (!current || !message.trim()) return;
    current.task = message;
    // The tree before this turn: round 1's "what changed" baseline.
    current.base = snapshot ?? null;
    current.round = 0;
    current.defense = "";
  }

  async function runRound(sessionKey, executor) {
    const current = cases.get(sessionKey);
    current.busy = true;
    current.round += 1;
    const who = current.model?.id || current.backend;
    const cardId = `prosecutor-${Date.now()}`;
    const agent = poolFor(current.backend).get(prosecutorKey(sessionKey));
    // A fresh prosecutor process knows nothing of this session: brief it.
    const fresh = !agentIsAlive(agent);
    const brief = fresh
      ? historyBrief(
          sessionHistory(
            await Promise.resolve(executor.getMessages?.()).catch(() => []),
            current.task,
          ),
        )
      : "";
    const cwd = executor.cwd ?? executor.lastState?.cwd ?? process.cwd();
    const base = await Promise.resolve(current.base).catch(() => null);
    const changes = base?.ok
      ? await changedSince(cwd, base.commit).catch(() => null)
      : null;
    const prompt = prosecutionPrompt(
      current.task,
      current.round,
      current.defense,
      brief,
      changeNote(changes, base?.commit, current.round),
    );
    publish(sessionKey, {
      type: "tool_execution_start",
      toolCallId: cardId,
      toolName: "prosecutor",
      args: {
        description: `Round ${current.round}: try to break the change`,
        subagent_type: who,
        prompt,
      },
    });
    let outcome = { text: "Round failed", isError: true };
    const seq = { n: 0 };
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
      await Promise.resolve(
        agent.setThinkingLevel?.(
          current.round === 1 ? FIRST_ROUND_EFFORT : LATER_ROUND_EFFORT,
        ),
      ).catch(() => {});
      const report = await runTurn(agent, prompt, (event) => {
        const forwarded = forwardedEvent(event, cardId, seq);
        if (forwarded) publish(sessionKey, forwarded);
      });
      // Disarmed or re-armed with another prosecutor mid-round: drop it.
      if (cases.get(sessionKey) !== current) {
        outcome = { text: "Prosecutor changed mid-round; verdict dropped", isError: false };
        return;
      }
      const verdict = parseVerdict(report);
      outcome =
        verdict === "guilty"
          ? { text: "Guilty: failing test sent back to the executor", isError: true }
          : verdict === "acquitted"
            ? { text: "Acquitted: could not break the change", isError: false }
            : { text: "No verdict", isError: true };
      if (verdict === "acquitted") {
        notice(sessionKey, `Prosecutor (${who}) gave up after ${current.round} round${current.round === 1 ? "" : "s"} — diff accepted.`);
        current.task = "";
        return;
      }
      if (verdict !== "guilty") {
        notice(sessionKey, `Prosecutor (${who}) returned no verdict; loop stopped. Review the change yourself.`, "warning");
        current.task = "";
        return;
      }
      if (current.round >= MAX_ROUNDS) {
        notice(sessionKey, `Prosecutor (${who}) still breaks the change after ${MAX_ROUNDS} rounds; loop stopped. Last failing test:\n\n${report}`, "warning");
        current.task = "";
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
      current.busy = false;
      current.defense = "";
      void Promise.resolve(executor.prompt(defensePrompt(current.task, report))).catch(
        (error) => notice(sessionKey, `Executor could not take the failing test: ${error?.message ?? error}`, "error"),
      );
    } catch (error) {
      outcome = { text: `Round failed: ${error?.message ?? error}`, isError: true };
      notice(sessionKey, `Prosecutor round failed: ${error?.message ?? error}`, "error");
      current.task = "";
    } finally {
      current.busy = false;
      publish(sessionKey, {
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
      }
      return;
    }
    if (event?.type !== "agent_end" && event?.type !== "agent_settled") return;
    // No task = nothing the user asked for in this mode (a goal check-in,
    // or the case already closed); `busy` collapses agent_end+agent_settled.
    if (!current || !current.task || current.busy || !executor) return;
    if (current.failed) {
      notice(
        sessionKey,
        `The executor's turn failed (${clip(current.failed, 300)}); prosecutor loop stopped. Resend once the agent is available.`,
        "warning",
      );
      current.task = "";
      current.failed = "";
      return;
    }
    void runRound(sessionKey, executor);
  }

  return { arm, disarm, noteTask, onExecutorEvent, armed: (key) => cases.get(key) };
}
