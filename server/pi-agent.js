/**
 * Pi RPC process pool.
 *
 * Each logical session key owns its own `pi --mode rpc` child process (the same
 * model AgentDeck uses). Commands arrive as JSON over HTTP, events stream out
 * over Server-Sent Events. One process = one session at a time; `new_session`
 * and `switch_session` rebind the process to a fresh conversation.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { AgentPool } from "./agent-pool.js";
import { ApprovalGate } from "./approval-gate.js";
import { attachQueue } from "./agent-queue.js";
import {
  attachSubagentFollows,
  noteSubagentToolEvent,
  subagentBusy,
} from "./agent-subagent.js";
import { loadCodexUsage } from "./codex-usage.js";
import { loadGrokUsage } from "./grok-usage.js";
import { ollamaResets } from "./ollama-resets.js";
import { readResumeSession } from "./sessions.js";
import { logFault } from "./log-fault.js";
import {
  CO_PARTNER_PROMPT,
  CO_PARTNER_PROMPT_MANUAL,
  CLARIFY_PROMPT,
  REPORT_PROMPT,
} from "./co-partner-prompt.js";
import { withHostGuardEnv } from "./host-guard.js";
import {
  listOllamaModels,
  mergeModelLists,
  syncOllamaModelsJson,
} from "./ollama-models.js";

const MANUAL_APPROVE_EXTENSION_URL = new URL(
  "./pi-extensions/manual-approve.ts",
  import.meta.url,
);

const PLAN_MODE_PROMPT = [
  "You are in plan mode, a strictly read-only exploration phase.",
  "Inspect the workspace with the available read-only tools, ask concise clarifying questions when needed,",
  "and do not attempt to edit, write, install, or otherwise change files or external state.",
  'Finish with a detailed numbered implementation plan under an exact "Plan:" heading:',
  "Plan:",
  "1. First step description",
  "2. Second step description",
  "Do not execute the plan until the user explicitly chooses Execute plan in the interface.",
].join("\n");

const USAGE_CACHE_TTL_MS = 5 * 60_000;

// Control commands (state, model, session ops) must answer promptly; a hung
// pi child would otherwise leave the pending entry and the HTTP request
// hanging forever. Long-lived turn commands are deliberately untimed — a
// prompt legitimately runs for minutes and the turn streams over SSE.
const DEFAULT_RPC_TIMEOUT_MS = 60_000;
// Compaction is a model round trip over the whole transcript, not a local
// bookkeeping call.
const COMPACT_TIMEOUT_MS = 5 * 60_000;
const UNTIMED_COMMANDS = new Set(["prompt", "steer", "follow_up"]);
/** How long agent_settled gets to show up on its own after the turn's RPC
 *  response, before the response is taken as the end of the turn. */
const STRANDED_TURN_GRACE_MS = 5_000;

function resolvePiExecutable() {
  return process.env.PI_WEB_PI_BIN || "pi";
}

// pi's own answer to "what thinking levels exist" (confirmed against a live
// RPC session across several different configured models -- it never varies
// per model, it's the same fixed CLI-level ladder `pi --help` documents).
// Kept as a constant so a session that has no live process yet -- every
// saved session, until its first message -- can still answer this instead
// of 500ing.
const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const LIST_MODELS_TIMEOUT_MS = 15_000;

/**
 * `pi --list-models` is a one-shot, standalone listing -- no RPC session
 * required -- so a saved session that has not started its process yet (pi
 * only spawns on the first message) can still answer "what models exist"
 * instead of rejecting with "Pi process is not running". Output is a
 * fixed-width table; provider and model id are always its first two
 * whitespace-separated columns, so splitting on any run of whitespace is
 * robust regardless of the column widths.
 */
