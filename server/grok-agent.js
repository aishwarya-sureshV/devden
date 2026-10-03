/**
 * Grok agent, driven directly over ACP (Agent Client Protocol) instead of
 * through `pi`.
 *
 * Background: `pi --provider grok-sdk` never surfaces tool calls -- confirmed
 * by capturing its raw RPC event stream directly (thinking/text content only,
 * even when explicitly told "use your bash tool now"). That's a bug in pi's
 * native grok-sdk adapter, not in devden, and pi's extension system can't
 * redirect a built-in provider id to different request-building code.
 *
 * The real `grok` CLI (xAI's own harness, "grok-build") speaks ACP natively
 * via `grok agent stdio` and does emit proper tool_call/tool_call_update
 * notifications -- this adapter drives that directly and translates ACP
 * session updates into the same event vocabulary PiAgentProcess/
 * ClaudeAgentProcess already emit (message_start/message_update with
 * assistantMessageEvent envelopes, turn_end, agent_start/agent_settled),
 * captured empirically from a live pi RPC session so the existing frontend
 * needs no changes to render it.
 *
 * Session resume uses ACP's `loadSession` (confirmed working: grok replays
 * full history as session/update notifications on a fresh connection given
 * just the sessionId). Model and reasoning-effort switching both go through
 * ACP's standard `session/set_mode` -- grok exposes both models and effort
 * levels as flat "mode" options (confirmed empirically; grok's own
 * setSessionModel method rejects the standard ACP request shape, but
 * setSessionMode accepts model ids and effort ids interchangeably).
 *
 * Known gap: ACP's `prompt()` runs a turn to completion before returning, so
 * there's no protocol-level way to interject mid-turn the way pi/claude's
 * "steer" does -- steer() rejects while a turn is in flight instead of
 * silently queuing or corrupting state.
 */
import { readFile } from "node:fs/promises";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { GROK_ACP_ARGS, openAcpClient } from "./acp-agent.js";
import { AgentPool } from "./agent-pool.js";
import { MODEL_CATALOG_TTL_MS } from "./model-catalog.js";
import { ApprovalGate } from "./approval-gate.js";
import { attachQueue } from "./agent-queue.js";
import { unsupported } from "./agent-methods.js";
import { isSubagentToolName } from "./agent-subagent.js";
import {
  repoContext,
  stripClarifyPrefix,
  withGrokPrefix,
} from "./co-partner-prompt.js";
import {
  GROK_PROXY_BASE,
  GROK_PROXY_HEADERS,
  grokHome,
  loadGrokUsage,
  readGrokToken,
} from "./grok-usage.js";
import {
  grokToolOutputText,
  messagesFromGrokLog,
  parseSubagentId,
  stripTrailingCompactTurn,
} from "./sessions.js";
import {
  contextTokensFromJournal,
  contextWindowForModel,
  turnUsagesFromJournal,
} from "./grok-context.js";
import {
  cwdFromGrokSession,
  promptIndexFromTimestamp,
  resolvePromptIndex,
  seedGrokForkJournals,
  sliceMessagesThroughPrompt,
} from "./grok-fork.js";

export { isSubagentToolName } from "./agent-subagent.js";
export { parseSubagentId } from "./sessions.js";

export const GROK_SESSIONS_ROOT = () => join(grokHome(), "sessions");

