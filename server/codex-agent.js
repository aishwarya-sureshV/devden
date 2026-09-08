/**
 * Codex backend, driven through `codex app-server` (see codex-app-server.js).
 *
 * Shape and event vocabulary mirror GrokAgentProcess deliberately: index.js
 * routes every backend through the same pool/watch machinery, and the
 * Conversation UI renders whatever arrives on the shared event stream, so a
 * new backend is "done" exactly when it emits the same events as the others.
 *
 * The protocol maps almost 1:1 onto that contract -- threads are
 * conversations, turns are turns, and `item/*` notifications are the
 * streaming blocks -- so the work here is translation, not bookkeeping.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CodexAppServer, codexRequest } from "./codex-app-server.js";
import { loadCodexUsage } from "./codex-usage.js";
import { CLARIFY_PROMPT } from "./co-partner-prompt.js";

export const CODEX_SESSIONS_ROOT = () =>
  join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");

const DEFAULT_MODEL_ID = "gpt-5.6-terra";
const USAGE_CACHE_TTL_MS = 5 * 60_000;

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

function usageFrom(tokenUsage) {
  const last = tokenUsage?.last ?? tokenUsage?.total;
  if (!last) return zeroUsage();
  return {
    input: Number(last.inputTokens ?? 0),
    output: Number(last.outputTokens ?? 0),
    cacheRead: Number(last.cachedInputTokens ?? 0),
    cacheWrite: Number(last.cacheWriteInputTokens ?? 0),
    totalTokens: Number(last.totalTokens ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// Codex has no system-prompt channel a client can set per turn without also
// replacing its own base instructions, so -- as with grok -- the always-on
// clarify instruction rides along on the prompt text and is stripped back
// out of replayed history so a reload never shows it.
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

/**
 * Rollout files are named rollout-<ISO timestamp>-<thread uuid>.jsonl, so a
 * saved-session path (pi-web's session identity) yields the threadId that
 * `thread/resume` wants without opening the file.
 */
export function threadIdFromPath(sessionPath) {
  const match = /-([0-9a-f-]{36})\.jsonl$/i.exec(basename(sessionPath ?? ""));
  return match?.[1];
}

function textOfUserInput(content) {
  return (content ?? [])
    .map((part) => (part?.type === "text" ? (part.text ?? "") : ""))
    .filter(Boolean)
    .join("");
}

/**
 * Every thread item that is not a message or reasoning renders as a tool
 * card. Returns the display name plus the arguments the card shows, or
 * undefined for item kinds the timeline has no card for.
 */
function toolCallOf(item) {
  switch (item.type) {
    case "commandExecution":
      return {
        name: "shell",
        execKind: "execute",
        arguments: { command: item.command, cwd: item.cwd },
        output: item.aggregatedOutput ?? "",
        failed: item.status === "failed" || item.status === "declined",
      };
    case "fileChange":
      return {
        name: "apply_patch",
        arguments: {
          changes: (item.changes ?? []).map((change) => ({
            path: change.path,
            kind: change.kind,
          })),
        },
        output: (item.changes ?? [])
          .map((change) => change.diff)
          .filter(Boolean)
          .join("\n"),
        failed: item.status === "failed",
      };
    case "mcpToolCall":
      return {
        name: `${item.server}/${item.tool}`,
        arguments: item.arguments ?? {},
        output: JSON.stringify(item.result ?? item.error ?? {}),
        failed: Boolean(item.error),
      };
    case "dynamicToolCall":
      return {
        name: item.tool,
        arguments: item.arguments ?? {},
        output: JSON.stringify(item.contentItems ?? {}),
        failed: item.success === false,
      };
    case "webSearch":
      return {
        name: "web_search",
        arguments: { query: item.query ?? "" },
        output: "",
        failed: false,
      };
    case "imageView":
      return {
        name: "view_image",
        arguments: { path: item.path },
        output: "",
        failed: false,
      };
    default:
      return undefined;
  }
}