function listPiModelsStandalone(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePiExecutable(), ["--list-models"], {
      cwd: cwd || homedir(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("pi --list-models timed out"));
    }, LIST_MODELS_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `pi --list-models exited ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

const LIST_COMMANDS_TIMEOUT_MS = 20_000;

/**
 * Cold sessions have no pi process yet (pi only spawns on the first
 * message), so get_commands over the live pipe rejects and the command
 * menu 500s. Spawn a throwaway `pi --mode rpc` that answers the same RPC
 * once and dies — the command-menu twin of listPiModelsStandalone.
 * ponytail: uncached, so each cold-session menu load pays one pi startup
 * (~seconds); cache per cwd if that ever feels slow.
 */
function listPiCommandsStandalone(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePiExecutable(), ["--mode", "rpc", "--approve"], {
      cwd: cwd || homedir(),
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn(value);
    };
    const timer = setTimeout(
      () => settle(reject, new Error("pi get_commands timed out")),
      LIST_COMMANDS_TIMEOUT_MS,
    );
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // partial line at the chunk boundary — more coming
        }
        if (parsed?.type === "response" && parsed.id === "cold-commands") {
          if (parsed.success === false)
            return settle(reject, new Error(parsed.error ?? "failed"));
          const data = parsed.data;
          return settle(
            resolve,
            Array.isArray(data) ? data : (data?.commands ?? []),
          );
        }
      }
    });
    child.once("error", (error) => settle(reject, error));
    child.once("exit", () =>
      settle(reject, new Error("pi exited before answering get_commands")),
    );
    child.stdin.write(
      JSON.stringify({ type: "get_commands", id: "cold-commands" }) + "\n",
    );
  });
}

/** "gpt-5.6-luna" -> "Gpt 5.6 Luna"; good enough for a fallback listing. */
function titleizeModelId(id) {
  return String(id ?? "")
    .replace(/[:_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function parsePiModelListing(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // First line is the "provider  model  context  ..." header.
  return lines.slice(1).map((line) => {
    const [provider, id] = line.split(/\s+/);
    return { provider, id, name: titleizeModelId(id) };
  });
}

export class PiAgentProcess {
  constructor(sessionKey) {
    this.sessionKey = sessionKey;
    this.process = undefined;
    this.decoder = new StringDecoder("utf8");
    this.stdoutBuffer = "";
    this.nextRequestId = 1;
    this.pending = new Map();
    this.status = "stopped";
    this.lastState = undefined;
    this.usageRequest = undefined;
    this.usageCache = { at: 0, result: undefined };
    this.agentMode = undefined;
    this.approvalGate = new ApprovalGate(this);
    /** @type {Set<(event: object) => void>} */
    this.listeners = new Set();
    // First-response watchdog state (see armFirstResponseWatchdog).
    this.awaitingFirstActivity = false;
    this.firstActivityTimer = undefined;
    // Stranded-turn backstop (see settleAfterResponse). turnSeq identifies
    // which turn a pending backstop belongs to.
    this.strandedTurnTimer = undefined;
    this.turnSeq = 0;
    // Messages held while a turn is running; delivered as fresh prompts when
    // the turn settles. Mirrors the claude-agent queue (pi's own follow_up
    // queue can't cancel a single message or keep an orderable snapshot).
    this.queuedMessages = [];
    this.queueSeq = 0;
    attachQueue(this, {
      isBusy() {
        // pi flips back to "ready" the moment it hands a subagent off to the
        // detached runner, so status alone reports idle while the panel is
        // still filling in.
        return this.status === "working" || subagentBusy(this);
      },
      sendNow(message, images) {
        return this.prompt(message, images);
      },
      steerNow(message, images) {
        return this.steer(message, images);
      },
    });
    // Live `subagent` runs (pi-subagents extension). Their children work in a
    // detached runner, so their tool calls only reach the UI by tailing the
    // run's artifacts — see pi-subagent.js. Same follower every backend uses.
    attachSubagentFollows(this);
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    // Any sign of turn activity clears the first-response watchdog.
    if (
      this.awaitingFirstActivity &&
      (event.type === "agent_start" ||
        event.type === "message_update" ||
        event.type === "agent_end")
    ) {
      this.disarmFirstResponseWatchdog();
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* listener errors must not kill the pump */
      }
    }
  }

  /**
   * A prompt whose turn never starts is invisible: pi accepted the message
   * (it lands in the session file) but a stalled model call produced no
   * agent_start, no deltas, and no error — the UI just sat quiet for minutes
   * while the user wondered whether anything was sent. If the child process
   * shows no turn activity within 60s of a prompt, tell the user plainly so
   * they can interrupt and resend instead of waiting blind.
   */
  armFirstResponseWatchdog() {
    this.disarmFirstResponseWatchdog();
    this.awaitingFirstActivity = true;
    this.firstActivityTimer = setTimeout(() => {
      if (!this.awaitingFirstActivity) return;
      this.awaitingFirstActivity = false;
      this.emit({
        type: "stderr",
        sessionKey: this.sessionKey,
        message:
          "The model has not responded for over a minute — it may be stalled. Press esc to interrupt, then resend your message.",
      });
    }, 60_000);
  }

  disarmFirstResponseWatchdog() {
    this.awaitingFirstActivity = false;
    if (this.firstActivityTimer) {
      clearTimeout(this.firstActivityTimer);
      this.firstActivityTimer = undefined;
    }
  }

  /** Everything that has to happen when a turn is over, from whichever signal
   *  got here first. */
  settleTurn() {
    if (this.strandedTurnTimer) {
      clearTimeout(this.strandedTurnTimer);
      this.strandedTurnTimer = undefined;
    }
    // A child's closing report can be written after its run is marked
    // complete; by the time the parent turn settles it is certainly on
    // disk, so pick up anything the live follow missed.
    this.subagents.reconcile();
    this.setStatus("ready");
    // Drain first so the state snapshot cannot resurrect a chip the
    // queue_updated event just cleared.
    this.sendNextQueued();
    void this.getState()
      .then((state) =>
        this.emit({ type: "state", sessionKey: this.sessionKey, state }),
      )
      .catch(() => {});
  }

  /**
   * Backstop for a turn that ended without saying so.
   *
   * prompt/steer are in UNTIMED_COMMANDS on the theory that their RPC
   * response resolves once the whole turn is over -- but on current pi the
   * prompt response is an ack that resolves the millisecond the turn
   * *starts*, so this backstop is armed on every turn and used to settle
   * healthy >5s turns mid-flight: the agent flipped to "ready", isBusy()
   * went false, and the user's next message was fired as a concurrent
   * prompt into the live turn, which pi rejects -- silently dropping it.
   * (Seen live: a `tailscale serve` bash call that never exited, and two
   * lost "what happened?" messages.)
   *
   * pi's own state is the authority: the timer asks get_state, and only
   * settles when pi says no turn is streaming. If agent_settled is lost but
   * the turn is genuinely over, get_state answers isStreaming:false and the
   * settle fires; a live turn -- even one hung in a blocking tool -- answers
   * isStreaming:true (get_state responds even while a tool runs) and is
   * left alone.
   */
  settleAfterResponse(delayMs = STRANDED_TURN_GRACE_MS) {
    // Already settled: pi's agent_settled normally lands *before* the
    // response resolves, which is the healthy path and needs no backstop at
    // all. Arming here anyway left a live timer that the NEXT turn's
    // "working" satisfied -- so a perfectly good turn got the stranded notice
    // and, worse, was settled out from under itself.
    if (this.status !== "working") return;
    if (this.strandedTurnTimer) clearTimeout(this.strandedTurnTimer);
    const turn = this.turnSeq;
    const poll = () => {
      this.strandedTurnTimer = undefined;
      // Only ever settle the turn this backstop was armed for.
      if (this.status !== "working" || this.turnSeq !== turn) return;
      // pi is the authority on liveness: with ack-style prompt responses
      // the first poll fires 5s into every live turn, so never settle
      // without asking.
      void this.getState()
        .then((state) => {
          if (this.status !== "working" || this.turnSeq !== turn) return;
          if (state?.isStreaming) {
            // The prompt response is an ack at turn start, so this fires
            // mid-turn on every live turn. The old one-shot gave up here,
            // and a turn whose agent_settled went missing stayed "working"
            // forever -- the sidebar's running dot outlived the finished
            // conversation until the next prompt. Re-arm until pi says the
            // turn is over: one cheap get_state per grace window.
            this.strandedTurnTimer = setTimeout(poll, delayMs);
            this.strandedTurnTimer.unref?.();
            return;
          }
          // Recorded, not announced. This lands at the bottom of the
          // transcript, where it reads as if it describes whatever the user
          // just sent -- and by now the settle is a handled condition, not
          // something they can act on. server-faults.log is where it belongs.
          logFault(
            "stranded pi turn settled from its RPC response",
            this.sessionKey,
          );
          this.settleTurn();
          this.emit({ type: "agent_settled", sessionKey: this.sessionKey });
        })
        .catch(() => {});
    };
    this.strandedTurnTimer = setTimeout(poll, delayMs);
    this.strandedTurnTimer.unref?.();
  }

  setStatus(status, error) {
    this.status = status;
    this.emit({
      type: "__status",
      sessionKey: this.sessionKey,
      status,
      ...(error ? { error } : {}),
    });
  }

  async start(cwd, options = {}) {
    // A bogus cwd surfaces as a confusing 'spawn pi ENOENT' (Node reports the
    // same errno for a missing working directory as for a missing binary).
    // Fall back to $HOME and tell the UI.
    if (cwd && !existsSync(cwd)) {
      this.emit({
        type: "__status",
        sessionKey: this.sessionKey,
        status: this.status,
      });
      cwd = homedir();
      queueMicrotask(() =>
        this.emit({
          type: "stderr",
          sessionKey: this.sessionKey,
          message: `cwd not found; opened in ${cwd} instead`,
        }),
      );
    }
    if (this.process) {
      try {
        return { ok: true, state: await this.getState() };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }
    this.setStatus("starting");
    this.cwd = cwd;
    this.agentMode = options.agentMode;
    this.stdoutBuffer = "";
    const systemPrompt = [
      // Manual mode skips the pre-tool narration line: the approval card
      // already shows what is about to run, so it would be pure token spend.
      options.agentMode === "manual"
        ? CO_PARTNER_PROMPT_MANUAL
        : CO_PARTNER_PROMPT,
      CLARIFY_PROMPT,
      REPORT_PROMPT,
      ...(options.agentMode === "plan" ? [PLAN_MODE_PROMPT] : []),
    ].join("\n\n");
    const args = [
      "--mode",
      "rpc",
      "--approve",
      "--append-system-prompt",
      systemPrompt,
    ];
    if (options.accessMode === "read-only" || options.agentMode === "plan") {
      args.push("--tools", "read,grep,find,ls");
    }
    if (this.agentMode === "manual") {
      // pi's RPC protocol has no built-in tool approval; the extension
      // provides it by blocking tool_call and asking over ctx.ui.select,
      // which reaches us as extension_ui_request on the RPC stream.
      args.push("-e", fileURLToPath(MANUAL_APPROVE_EXTENSION_URL));
    }
    if (options.sessionPath) args.push("--session", options.sessionPath);
    if (options.model?.provider && options.model?.id)
      args.push(
        "--provider",
        options.model.provider,
        "--model",
        options.model.id,
      );
    if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
    const child = spawn(resolvePiExecutable(), args, {
      cwd,
      env: withHostGuardEnv({
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    child.stdout.on("data", (chunk) => this.readStdout(chunk));
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message)
        this.emit({ type: "stderr", sessionKey: this.sessionKey, message });
    });
    child.once("error", (error) => {
      this.failPending(error);
      if (this.process === child) this.process = undefined;
      this.setStatus("error", error.message);
    });
    child.once("exit", (code, signal) => {
      this.flushStdout();
      // The detached runner outlives pi, but its results can no longer reach
      // this session; without this the follow intervals leak and the spawn
      // card spins forever.
      this.subagents.stopAll();
      this.failPending(new Error(`Pi exited (${signal ?? code ?? "unknown"})`));
      if (this.process === child) this.process = undefined;
      if (this.status !== "stopped" && this.process === undefined) {
        const err =
          code && code !== 0 ? `Pi exited with code ${code}` : undefined;
        this.setStatus(err ? "error" : "stopped", err);
      }
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    let state;
    try {
      state = await this.getState(15_000);
    } catch (error) {
      this.stop();
      throw new Error(
        `Pi did not finish starting within 15 seconds: ${String(error?.message ?? error)}`,
      );
    }
    this.setStatus(state.isStreaming ? "working" : "ready");
    if (state.isStreaming) {
      // A persisted session can contain an interrupted turn from another Pi
      // process. This spawn is new, so that flag is stale — leaving it
      // "working" made enqueue() park the first prompt forever.
      await this.abort();
      this.setStatus("ready");
      try {
        state = {
          ...(await this.getState(10_000)),
          isStreaming: false,
        };
      } catch {
        state = { ...state, isStreaming: false };
      }
    }
    if (this.status === "ready") this.sendNextQueued();
    return { ok: true, state };
  }

  prompt(message, images) {
    this.turnSeq += 1;
    this.setStatus("working");
    this.armFirstResponseWatchdog();
    return this.runCommand({
      type: "prompt",
      message,
      ...(images?.length ? { images } : {}),
    }).then((result) => this.recoverIdleAfterFailedTurn(result));
  }
  steer(message, images) {
    this.turnSeq += 1;
    this.setStatus("working");
    this.armFirstResponseWatchdog();
    return this.runCommand({
      type: "steer",
      message,
      ...(images?.length ? { images } : {}),
    }).then((result) => this.recoverIdleAfterFailedTurn(result));
  }
  recoverIdleAfterFailedTurn(result) {
    if (!result?.ok) {
      this.disarmFirstResponseWatchdog();
      if (this.status === "working") this.setStatus("ready");
      return result;
    }
    // The turn's response came back, so the turn is over whether or not its
    // event says so.
    this.settleAfterResponse();
    return result;
  }
  followUp(message, images) {
    return this.runCommand({
      type: "follow_up",
      message,
      ...(images?.length ? { images } : {}),
    });
  }
  abort() {
    this.approvalGate.denyAll();
    this.holdQueue();
    return this.runCommand({ type: "abort" });
  }

  /** Manual-mode answer from POST /api/<key>/approve. */
  resolveApproval(requestId, optionId) {
    return this.approvalGate.resolve(requestId, optionId);
  }
  newSession() {
    return this.runSessionCommand({ type: "new_session" });
  }
  async switchSession(sessionPath) {
    const result = await this.runSessionCommand(
      { type: "switch_session", sessionPath },
      20_000,
    );
    if (result.ok) this.usageCache = { at: 0, result: undefined };
    if (!result.ok || !result.state?.isStreaming) return result;

    // A persisted session can contain an interrupted turn from another Pi
    // process. Never let that stale flag turn a read-only resume into a live
    // run in the web UI.
    await this.abort();
    this.setStatus("ready");
    try {
      const [state, messages] = await Promise.all([
        this.getState(10_000),
        this.getMessages(10_000),
      ]);
      return { ...result, state: { ...state, isStreaming: false }, messages };
    } catch {
      return { ...result, state: { ...result.state, isStreaming: false } };
    }
  }
  /**
   * Compaction re-summarizes the entire history through the model, which
   * routinely takes minutes on a long session -- far past the default RPC
   * timeout, which reported a failure for a compaction that then finished
   * anyway (hence "already compacted" on the retry). It also rewrites the
   * transcript, so the fresh history is returned with the result: without it
   * the UI kept showing the pre-compaction messages. That is now the
   * intended display: compact is for the model's context, not the transcript.
   */
  async compact(customInstructions) {
    const result = await this.runCommand(
      {
        type: "compact",
        ...(customInstructions ? { customInstructions } : {}),
      },
      COMPACT_TIMEOUT_MS,
    );
    if (!result.ok) return result;
    try {
      const [state, messages] = await Promise.all([
        this.getState(10_000),
        this.getMessages(10_000),
      ]);
      return { ...result, state, messages };
    } catch {
      return result;
    }
  }
  async setModel(provider, modelId) {
    if (provider === "ollama") {
      try {
        await syncOllamaModelsJson(await listOllamaModels());
      } catch {
        /* listing is best-effort; set_model may still work */
      }
    }
    // A session opened for viewing has no process yet (pi only spawns on
    // the first message), so there is nothing live to push this into --
    // `send()` would just reject with "Pi process is not running", which is
    // what made every saved session's model picker fail before its first
    // message. Answering with the picked model (no `state`) is enough: the
    // client merges it into its own state and the next real prompt carries
    // it into start(), same as grok/codex already handle a pre-start pick.
    if (!this.process) return { ok: true, data: { provider, id: modelId } };
    const result = await this.runCommand({
      type: "set_model",
      provider,
      modelId,
    });
    // pi's live process can be running with a stale ollama catalog (a model
    // pulled after it started); restarting reloads ~/.pi/agent/models.json,
    // which was just re-synced above.
    if (!result.ok && provider === "ollama" && this.cwd) {
      const sessionPath = this.lastState?.sessionFile;
      const thinkingLevel = this.lastState?.thinkingLevel;
      this.stop();
      return this.start(this.cwd, {
        model: { provider, id: modelId },
        ...(sessionPath ? { sessionPath } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      });
    }
    if (!result.ok) return result;
    this.usageCache = { at: 0, result: undefined };
    try {
      return { ok: true, data: result.data, state: await this.getState() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
  setThinkingLevel(level) {
    // Same as setModel: a not-yet-started session has nothing live to push
    // this into. The client applies `level` locally on `ok: true` regardless
    // of any returned data, so succeeding here is the whole fix -- the next
    // real prompt carries state.thinkingLevel into start().
    if (!this.process) return Promise.resolve({ ok: true });
    return this.runCommand({ type: "set_thinking_level", level });
  }
  setSessionName(name) {
    return this.runCommand({ type: "set_session_name", name });
  }

  async getState(timeoutMs) {
    const response = await this.send({ type: "get_state" }, timeoutMs);
    if (response.success === false)
      throw new Error(response.error ?? "get_state failed");
    this.lastState = {
      ...response.data,
      queuedMessages: this.queueSnapshot(),
    };
    return this.lastState;
  }

  async getMessages(timeoutMs) {
    const response = await this.send({ type: "get_messages" }, timeoutMs);
    if (response.success === false)
      throw new Error(response.error ?? "get_messages failed");
    const data = response.data;
    return Array.isArray(data) ? data : (data?.messages ?? []);
  }

  async getEntries() {
    const response = await this.send({ type: "get_entries" });
    if (response.success === false)
      throw new Error(response.error ?? "get_entries failed");
    const data = response.data;
    return Array.isArray(data) ? data : (data?.entries ?? []);
  }

  async forkAt(timestamp) {
    const entries = await this.getEntries();
    const assistantEntries = entries.filter(
      (entry) =>
        entry?.type === "message" &&
        entry?.message?.role === "assistant" &&
        entry?.id,
    );
    if (assistantEntries.length === 0)
      return {
        ok: false,
        error: "No assistant response is available to fork.",
      };
    const requested = Number(timestamp);
    const entry = Number.isFinite(requested)
      ? assistantEntries.reduce((closest, candidate) => {
          const closestTime = Number(
            closest?.message?.timestamp ?? Date.parse(closest?.timestamp ?? ""),
          );
          const candidateTime = Number(
            candidate?.message?.timestamp ??
              Date.parse(candidate?.timestamp ?? ""),
          );
          return Math.abs(candidateTime - requested) <
            Math.abs(closestTime - requested)
            ? candidate
            : closest;
        })
      : assistantEntries.at(-1);
    const entryIndex = entries.findIndex(
      (candidate) => candidate?.id === entry?.id,
    );
    const nextUser = entries
      .slice(entryIndex + 1)
      .find(
        (candidate) =>
          candidate?.type === "message" &&
          candidate?.message?.role === "user" &&
          candidate?.id,
      );
    // pi's fork/clone rebinds this live process to the new branch file.
    // Capture the original first, then hand the branch to its own tab and
    // put the live conversation back where it was, so a forked session runs
    // independently instead of stealing this agent.
    const originalFile = this.lastState?.sessionFile;
    const result = nextUser
      ? await this.runSessionCommand({ type: "fork", entryId: nextUser.id })
      : await this.runSessionCommand({ type: "clone" });
    if (!result.ok) return result;
    if (result.data?.cancelled)
      return { ok: false, error: "The fork was cancelled by an extension." };
    const forkFile = result.state?.sessionFile;
    if (forkFile && forkFile !== originalFile && originalFile) {
      const restore = await this.switchSession(originalFile);
      if (!restore.ok)
        return {
          ok: false,
          error:
            restore.error ??
            "Could not restore the original session after forking.",
        };
    }
    return {
      ok: true,
      restored: true,
      state: result.state,
      messages: result.messages,
      forkCwd: this.cwd,
    };
  }

  async runSessionCommand(command, timeoutMs) {
    const result = await this.runCommand(command, timeoutMs);
    if (!result.ok) return result;
    try {
      const [state, messages] = await Promise.all([
        this.getState(timeoutMs),
        this.getMessages(timeoutMs),
      ]);
      return { ok: true, state, messages, data: result.data };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  // pi answers these with envelopes like { models: [...] } — unwrap to arrays.
  // A cold session has no process (pi spawns on the first message), so ask a
  // throwaway rpc child in the session's cwd instead of letting the send
  // reject 500 the command menu. cwd arrives as a request param because the
  // agent itself only learns cwd at start().
  async getCommands(cwd) {
    if (!this.process) {
      if (cwd) this.cwd = cwd;
      return { ok: true, commands: await listPiCommandsStandalone(this.cwd) };
    }
    const response = await this.send({ type: "get_commands" });
    if (response.success === false)
      return { ok: false, error: response.error ?? "failed" };
    const data = response.data;
    return {
      ok: true,
      commands: Array.isArray(data) ? data : (data?.commands ?? []),
    };
  }

  // A saved session viewed but not yet started has no process (pi only
  // spawns on the first message), and `this.send` rejects rather than
  // answers in that case -- the model dropdown 500ed and stayed on
  // "model…" with nothing to pick, for every session until its first
  // message. `pi --list-models` answers the same question standalone.
  async getAvailableModels() {
    const [response, ollama] = await Promise.all([
      this.process
        ? this.send({ type: "get_available_models" })
        : listPiModelsStandalone(this.cwd)
            .then((stdout) => ({
              success: true,
              data: parsePiModelListing(stdout),
            }))
            .catch((error) => ({
              success: false,
              error: String(error?.message ?? error),
            })),
      listOllamaModels().catch(() => []),
    ]);
    if (ollama.length) void syncOllamaModelsJson(ollama).catch(() => {});
    if (response.success === false) {
      if (ollama.length) return { ok: true, models: ollama };
      return { ok: false, error: response.error ?? "failed" };
    }
    const data = response.data;
    const models = (Array.isArray(data) ? data : (data?.models ?? [])).filter(
      // pi registers the grok provider too; this UI drives pi, not grok.
      (model) => !/^grok/i.test(String(model?.provider ?? "")),
    );
    return { ok: true, models: mergeModelLists(models, ollama) };
  }

  async getThinkingLevels() {
    // Same fixed ladder either way (confirmed against a live process across
    // several models) -- skip the RPC round trip entirely when there is no
    // process to ask instead of rejecting.
    if (!this.process) return { ok: true, levels: PI_THINKING_LEVELS };
    const response = await this.send({ type: "get_available_thinking_levels" });
    if (response.success === false)
      return { ok: false, error: response.error ?? "failed" };
    const data = response.data;
    return {
      ok: true,
      levels: Array.isArray(data) ? data : (data?.levels ?? []),
    };
  }

  async getUsage(force = false, sessionPath) {
    const now = Date.now();
    if (
      !force &&
      this.usageCache.result &&
      now - this.usageCache.at < USAGE_CACHE_TTL_MS
    ) {
      return this.usageCache.result;
    }
    if (this.usageRequest) return this.usageRequest;
    this.usageRequest = this.loadUsage(sessionPath)
      .then((result) => {
        if (result?.ok) this.usageCache = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        this.usageRequest = undefined;
      });
    return this.usageRequest;
  }

  async loadUsage(sessionPath) {
    let state = this.lastState;
    // A session opened for viewing has no process yet (pi starts on the first
    // message). Usage is a composer chip, not an error: answer from the
    // session file on disk when we know it, or "nothing to report" to keep
    // the poll quiet instead of 500ing every 30s.
    if (!state && !this.process) {
      if (sessionPath) {
        const summary = await readResumeSession(sessionPath).catch(() => null);
        if (summary?.usage?.total > 0) {
          if (summary.lastModelProvider === "grok-sdk") return loadGrokUsage();
          if (summary.lastModelProvider === "ollama")
            return this.loadOllamaUsage();
          const providerName = summary.lastModelProvider ?? "Provider";
          return {
            ok: true,
            usage: {
              available: true,
              provider: providerName,
              windows: [],
              tokens: summary.usage,
              updatedAt: new Date().toISOString(),
            },
          };
        }
      }
      return {
        ok: true,
        usage: { available: false, provider: "Provider", windows: [] },
      };
    }
    try {
      state ??= await this.getState(5_000);
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
    const identity =
      `${state?.model?.provider ?? ""}/${state?.model?.id ?? ""}`.toLowerCase();
    if (identity.includes("grok")) return loadGrokUsage();
    if (identity.includes("openai-codex"))
      return loadCodexUsage(state?.model?.id);
    if (identity.includes("ollama")) return this.loadOllamaUsage();
    return {
      ok: true,
      usage: {
        available: false,
        provider: state?.model?.provider ?? "Provider",
        windows: [],
      },
    };
  }

  async loadOllamaUsage() {
    try {
      // Account usage from ollama.com (same auth the cloud models use). The
      // session-file token sum is gone: this is the provider's own number.
      const key = process.env.OLLAMA_API_KEY;
      if (!key)
        return {
          ok: true,
          usage: { available: false, provider: "Ollama", windows: [] },
        };
      const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
      };
      const response = await fetch("https://ollama.com/api/usage", {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error(`Ollama usage returned ${response.status}`);
      const payload = await response.json();
      // limits.{session,weekly}.usage are precomputed utilization fractions
      // (verified against the live endpoint 2026-09-08: e.g. 0.288 = 28.8%).
      const windows = [
        ["Session", payload?.limits?.session?.usage],
        ["Weekly", payload?.limits?.weekly?.usage],
      ]
        .map(([label, usage]) => {
          const usedPercent = Number(usage) * 100;
          return Number.isFinite(usedPercent) && usedPercent > 0
            ? { label, usedPercent }
            : null;
        })
        .filter(Boolean);
      // The API carries no reset time at all, so the instants are computed
      // from Ollama's own schedules (a 5 hour session grid and a Sunday 04:30
      // week) rather than fetched -- see ollama-resets.js. Always present.
      const resets = ollamaResets();
      const byLabel = { Session: resets.session, Weekly: resets.weekly };
      for (const window of windows) {
        const at = byLabel[window.label];
        if (at) window.resetsAt = at;
      }
      return {
        ok: true,
        usage: {
          available: true,
          provider: "Ollama",
          windows,
          updatedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async runCommand(command, timeoutMs) {
    try {
      const response = await this.send(command, timeoutMs);
      return response.success === false
        ? { ok: false, error: response.error ?? `${command.type} failed` }
        : { ok: true, data: response.data };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  send(command, timeoutMs) {
    if (!this.process)
      return Promise.reject(new Error("Pi process is not running"));
    const id = `req-${this.nextRequestId++}`;
    const payload = { ...command, id };
    return new Promise((resolve, reject) => {
      const effectiveTimeout =
        timeoutMs ??
        (UNTIMED_COMMANDS.has(command.type)
          ? undefined
          : DEFAULT_RPC_TIMEOUT_MS);
      const timeout = effectiveTimeout
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`${command.type} timed out`));
          }, effectiveTimeout)
        : undefined;
      this.pending.set(id, {
        resolve: (value) => {
          if (timeout) clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          if (timeout) clearTimeout(timeout);
          reject(error);
        },
      });
      this.process.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          if (timeout) clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  readStdout(chunk) {
    this.stdoutBuffer += this.decoder.write(chunk);
    this.drainStdout();
  }

  flushStdout() {
    this.stdoutBuffer += this.decoder.end();
    this.drainStdout();
    this.stdoutBuffer = "";
  }

  drainStdout() {
    let index = this.stdoutBuffer.indexOf("\n");
    while (index !== -1) {
      let line = this.stdoutBuffer.slice(0, index);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.stdoutBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.emit({
        type: "pi_raw_line",
        sessionKey: this.sessionKey,
        raw: line,
      });
      return;
    }
    if (event.type === "response" && event.id && this.pending.has(event.id)) {
      const { resolve } = this.pending.get(event.id);
      this.pending.delete(event.id);
      resolve(event);
      // Responses are part of the RPC lifecycle too. Keep them on the shared
      // event stream so the backend log can show the command boundary and its
      // raw acknowledgement, not only the agent's streamed events.
      this.emit({ ...event, sessionKey: this.sessionKey });
      return;
    }
    if (event.type === "agent_start") this.setStatus("working");
    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_end"
    ) {
      const { holdEnd } = noteSubagentToolEvent(this, event);
      if (holdEnd) return;
    }
    if (event.type === "agent_settled") this.settleTurn();
    if (
      event.type === "extension_ui_request" &&
      event.method === "select" &&
      this.approvalGate.enabled
    ) {
      // The manual-approve extension asking to run a tool. Title is
      // "Allow <tool>\n<input json>" — split it back apart for the card.
      const title = String(event.title ?? "");
      const split = title.indexOf("\n");
      const toolName =
        split === -1
          ? title.replace(/^Allow\s+/, "").replace(/\?$/, "") || "tool"
          : title
              .slice(0, split)
              .replace(/^Allow\s+/, "")
              .replace(/\?$/, "") || "tool";
      const detail = split === -1 ? "" : title.slice(split + 1);
      void this.approvalGate
        .request({ toolName, title: toolName, detail })
        .then(({ allow, choice }) => {
          const value = !allow
            ? "Deny"
            : choice === "allow_always"
              ? "Always allow"
              : "Allow once";
          // A response to pi's request: the id must match the request's,
          // so this cannot go through send() (it stamps its own id).
          this.process?.stdin.write(
            `${JSON.stringify({ type: "extension_ui_response", id: event.id, value })}\n`,
          );
        })
        .catch(() => {
          /* gate failure: pi's select stays unanswered — same failure mode
             as any unanswered dialog; the 10-min timeout denies instead. */
        });
      this.emit({ ...event, sessionKey: this.sessionKey });
      return;
    }
    this.emit({ ...event, sessionKey: this.sessionKey });
  }

  failPending(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  stop() {
    this.status = "stopped";
    if (this.strandedTurnTimer) {
      clearTimeout(this.strandedTurnTimer);
      this.strandedTurnTimer = undefined;
    }
    if (this.process) {
      this.process.kill();
      this.process = undefined;
    }
    this.subagents.stopAll();
    this.failPending(new Error("Pi process stopped"));
    this.emit({
      type: "__status",
      sessionKey: this.sessionKey,
      status: "stopped",
    });
  }
}

export class PiAgentPool extends AgentPool {
  constructor() {
    super((sessionKey) => new PiAgentProcess(sessionKey));
  }
}

/**
 * Claude-style session titles: a short-lived, ephemeral pi process summarizes
 * the first user prompt into a concise, professional title. The main agent
 * process is never touched, so the conversation transcript stays clean.
 */
/**
 * A board card is a to-do, not a conversation: an imperative fragment reads
 * right in a narrow lane where a Title Case noun phrase does not.
 */
export const CARD_TITLE_INSTRUCTION =
  "Summarize this excerpt as a task title: 3-6 words, imperative mood, sentence case, no quotes, no trailing period. It labels a card on a kanban board. Reply with ONLY the title, nothing else.";

const TITLE_INSTRUCTION =
  "Generate a short, professional title (3-7 words, Title Case, no quotes, no trailing period) for a conversation that starts with this user message. Reply with ONLY the title, nothing else.";

function cleanGeneratedTitle(value) {
  const title = String(value ?? "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/[.!?]+$/, "")
    .trim();
  if (!title) return "";
  if (title.length <= 60) return title;
  return `${title
    .slice(0, 60)
    .replace(/\s+\S*$/, "")
    .trim()}…`;
}

export function assistantText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * Generate a title from a piece of text. Best-effort: resolves to "" on any
 * failure so callers can fall back to the text itself. `instruction` lets a
 * caller ask for a different kind of title (board cards want an imperative
 * label, not a conversation name) without a second spawner.
 */
export function generateSessionTitle(
  firstPrompt,
  model,
  instruction = TITLE_INSTRUCTION,
) {
  const prompt = String(firstPrompt ?? "").trim();
  if (!prompt) return Promise.resolve("");
  const message = `${instruction}\n\nUser message:\n"${prompt.slice(0, 500)}"`;
  return new Promise((resolve) => {
    const args = [
      "--mode",
      "rpc",
      "--no-session",
      // Skip extensions/skills/context discovery: the title process only needs
      // a bare model call, and loading the full environment is slow and can
      // have side effects that interfere with the live session's process.
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
    ];
    if (model?.provider && model?.id) {
      args.push("--provider", model.provider, "--model", model.id);
    }
    let child;
    try {
      child = spawn(resolvePiExecutable(), args, {
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve("");
      return;
    }
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let title = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(""), 45_000);
    child.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "message_update") {
          const update = event.assistantMessageEvent;
          if (
            update?.type === "text_end" &&
            typeof update.content === "string"
          ) {
            title = update.content.trim();
          }
        } else if (event.type === "message_end") {
          const text = assistantText(event.message);
          if (text) title = text;
        } else if (event.type === "agent_settled") {
          finish(cleanGeneratedTitle(title));
        }
      }
    });
    child.once("error", () => finish(""));
    child.once("exit", () => finish(cleanGeneratedTitle(title)));
    child.stdin.write(
      `${JSON.stringify({ type: "prompt", message })}\n`,
      (error) => {
        if (error) finish("");
      },
    );
  });
}