function resolveGrokExecutable() {
  return process.env.GROK_EXECUTABLE || "grok";
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * grok's turn_completed usage. Two things differ from every other backend:
 * `inputTokens` is INCLUSIVE of the cached reads (totalTokens is exactly
 * inputTokens + outputTokens), where pi/Codex/Anthropic report input as the
 * uncached remainder; and cost arrives as one undifferentiated `costUsdTicks`
 * (1e-9 USD) with no per-bucket breakdown, so the cost fields stay zero.
 */
export function usageFrom(raw) {
  if (!raw || typeof raw !== "object") return zeroUsage();
  const num = (key) => {
    const value = Number(raw[key]);
    return Number.isFinite(value) ? value : 0;
  };
  const cacheRead = num("cachedReadTokens");
  const cacheWrite = num("cacheCreationTokens");
  return {
    // Re-based to the shared "input excludes cache" convention.
    input: Math.max(0, num("inputTokens") - cacheRead - cacheWrite),
    output: num("outputTokens"),
    cacheRead,
    cacheWrite,
    totalTokens: num("totalTokens"),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function acpTextOf(block) {
  return block?.type === "text" ? (block.text ?? "") : "";
}

// grok's ACP tool_call notifications don't populate the optional `kind`
// field (confirmed empirically), so shell-command detection falls back to
// known tool names -- this is what lets the UI show a live "running $ ..."
// indicator instead of a generic thinking spinner during shell execution.
const SHELL_TOOL_NAMES = new Set(["run_terminal_command"]);

// How long a background-driven piece of a turn may go silent before devden
// treats it as dead. A healthy grok streams chunks continuously; silence means
// the child crashed or stopped mid-report and the turn would otherwise wedge
// the session on "running" forever — every later prompt queued behind it.
// Covers stalled subagent follows (no bytes in the child's session file) and
// idle reminder turns whose stream stopped.
let stallMs = 5 * 60_000;
// turn_completed in the child stream can beat output.json to disk; wait this
// long for the official findings before falling back to streamed narration.
let outputWaitMs = 1_500;
// After a spawn follow drains, grok often starts an idle handover turn.
// Flushing the queue in that gap interleaved the follow-up with the
// handover and scrambled the transcript.
let queueIdleMs = 500;

/** Tests only: shrink the stall watchdogs so the bail-out is observable. */
export function setStallMsForTesting(ms) {
  stallMs = ms;
  outputWaitMs = ms < 5 * 60_000 ? Math.max(1, ms) : 1_500;
}

/** Tests only: shrink the post-follow queue pause. */
export function setQueueIdleMsForTesting(ms) {
  queueIdleMs = ms;
}

/**
 * Read complete jsonl rows added since `offset` without rereading the prefix.
 * Incomplete trailing bytes stay unread for the next tick. A shrunk file
 * (rewrite) resets to the start.
 */
export function readJsonlFromOffset(path, offset) {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { lines: [], offset: 0, missing: true };
  }
  if (size < offset) offset = 0;
  if (size <= offset) return { lines: [], offset, missing: false };
  let fd;
  try {
    fd = openSync(path, "r");
    const length = size - offset;
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, offset);
    const end = buffer.lastIndexOf(0x0a, read - 1);
    if (end < 0) return { lines: [], offset, missing: false };
    const chunk = buffer.subarray(0, end + 1).toString("utf8");
    return {
      lines: chunk.split("\n").filter((line) => line.trim()),
      offset: offset + end + 1,
      missing: false,
    };
  } catch {
    return { lines: [], offset, missing: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Child tools also arrive on the parent ACP stream, usually without a parent
 *  id. While we are following a spawn, those calls belong in the pane only. */
export function parentToolBelongsToFollow(follows, update, turn) {
  if (!follows || follows.size === 0) return false;
  const id = update?.toolCallId;
  if (!id) return false;
  if (follows.has(id)) return false;
  if (turn?.toolIndex?.has(id)) return false;
  if (isSubagentToolName(update.title ?? update.toolCallId)) return false;
  for (const follow of follows.values()) {
    if (follow.toolNames?.has(id)) return true;
  }
  return false;
}

/** Parent ACP text held while a child runs. Strip the nested copy so the
 *  leftover (status + handover) can land in the main transcript. */
export function parentTextAfterChild(held, childText) {
  const parent = String(held ?? "");
  const child = String(childText ?? "").trim();
  if (!parent.trim()) return "";
  if (!child) return parent;
  if (child.includes(parent.trim()) && parent.trim().length >= 40) return "";
  if (parent.includes(child)) {
    return parent
      .split(child)
      .join("")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return parent;
}

/** The child's streamed narration arrives in blocks — opening chatter,
 *  then the final findings after its tools. Each block keeps its own index
 *  (its real place in the sequence). The official output.json findings are
 *  appended as one more block only when no streamed block already contains
 *  them — otherwise the panel would print the same report twice. The spawn
 *  tool's result prefers the findings: that is what the Task card shows. */
export function subagentFindings(segments, output) {
  const blocks = (Array.isArray(segments) ? segments : [segments])
    .map((text, index) => ({
      contentIndex: index,
      content: String(text ?? "").trim(),
    }))
    .filter((block) => block.content);
  const findings = String(output ?? "").trim();
  if (findings && !blocks.some((block) => block.content.includes(findings)))
    blocks.push({ contentIndex: blocks.length, content: findings });
  const narration = blocks.map((block) => block.content).join("\n");
  return { blocks, resultText: findings || narration || "Subagent finished." };
}

function childUpdatesPath(cwd, subagentId) {
  return join(
    GROK_SESSIONS_ROOT(),
    encodeURIComponent(cwd),
    subagentId,
    "updates.jsonl",
  );
}

/** The session's own update journal — the ground truth for what grok has
 *  finished. grok journals its turn marker with a non-ACP method
 *  (`_x.ai/session/update`), so the turn_completed notification never
 *  reaches the standard ACP stream and devden must read the file. */
function sessionUpdatesPath(cwd, sessionId) {
  return join(
    GROK_SESSIONS_ROOT(),
    encodeURIComponent(cwd),
    sessionId,
    "updates.jsonl",
  );
}

function childMetaPath(cwd, parentSessionId, subagentId) {
  return join(
    GROK_SESSIONS_ROOT(),
    encodeURIComponent(cwd),
    parentSessionId,
    "subagents",
    subagentId,
    "meta.json",
  );
}

/** The child's official final report, written at completion. The streamed
 *  narration chunks are process-speak ("I'll search for…"); the findings the
 *  user wants live here. */
function childOutputPath(cwd, parentSessionId, subagentId) {
  return join(
    GROK_SESSIONS_ROOT(),
    encodeURIComponent(cwd),
    parentSessionId,
    "subagents",
    subagentId,
    "output.json",
  );
}

function parentToolUseIdOf(update) {
  const meta =
    update?._meta && typeof update._meta === "object" ? update._meta : {};
  for (const key of [
    "parentToolCallId",
    "parentToolUseId",
    "parent_tool_use_id",
  ]) {
    if (typeof meta[key] === "string" && meta[key]) return meta[key];
  }
  return "";
}

function toolResultText(content) {
  return (content ?? [])
    .map((entry) => (entry?.type === "content" ? acpTextOf(entry.content) : ""))
    .filter(Boolean)
    .join("\n");
}

/** True when the last real block is a tool call. Grok journals
 *  `turn_completed` at the end of a generation, including ones that still
 *  end on tools — that is not the end of the user prompt. */
/**
 * ACP `session/update` is per-session. Forking creates a second session on
 * the same grok process (and a second process may load it too). Thoughts
 * for the child still arrive on this connection; applying them called
 * startIdleTurn and the parent tab showed "Grok is thinking".
 */
export function sessionUpdateIsFor(sessionId, notification) {
  const incoming = notification?.sessionId;
  if (!incoming || !sessionId) return true;
  return incoming === sessionId;
}

export function assistantEndedOnTools(content) {
  if (!Array.isArray(content)) return false;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    const type = String(block?.type ?? "");
    if (type === "thinking") continue;
    if (type === "text" && String(block?.text ?? "").trim()) return false;
    if (type === "toolCall") return true;
  }
  return false;
}

// GROK_SESSIONS_ROOT/<encodeURIComponent(cwd)>/<sessionId>/chat_history.jsonl
// -- grok's own on-disk layout. sessions.js discovers past sessions by
// scanning this directly; this adapter only needs to go the other direction
// (recover a sessionId from a chat_history.jsonl path) to resume one.
function sessionFilePathFor(cwd, sessionId) {
  return join(
    GROK_SESSIONS_ROOT(),
    encodeURIComponent(cwd),
    sessionId,
    "chat_history.jsonl",
  );
}

function sessionIdFromPath(sessionPath) {
  return basename(dirname(sessionPath));
}

/** Ids are only unique inside one cwd directory. */
function sameGrokSession(sessionPath, sessionId, cwd) {
  if (!sessionPath || sessionIdFromPath(sessionPath) !== sessionId) return false;
  const pathCwd = cwdFromGrokSession(sessionPath);
  if (pathCwd && cwd && pathCwd !== cwd) return false;
  return true;
}

class GrokAgentProcess {
  constructor(sessionKey) {
    this.sessionKey = sessionKey;
    this.process = undefined;
    this.connection = undefined;
    this.status = "stopped";
    this.sessionId = undefined;
    this.cwd = undefined;
    this.model = undefined;
    this.thinkingLevel = undefined;
    this.agentMode = undefined;
    this.approvalGate = new ApprovalGate(this);
    this.sessionFile = undefined;
    this.lastState = undefined;
    this.listeners = new Set();
    this.turn = undefined;
    this.replayMode = undefined;
    // Set while replaying a resumed session's history. Replayed turns are
    // returned synchronously from start()/replayHistory() and the callers
    // hydrate from that; re-emitting them as live events would only double-
    // render the history (and, once resume is lazy, interleave it into an
    // already-rendered timeline). stderr stays visible — auth/usage failures
    // surface there.
    this.suppressReplayEvents = false;
    this.availableCommands = [];
    this.modelCatalog = undefined;
    this.messages = [];
    this.queuedMessages = [];
    this.queueSeq = 0;
    this.startPromise = undefined;
    this.opening = false;
    attachQueue(this, {
      isBusy() {
        // An idle reminder turn must not park a user prompt in the queue —
        // grok starts those on its own after newSession / a subagent, and
        // treating them as busy made the first hello sit unsent.
        return (
          Boolean(this.turn && !this.turn.idle) || this.subagentFollows.size > 0
        );
      },
      sendNow(message, images) {
        return this.prompt(message, images);
      },
    });
    this.usageCache = { at: 0, result: undefined };
    this.usageRequest = undefined;
    this.subagentFollows = new Map();
    this.parentHoldText = "";
    this.lastChildText = "";
    this.followsDrained = [];
    this.queueIdleTimer = undefined;
    this.suppressCompactUi = false;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    if (this.suppressReplayEvents && event.type !== "stderr") return;
    if (
      this.suppressCompactUi &&
      !["__status", "state", "agent_settled", "stderr"].includes(event.type)
    )
      return;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* listener errors must not kill the pump */
      }
    }
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

  hasConnection() {
    const child = this.process;
    return Boolean(
      child &&
        child.exitCode == null &&
        child.signalCode == null &&
        this.connection,
    );
  }

  isAlive() {
    return this.hasConnection() && Boolean(this.sessionId);
  }

  async ensureRunning(sessionPath, options = {}) {
    const path =
      (typeof sessionPath === "string" && sessionPath) || this.sessionFile;
    if (this.isAlive()) {
      if (!path || sameGrokSession(path, this.sessionId, this.cwd))
        return { ok: true };
      return this.switchSession(path);
    }
    const cwd = cwdFromGrokSession(path) || options.cwd || this.cwd;
    if (!cwd) return { ok: false, error: "Grok session is not running" };
    if (!this.hasConnection()) this.killChild();
    return this.start(cwd, {
      sessionPath: path,
      model: options.model || this.model,
      thinkingLevel: options.thinkingLevel || this.thinkingLevel,
      ...(options.agentMode || this.agentMode
        ? { agentMode: options.agentMode || this.agentMode }
        : {}),
    });
  }

  async warm(cwd, options = {}) {
    return this.start(cwd, { ...options, warmOnly: true });
  }

  async start(cwd, options = {}) {
    if (this.isAlive() && !options.warmOnly)
      return { ok: true, state: await this.getState() };
    if (this.startPromise) {
      await this.startPromise;
      if (this.isAlive() && !options.warmOnly)
        return { ok: true, state: await this.getState() };
      if (options.warmOnly && this.hasConnection())
        return { ok: true, state: await this.getState() };
    }
    this.startPromise = this.doStart(cwd, options);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async doStart(cwd, options = {}) {
    if (this.isAlive() && !options.warmOnly)
      return { ok: true, state: await this.getState() };
    if (options.warmOnly && this.hasConnection())
      return { ok: true, state: await this.getState() };
    if (!this.hasConnection() && this.process) this.killChild();
    let effectiveCwd = cwd;
    if (effectiveCwd && !existsSync(effectiveCwd)) {
      effectiveCwd = homedir();
      queueMicrotask(() =>
        this.emit({
          type: "stderr",
          sessionKey: this.sessionKey,
          message: `cwd not found; opened in ${effectiveCwd} instead`,
        }),
      );
    }
    this.cwd = effectiveCwd;
    this.setStatus("starting");
    this.opening = true;

    try {
      if (!this.hasConnection()) {
        const self = this;
        const opened = await openAcpClient({
          command: this.executable || resolveGrokExecutable(),
          args: GROK_ACP_ARGS,
          env: this.envExtra || {},
          cwd: effectiveCwd,
          onSpawn: (child) => {
            this.process = child;
          },
          onStderr: (chunk) => {
            // grok colours its logs; raw escapes render as "[2m...[0m" noise in
            // the transcript, which is where its network errors surface.
            // node's stream "data" event does not respect line boundaries, so
            // a single log line (e.g. the usage-limit error, which readableAgentError
            // matches with an anchored/line-scoped regex) can arrive split across two
            // chunks. Buffer until a full line is available before parsing.
            this.grokStderrBuf =
              (this.grokStderrBuf ?? "") +
              chunk
                .toString("utf8")
                // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR
                .replace(/\u001b\[[0-9;]*m/g, "");
            const lines = this.grokStderrBuf.split(/\r?\n/);
            this.grokStderrBuf = lines.pop() ?? "";
            const message = lines
              // grok logs ERROR tool_error: tool_output_error for every failed
              // tool (missing file, MCP -32602). The card already shows that.
              .filter((line) => !/\btool_error:\s*tool_output_error\b/i.test(line))
              .join("\n")
              .trim();
            if (message)
              this.emit({ type: "stderr", sessionKey: this.sessionKey, message });
          },
          onError: (error) => {
            this.process = undefined;
            this.connection = undefined;
            this.setStatus("error", error.message);
          },
          onExit: (code, signal) => {
            this.process = undefined;
            // index.js treats a truthy `connection` as "grok is alive" and skips
            // the restart. Left set, every later prompt writes into a closed pipe
            // and hangs forever -- the conversation looks frozen and no message
            // can revive it.
            this.connection = undefined;
            if (this.turn?.idle) {
              // The idle turn is fed by notifications from this child; with the
              // child gone they never arrive. Close it so the composer does not
              // stay "running" and the next prompt is not rejected with "already
              // in progress".
              this.finishIdleTurn();
            } else if (this.turn) {
              this.turn.reject?.(
                new Error(`Grok exited (${signal ?? code ?? "unknown"})`),
              );
              this.turn = undefined;
            }
            // Parent death used to leave jsonl pumps running, so spawn_subagent
            // stayed `running` and the main transcript kept hiding later tools.
            this.stopSubagentFollows();
            if (this.status !== "stopped") {
              this.setStatus(
                code && code !== 0 ? "error" : "stopped",
                code && code !== 0 ? `Grok exited with code ${code}` : undefined,
              );
            }
          },
          handlers: () => ({
            async sessionUpdate(notification) {
              self.handleSessionUpdate(notification);
            },
            async requestPermission(params) {
              if (!sessionUpdateIsFor(self.sessionId, params))
                return { outcome: { outcome: "cancelled" } };
              const options = params.options ?? [];
              // Manual mode routes the ask to the UI; the choice comes back
              // as a gate option id, which maps onto ACP's optionId here.
              // Read-only calls (kind "read") never prompt — same category
              // split the pi extension and Claude Code use.
              const toolKind = String(params.toolCall?.kind ?? "");
              if (
                self.agentMode === "auto-edit" &&
                !/execute|delete/i.test(toolKind)
              ) {
                const allow = options.find(
                  (o) => o.kind === "allow_once" || o.kind === "allow_always",
                );
                return allow
                  ? {
                      outcome: {
                        outcome: "selected",
                        optionId: allow.optionId,
                      },
                    }
                  : { outcome: { outcome: "cancelled" } };
              }
              if (
                self.agentMode === "manual" ||
                self.agentMode === "auto-edit"
              ) {
                if (params.toolCall?.kind === "read") {
                  const readAllow = options.find(
                    (o) => o.kind === "allow_once" || o.kind === "allow_always",
                  );
                  return readAllow
                    ? {
                        outcome: {
                          outcome: "selected",
                          optionId: readAllow.optionId,
                        },
                      }
                    : { outcome: { outcome: "cancelled" } };
                }
                const { allow, choice } = await self.approvalGate.request({
                  toolName:
                    self.agentMode === "auto-edit"
                      ? `${toolKind} ${String(params.toolCall?.title ?? "tool")}`
                      : String(params.toolCall?.title ?? "tool"),
                  title: String(params.toolCall?.title ?? "tool"),
                  detail: params.toolCall?.rawInput,
                  options: options.map((option) => ({
                    id: option.optionId,
                    label:
                      option.name ??
                      (option.kind === "allow_once"
                        ? "Allow once"
                        : option.kind === "allow_always"
                          ? "Always allow"
                          : option.kind === "reject_once"
                            ? "Deny"
                            : (option.kind ?? "Skip")),
                  })),
                });
                const picked = options.find(
                  (option) => option.optionId === choice,
                );
                if (allow && picked)
                  return {
                    outcome: {
                      outcome: "selected",
                      optionId: picked.optionId,
                    },
                  };
                const reject = options.find((o) => o.kind === "reject_once");
                return reject
                  ? {
                      outcome: {
                        outcome: "selected",
                        optionId: reject.optionId,
                      },
                    }
                  : { outcome: { outcome: "cancelled" } };
              }
              const chosen =
                options.find((o) => o.kind === "allow_always") ??
                options.find((o) => o.kind === "allow_once") ??
                options[0];
              return chosen
                ? {
                    outcome: { outcome: "selected", optionId: chosen.optionId },
                  }
                : { outcome: { outcome: "cancelled" } };
            },
            async writeTextFile() {
              throw new Error(
                "writeTextFile not supported by devden's grok client",
              );
            },
            async readTextFile() {
              throw new Error(
                "readTextFile not supported by devden's grok client",
              );
            },
          }),
        });
        this.connection = opened.connection;
      }

      // Prefetch so a later model picker / resolveEffort doesn't wait on
      // the network. Must not sit on the first-token path.
      void this.fetchModelCatalog().catch(() => {});

      if (options.warmOnly) {
        this.model = options.model?.id
          ? { provider: "grok-sdk", id: options.model.id }
          : (this.model ?? { provider: "grok-sdk", id: "grok-4.6" });
        if (options.thinkingLevel) this.thinkingLevel = options.thinkingLevel;
        if (options.agentMode) this.agentMode = options.agentMode;
        this.setStatus("ready");
        return { ok: true, state: await this.getState() };
      }

      let replayedMessages;
      if (options.agentMode) this.agentMode = options.agentMode;
      if (options.sessionPath) {
        this.sessionId = sessionIdFromPath(options.sessionPath);
        this.model = options.model?.id
          ? { provider: "grok-sdk", id: options.model.id }
          : { provider: "grok-sdk", id: "grok-4.6" };
        replayedMessages = await this.replayHistory(effectiveCwd);
      } else {
        const newSession = await this.connection.newSession({
          cwd: effectiveCwd,
          mcpServers: [],
        });
        this.sessionId = newSession.sessionId;
        this.messages = [];
        this.model = options.model?.id
          ? { provider: "grok-sdk", id: options.model.id }
          : { provider: "grok-sdk", id: "grok-4.6" };
        if (options.agentMode) this.agentMode = options.agentMode;
        if (options.model?.id) {
          try {
            await this.connection.setSessionMode({
              sessionId: this.sessionId,
              modeId: options.model.id,
            });
          } catch {
            /* model selection is best-effort at session creation */
          }
        }
      }
      // Grok advertises a different effort ladder per model (grok-4.6 adds
      // xhigh, grok-4.5 stops at high), so an unset or unsupported effort
      // falls back to whatever the model itself marks as default -- that is
      // the level the session actually runs at, and the UI reads it back
      // from getState(). The UI already sends a level on a fresh tab;
      // skipping the catalog fetch keeps that off the first-token path.
      this.thinkingLevel =
        options.thinkingLevel || this.thinkingLevel
          ? options.thinkingLevel || this.thinkingLevel
          : await this.resolveEffort(this.model?.id, this.thinkingLevel);
      if (this.thinkingLevel) {
        try {
          await this.connection.setSessionMode({
            sessionId: this.sessionId,
            modeId: this.thinkingLevel,
          });
        } catch {
          /* effort selection is best-effort at session creation */
        }
      }
      this.sessionFile = sessionFilePathFor(effectiveCwd, this.sessionId);
      this.setStatus("ready");
      const state = await this.getState();
      // Resume relies on the response carrying the replayed history directly
      // -- mirrors PiAgentProcess/ClaudeAgentProcess.start(), which read the
      // session file and return `messages` synchronously rather than relying
      // on the caller's SSE listener already being attached in time to catch
      // events emitted during this same call.
      return replayedMessages
        ? { ok: true, state, messages: replayedMessages }
        : { ok: true, state };
    } catch (error) {
      // A failed initialize()/loadSession must not orphan the child: it holds
      // a lock on the session's events.jsonl and would keep running (and
      // streaming to nobody) until the server exits.
      this.killChild();
      this.setStatus("error", String(error?.message ?? error));
      return { ok: false, error: String(error?.message ?? error) };
    } finally {
      this.opening = false;
    }
  }

  // Replays a resumed session's full history. loadSession() streams the
  // whole conversation back as session/update notifications on the same
  // channel live turns use; a user_message_chunk marks the start of each
  // historical turn, so it's the boundary signal for splitting the replay
  // into discrete (user, assistant) message pairs that reuse the exact same
  // per-block accumulation logic as a live turn (appendDelta/startToolCall/
  // updateToolCall/closeOpenBlock all read and write plain "turn" objects,
  // agnostic to whether the turn is live or replayed).
  async replayHistory(cwd) {
    this.emit({ type: "agent_start", sessionKey: this.sessionKey });
    this.messages = [];
    const replayedMessages = [];

    const finalizeTurn = () => {
      if (!this.turn) return;
      this.closeOpenBlock(this.turn);
      const assistantMessage = this.turn.message;
      assistantMessage.stopReason = "end_turn";
      this.emit({
        type: "turn_end",
        sessionKey: this.sessionKey,
        message: assistantMessage,
      });
      this.emit({
        type: "agent_end",
        sessionKey: this.sessionKey,
        messages: [this.turn.userMessage, assistantMessage],
      });
      replayedMessages.push(this.turn.userMessage, assistantMessage);
      this.messages.push(this.turn.userMessage, assistantMessage);
      this.turn = undefined;
    };

    const startTurn = (userText) => {
      this.emit({ type: "turn_start", sessionKey: this.sessionKey });
      const userMessage = {
        role: "user",
        content: [{ type: "text", text: stripClarifyPrefix(userText) }],
        timestamp: Date.now(),
      };
      this.emit({
        type: "message_start",
        sessionKey: this.sessionKey,
        message: userMessage,
      });
      this.emit({
        type: "message_end",
        sessionKey: this.sessionKey,
        message: userMessage,
      });
      const assistantMessage = {
        role: "assistant",
        content: [],
        api: "grok-sdk",
        provider: "grok-sdk",
        model: this.model?.id ?? "grok-4.6",
        usage: zeroUsage(),
        stopReason: "pending",
        timestamp: Date.now(),
      };
      this.emit({
        type: "message_start",
        sessionKey: this.sessionKey,
        message: assistantMessage,
      });
      this.turn = {
        content: assistantMessage.content,
        openKind: undefined,
        openIndex: undefined,
        toolIndex: new Map(),
        message: assistantMessage,
        userMessage,
      };
    };

    this.replayMode = {
      onUserChunk: (text) => {
        finalizeTurn();
        startTurn(text);
      },
    };
    this.suppressReplayEvents = true;
    try {
      // replayMode is armed before this call so every history notification
      // loadSession() streams back lands in handleSessionUpdate above.
      await this.connection.loadSession({
        sessionId: this.sessionId,
        cwd,
        mcpServers: [],
      });
    } finally {
      finalizeTurn();
      this.replayMode = undefined;
      this.suppressReplayEvents = false;
    }
    return replayedMessages;
  }

  handleSessionUpdate(notification) {
    if (!sessionUpdateIsFor(this.sessionId, notification)) return;
    const update = notification.update;
    if (update.sessionUpdate === "available_commands_update") {
      this.availableCommands = Array.isArray(update.availableCommands)
        ? update.availableCommands
        : [];
    }
    if (update.sessionUpdate === "user_message_chunk" && this.replayMode) {
      this.replayMode.onUserChunk(acpTextOf(update.content));
      return;
    }
    // Child tools and mirrored tokens also arrive on the parent ACP stream,
    // usually untagged. While a jsonl follow is live those belong in the
    // pane; the parent turn may already have settled (spawn is background).
    // Pump first so hide sees ids the child already wrote.
    if (!this.turn && this.subagentFollows.size > 0 && !this.replayMode) {
      this.pumpAllSubagents();
      if (
        update.sessionUpdate === "agent_thought_chunk" ||
        update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update"
      )
        return;
    }
    let turn = this.turn;
    if (!turn) {
      // grok continues the session on its own after a background subagent
      // completes: the completion reminder triggers a fresh turn with no
      // prompt from this side. Without synthesizing a turn here, the
      // parent's handover narration streamed while `this.turn` was undefined
      // and never reached the timeline — the findings only appeared after
      // a page refresh re-read the session file.
      // newSession/initialize also emit chunks (user_info, skills). Treating
      // those as an idle turn marked the session working and queued the
      // user's first prompt behind a turn nobody was running.
      if (
        !this.replayMode &&
        !this.opening &&
        (update.sessionUpdate === "agent_message_chunk" ||
          update.sessionUpdate === "agent_thought_chunk")
      ) {
        this.startIdleTurn();
        turn = this.turn;
      } else {
        this.emit({
          type: "grok_session_update",
          sessionKey: this.sessionKey,
          update,
        });
        return;
      }
    }
    // turn_completed carries the turn's token usage (including grok's cache
    // reads). Recorded before the idle branch returns, so it lands on the
    // message whichever way the turn finishes.
    if (turn && update.sessionUpdate === "turn_completed" && update.usage)
      turn.message.usage = usageFrom(update.usage);
    if (turn?.idle && update.sessionUpdate === "turn_completed") {
      this.finishIdleTurn();
      return;
    }
    switch (update.sessionUpdate) {
      case "agent_thought_chunk":
        if (this.subagentFollows.size > 0) return;
        this.appendDelta(turn, "thinking", acpTextOf(update.content));
        return;
      case "agent_message_chunk": {
        const delta = acpTextOf(update.content);
        if (this.subagentFollows.size > 0) {
          this.pumpAllSubagents();
          const childText = [...this.subagentFollows.values()]
            .map((follow) => follow.text)
            .join("");
          // Child already talking: hold parent-stream text until handover so
          // mirrored nested tokens never flash in the main chat. Before that,
          // the parent is allowed to say it spawned a child.
          if (childText.length >= 20) {
            this.parentHoldText += delta;
            return;
          }
        }
        this.appendDelta(turn, "text", delta);
        return;
      }
      case "tool_call":
        this.pumpAllSubagents();
        if (this.shouldHideParentTool(update)) return;
        this.startToolCall(turn, update);
        return;
      case "tool_call_update":
        this.pumpAllSubagents();
        if (this.shouldHideParentTool(update)) return;
        this.updateToolCall(turn, update);
        return;
      default:
        // plan / current_mode_update / etc. -- preserve on the shared event
        // stream rather than dropping silently.
        this.emit({
          type: "grok_session_update",
          sessionKey: this.sessionKey,
          update,
        });
    }
  }

  closeOpenBlock(turn) {
    if (turn.openKind === "text") {
      const block = turn.content[turn.openIndex];
      this.emitUpdate(turn, {
        type: "text_end",
        contentIndex: turn.openIndex,
        content: block.text,
      });
    } else if (turn.openKind === "thinking") {
      const block = turn.content[turn.openIndex];
      this.emitUpdate(turn, {
        type: "thinking_end",
        contentIndex: turn.openIndex,
        content: block.thinking,
      });
    }
    turn.openKind = undefined;
    turn.openIndex = undefined;
  }

  appendDelta(turn, kind, delta) {
    if (!delta) return;
    if (turn.openKind !== kind) {
      this.closeOpenBlock(turn);
      turn.content.push(
        kind === "text"
          ? { type: "text", text: "" }
          : { type: "thinking", thinking: "" },
      );
      turn.openIndex = turn.content.length - 1;
      turn.openKind = kind;
      this.emitUpdate(turn, {
        type: kind === "text" ? "text_start" : "thinking_start",
        contentIndex: turn.openIndex,
      });
    }
    const block = turn.content[turn.openIndex];
    if (kind === "text") block.text += delta;
    else block.thinking += delta;
    this.emitUpdate(turn, {
      type: kind === "text" ? "text_delta" : "thinking_delta",
      contentIndex: turn.openIndex,
      delta,
    });
  }

  shouldHideParentTool(update) {
    return parentToolBelongsToFollow(this.subagentFollows, update, this.turn);
  }

  pumpAllSubagents() {
    for (const follow of [...this.subagentFollows.values()])
      this.pumpSubagent(follow);
  }

  startToolCall(turn, update) {
    this.closeOpenBlock(turn);
    const name = update.title ?? update.toolCallId;
    const block = {
      type: "toolCall",
      id: update.toolCallId,
      name,
      kind: update.kind,
      arguments: update.rawInput ?? {},
    };
    turn.content.push(block);
    const index = turn.content.length - 1;
    turn.toolIndex.set(update.toolCallId, index);
    this.emitUpdate(turn, { type: "toolcall_start", contentIndex: index });
    let parentToolUseId = parentToolUseIdOf(update);
    if (!parentToolUseId) {
      for (const follow of this.subagentFollows.values()) {
        if (follow.toolNames.has(update.toolCallId)) {
          parentToolUseId = follow.parentToolUseId;
          break;
        }
      }
    }
    this.emit({
      type: "tool_execution_start",
      sessionKey: this.sessionKey,
      toolCallId: update.toolCallId,
      toolName: name,
      args: block.arguments,
      execKind:
        update.kind ?? (SHELL_TOOL_NAMES.has(name) ? "execute" : undefined),
      ...(parentToolUseId ? { parentToolUseId } : {}),
    });
    if (isSubagentToolName(name)) {
      this.emit({
        type: "subagent_start",
        sessionKey: this.sessionKey,
        parentToolUseId: update.toolCallId,
      });
    }
    if (update.status === "completed" || update.status === "failed") {
      this.finishToolCall(turn, index, update);
    }
  }

  updateToolCall(turn, update) {
    const index = turn.toolIndex.get(update.toolCallId);
    if (index === undefined) return; // update for a call we didn't see start
    const block = turn.content[index];
    // The first notification's title is grok's raw tool name (read_file,
    // run_terminal_command, ...), which is what the UI's tool cards key on;
    // later updates replace it with a prose title ("Read `notes.txt`") that
    // matches nothing. Keep the name we started with.
    if (update.rawInput != null) block.arguments = update.rawInput;
    this.emitUpdate(turn, {
      type: "toolcall_delta",
      contentIndex: index,
      delta: "",
    });
    if (isSubagentToolName(block.name) && update.content) {
      const output = toolResultText(update.content);
      if (output) {
        this.emit({
          type: "tool_execution_update",
          sessionKey: this.sessionKey,
          toolCallId: update.toolCallId,
          partialResult: {
            content: [{ type: "text", text: output }],
          },
        });
      }
    }
    if (update.status === "completed" || update.status === "failed") {
      this.finishToolCall(turn, index, update);
    }
  }

  finishToolCall(turn, index, update) {
    const block = turn.content[index];
    if (isSubagentToolName(block.name) && update.status !== "failed") {
      const output = toolResultText(update.content);
      const childId = parseSubagentId(output);
      this.emit({
        type: "tool_execution_update",
        sessionKey: this.sessionKey,
        toolCallId: update.toolCallId,
        partialResult: {
          content: [{ type: "text", text: output }],
        },
      });
      if (childId && this.cwd) {
        this.followSubagent(update.toolCallId, childId);
        return;
      }
    }
    this.emitUpdate(turn, {
      type: "toolcall_end",
      contentIndex: index,
      toolCall: {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: block.arguments,
      },
    });
    this.emit({
      type: "tool_execution_end",
      sessionKey: this.sessionKey,
      toolCallId: update.toolCallId,
      result: {
        content: [{ type: "text", text: toolResultText(update.content) }],
        details: update.rawOutput ?? {},
      },
      isError: update.status === "failed",
    });
  }

  followSubagent(parentToolUseId, subagentId) {
    if (this.subagentFollows.has(parentToolUseId)) return;
    const follow = {
      parentToolUseId,
      subagentId,
      offset: 0,
      text: "",
      thinking: "",
      // The child narrates in separate blocks (opening chatter, then the
      // final findings after its tools). Each block keeps its own index so
      // the panel shows them where they actually happened, not glued onto
      // the first block's position above every tool card.
      segments: [""],
      segmentToolCount: undefined,
      lastAdvance: Date.now(),
      toolNames: new Map(),
      timer: undefined,
    };
    this.subagentFollows.set(parentToolUseId, follow);
    const tick = () => this.pumpSubagent(follow);
    // Set the interval before the first tick: a child that is already done
    // finishes on that tick, and finishSubagentFollow's clearInterval must
    // find a real timer or the interval re-finishes and double-emits.
    follow.timer = setInterval(tick, 200);
    tick();
  }

  pumpSubagent(follow) {
    if (!this.cwd) return;
    const path = childUpdatesPath(this.cwd, follow.subagentId);
    const { lines, offset, missing } = readJsonlFromOffset(path, follow.offset);
    if (missing) {
      this.checkSubagentDone(follow);
      return;
    }
    if (offset > follow.offset) follow.lastAdvance = Date.now();
    follow.offset = offset;
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.method === "_x.ai/session/update") {
        const kind = event.params?.update?.sessionUpdate;
        if (kind === "turn_completed") follow.turnCompleted = true;
        continue;
      }
      if (event.method !== "session/update") continue;
      this.handleChildUpdate(follow, event.params?.update);
    }
    this.checkSubagentDone(follow);
  }

  handleChildUpdate(follow, update) {
    if (!update || typeof update !== "object") return;
    const parentToolUseId = follow.parentToolUseId;
    const streamKey = `grok-sub-${parentToolUseId}`;
    if (update.sessionUpdate === "agent_thought_chunk") {
      // Thinking stays off the subagent pane — same as the main chat.
      return;
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      const delta = acpTextOf(update.content);
      if (!delta) return;
      // A message that starts after the child has run tools is a new block
      // of its transcript (the final findings after the opening narration),
      // not a continuation of the first — otherwise the findings would
      // render at the first block's position, above the tool cards that
      // actually preceded them.
      if (
        follow.segmentToolCount !== undefined &&
        follow.segmentToolCount < follow.toolNames.size
      )
        follow.segments.push("");
      follow.segmentToolCount = follow.toolNames.size;
      const index = follow.segments.length - 1;
      follow.segments[index] += delta;
      follow.text += delta;
      this.emit({
        type: "message_update",
        sessionKey: this.sessionKey,
        streamKey,
        parentToolUseId,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: index,
          delta,
        },
      });
      return;
    }
    if (update.sessionUpdate === "tool_call") {
      const name = update.title ?? update.toolCallId;
      follow.toolNames.set(update.toolCallId, name);
      this.emit({
        type: "tool_execution_start",
        sessionKey: this.sessionKey,
        toolCallId: update.toolCallId,
        toolName: name,
        args: update.rawInput ?? {},
        execKind:
          update.kind ?? (SHELL_TOOL_NAMES.has(name) ? "execute" : undefined),
        parentToolUseId,
      });
      if (update.status === "completed" || update.status === "failed") {
        this.emitChildToolEnd(follow, update);
      }
      return;
    }
    if (update.sessionUpdate === "tool_call_update") {
      if (update.rawInput && !follow.toolNames.has(update.toolCallId)) {
        const name = update.title ?? update.toolCallId;
        follow.toolNames.set(update.toolCallId, name);
        this.emit({
          type: "tool_execution_start",
          sessionKey: this.sessionKey,
          toolCallId: update.toolCallId,
          toolName: name,
          args: update.rawInput,
          parentToolUseId,
        });
      }
      if (update.status === "completed" || update.status === "failed") {
        this.emitChildToolEnd(follow, update);
      }
    }
  }

  emitChildToolEnd(follow, update) {
    this.emit({
      type: "tool_execution_end",
      sessionKey: this.sessionKey,
      toolCallId: update.toolCallId,
      result: {
        content: [{ type: "text", text: grokToolOutputText(update) }],
        details: update.rawOutput ?? {},
      },
      isError: update.status === "failed",
      parentToolUseId: follow.parentToolUseId,
    });
  }

  checkSubagentDone(follow) {
    if (!this.cwd) return;
    let status = "";
    if (this.sessionId) {
      try {
        const meta = JSON.parse(
          readFileSync(
            childMetaPath(this.cwd, this.sessionId, follow.subagentId),
            "utf8",
          ),
        );
        status = String(meta.status ?? "");
      } catch {
        /* meta is written when the child finishes */
      }
    }
    const failed = status === "failed";
    const done = follow.turnCompleted || status === "completed" || failed;
    if (!done) {
      // A silent child is a dead child: without this bail the spawn card
      // stays `running` and isHeldMainTool keeps hiding later parent tools.
      if (Date.now() - follow.lastAdvance < stallMs) return;
      this.finishSubagentFollow(follow, true);
      return;
    }
    if (!failed && !this.readChildOutput(follow)) {
      if (follow.outputWaitUntil === undefined)
        follow.outputWaitUntil = Date.now() + outputWaitMs;
      if (Date.now() < follow.outputWaitUntil) return;
    }
    this.finishSubagentFollow(follow, failed);
  }

  /** The child's official findings from output.json; "" when the file has
   *  not landed yet. checkSubagentDone retries for outputWaitMs after
   *  turn_completed so a late write still wins over streamed chatter. */
  readChildOutput(follow) {
    if (!this.cwd || !this.sessionId) return "";
    try {
      const parsed = JSON.parse(
        readFileSync(
          childOutputPath(this.cwd, this.sessionId, follow.subagentId),
          "utf8",
        ),
      );
      return typeof parsed?.output === "string" ? parsed.output : "";
    } catch {
      return "";
    }
  }

  finishSubagentFollow(follow, failed) {
    if (follow.timer) {
      clearInterval(follow.timer);
      follow.timer = undefined;
    }
    const streamKey = `grok-sub-${follow.parentToolUseId}`;
    if (follow.text) {
      this.lastChildText = [this.lastChildText, follow.text]
        .filter(Boolean)
        .join("\n");
    }
    const { blocks, resultText } = subagentFindings(
      follow.segments,
      failed ? "" : this.readChildOutput(follow),
    );
    for (const block of blocks) {
      this.emit({
        type: "message_update",
        sessionKey: this.sessionKey,
        streamKey,
        parentToolUseId: follow.parentToolUseId,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: block.contentIndex,
          content: block.content,
        },
      });
    }
    this.emit({
      type: "tool_execution_end",
      sessionKey: this.sessionKey,
      toolCallId: follow.parentToolUseId,
      result: {
        content: [{ type: "text", text: resultText }],
      },
      isError: failed,
    });
    this.subagentFollows.delete(follow.parentToolUseId);
    if (this.subagentFollows.size === 0) {
      this.flushHeldParentText();
      const drained = this.followsDrained;
      this.followsDrained = [];
      for (const resolve of drained) resolve();
    }
  }

  flushHeldParentText() {
    const leftover = parentTextAfterChild(
      this.parentHoldText,
      this.lastChildText,
    );
    this.parentHoldText = "";
    if (!leftover || !this.turn) return;
    this.appendDelta(this.turn, "text", leftover);
  }

  /** Wait for live subagent panes to drain before settling the parent turn.
   *  Bounded: a follow whose child died, or whose artifacts stopped growing
   *  before the pump saw a terminal state, never calls back — and this is
   *  awaited *after* watchTurnCompletion's file timer is cleared, so an
   *  unbounded wait left the turn open with no watchdog behind it. That is
   *  the "grok is still thinking but the reply is already on disk, refresh
   *  to see it" stall. A late settle beats a turn that never ends. */
  waitForSubagentFollows() {
    if (this.subagentFollows.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        // Close the panes too, or they keep the next turn's isBusy() true.
        this.stopSubagentFollows();
        settle();
        // Twice the per-follow stall watchdog: this only ever fires when
        // that watchdog itself failed to drain the pane.
      }, stallMs * 2);
      timer.unref?.();
      this.followsDrained.push(settle);
    });
  }

  /** Send the next queued prompt only once nothing else is printing.
   *  A follow-up flushed the instant ACP returned landed inside the still-
   *  running spawn (and grok's idle handover), which scrambled the
   *  transcript and printed the follow-up reply before its own user bubble
   *  belonged there. */
  flushQueueWhenIdle() {
    if (this.queueIdleTimer) {
      clearTimeout(this.queueIdleTimer);
      this.queueIdleTimer = undefined;
    }
    this.queueIdleTimer = setTimeout(() => {
      this.queueIdleTimer = undefined;
      if (this.turn || this.subagentFollows.size > 0) return;
      this.sendNextQueued();
    }, queueIdleMs);
  }

  stopSubagentFollows() {
    const follows = [...this.subagentFollows.values()];
    for (const follow of follows) {
      this.finishSubagentFollow(follow, true);
    }
  }

  emitUpdate(_turn, assistantMessageEvent) {
    this.emit({
      type: "message_update",
      sessionKey: this.sessionKey,
      usage: zeroUsage(),
      assistantMessageEvent,
    });
  }

  async runTurn(kind, message, images) {
    if (!this.isAlive()) {
      const revived = await this.ensureRunning();
      if (!revived.ok)
        return {
          ok: false,
          error: revived.error ?? "Grok session is not running",
        };
    }
    if (this.turn?.idle) this.finishIdleTurn();
    if (this.turn)
      return {
        ok: false,
        error:
          kind === "steer"
            ? "Grok agent does not support steering mid-turn yet"
            : "A Grok turn is already in progress",
      };

    // The clarify gate applies to what the user typed; a harness follow-up
    // (a goal check-in, an interrupted-turn resume) must not be told to stop
    // and ask questions instead of continuing.
    const promptBlocks = [
      {
        type: "text",
        text:
          kind === "prompt"
            ? withGrokPrefix(
                message,
                repoContext(this.cwd),
                this.agentMode === "manual" ||
                  this.agentMode === "auto-edit",
              )
            : message,
      },
    ];
    for (const image of images ?? []) {
      if (image?.data && image?.mimeType)
        promptBlocks.push({
          type: "image",
          data: image.data,
          mimeType: image.mimeType,
        });
    }

    const userMessage = {
      role: "user",
      content: [{ type: "text", text: message }],
      timestamp: Date.now(),
    };
    this.parentHoldText = "";
    this.lastChildText = "";
    this.emit({ type: "agent_start", sessionKey: this.sessionKey });
    this.emit({ type: "turn_start", sessionKey: this.sessionKey });
    // A follow-up is the harness talking, not the user: showing its
    // instruction block as a user message would put text in the transcript
    // that the user never typed.
    if (kind !== "follow_up") {
      this.emit({
        type: "message_start",
        sessionKey: this.sessionKey,
        message: userMessage,
      });
      this.emit({
        type: "message_end",
        sessionKey: this.sessionKey,
        message: userMessage,
      });
    }

    const assistantMessage = {
      role: "assistant",
      content: [],
      api: "grok-sdk",
      provider: "grok-sdk",
      model: this.model?.id ?? "grok-4.6",
      usage: zeroUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
    };
    this.emit({
      type: "message_start",
      sessionKey: this.sessionKey,
      message: assistantMessage,
    });

    this.turn = {
      content: assistantMessage.content,
      openKind: undefined,
      openIndex: undefined,
      toolIndex: new Map(),
      // The replay and idle turns carry this too; without it the
      // turn_completed usage handler has nothing to write onto.
      message: assistantMessage,
    };
    this.setStatus("working");
    // grok journals turn_completed off the ACP stream. Idle turns already
    // watched that file; a normal prompt that hung after the reply was on
    // disk left the UI on "Grok is thinking" until a refresh re-read it.
    this.watchTurnCompletion(this.turn);
    const turn = this.turn;

    try {
      // The exit handler and stop() reject through turn.reject. Without this
      // wiring they were silent no-ops and a child that died mid-turn hung
      // the awaited prompt forever — the session stayed "running" and every
      // later prompt was queued behind a turn nobody was executing.
      const response = await new Promise((resolve, reject) => {
        turn.reject = reject;
        turn.resolve = resolve;
        this.connection
          .prompt({ sessionId: this.sessionId, prompt: promptBlocks })
          .then(
            (value) => {
              if (this.turn === turn) resolve(value);
            },
            (error) => {
              if (this.turn === turn) reject(error);
            },
          );
      });
      clearInterval(turn.fileTimer);
      this.closeOpenBlock(this.turn);
      assistantMessage.stopReason = response.stopReason;
      if (this.subagentFollows.size > 0) await this.waitForSubagentFollows();
      if (!this.turn) {
        this.setStatus("ready");
        this.emit({ type: "agent_settled", sessionKey: this.sessionKey });
        return { ok: false, error: "Grok turn was stopped" };
      }
      this.flushHeldParentText();
      this.closeOpenBlock(this.turn);
      // The timeline only records usage from message_end. turn_end alone
      // left the session card summing nothing, or summing a stale copy.
      this.emit({
        type: "message_end",
        sessionKey: this.sessionKey,
        message: assistantMessage,
      });
      this.emit({
        type: "turn_end",
        sessionKey: this.sessionKey,
        message: assistantMessage,
      });
      const turnMessages =
        kind === "follow_up"
          ? [assistantMessage]
          : [userMessage, assistantMessage];
      this.emit({
        type: "agent_end",
        sessionKey: this.sessionKey,
        messages: turnMessages,
      });
      this.messages.push(...turnMessages);
      this.turn = undefined;
      if (this.subagentFollows.size === 0) this.lastChildText = "";
      this.setStatus("ready");
      this.emit({ type: "agent_settled", sessionKey: this.sessionKey });
      this.flushQueueWhenIdle();
      const state = await this.getState();
      this.emit({ type: "state", sessionKey: this.sessionKey, state });
      return { ok: true, state };
    } catch (error) {
      clearInterval(turn?.fileTimer);
      this.turn = undefined;
      this.stopSubagentFollows();
      const message = String(error?.message ?? error);
      // A user stop already moved the session to "stopped"; re-marking it
      // ready or notifying would resurrect a stopped agent. Otherwise,
      // without the settle the composer spins forever and the interrupted-
      // turn record never settles, so the next boot resumes a turn that
      // already failed.
      if (this.status !== "stopped") {
        this.setStatus("ready");
        this.emit({
          type: "notice",
          sessionKey: this.sessionKey,
          message,
          tone: "error",
        });
      }
      this.emit({ type: "agent_settled", sessionKey: this.sessionKey });
      return { ok: false, error: message };
    }
  }

  prompt(message, images) {
    return this.runTurn("prompt", message, images);
  }

  /** A turn grok started on its own — the background-subagent completion
   *  reminder (or a goal check-in) triggers the parent without a prompt
   *  from this side. Streamed live like any other turn so the handover
   *  narration reaches the main transcript without a page refresh. */
  startIdleTurn() {
    if (this.opening || !this.sessionId) return;
    const assistantMessage = {
      role: "assistant",
      content: [],
      api: "grok-sdk",
      provider: "grok-sdk",
      model: this.model?.id ?? "grok-4.6",
      usage: zeroUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
    };
    this.emit({ type: "agent_start", sessionKey: this.sessionKey });
    this.emit({ type: "turn_start", sessionKey: this.sessionKey });
    this.emit({
      type: "message_start",
      sessionKey: this.sessionKey,
      message: assistantMessage,
    });
    this.turn = {
      content: assistantMessage.content,
      openKind: undefined,
      openIndex: undefined,
      toolIndex: new Map(),
      idle: true,
      message: assistantMessage,
    };
    // ponytail: the reminder turn is fed by the child's notification
    // stream. If that stream dies mid-narration the turn would stay open
    // forever and wedge the session on "running"; close it after a silent
    // stall instead. If a very slow report overruns the window, its tail
    // chunks simply open a fresh idle turn — self-healing.
    const turn = this.turn;
    turn.stallTimer = setTimeout(() => {
      if (this.turn === turn) this.finishIdleTurn();
    }, stallMs);
    this.watchTurnCompletion(turn);
    this.setStatus("working");
  }

  /** grok journals turn_completed with a non-ACP method, so neither an idle
   *  reminder turn nor a hung `connection.prompt()` hears completion through
   *  handleSessionUpdate. The session file is the ground truth: poll the
   *  journal and close the turn within one tick. */
  watchTurnCompletion(turn) {
    if (!this.cwd || !this.sessionId) return;
    const path = sessionUpdatesPath(this.cwd, this.sessionId);
    let offset = 0;
    try {
      offset = statSync(path).size;
    } catch {
      /* file appears once grok journals its first update */
    }
    turn.fileTimer = setInterval(() => {
      if (this.turn !== turn) {
        clearInterval(turn.fileTimer);
        return;
      }
      const { lines, offset: next } = readJsonlFromOffset(path, offset);
      offset = next;
      for (const line of lines) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.params?.update?.sessionUpdate === "turn_completed") {
          if (event.params.update.usage)
            turn.message.usage = usageFrom(event.params.update.usage);
          if (turn.idle) {
            clearInterval(turn.fileTimer);
            this.finishIdleTurn();
            return;
          }
          // A generation that still ends on tools is not the user prompt
          // finishing. Resolving here settled the UI and dropped whatever
          // grok streamed next — the cut-off turn. Keep watching.
          if (assistantEndedOnTools(turn.content)) continue;
          clearInterval(turn.fileTimer);
          turn.resolve?.({ stopReason: "end_turn" });
          return;
        }
      }
    }, 200);
  }

  finishIdleTurn() {
    const turn = this.turn;
    if (!turn?.idle) return;
    clearTimeout(turn.stallTimer);
    clearInterval(turn.fileTimer);
    this.turn = undefined;
    this.closeOpenBlock(turn);
    turn.message.stopReason = "end_turn";
    this.emit({
      type: "message_end",
      sessionKey: this.sessionKey,
      message: turn.message,
    });
    this.emit({
      type: "turn_end",
      sessionKey: this.sessionKey,
      message: turn.message,
    });
    this.emit({
      type: "agent_end",
      sessionKey: this.sessionKey,
      messages: [turn.message],
    });
    this.messages.push(turn.message);
    this.setStatus("ready");
    this.emit({ type: "agent_settled", sessionKey: this.sessionKey });
    this.flushQueueWhenIdle();
    void this.getState()
      .then((state) =>
        this.emit({ type: "state", sessionKey: this.sessionKey, state }),
      )
      .catch(() => {});
  }

  steer(message, images) {
    return this.runTurn("steer", message, images);
  }

  // ACP has no separate follow-up channel; a follow-up is an ordinary prompt
  // the harness rather than the user originated. Named to match the other
  // adapters so callers (goal check-ins, interrupted-turn resume) need no
  // per-backend branch.
  followUp(message, images) {
    return this.runTurn("follow_up", message, images);
  }

  // grok's own slash commands (compact, always-approve, context, ...) are
  // plain prompt text as far as ACP is concerned -- grok's harness parses
  // the leading "/name" itself, same convention its own CLI uses.
  async compact(customInstructions) {
    const text = customInstructions
      ? `/compact ${customInstructions}`
      : "/compact";
    this.suppressCompactUi = true;
    try {
      const result = await this.runTurn("follow_up", text);
      if (!result.ok) return result;
      let messages = [];
      if (this.sessionFile && existsSync(this.sessionFile)) {
        messages = stripTrailingCompactTurn(
          messagesFromGrokLog(readFileSync(this.sessionFile, "utf8")),
        );
      }
      return {
        ok: true,
        state: await this.getState(),
        messages,
      };
    } finally {
      this.suppressCompactUi = false;
    }
  }

  async abort() {
    // Cancel the ACP turn AND the jsonl follows. connection.cancel alone
    // left spawn_subagent `running`, so isHeldMainTool kept hiding later
    // parent tools after the user hit interrupt.
    this.approvalGate.denyAll();
    this.holdQueue();
    this.stopSubagentFollows();
    if (!this.connection || !this.sessionId) return { ok: true };
    try {
      await this.connection.cancel({ sessionId: this.sessionId });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** Manual-mode answer from POST /api/<key>/approve. */
  resolveApproval(requestId, optionId) {
    return this.approvalGate.resolve(requestId, optionId);
  }

  // Hot-swaps an already-running process onto a different saved session,
  // mirroring PiAgentProcess.switchSession. ACP has no "rebind this
  // connection to another session" primitive, so this restarts the
  // underlying grok process against the requested session.
  async switchSession(sessionPath) {
    if (!sessionPath) return { ok: false, error: "sessionPath is required" };
    if (sessionPath === this.sessionFile) {
      try {
        return { ok: true, state: await this.getState() };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }
    const cwd = cwdFromGrokSession(sessionPath) || this.cwd || homedir();
    this.stop();
    return this.start(cwd, { sessionPath });
  }

  async getMessages() {
    return this.messages;
  }

  // Starts a fresh session on the same underlying grok process -- ACP
  // supports multiple sessionIds per connection, so this doesn't need to
  // respawn the child the way switchSession does.
  async newSession() {
    if (!this.connection)
      return { ok: false, error: "Grok process is not running" };
    try {
      const session = await this.connection.newSession({
        cwd: this.cwd ?? homedir(),
        mcpServers: [],
      });
      this.sessionId = session.sessionId;
      this.sessionFile = sessionFilePathFor(
        this.cwd ?? homedir(),
        this.sessionId,
      );
      this.messages = [];
      this.availableCommands = [];
      return { ok: true, state: await this.getState() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  // Grok's ACP x.ai/session/fork copies the session, optionally cut at
  // targetPromptIndex. The live process can sit on a *different* session
  // id than the tab (warm newSession, or a restart that didn't pass
  // sessionPath) — always fork the file the client named, and if ACP
  // writes an empty journal, copy the source journals ourselves.
  async forkAt(timestamp, context = {}) {
    const sourceFile =
      (typeof context.sessionPath === "string" && context.sessionPath) ||
      this.sessionFile;
    if (!sourceFile && !this.sessionId)
      return { ok: false, error: "No Grok session is available to fork." };
    const revived = await this.ensureRunning(sourceFile, context);
    if (!revived?.ok)
      return {
        ok: false,
        error: revived?.error ?? "No Grok session is available to fork.",
      };
    if (!this.sessionId || !this.connection)
      return { ok: false, error: "No Grok session is available to fork." };
    try {
      const sourceId = sourceFile
        ? sessionIdFromPath(sourceFile)
        : this.sessionId;
      let messages = Array.isArray(this.messages) ? this.messages : [];
      // Live turns only land in this.messages at turn_end. A fork mid-turn,
      // or after a resume that hydrated the UI from disk, would otherwise
      // hand the new tab an empty transcript.
      const readSource =
        sourceFile && existsSync(sourceFile)
          ? sourceFile
          : this.sessionFile && existsSync(this.sessionFile)
            ? this.sessionFile
            : "";
      if (messages.length === 0 && readSource) {
        try {
          messages = messagesFromGrokLog(await readFile(readSource, "utf8"));
        } catch {
          /* start() on the fork tab will replay from the new session file */
        }
      }
      const promptIndex =
        Number.isFinite(Number(context.promptIndex)) || context.userText
          ? resolvePromptIndex(messages, context.promptIndex, context.userText)
          : promptIndexFromTimestamp(messages, timestamp);
      const sourceCwd = cwdFromGrokSession(sourceFile) || this.cwd;
      const forkCwd =
        typeof context.forkCwd === "string" && context.forkCwd
          ? context.forkCwd
          : sourceCwd;
      const forked = await this.connection.extMethod("x.ai/session/fork", {
        sourceSessionId: sourceId,
        sourceCwd,
        newCwd: forkCwd,
        targetPromptIndex: promptIndex,
      });
      const newSessionId = forked?.newSessionId;
      if (!newSessionId) throw new Error("fork returned no new session id");
      // ACP sometimes ignores newCwd and writes the fork under the source
      // directory. Seeding the newCwd path as well would be a second copy.
      const atFork = sessionFilePathFor(forkCwd, newSessionId);
      const atSource = sourceCwd
        ? sessionFilePathFor(sourceCwd, newSessionId)
        : "";
      let forkFile = atFork;
      let usedCwd = forkCwd;
      if (
        atSource &&
        forkCwd !== sourceCwd &&
        existsSync(atSource) &&
        !existsSync(atFork)
      ) {
        forkFile = atSource;
        usedCwd = sourceCwd;
      }
      try {
        await seedGrokForkJournals(readSource, forkFile, promptIndex);
      } catch {
        /* sliced messages still stop the UI at the fork point */
      }
      if (existsSync(forkFile)) {
        try {
          const fromDisk = messagesFromGrokLog(await readFile(forkFile, "utf8"));
          if (fromDisk.length > 0) messages = fromDisk;
        } catch {
          /* keep the in-memory slice */
        }
      }
      return {
        ok: true,
        restored: true,
        forkCwd: usedCwd,
        state: {
          ...(await this.getState()),
          sessionId: newSessionId,
          sessionFile: forkFile,
        },
        messages: sliceMessagesThroughPrompt(messages, promptIndex),
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async truncateAt() {
    return unsupported(
      "truncate",
      "Rewinding a Grok conversation isn't supported yet.",
    );
  }

  async getState() {
    const state = {
      status: this.status,
      isStreaming: this.status === "working",
      queuedMessages: this.queueSnapshot(),
      sessionId: this.sessionId,
      cwd: this.cwd,
      // Unset means grok runs its default; report it so the UI names it
      // instead of "model…" (resumed sessions never set one explicitly).
      model: this.model ?? { provider: "grok-sdk", id: "grok-4.6" },
      thinkingLevel: this.thinkingLevel,
      sessionFile: this.sessionFile,
    };
    this.lastState = state;
    return state;
  }

  async getCommands() {
    return {
      ok: true,
      commands: this.availableCommands.map((command) => ({
        name: command.name,
        description: command.description,
        argumentHint: command.input?.hint,
      })),
    };
  }

  async fetchModelCatalog(refresh = false) {
    if (!refresh && this.modelCatalog && Date.now() - this.modelCatalogAt < MODEL_CATALOG_TTL_MS)
      return this.modelCatalog;
    const token = await readGrokToken();
    if (!token) throw new Error("Not logged into grok-cli");
    const response = await fetch(`${GROK_PROXY_BASE}/models`, {
      headers: {
        ...GROK_PROXY_HEADERS,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok)
      throw new Error(`models fetch failed: ${response.status}`);
    const payload = await response.json();
    const raw = Array.isArray(payload)
      ? payload
      : Object.values(payload?.models ?? payload?.data ?? {}).map(
          (entry) => entry?.info ?? entry,
        );
    this.modelCatalog = raw.filter((m) => m?.id ?? m?.model);
    this.modelCatalogAt = Date.now();
    return this.modelCatalog;
  }

  async getAvailableModels() {
    try {
      const raw = await this.fetchModelCatalog(true);
      const models = raw
        .filter((m) => m.hidden !== true && m.supported_in_api !== false)
        .map((m) => ({
          provider: "grok-sdk",
          id: m.id ?? m.model,
          name: m.name ?? m.id ?? m.model,
          levels: (m.reasoning_efforts ?? []).map((effort) => effort.id ?? effort.value),
          contextWindow: m.context_window ?? m.contextWindow,
        }));
      return { ok: true, models };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** The effort ladder grok advertises for one model, in catalog order. */
  async modelEfforts(modelId) {
    const raw = await this.fetchModelCatalog();
    const entry = raw.find((m) => (m.id ?? m.model) === modelId) ?? raw[0];
    return Array.isArray(entry?.reasoning_efforts)
      ? entry.reasoning_efforts
      : [];
  }

  /** Keep `current` when the model offers it, else the model's own default. */
  async resolveEffort(modelId, current) {
    try {
      const efforts = await this.modelEfforts(modelId);
      if (!efforts.length) return current;
      const ids = efforts.map((effort) => effort.id ?? effort.value);
      if (current && ids.includes(current)) return current;
      return efforts.find((effort) => effort.default)?.id ?? ids[0];
    } catch {
      return current;
    }
  }

  async getThinkingLevels() {
    try {
      const efforts = await this.modelEfforts(this.model?.id);
      return {
        ok: true,
        levels: efforts.map((effort) => effort.id ?? effort.value),
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async setModel(provider, modelId) {
    this.model = { provider, id: modelId };
    // The previous effort may not exist on the new model (xhigh is grok-4.6
    // only), so re-resolve and re-push it rather than leaving the session on
    // a level the model does not accept.
    const effort = await this.resolveEffort(modelId, this.thinkingLevel);
    if (this.connection && this.sessionId) {
      try {
        await this.connection.setSessionMode({
          sessionId: this.sessionId,
          modeId: modelId,
        });
        if (effort)
          await this.connection.setSessionMode({
            sessionId: this.sessionId,
            modeId: effort,
          });
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }
    this.thinkingLevel = effort;
    return { ok: true, state: await this.getState() };
  }

  async setThinkingLevel(level) {
    if (this.connection && this.sessionId) {
      try {
        await this.connection.setSessionMode({
          sessionId: this.sessionId,
          modeId: level,
        });
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }
    this.thinkingLevel = level;
    return { ok: true, state: await this.getState() };
  }

  /**
   * Current window fill from the journal, and the session ledger from
   * usage.json (one row per completed turn, already summed by grok).
   */
  async getContextUsage() {
    const dir = this.sessionFile ? dirname(this.sessionFile) : "";
    if (!dir)
      return { ok: false, error: "Grok has not reported context usage yet" };
    let journal = "";
    let usageFile;
    try {
      journal = await readFile(join(dir, "updates.jsonl"), "utf8");
    } catch {
      journal = "";
    }
    try {
      usageFile = JSON.parse(await readFile(join(dir, "usage.json"), "utf8"));
    } catch {
      usageFile = undefined;
    }
    const totalTokens = contextTokensFromJournal(journal);
    if (!totalTokens)
      return { ok: false, error: "Grok has not reported context usage yet" };
    let windowInfo = null;
    try {
      windowInfo = contextWindowForModel(
        await this.fetchModelCatalog(),
        this.model?.id || usageFile?.session?.primaryModelId,
      );
    } catch {
      windowInfo = null;
    }
    if (!windowInfo)
      return { ok: false, error: "Grok has not reported a context window" };
    const turns = turnUsagesFromJournal(journal);
    const summed = turns.reduce(
      (total, turn) => {
        const usage = usageFrom(turn);
        total.input += usage.input;
        total.output += usage.output;
        total.cacheRead += usage.cacheRead;
        total.cacheWrite += usage.cacheWrite;
        total.durationMs += Number(turn.apiDurationMs) || 0;
        return total;
      },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, durationMs: 0 },
    );
    const ledger = usageFile?.session ? usageFrom(usageFile.session) : summed;
    const session =
      ledger.input || ledger.output || ledger.cacheRead
        ? {
            input: ledger.input,
            output: ledger.output,
            cacheRead: ledger.cacheRead,
            cacheWrite: ledger.cacheWrite,
            durationMs: summed.durationMs,
          }
        : undefined;
    return {
      ok: true,
      data: {
        totalTokens,
        maxTokens: windowInfo.maxTokens,
        percent: Math.round((totalTokens / windowInfo.maxTokens) * 100),
        model: windowInfo.model,
        autoCompactThreshold: windowInfo.autoCompactThreshold,
        isAutoCompactEnabled: windowInfo.isAutoCompactEnabled,
        categories: [],
        ...(session ? { session } : {}),
      },
    };
  }

  async getUsage(force = false) {
    const now = Date.now();
    if (
      !force &&
      this.usageCache.result &&
      now - this.usageCache.at < 5 * 60_000
    ) {
      return this.usageCache.result;
    }
    if (this.usageRequest) return this.usageRequest;
    this.usageRequest = loadGrokUsage()
      .then((result) => {
        if (result?.ok) this.usageCache = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        this.usageRequest = undefined;
      });
    return this.usageRequest;
  }

  killChild() {
    const child = this.process;
    this.process = undefined;
    this.connection = undefined;
    if (!child) return;
    // grok agent stdio doesn't reliably exit on SIGTERM alone -- observed
    // processes surviving well past stop() with an open write handle on
    // the session's events.jsonl, which then lock-contends with anything
    // else (including grok's own dashboard) trying to open that session.
    // Escalate to SIGKILL if it hasn't exited shortly after.
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, 2000).unref();
  }

  stop() {
    const turn = this.turn;
    this.status = "stopped";
    this.turn = undefined;
    this.replayMode = undefined;
    if (this.queueIdleTimer) {
      clearTimeout(this.queueIdleTimer);
      this.queueIdleTimer = undefined;
    }
    this.queuedMessages = [];
    this.emitQueue();
    this.stopSubagentFollows();
    this.killChild();
    // Reject after clearing: the exit handler only rejects a turn it can
    // still see on this.turn, and the awaited prompt in runTurn must settle
    // so its catch emits agent_settled.
    turn?.reject?.(new Error("Grok turn was stopped"));
    // The frontend clears its running flag on agent_settled and
    // state.isStreaming — without both, stopping a wedged turn left the
    // composer spinning on "running" even though nothing was executing.
    this.emit({ type: "agent_settled", sessionKey: this.sessionKey });
    void this.getState()
      .then((state) =>
        this.emit({ type: "state", sessionKey: this.sessionKey, state }),
      )
      .catch(() => {});
    this.emit({
      type: "__status",
      sessionKey: this.sessionKey,
      status: "stopped",
    });
  }
}

export class GrokAgentPool extends AgentPool {
  constructor() {
    super((sessionKey) => new GrokAgentProcess(sessionKey));
  }
}