class CodexAgentProcess {
  constructor(sessionKey) {
    this.sessionKey = sessionKey;
    this.connection = undefined;
    this.status = "stopped";
    this.threadId = undefined;
    this.cwd = undefined;
    this.model = undefined;
    this.thinkingLevel = undefined;
    this.sessionFile = undefined;
    this.lastState = undefined;
    this.listeners = new Set();
    this.turn = undefined;
    // See GrokAgentProcess: replayed history is returned synchronously from
    // start(), so re-emitting it as live events would double-render it.
    this.suppressReplayEvents = false;
    this.accessMode = "workspace-write";
    this.modelCatalog = undefined;
    this.skills = [];
    this.messages = [];
    this.queuedMessages = [];
    this.queueSeq = 0;
    this.usageCache = { at: 0, result: undefined };
    this.usageRequest = undefined;
  }

  // index.js treats `process` as "is this agent alive"; the app-server
  // connection is this backend's equivalent.
  get process() {
    return this.connection?.running ? this.connection : undefined;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    if (this.suppressReplayEvents && event.type !== "stderr") return;
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

  async start(cwd, options = {}) {
    if (this.connection?.running)
      return { ok: true, state: await this.getState() };
    let effectiveCwd = cwd;
    if (effectiveCwd && !existsSync(effectiveCwd)) {
      effectiveCwd = homedir();
      queueMicrotask(() =>
        this.emit({
          type: "notice",
          sessionKey: this.sessionKey,
          message: `${cwd} no longer exists; started in ${effectiveCwd}`,
        }),
      );
    }
    effectiveCwd = effectiveCwd || homedir();
    this.cwd = effectiveCwd;
    if (options.accessMode)
      this.accessMode =
        options.accessMode === "read-only" ? "read-only" : "workspace-write";
    if (options.model?.id)
      this.model = { provider: "codex", id: options.model.id };
    if (options.thinkingLevel) this.thinkingLevel = options.thinkingLevel;

    this.setStatus("starting");
    const connection = new CodexAppServer();
    this.connection = connection;
    connection.onNotification((message) => this.handleNotification(message));
    connection.onServerRequest((message) => this.handleServerRequest(message));
    try {
      await connection.start();
      const config = {
        cwd: effectiveCwd,
        sandbox: this.accessMode,
        // pi-web owns the access decision through accessMode; asking for
        // approvals over a protocol nobody is watching would just hang the
        // turn on an unanswered request.
        approvalPolicy: "never",
        ...(this.model?.id ? { model: this.model.id } : {}),
      };
      const resumeId =
        threadIdFromPath(options.sessionPath) ?? options.threadId;
      const opened = resumeId
        ? await connection.request("thread/resume", {
            threadId: resumeId,
            ...config,
          })
        : await connection.request("thread/start", config);
      this.threadId = opened.thread.id;
      this.sessionFile = opened.thread.path ?? options.sessionPath;
      this.model = { provider: "codex", id: opened.model };
      // The composer's placeholder effort for a not-yet-started session is
      // "off", which codex has no equivalent for -- and each model advertises
      // its own ladder (gpt-5.6-terra has "max", gpt-5.5 stops at "xhigh"),
      // so anything unsupported falls back to the model's own default.
      this.thinkingLevel = await this.resolveEffort(
        opened.model,
        options.thinkingLevel && options.thinkingLevel !== "off"
          ? options.thinkingLevel
          : opened.reasoningEffort,
      );
      this.setStatus("ready");
      const replayedMessages = resumeId
        ? this.replayHistory(opened.thread.turns ?? [])
        : undefined;
      const state = await this.getState();
      return replayedMessages
        ? { ok: true, state, messages: replayedMessages }
        : { ok: true, state };
    } catch (error) {
      const message = String(error?.message ?? error);
      this.setStatus("error", message);
      this.stop();
      return { ok: false, error: message };
    }
  }

  /**
   * Turn a resumed thread's persisted turns into the same event sequence a
   * live turn produces, so the timeline renders history and new work
   * identically. Events are suppressed; the messages are returned instead.
   */
  replayHistory(turns) {
    this.messages = [];
    const replayed = [];
    this.suppressReplayEvents = true;
    try {
      for (const turn of turns) {
        const userItem = (turn.items ?? []).find(
          (item) => item.type === "userMessage",
        );
        const userMessage = {
          role: "user",
          content: [
            {
              type: "text",
              text: stripClarifyPrefix(textOfUserInput(userItem?.content)),
            },
          ],
          timestamp: Date.now(),
        };
        const assistantMessage = this.newAssistantMessage();
        this.turn = {
          content: assistantMessage.content,
          message: assistantMessage,
          openKind: undefined,
          openIndex: undefined,
          itemIndex: new Map(),
        };
        for (const item of turn.items ?? []) {
          if (item.type === "userMessage") continue;
          this.startItem(item);
          this.completeItem(item);
        }
        this.closeOpenBlock(this.turn);
        assistantMessage.stopReason =
          turn.status === "completed"
            ? "end_turn"
            : (turn.status ?? "end_turn");
        this.turn = undefined;
        replayed.push(userMessage, assistantMessage);
      }
    } finally {
      this.suppressReplayEvents = false;
    }
    this.messages = [...replayed];
    return replayed;
  }

  newAssistantMessage() {
    return {
      role: "assistant",
      content: [],
      api: "codex",
      provider: "codex",
      model: this.model?.id ?? DEFAULT_MODEL_ID,
      usage: zeroUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
    };
  }

  // ---- notification handling -------------------------------------------

  handleServerRequest(message) {
    // approvalPolicy "never" means codex should not ask, but the protocol
    // still allows a few request kinds. Decline rather than leave the turn
    // blocked forever on a request no human is watching.
    const denial = {
      decision: "denied",
      "item/tool/requestUserInput": { response: null },
    };
    try {
      this.connection?.respond(
        message.id,
        denial[message.method] ?? { decision: "denied" },
      );
    } catch {
      /* connection already gone */
    }
  }

  handleNotification(message) {
    const params = message.params ?? {};
    if (params.threadId && params.threadId !== this.threadId) return;
    const turn = this.turn;
    switch (message.method) {
      case "item/started":
        if (turn) this.startItem(params.item);
        return;
      case "item/completed":
        if (turn) this.completeItem(params.item);
        return;
      case "item/agentMessage/delta":
        if (turn) this.appendDelta(turn, "text", params.delta);
        return;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        if (turn) this.appendDelta(turn, "thinking", params.delta);
        return;
      case "item/commandExecution/outputDelta":
        return; // the completed item carries the aggregated output
      case "thread/tokenUsage/updated":
        if (turn) turn.message.usage = usageFrom(params.tokenUsage);
        return;
      case "turn/completed":
        this.finishTurn(params.turn);
        return;
      case "thread/name/updated":
        this.emit({
          type: "session_name",
          sessionKey: this.sessionKey,
          name: params.name,
        });
        return;
      case "error": {
        // A turn that errors still reports turn/completed afterwards, so the
        // message is stashed on the turn and surfaced when it settles --
        // otherwise a failed turn renders as an empty assistant bubble.
        const text = String(params.error?.message ?? params.message ?? "");
        this.emit({
          type: "stderr",
          sessionKey: this.sessionKey,
          message: text,
        });
        if (turn && params.willRetry !== true) turn.error = text;
        return;
      }
      case "warning":
        this.emit({
          type: "stderr",
          sessionKey: this.sessionKey,
          message: String(params.message ?? ""),
        });
        return;
      default:
        return;
    }
  }

  startItem(item) {
    const turn = this.turn;
    if (!turn || !item) return;
    if (item.type === "userMessage") return;
    if (item.type === "agentMessage" || item.type === "plan") {
      this.appendDelta(turn, "text", item.text ?? "");
      turn.itemIndex.set(item.id, { kind: "text" });
      return;
    }
    if (item.type === "reasoning") {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].join(
        "\n",
      );
      this.appendDelta(turn, "thinking", text);
      turn.itemIndex.set(item.id, { kind: "thinking" });
      return;
    }
    const call = toolCallOf(item);
    if (!call) return;
    this.closeOpenBlock(turn);
    const block = {
      type: "toolCall",
      id: item.id,
      name: call.name,
      arguments: call.arguments,
    };
    turn.content.push(block);
    const index = turn.content.length - 1;
    turn.itemIndex.set(item.id, { kind: "tool", index });
    this.emitUpdate({ type: "toolcall_start", contentIndex: index });
    this.emit({
      type: "tool_execution_start",
      sessionKey: this.sessionKey,
      toolCallId: item.id,
      toolName: call.name,
      args: call.arguments,
      ...(call.execKind ? { execKind: call.execKind } : {}),
    });
  }

