/**
 * Grok agent, driven directly over ACP (Agent Client Protocol) instead of
 * through `pi`.
 *
 * Background: `pi --provider grok-sdk` never surfaces tool calls -- confirmed
 * by capturing its raw RPC event stream directly (thinking/text content only,
 * even when explicitly told "use your bash tool now"). That's a bug in pi's
 * native grok-sdk adapter, not in pi-web, and pi's extension system can't
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
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
} from "@zed-industries/agent-client-protocol";
import { CLARIFY_PROMPT } from "./co-partner-prompt.js";
import {
  isSubagentToolName,
  messagesFromGrokLog,
  parseSubagentId,
  stripTrailingCompactTurn,
} from "./sessions.js";

export { isSubagentToolName, parseSubagentId } from "./sessions.js";

const GROK_HOME = () => process.env.GROK_HOME || join(homedir(), ".grok");
const GROK_HOME_AUTH = () => join(GROK_HOME(), "auth.json");
export const GROK_SESSIONS_ROOT = () => join(GROK_HOME(), "sessions");
const PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";
const PROXY_HEADERS = {
  "User-Agent": "grok-cli",
  "x-xai-token-auth": "xai-grok-cli",
};
const ACP_PROTOCOL_VERSION = 1;

function formatResetTime(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return undefined;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(epochSeconds * 1000));
}

async function readGrokToken() {
  try {
    const auth = JSON.parse(await readFile(GROK_HOME_AUTH(), "utf8"));
    return (
      auth?.["https://accounts.x.ai/sign-in"]?.key ??
      Object.values(auth ?? {}).find((entry) => typeof entry?.key === "string")
        ?.key
    );
  } catch {
    // Missing or corrupt auth file simply means "not logged in"; callers
    // surface that as their own error instead of an unhandled throw.
    return undefined;
  }
}

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

function acpTextOf(block) {
  return block?.type === "text" ? (block.text ?? "") : "";
}

// ACP has no system-prompt channel, so the always-on clarify instruction is
// prepended to every outgoing prompt text instead. It stays in grok's own
// chat history (keeping it in-context for the whole session) but is hidden
// from pi-web's live timeline and stripped back out of replayed history so a
// reload never shows it. The exact-string prefix makes the strip unambiguous.
const CLARIFY_PROMPT_PREFIX = [
  "[pi-web harness instruction — this block is not part of the user's message; do not quote, repeat, or reference it]",
  CLARIFY_PROMPT,
  "[end pi-web harness instruction]",
  "",
].join("\n");

function withClarifyPrefix(text) {
  return `${CLARIFY_PROMPT_PREFIX}${text}`;
}

function stripClarifyPrefix(text) {
  return typeof text === "string" && text.startsWith(CLARIFY_PROMPT_PREFIX)
    ? text.slice(CLARIFY_PROMPT_PREFIX.length)
    : text;
}

// grok's ACP tool_call notifications don't populate the optional `kind`
// field (confirmed empirically), so shell-command detection falls back to
// known tool names -- this is what lets the UI show a live "running $ ..."
// indicator instead of a generic thinking spinner during shell execution.
const SHELL_TOOL_NAMES = new Set(["run_terminal_command"]);

// How long a background-driven piece of a turn may go silent before pi-web
// treats it as dead. A healthy grok streams chunks continuously; silence means
// the child crashed or stopped mid-report and the turn would otherwise wedge
// the session on "running" forever — every later prompt queued behind it.
// Covers stalled subagent follows (no bytes in the child's session file) and
// idle reminder turns whose stream stopped.
let stallMs = 5 * 60_000;

/** Tests only: shrink the stall watchdogs so the bail-out is observable. */
export function setStallMsForTesting(ms) {
  stallMs = ms;
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
 *  reaches the standard ACP stream and pi-web must read the file. */
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
    this.usageCache = { at: 0, result: undefined };
    this.usageRequest = undefined;
    this.subagentFollows = new Map();
    this.parentHoldText = "";
    this.lastChildText = "";
    this.followsDrained = undefined;
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

  isAlive() {
    const child = this.process;
    const childAlive = Boolean(
      child && child.exitCode == null && child.signalCode == null,
    );
    return childAlive && Boolean(this.connection) && Boolean(this.sessionId);
  }

  async ensureRunning() {
    if (this.isAlive()) return { ok: true };
    const cwd = this.cwd;
    const sessionPath = this.sessionFile;
    if (!cwd) return { ok: false, error: "Grok session is not running" };
    this.killChild();
    return this.start(cwd, {
      sessionPath,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
    });
  }

  async start(cwd, options = {}) {
    if (this.isAlive()) return { ok: true, state: await this.getState() };
    if (this.process) this.killChild();
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

    try {
      const child = spawn(resolveGrokExecutable(), ["agent", "stdio"], {
        cwd: effectiveCwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.process = child;
      child.stderr.on("data", (chunk) => {
        // grok colours its logs; raw escapes render as "[2m...[0m" noise in
        // the transcript, which is where its network errors surface.
        const message = chunk
          .toString("utf8")
          // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR
          .replace(/\u001b\[[0-9;]*m/g, "")
          .trim();
        if (message)
          this.emit({ type: "stderr", sessionKey: this.sessionKey, message });
      });
      child.once("error", (error) => {
        this.process = undefined;
        this.connection = undefined;
        this.setStatus("error", error.message);
      });
      child.once("exit", (code, signal) => {
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
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      const stream = ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout),
      );
      const self = this;
      this.connection = new ClientSideConnection(
        () => ({
          async sessionUpdate(notification) {
            self.handleSessionUpdate(notification);
          },
          async requestPermission(params) {
            const options = params.options ?? [];
            const chosen =
              options.find((o) => o.kind === "allow_always") ??
              options.find((o) => o.kind === "allow_once") ??
              options[0];
            return chosen
              ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
              : { outcome: { outcome: "cancelled" } };
          },
          async writeTextFile() {
            throw new Error(
              "writeTextFile not supported by pi-web's grok client",
            );
          },
          async readTextFile() {
            throw new Error(
              "readTextFile not supported by pi-web's grok client",
            );
          },
        }),
        stream,
      );

      await this.connection.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });

      let replayedMessages;
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
      // from getState().
      this.thinkingLevel = await this.resolveEffort(
        this.model?.id,
        options.thinkingLevel || this.thinkingLevel,
      );
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
    let turn = this.turn;
    if (!turn) {
      // grok continues the session on its own after a background subagent
      // completes: the completion reminder triggers a fresh turn with no
      // prompt from this side. Without synthesizing a turn here, the
      // parent's handover narration streamed while `this.turn` was undefined
      // and never reached the timeline — the findings only appeared after
      // a page refresh re-read the session file.
      if (
        !this.replayMode &&
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
    } else if (turn.idle && update.sessionUpdate === "turn_completed") {
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
          for (const follow of [...this.subagentFollows.values()])
            this.pumpSubagent(follow);
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
        if (this.shouldHideParentTool(update)) {
          for (const follow of [...this.subagentFollows.values()])
            this.pumpSubagent(follow);
          return;
        }
        this.startToolCall(turn, update);
        return;
      case "tool_call_update":
        if (this.shouldHideParentTool(update)) {
          for (const follow of [...this.subagentFollows.values()])
            this.pumpSubagent(follow);
          return;
        }
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

  startToolCall(turn, update) {
    for (const follow of [...this.subagentFollows.values()]) {
      this.pumpSubagent(follow);
    }
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
      pending: "",
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
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      this.checkSubagentDone(follow);
      return;
    }
    if (text.length < follow.offset) follow.offset = 0;
    if (text.length > follow.offset) follow.lastAdvance = Date.now();
    const chunk = follow.pending + text.slice(follow.offset);
    follow.offset = text.length;
    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl < 0) {
      follow.pending = chunk;
      this.checkSubagentDone(follow);
      return;
    }
    follow.pending = chunk.slice(lastNl + 1);
    for (const line of chunk.slice(0, lastNl + 1).split("\n")) {
      if (!line.trim()) continue;
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

  emitChildToolEnd(_follow, update) {
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
    if (
      !follow.turnCompleted &&
      status !== "completed" &&
      status !== "failed"
    ) {
      // A silent child is a dead child: without this bail runTurn waits on
      // the drain forever and the session wedges on "running".
      if (Date.now() - follow.lastAdvance < stallMs) return;
      this.finishSubagentFollow(follow, true);
      return;
    }
    this.finishSubagentFollow(follow, status === "failed");
  }

  /** The child's official findings from output.json; "" when the file has
   *  not landed yet (ponytail: turn_completed in the child stream can beat
   *  the file to disk; the narration fallback still lands — add a retry
   *  tick if that race is ever observed). */
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
      this.followsDrained = undefined;
      drained?.();
    }
  }

  flushHeldParentText() {
    const leftover = parentTextAfterChild(
      this.parentHoldText,
      this.lastChildText,
    );
    this.parentHoldText = "";
    if (!leftover) return;
    if (this.turn) {
      this.appendDelta(this.turn, "text", leftover);
      return;
    }
    this.emit({
      type: "message_update",
      sessionKey: this.sessionKey,
      streamKey: "grok-parent-handoff",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: leftover,
      },
    });
    this.emit({
      type: "message_update",
      sessionKey: this.sessionKey,
      streamKey: "grok-parent-handoff",
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: leftover,
      },
    });
  }

  waitForSubagentFollows() {
    if (this.subagentFollows.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.followsDrained = resolve;
    });
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
        text: kind === "prompt" ? withClarifyPrefix(message) : message,
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
    };
    this.setStatus("working");

    try {
      // The exit handler and stop() reject through turn.reject. Without this
      // wiring they were silent no-ops and a child that died mid-turn hung
      // the awaited prompt forever — the session stayed "running" and every
      // later prompt was queued behind a turn nobody was executing.
      const response = await new Promise((resolve, reject) => {
        this.turn.reject = reject;
        this.connection
          .prompt({ sessionId: this.sessionId, prompt: promptBlocks })
          .then(resolve, reject)
          .finally(() => {
            if (this.turn) this.turn.reject = undefined;
          });
      });
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
      this.lastChildText = "";
      this.setStatus("ready");
      this.emit({ type: "agent_settled", sessionKey: this.sessionKey });
      const state = await this.getState();
      this.emit({ type: "state", sessionKey: this.sessionKey, state });
      this.sendNextQueued();
      return { ok: true, state };
    } catch (error) {
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
          message: `Grok turn failed: ${message}`,
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
    this.watchIdleTurnFile(turn);
    this.setStatus("working");
  }

  /** grok journals turn_completed with a non-ACP method, so the idle turn
   *  never hears about its own completion through handleSessionUpdate — it
   *  would sit open until the stall watchdog and every prompt typed in that
   * window gets queued behind a turn nobody is executing. The session file
   * is the ground truth: poll the journal for the completion line and close
   * the turn within one tick. */
  watchIdleTurnFile(turn) {
    if (!this.cwd || !this.sessionId) return;
    const path = sessionUpdatesPath(this.cwd, this.sessionId);
    let offset = 0;
    try {
      offset = readFileSync(path, "utf8").length;
    } catch {
      /* file appears once grok journals its first update */
    }
    turn.fileTimer = setInterval(() => {
      if (this.turn !== turn) {
        clearInterval(turn.fileTimer);
        return;
      }
      let text = "";
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return;
      }
      if (text.length <= offset) return;
      const chunk = text.slice(offset);
      const lastNl = chunk.lastIndexOf("\n");
      if (lastNl < 0) return;
      offset += lastNl + 1;
      for (const line of chunk.slice(0, lastNl + 1).split("\n")) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.params?.update?.sessionUpdate === "turn_completed") {
          clearInterval(turn.fileTimer);
          this.finishIdleTurn();
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
    void this.getState()
      .then((state) =>
        this.emit({ type: "state", sessionKey: this.sessionKey, state }),
      )
      .catch(() => {});
    this.sendNextQueued();
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

  queueSnapshot() {
    return this.queuedMessages.map(({ id, message, at }) => ({
      id,
      message,
      at,
    }));
  }

  emitQueue() {
    this.emit({
      type: "queue_updated",
      sessionKey: this.sessionKey,
      queued: this.queueSnapshot(),
    });
  }

  /** Hold the message until the running turn settles; send now if idle. */
  enqueue(message, images) {
    const text = String(message ?? "");
    if (!text.trim())
      return Promise.resolve({ ok: false, error: "Empty message" });
    if (this.turn) return this.queueMessage(text, images);
    return this.prompt(text, images).then((result) =>
      result.ok ? { ok: true, data: { queued: false } } : result,
    );
  }

  queueMessage(text, images) {
    this.queueSeq += 1;
    this.queuedMessages.push({
      id: `q-${Date.now()}-${this.queueSeq}`,
      message: text,
      images: Array.isArray(images) ? images : [],
      at: Date.now(),
    });
    this.emitQueue();
    return Promise.resolve({
      ok: true,
      data: { queued: true, position: this.queuedMessages.length },
    });
  }

  cancelQueued(id) {
    const before = this.queuedMessages.length;
    this.queuedMessages = id
      ? this.queuedMessages.filter((entry) => entry.id !== id)
      : [];
    if (this.queuedMessages.length === before)
      return { ok: false, error: "That message is no longer queued" };
    this.emitQueue();
    return {
      ok: true,
      data: { cancelled: before - this.queuedMessages.length },
    };
  }

  sendNextQueued() {
    const next = this.queuedMessages.shift();
    if (!next) return;
    this.emitQueue();
    this.prompt(next.message, next.images.length ? next.images : undefined)
      .then((result) => {
        if (result.ok) return;
        this.queuedMessages.unshift(next);
        this.emitQueue();
      })
      .catch(() => {
        this.queuedMessages.unshift(next);
        this.emitQueue();
      });
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
    this.stopSubagentFollows();
    if (!this.connection || !this.sessionId) return { ok: true };
    try {
      await this.connection.cancel({ sessionId: this.sessionId });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
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
    const cwd = this.cwd ?? homedir();
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

  // Branching a conversation (pi's fork/truncate) needs either a documented
  // ACP extension for it or reverse-engineering grok's own rewind_points
  // format -- grok's ACP init response does advertise a `cancelRewind`
  // capability, suggesting something exists, but its shape isn't confirmed.
  // Fail clearly rather than guess at a protocol extension and risk silently
  // corrupting session state.
  async forkAt() {
    return {
      ok: false,
      error: "Forking a Grok conversation isn't supported yet.",
    };
  }

  async truncateAt() {
    return {
      ok: false,
      error: "Rewinding a Grok conversation isn't supported yet.",
    };
  }

  async getState() {
    const state = {
      status: this.status,
      isStreaming: this.status === "working",
      queuedMessages: this.queueSnapshot(),
      sessionId: this.sessionId,
      cwd: this.cwd,
      model: this.model,
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

  async fetchModelCatalog() {
    if (this.modelCatalog) return this.modelCatalog;
    const token = await readGrokToken();
    if (!token) throw new Error("Not logged into grok-cli");
    const response = await fetch(`${PROXY_BASE}/models`, {
      headers: {
        ...PROXY_HEADERS,
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
    return this.modelCatalog;
  }

  async getAvailableModels() {
    try {
      const raw = await this.fetchModelCatalog();
      const models = raw
        .filter((m) => m.hidden !== true && m.supported_in_api !== false)
        .map((m) => ({
          provider: "grok-sdk",
          id: m.id ?? m.model,
          name: m.name ?? m.id ?? m.model,
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
    this.usageRequest = this.loadUsage()
      .then((result) => {
        if (result?.ok) this.usageCache = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        this.usageRequest = undefined;
      });
    return this.usageRequest;
  }

  async loadUsage() {
    try {
      const token = await readGrokToken();
      if (!token)
        return {
          ok: true,
          usage: { available: false, provider: "Grok", windows: [] },
        };
      const response = await fetch(`${PROXY_BASE}/billing?format=credits`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...PROXY_HEADERS,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error(`Grok usage returned ${response.status}`);
      const payload = await response.json();
      const config = payload?.config ?? payload;
      const usedPercent = Number(config?.creditUsagePercent);
      const resetAt =
        Date.parse(
          String(config?.currentPeriod?.end ?? config?.billingPeriodEnd ?? ""),
        ) / 1000;
      const resetsAt = formatResetTime(resetAt);
      const windows = Number.isFinite(usedPercent)
        ? [
            {
              label: "Current week",
              usedPercent,
              ...(resetsAt ? { resetsAt } : {}),
            },
          ]
        : [];
      return {
        ok: true,
        usage: {
          available: windows.length > 0,
          provider: "Grok",
          windows,
          updatedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
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
    this.queuedMessages = [];
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

export class GrokAgentPool {
  constructor() {
    this.agents = new Map();
  }

  get(sessionKey) {
    let agent = this.agents.get(sessionKey);
    if (!agent) {
      agent = new GrokAgentProcess(sessionKey);
      this.agents.set(sessionKey, agent);
    }
    return agent;
  }

  stop(sessionKey) {
    if (sessionKey) {
      this.agents.get(sessionKey)?.stop();
      this.agents.delete(sessionKey);
      return;
    }
    for (const agent of this.agents.values()) agent.stop();
    this.agents.clear();
  }
}