  completeItem(item) {
    const turn = this.turn;
    if (!turn || !item) return;
    const tracked = turn.itemIndex.get(item.id);
    if (item.type === "agentMessage" || item.type === "plan") {
      // The deltas already built the block; only an item we never saw start
      // (a non-streamed message) still needs its text.
      if (!tracked) this.appendDelta(turn, "text", item.text ?? "");
      this.closeOpenBlock(turn);
      return;
    }
    if (item.type === "reasoning") {
      if (!tracked)
        this.appendDelta(
          turn,
          "thinking",
          [...(item.summary ?? []), ...(item.content ?? [])].join("\n"),
        );
      this.closeOpenBlock(turn);
      return;
    }
    const call = toolCallOf(item);
    if (!call) return;
    if (!tracked) this.startItem(item);
    const index = turn.itemIndex.get(item.id)?.index;
    if (index === undefined) return;
    const block = turn.content[index];
    block.arguments = call.arguments;
    this.emitUpdate({
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
      toolCallId: item.id,
      result: {
        content: [{ type: "text", text: call.output ?? "" }],
        details: item,
      },
      isError: Boolean(call.failed),
    });
  }

  closeOpenBlock(turn) {
    if (turn.openKind === "text") {
      this.emitUpdate({
        type: "text_end",
        contentIndex: turn.openIndex,
        content: turn.content[turn.openIndex].text,
      });
    } else if (turn.openKind === "thinking") {
      this.emitUpdate({
        type: "thinking_end",
        contentIndex: turn.openIndex,
        content: turn.content[turn.openIndex].thinking,
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
      this.emitUpdate({
        type: kind === "text" ? "text_start" : "thinking_start",
        contentIndex: turn.openIndex,
      });
    }
    const block = turn.content[turn.openIndex];
    if (kind === "text") block.text += delta;
    else block.thinking += delta;
    this.emitUpdate({
      type: kind === "text" ? "text_delta" : "thinking_delta",
      contentIndex: turn.openIndex,
      delta,
    });
  }

  emitUpdate(assistantMessageEvent) {
    this.emit({
      type: "message_update",
      sessionKey: this.sessionKey,
      usage: this.turn?.message.usage ?? zeroUsage(),
      assistantMessageEvent,
    });
  }

  // ---- turns ------------------------------------------------------------

  async runTurn(kind, message, images) {
    if (!this.connection?.running || !this.threadId)
      return { ok: false, error: "Codex session is not running" };
    if (this.turn && kind !== "steer")
      return { ok: false, error: "A Codex turn is already in progress" };

    const input = [
      {
        type: "text",
        // The clarify gate applies to what the user typed. A steer or a
        // harness follow-up must not be told to stop and ask questions.
        text: kind === "prompt" ? withClarifyPrefix(message) : message,
        text_elements: [],
      },
    ];
    for (const image of images ?? []) {
      if (image?.data && image?.mimeType)
        input.push({
          type: "image",
          url: `data:${image.mimeType};base64,${image.data}`,
        });
    }

    if (kind === "steer") {
      if (!this.turn) return { ok: false, error: "No Codex turn to steer" };
      try {
        await this.connection.request("turn/steer", {
          threadId: this.threadId,
          turnId: this.turn.id,
          input,
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }

    const userMessage = {
      role: "user",
      content: [{ type: "text", text: message }],
      timestamp: Date.now(),
    };
    this.emit({ type: "agent_start", sessionKey: this.sessionKey });
    this.emit({ type: "turn_start", sessionKey: this.sessionKey });
    // A follow-up is the harness talking, not the user: showing its
    // instruction block as a user message would put text in the transcript
    // that the user never typed. The turn itself still renders normally.
    if (kind !== "follow_up")
      for (const type of ["message_start", "message_end"])
        this.emit({ type, sessionKey: this.sessionKey, message: userMessage });

    const assistantMessage = this.newAssistantMessage();
    this.emit({
      type: "message_start",
      sessionKey: this.sessionKey,
      message: assistantMessage,
    });

    // The turn record is armed before turn/start resolves: codex streams
    // item notifications for the turn while that request is still in
    // flight, and a late assignment would drop the first blocks.
    const settled = Promise.withResolvers();
    this.turn = {
      id: undefined,
      content: assistantMessage.content,
      message: assistantMessage,
      openKind: undefined,
      openIndex: undefined,
      itemIndex: new Map(),
      userMessage: kind === "follow_up" ? undefined : userMessage,
      settled,
    };
    this.setStatus("working");

    try {
      const started = await this.connection.request("turn/start", {
        threadId: this.threadId,
        input,
        cwd: this.cwd,
        ...(this.model?.id ? { model: this.model.id } : {}),
        ...(this.thinkingLevel ? { effort: this.thinkingLevel } : {}),
      });
      if (this.turn) this.turn.id = started.turn.id;
      return await settled.promise;
    } catch (error) {
      this.turn = undefined;
      this.setStatus("ready");
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  finishTurn(completed) {
    const turn = this.turn;
    if (!turn) return;
    this.closeOpenBlock(turn);
    turn.message.stopReason =
      completed?.status === "completed"
        ? "end_turn"
        : (completed?.status ?? "end_turn");
    this.emit({
      type: "turn_end",
      sessionKey: this.sessionKey,
      message: turn.message,
    });
    this.emit({
      type: "agent_end",
      sessionKey: this.sessionKey,
      messages: [turn.userMessage, turn.message].filter(Boolean),
    });
    if (turn.userMessage) this.messages.push(turn.userMessage, turn.message);
    else this.messages.push(turn.message);
    this.turn = undefined;
    this.setStatus("ready");
    this.emit({ type: "agent_settled", sessionKey: this.sessionKey });
    void this.getState().then((state) => {
      this.emit({ type: "state", sessionKey: this.sessionKey, state });
      turn.settled?.resolve(
        turn.error ? { ok: false, error: turn.error } : { ok: true, state },
      );
      if (!turn.error) this.sendNextQueued();
    });
  }

  prompt(message, images) {
    return this.runTurn("prompt", message, images);
  }

  steer(message, images) {
    return this.runTurn("steer", message, images);
  }

  // See GrokAgentProcess.followUp: codex has no separate follow-up channel
  // either, so this exists to keep the contract uniform across backends.
  followUp(message, images) {
    return this.runTurn("follow_up", message, images);
  }

  // ---- queue (same contract as the other backends) ----------------------

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

  // ---- session management ----------------------------------------------

  async compact() {
    if (!this.connection?.running || !this.threadId)
      return { ok: false, error: "Codex session is not running" };
    try {
      await this.connection.request("thread/compact/start", {
        threadId: this.threadId,
      });
      return { ok: true, state: await this.getState() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async abort() {
    if (!this.connection?.running || !this.threadId || !this.turn?.id)
      return { ok: true };
    try {
      await this.connection.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.turn.id,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async switchSession(sessionPath) {
    if (!sessionPath) return { ok: false, error: "sessionPath is required" };
    if (sessionPath === this.sessionFile) {
      return { ok: true, state: await this.getState() };
    }
    const cwd = this.cwd ?? homedir();
    this.stop();
    return this.start(cwd, { sessionPath });
  }

  async getMessages() {
    return this.messages;
  }

  async newSession() {
    if (!this.connection?.running)
      return { ok: false, error: "Codex is not running" };
    try {
      const started = await this.connection.request("thread/start", {
        cwd: this.cwd ?? homedir(),
        sandbox: this.accessMode,
        approvalPolicy: "never",
        ...(this.model?.id ? { model: this.model.id } : {}),
      });
      this.threadId = started.thread.id;
      this.sessionFile = started.thread.path;
      this.messages = [];
      return { ok: true, state: await this.getState() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async forkAt() {
    return {
      ok: false,
      error: "Forking a Codex conversation isn't supported yet.",
    };
  }

  async truncateAt() {
    return {
      ok: false,
      error: "Rewinding a Codex conversation isn't supported yet.",
    };
  }

  async getState() {
    const state = {
      status: this.status,
      isStreaming: this.status === "working",
      queuedMessages: this.queueSnapshot(),
      sessionId: this.threadId,
      cwd: this.cwd,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      sessionFile: this.sessionFile,
    };
    this.lastState = state;
    return state;
  }

  async getCommands() {
    try {
      const response = await this.connection?.request("skills/list", {});
      const entries = Array.isArray(response?.data) ? response.data : [];
      return {
        ok: true,
        commands: entries
          .filter((entry) => entry?.name && entry.enabled !== false)
          .map((entry) => ({
            name: entry.name,
            description: entry.shortDescription ?? entry.description ?? "",
            source: "skill",
          })),
      };
    } catch {
      return { ok: true, commands: [] };
    }
  }

  // ---- models and effort ------------------------------------------------

  async fetchModelCatalog() {
    if (this.modelCatalog) return this.modelCatalog;
    // The catalog is also needed before a session exists (a fresh tab lists
    // models), so fall back to the shared connection.
    const response = this.connection?.running
      ? await this.connection.request("model/list", {})
      : await codexRequest("model/list", {});
    this.modelCatalog = Array.isArray(response?.data) ? response.data : [];
    return this.modelCatalog;
  }

  async getAvailableModels() {
    try {
      const raw = await this.fetchModelCatalog();
      return {
        ok: true,
        models: raw
          .filter((model) => !model.hidden)
          .map((model) => ({
            provider: "codex",
            id: model.id,
            name: model.displayName ?? model.id,
          })),
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** The effort ladder codex advertises for one model, in catalog order. */
  async modelEfforts(modelId) {
    const raw = await this.fetchModelCatalog();
    const entry = raw.find((model) => model.id === modelId) ?? raw[0];
    return {
      levels: (entry?.supportedReasoningEfforts ?? []).map(
        (option) => option.reasoningEffort,
      ),
      fallback: entry?.defaultReasoningEffort,
    };
  }

  /** Keep `current` when the model offers it, else the model's own default. */
  async resolveEffort(modelId, current) {
    try {
      const { levels, fallback } = await this.modelEfforts(modelId);
      if (!levels.length) return current;
      if (current && levels.includes(current)) return current;
      return fallback ?? levels[0];
    } catch {
      return current;
    }
  }

  async getThinkingLevels() {
    try {
      const { levels } = await this.modelEfforts(this.model?.id);
      return { ok: true, levels };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  // Model and effort are turn/start overrides rather than session settings,
  // so switching either is just bookkeeping -- the next turn carries it.
  async setModel(_provider, modelId) {
    this.model = { provider: "codex", id: modelId };
    this.thinkingLevel = await this.resolveEffort(modelId, this.thinkingLevel);
    this.usageCache = { at: 0, result: undefined };
    return { ok: true, data: this.model, state: await this.getState() };
  }

  async setThinkingLevel(level) {
    this.thinkingLevel = await this.resolveEffort(this.model?.id, level);
    return { ok: true, state: await this.getState() };
  }

  setSessionName(name) {
    if (!this.connection?.running || !this.threadId)
      return Promise.resolve({ ok: false, error: "Codex is not running" });
    return this.connection
      .request("thread/name/set", { threadId: this.threadId, name })
      .then(() => ({ ok: true }))
      .catch((error) => ({
        ok: false,
        error: String(error?.message ?? error),
      }));
  }

  // ---- usage ------------------------------------------------------------

  async getUsage(force = false) {
    const now = Date.now();
    if (
      !force &&
      this.usageCache.result &&
      now - this.usageCache.at < USAGE_CACHE_TTL_MS
    )
      return this.usageCache.result;
    if (this.usageRequest) return this.usageRequest;
    this.usageRequest = loadCodexUsage(this.model?.id)
      .then((result) => {
        if (result?.ok) this.usageCache = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        this.usageRequest = undefined;
      });
    return this.usageRequest;
  }

  stop() {
    this.turn?.settled?.resolve({
      ok: false,
      error: "Codex session stopped",
    });
    this.turn = undefined;
    this.connection?.close();
    this.connection = undefined;
    this.threadId = undefined;
    this.setStatus("stopped");
  }
}

export class CodexAgentPool {
  constructor() {
    this.agents = new Map();
  }

  get(sessionKey) {
    let agent = this.agents.get(sessionKey);
    if (!agent) {
      agent = new CodexAgentProcess(sessionKey);
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
