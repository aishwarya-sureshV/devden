/**
 * ZCode backend (Z.ai's harness, github.com/zai-org/ZCode), driven through
 * `zcode agent-server` (see zcode-app-server.js). Shape and event vocabulary
 * mirror CodexAgentProcess deliberately: index.js routes every backend
 * through the same pool/watch machinery and the Conversation UI renders
 * whatever arrives on the shared event stream.
 *
 * Protocol map (ZCode Protocol, legacy methods, verified against v3.14.3):
 *   session/create   -> one devden conversation
 *   session/subscribe (deliveryKind "desktop-continuous") -> initial backlog
 *   state.updated notification -> pull session/events after the last seq
 *   session/send     -> prompt; turn.completed/turn.failed settle the turn
 *   session/setModel / setThoughtLevel -> picker controls
 *   interaction/requestPermission (agent->us request) -> ApprovalGate
 *   interaction/requestUserInput (agent->us request) -> ask blocks
 *
 * Not wired yet (capability flags hide the UI): fork, compact, session
 * listing/resume from the sidebar, native subagent cards, usage gauges.
 * // ponytail: sidebar resume needs session/list + a ~/.zcode log reader;
 * add alongside listZcodeSessions when the harness stabilizes.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { AgentPool } from "./agent-pool.js";
import { ApprovalGate } from "./approval-gate.js";
import { attachQueue } from "./agent-queue.js";
import { unsupported } from "./agent-methods.js";
import { ZcodeAgentServer } from "./zcode-app-server.js";
// ponytail: ZCode Protocol's legacy session/create has no system-prompt
// field, so the co-partner harness prompt can't be injected yet; v4
// importedHistory/custom-command surfaces may allow it later.

const DELIVERY_KIND = "desktop-continuous";
/** devden agentMode -> zcode session mode (plan|build|edit|yolo|auto). */
const MODE_FOR = { plan: "plan", manual: "build", "auto-edit": "edit" };

/** Snapshot settings.model.available[] entry -> devden ModelInfo. */
function modelOption(option) {
  const ref = option?.ref ?? {};
  return {
    provider: String(ref.providerId ?? "zcode"),
    id: String(ref.modelId ?? option.label ?? ""),
    name: option.label,
    ...(Number.isFinite(option.contextWindow) && option.contextWindow > 0
      ? { contextWindow: option.contextWindow }
      : {}),
    ...(Array.isArray(option.reasoning?.levels) && option.reasoning.levels.length
      ? { levels: option.reasoning.levels.map((level) => level.value) }
      : {}),
  };
}

export class ZcodeAgentProcess {
  constructor(sessionKey, options = {}) {
    this.sessionKey = sessionKey;
    this.serverOptions = options;
    this.connection = undefined;
    this.status = "stopped";
    this.sessionId = undefined;
    this.cwd = undefined;
    this.model = undefined;
    this.thinkingLevel = undefined;
    this.agentMode = undefined;
    this.approvalGate = new ApprovalGate(this);
    this.listeners = new Set();
    this.turn = undefined;
    this.pendingUserInputs = new Map();
    this.messages = [];
    this.queuedMessages = [];
    this.queueSeq = 0;
    this.lastSeq = 0;
    this.lastState = undefined;
    this.modelCatalog = undefined;
    this.thoughtLevels = undefined;
    this.starting = undefined;
    attachQueue(this, {
      isBusy() {
        return Boolean(this.turn);
      },
      sendNow(message, images) {
        return this.prompt(message, images);
      },
    });
  }

  // index.js treats `process` as "is this agent alive"; the agent-server
  // connection is this backend's equivalent.
  get process() {
    return this.connection?.running ? this.connection : undefined;
  }

  /** Durable session reference echoed back by the UI and passed to
   * start() on refresh; `zcode:<sessionId>` survives server restarts. */
  get sessionFile() {
    return this.sessionId ? `zcode:${this.sessionId}` : undefined;
  }

  static sessionIdFromPath(sessionPath) {
    const match = /^zcode:(.+)$/.exec(String(sessionPath ?? ""));
    return match ? match[1] : null;
  }

  isAlive() {
    return Boolean(this.connection?.running && this.sessionId);
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
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

  start(cwd, options = {}) {
    if (this.starting) return this.starting;
    this.starting = this.startSession(cwd, options).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async startSession(cwd, options = {}) {
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
    if (options.agentMode) this.agentMode = options.agentMode;
    if (options.model?.id) this.model = { provider: options.model.provider || "zcode", id: options.model.id };
    if (options.thinkingLevel) this.thinkingLevel = options.thinkingLevel;

    this.setStatus("starting");
    const connection = new ZcodeAgentServer(this.serverOptions);
    this.connection = connection;
    connection.onNotification((message) => this.handleNotification(message));
    connection.onServerRequest((message) => this.handleServerRequest(message));
    connection.onFailure((error) => this.connectionFailed(error));
    try {
      await connection.start();
      // A fresh create must never inherit the previous session's event
      // cursor: seq numbering restarts per session, so a stale lastSeq skips
      // the new session's events (including turn.completed) entirely.
      this.lastSeq = 0;
      const resumeId = ZcodeAgentProcess.sessionIdFromPath(options.sessionPath);
      const workspace = {
        workspacePath: effectiveCwd,
        workspaceKey: effectiveCwd,
      };
      const opened = resumeId
        ? await connection.request("session/resume", { sessionId: resumeId })
        : await connection.request("session/create", {
            workspace,
            mode: MODE_FOR[this.agentMode] ?? "build",
            persistence: "immediate",
            ...(this.model?.id
              ? { model: { providerId: this.model.provider, modelId: this.model.id } }
              : {}),
            ...(this.thinkingLevel ? { thoughtLevel: this.thinkingLevel } : {}),
          });
      this.sessionId = resumeId ?? opened?.sessionId;
      if (!this.sessionId) throw new Error("zcode session/create returned no sessionId");
      this.readSnapshot(opened);
      const subscribed = await connection.request("session/subscribe", {
        sessionId: this.sessionId,
        deliveryKind: DELIVERY_KIND,
        afterSeq: 0,
        includeSnapshot: !resumeId,
      });
      if (!resumeId) this.readSnapshot(subscribed?.snapshot);
      this.lastSeq = subscribed?.eventSeq ?? 0;
      this.setStatus("ready");
      const replayed = resumeId ? this.replaySnapshotMessages(opened) : undefined;
      const state = await this.getState();
      return replayed
        ? { ok: true, state, messages: replayed }
        : { ok: true, state };
    } catch (error) {
      const message = String(error?.message ?? error);
      this.stop();
      this.setStatus("error", message);
      return { ok: false, error: message };
    }
  }

  /** The subscribe snapshot carries the model catalog and current picks. */
  readSnapshot(snapshot) {
    if (!snapshot) return;
    const settings = snapshot.settings ?? {};
    const available = settings.model?.available ?? [];
    if (available.length) {
      this.modelCatalog = available.map(modelOption);
      const current = settings.model.current;
      if (current?.modelId)
        this.model = { provider: current.providerId, id: current.modelId };
    }
    const levels = settings.thoughtLevel?.available ?? [];
    if (levels.length) {
      this.thoughtLevels = levels.map((level) => ({ id: level.value, label: level.label }));
      if (settings.thoughtLevel.current) this.thinkingLevel = settings.thoughtLevel.current;
    }
    if (snapshot.session?.title)
      this.emit({ type: "session_name", sessionKey: this.sessionKey, name: snapshot.session.title });
  }

  connectionFailed(error) {
    if (this.turn) this.finishTurn({ error: String(error?.message ?? error) });
    this.sessionId = undefined;
    this.setStatus("error", String(error?.message ?? error));
  }

  /** Turn a resumed session's snapshot messages into the same devden
   * message shapes a live turn produces, so a refreshed tab renders
   * history and new work identically. */
  replaySnapshotMessages(snapshot) {
    const replayed = [];
    for (const entry of snapshot?.messages ?? []) {
      const info = entry?.info;
      const parts = entry?.parts ?? [];
      if (!info?.messageId) continue;
      const content = [];
      const results = [];
      for (const part of parts) {
        if (part.type === "text" && part.text)
          content.push({ type: "text", text: part.text });
        else if (part.type === "reasoning" && part.text)
          content.push({ type: "thinking", thinking: part.text });
        else if (part.type === "tool") {
          const state = part.state ?? {};
          content.push({
            type: "toolCall",
            id: part.callId,
            name: part.tool,
            arguments: state.input ?? {},
          });
          const output = state.status === "error" ? state.error
            : state.status === "completed" ? state.output : "";
          if (output) results.push({
            role: "toolResult",
            toolCallId: part.callId,
            toolName: part.tool,
            content: [{ type: "text", text: String(output) }],
            isError: state.status === "error",
            timestamp: info.time?.completed ?? info.time?.created ?? Date.now(),
          });
        }
      }
      if (info.role === "user") {
        replayed.push({
          role: "user",
          content: [{ type: "text", text: String(info.content ?? "") }],
          timestamp: info.time?.created ?? Date.now(),
        });
      } else if (info.role === "assistant") {
        replayed.push({
          role: "assistant",
          content,
          api: "zcode",
          provider: "zcode",
          model: info.model?.modelId ?? "GLM",
          usage: info.tokens?.total ? { totalTokens: info.tokens.total } : undefined,
          stopReason: info.error ? "error" : "end_turn",
          ...(info.error ? { errorMessage: String(info.error.message ?? info.error) } : {}),
          timestamp: info.time?.completed ?? info.time?.created ?? Date.now(),
        });
        replayed.push(...results);
      }
    }
    this.messages = replayed;
    return replayed;
  }

  // ---- event pump -------------------------------------------------------

  handleNotification(message) {
    if (message.method !== "state.updated") return;
    const params = message.params ?? {};
    if (params.sessionId && params.sessionId !== this.sessionId) return;
    this.drainEvents();
  }

  /** Pull new events after the last seen seq; notifications only signal. */
  async drainEvents() {
    const connection = this.connection;
    if (!connection?.running || !this.sessionId || this.draining) return;
    this.draining = true;
    try {
      while (connection.running) {
        const result = await connection.request("session/events", {
          sessionId: this.sessionId,
          afterSeq: this.lastSeq,
        });
        const events = result?.events ?? [];
        for (const event of events) {
          this.handleSessionEvent(event);
          this.trackSeq(event);
        }
        if (!events.length) break;
      }
    } catch {
      /* a failed pull retries on the next state.updated */
    } finally {
      this.draining = false;
    }
  }

  trackSeq(event) {
    const seq = Number(event?.seq ?? 0);
    if (Number.isFinite(seq) && seq > this.lastSeq) this.lastSeq = seq;
  }

  handleSessionEvent(event) {
    if (!event || typeof event !== "object") return;
    const payload = event.payload ?? {};
    switch (event.type) {
      case "turn.started": {
        const turn = this.turn;
        if (turn && !turn.id) turn.id = event.turnId;
        return;
      }
      case "part.upserted":
        this.handlePart(payload.part);
        return;
      case "part.delta":
        this.handlePartDelta(payload);
        return;
      case "part.removed":
        return; // ponytail: removals only matter for edits we don't stream
      case "tool.updated":
        this.handleToolUpdated(payload);
        return;
      case "model.streaming":
        this.handleModelStreaming(payload);
        return;
      case "turn.completed":
        this.finishTurn(payload);
        return;
      case "turn.failed":
        this.finishTurn({
          error: String(payload.error?.message ?? "ZCode turn failed"),
        });
        return;
      case "session.titleUpdated":
        this.emit({ type: "session_name", sessionKey: this.sessionKey, name: payload.title ?? payload.name });
        return;
      case "message.upserted":
        return; // live parts already carry the content; used for replay only
      default:
        return;
    }
  }

  /** Map one zcode message part onto the open assistant turn's content.
   * Live turns stream via model.streaming; part.upserted is the durable
   * projection (cold resume, post-commit correction), so it always SETS
   * absolute text rather than appending. */
  handlePart(part) {
    const turn = this.turn;
    if (!turn || !part || !part.partId) return;
    if (part.type === "text" || part.type === "reasoning") {
      this.upsertBlock(
        turn,
        part.partId,
        part.type === "text" ? "text" : "thinking",
        part.text ?? "",
      );
      return;
    }
    // step-start/step-finish/snapshot/patch/compaction/timeline: no devden
    // rendering yet.
  }

  /** model.streaming is the live wire: text/reasoning deltas and tool
   * argument input, keyed by partId (same id space as part.upserted) and
   * toolCallId (same as tool.updated). */
  handleModelStreaming(payload) {
    const turn = this.turn;
    if (!turn || !payload?.kind) return;
    const kind = payload.kind;
    if (kind.startsWith("text")) {
      const partId = payload.partId;
      if (!partId) return;
      if (kind === "text_start") this.upsertBlock(turn, partId, "text", "");
      else if (kind === "text_delta")
        this.upsertBlock(turn, partId, "text", String(payload.delta ?? ""), { append: true });
      // text_end: the accumulated text is already absolute.
      return;
    }
    if (kind.startsWith("reasoning")) {
      const partId = payload.partId;
      if (!partId) return;
      if (kind === "reasoning_start") this.upsertBlock(turn, partId, "thinking", "");
      else if (kind === "reasoning_delta")
        this.upsertBlock(turn, partId, "thinking", String(payload.delta ?? ""), { append: true });
      return;
    }
    if (kind.startsWith("tool_input")) {
      const id = payload.toolCallId;
      if (!id) return;
      if (kind === "tool_input_start") {
        this.openStreamingTool(turn, id, payload.toolName ?? "tool");
        return;
      }
      const block = this.toolBlock(turn, id, payload.toolName);
      if (!block) return;
      if (kind === "tool_input_delta") {
        block.rawInput = `${block.rawInput ?? ""}${String(payload.delta ?? "")}`;
        block.arguments = safeJson(block.rawInput);
      } else if (kind === "tool_input_end" || kind === "tool_call") {
        // The frame carries the complete parsed input when present.
        if (payload.input !== undefined) block.arguments = payload.input;
        else if (block.rawInput) block.arguments = safeJson(block.rawInput);
        const index = turn.partIndex.get(id);
        if (index !== undefined)
          this.emitUpdate({ type: "toolcall_end", contentIndex: index, toolCall: block });
      }
      return;
    }
    // start/finish/error: turn lifecycle comes from turn.completed/failed.
  }

  openStreamingTool(turn, id, name) {
    if (turn.partIndex.has(id)) return;
    const block = {
      type: "toolCall",
      id,
      name,
      arguments: {},
      rawInput: "",
    };
    turn.content.push(block);
    const index = turn.content.length - 1;
    turn.partIndex.set(id, index);
    this.emitUpdate({ type: "toolcall_start", contentIndex: index });
    this.emit({
      type: "tool_execution_start",
      sessionKey: this.sessionKey,
      toolCallId: id,
      toolName: name,
      args: block.arguments,
    });
  }

  toolBlock(turn, id, name) {
    const index = turn.partIndex.get(id);
    if (index !== undefined) return turn.content[index];
    this.openStreamingTool(turn, id, name ?? "tool");
    const created = turn.partIndex.get(id);
    return created === undefined ? undefined : turn.content[created];
  }

  /**
   * Insert or update one content block keyed by zcode partId, emitting the
   * start/end pair the timeline expects. `append` marks a streaming delta
   * (model.streaming / part.delta); without it the value is absolute
   * (part.upserted's durable projection) and overwrites.
   */
  upsertBlock(turn, partId, blockType, value, { append = false } = {}) {
    const existing = turn.partIndex.get(partId);
    if (existing !== undefined) {
      const block = turn.content[existing];
      if (blockType === "tool") Object.assign(block, value);
      else if (block.type === "text")
        block.text = append ? `${block.text ?? ""}${value}` : value;
      else if (block.type === "thinking")
        block.thinking = append ? `${block.thinking ?? ""}${value}` : value;
      this.emitUpdate(
        blockType === "tool"
          ? { type: "toolcall_end", contentIndex: existing, toolCall: block }
          : blockType === "text"
            ? { type: append ? "text_delta" : "text_end", contentIndex: existing, ...(append ? { delta: value } : { content: block.text }) }
            : { type: append ? "thinking_delta" : "thinking_end", contentIndex: existing, ...(append ? { delta: value } : { content: block.thinking }) },
      );
      return existing;
    }
    if (blockType === "text") {
      // Consecutive text parts merge into one block, like the other backends.
      const last = turn.content[turn.content.length - 1];
      if (last?.type === "text") {
        last.text = `${last.text ?? ""}${value}`;
        turn.partIndex.set(partId, turn.content.length - 1);
        this.emitUpdate({
          type: "text_delta",
          contentIndex: turn.content.length - 1,
          delta: value,
        });
        return turn.content.length - 1;
      }
    }
    const block = blockType === "tool" ? value : blockType === "text"
      ? { type: "text", text: value }
      : { type: "thinking", thinking: value };
    turn.content.push(block);
    const index = turn.content.length - 1;
    turn.partIndex.set(partId, index);
    if (blockType === "tool") {
      this.emitUpdate({ type: "toolcall_start", contentIndex: index });
      this.emit({
        type: "tool_execution_start",
        sessionKey: this.sessionKey,
        toolCallId: block.id,
        toolName: block.name,
        args: block.arguments,
      });
    } else {
      this.emitUpdate({
        type: blockType === "text" ? "text_start" : "thinking_start",
        contentIndex: index,
      });
    }
    return index;
  }

  handlePartDelta(payload) {
    const turn = this.turn;
    if (!turn || !payload?.partId) return;
    const index = turn.partIndex.get(payload.partId);
    if (index === undefined) return;
    const block = turn.content[index];
    if (!block) return;
    if (block.type === "text" && payload.field === "text") {
      block.text = `${block.text ?? ""}${payload.delta ?? ""}`;
      this.emitUpdate({ type: "text_delta", contentIndex: index, delta: payload.delta ?? "" });
      return;
    }
    if (block.type === "thinking" && payload.field === "reasoning") {
      block.thinking = `${block.thinking ?? ""}${payload.delta ?? ""}`;
      this.emitUpdate({ type: "thinking_delta", contentIndex: index, delta: payload.delta ?? "" });
    }
  }

  /** Tool lifecycle from tool.updated events (scheduled/started/result/error). */
  handleToolUpdated(payload) {
    const turn = this.turn;
    if (!turn || !payload?.toolCallId) return;
    const id = payload.toolCallId;
    if (payload.kind === "scheduled" || payload.kind === "started") {
      if (turn.partIndex.has(id)) return;
      const block = {
        type: "toolCall",
        id,
        name: payload.toolName ?? "tool",
        arguments: safeJson(
          typeof payload.input === "string"
            ? payload.input
            : payload.input ?? {},
        ),
        rawInput: typeof payload.input === "string" ? payload.input : undefined,
      };
      turn.content.push(block);
      const index = turn.content.length - 1;
      turn.partIndex.set(id, index);
      this.emitUpdate({ type: "toolcall_start", contentIndex: index });
      this.emit({
        type: "tool_execution_start",
        sessionKey: this.sessionKey,
        toolCallId: id,
        toolName: block.name,
        args: block.arguments,
      });
      return;
    }
    if (payload.kind === "progress") return;
    if (payload.kind === "result" || payload.kind === "error") {
      let index = turn.partIndex.get(id);
      if (index === undefined) {
        // A result without a start we saw: create the block late.
        this.handleToolUpdated({
          ...payload,
          kind: "started",
          toolName: payload.toolName ?? "tool",
          input: payload.input ?? {},
        });
        index = turn.partIndex.get(id);
        if (index === undefined) return;
      }
      const block = turn.content[index];
      if (block?.type !== "toolCall") return;
      const output = payload.kind === "error"
        ? String(payload.error?.message ?? "tool failed")
        : String(payload.result?.output ?? payload.result?.text ?? "");
      this.emitUpdate({
        type: "toolcall_end",
        contentIndex: index,
        toolCall: block,
      });
      this.emit({
        type: "tool_execution_end",
        sessionKey: this.sessionKey,
        toolCallId: id,
        result: { content: [{ type: "text", text: output }], details: payload },
        isError: payload.kind === "error",
      });
      turn.results ??= [];
      turn.results.push({
        role: "toolResult",
        toolCallId: id,
        toolName: block.name,
        content: [{ type: "text", text: output }],
        details: payload,
        isError: payload.kind === "error",
        timestamp: Date.now(),
      });
    }
  }

  // Text blocks merge into the open one; thinking and tools each get their own.
  // (Handled inline in upsertBlock.)

  // ---- prompts ----------------------------------------------------------

  async prompt(message, images) {
    return this.runTurn("prompt", message, images);
  }

  async steer() {
    return unsupported("steer", "ZCode does not support steering mid-turn.");
  }

  async runTurn(kind, message, images) {
    if (!this.connection?.running || !this.sessionId)
      return { ok: false, error: "ZCode session is not running" };
    if (this.turn)
      return { ok: false, error: "A ZCode turn is already in progress" };
    if (kind !== "prompt")
      return { ok: false, error: `Unsupported turn kind: ${kind}` };

    const text = String(message ?? "");
    const userMessage = {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    };
    this.emit({ type: "agent_start", sessionKey: this.sessionKey });
    this.emit({ type: "turn_start", sessionKey: this.sessionKey });
    this.emit({ type: "message_start", sessionKey: this.sessionKey, message: userMessage });
    this.emit({ type: "message_end", sessionKey: this.sessionKey, message: userMessage });

    const assistantMessage = {
      role: "assistant",
      content: [],
      api: "zcode",
      provider: "zcode",
      model: this.model?.id ?? "GLM",
      usage: undefined,
      stopReason: "pending",
      timestamp: Date.now(),
    };
    this.emit({ type: "message_start", sessionKey: this.sessionKey, message: assistantMessage });

    const settled = Promise.withResolvers();
    this.turn = {
      id: undefined,
      content: assistantMessage.content,
      message: assistantMessage,
      partIndex: new Map(),
      userMessage,
      settled,
      results: [],
    };
    this.setStatus("working");

    try {
      await this.connection.request("session/send", {
        sessionId: this.sessionId,
        content: text,
        ...((images?.length)
          ? {
              // The protocol mapper (mapProtocolPromptAttachment) accepts
              // kind/dataBase64/localPath — not bare {mimeType, data}.
              attachments: images
                .filter((image) => image?.data && image?.mimeType)
                .map((image) => ({
                  kind: "image",
                  dataBase64: image.data,
                  mimeType: image.mimeType,
                  filename: image.filename ?? "image",
                })),
            }
          : {}),
      });
      return await settled.promise;
    } catch (error) {
      if (this.turn) this.finishTurn({ error: String(error?.message ?? error) });
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  finishTurn(completed) {
    const turn = this.turn;
    if (!turn) return;
    const error = completed?.error;
    if (error) turn.error = error;
    this.approvalGate.denyAll();
    this.dismissQuestions();
    turn.message.stopReason = error ? "error" : "end_turn";
    if (error) turn.message.errorMessage = error;
    // turn.completed carries the final aggregate text; if parts streamed,
    // it should agree, but a non-empty response wins for a silent turn.
    const response = completed?.response;
    if (response && !turn.content.some((block) => block.type === "text" && block.text)) {
      turn.content.push({ type: "text", text: response });
    }
    if (Number.isFinite(completed?.tokenCount) && completed.tokenCount > 0) {
      turn.message.usage = { totalTokens: completed.tokenCount };
    }
    this.emit({ type: "message_end", sessionKey: this.sessionKey, message: turn.message });
    this.emit({ type: "turn_end", sessionKey: this.sessionKey, message: turn.message });
    this.emit({
      type: "agent_end",
      sessionKey: this.sessionKey,
      messages: [turn.userMessage, turn.message].filter(Boolean),
    });
    this.messages.push(...[turn.userMessage, turn.message, ...(turn.results ?? [])].filter(Boolean));
    this.turn = undefined;
    void this.getState().then((state) => {
      this.emit({ type: "state", sessionKey: this.sessionKey, state });
      turn.settled?.resolve(
        turn.error ? { ok: false, error: turn.error } : { ok: true, state },
      );
      // Settled turns flush the queue, matching every other backend
      // (codex settleWhenIdle): a follow-up typed mid-turn sends now.
      try {
        this.sendNextQueued();
      } catch {
        /* queue flush must not break turn settlement */
      }
    });
  }

  emitUpdate(update) {
    if (!this.turn) return;
    this.emit({
      type: "message_update",
      sessionKey: this.sessionKey,
      assistantMessageEvent: update,
    });
  }

  // ---- agent->client requests -------------------------------------------

  reply(id, result) {
    try { this.connection?.respond(id, result); } catch { /* transport closed */ }
  }

  handleServerRequest(message) {
    const params = message.params ?? {};
    if (message.method === "interaction/requestPermission") {
      this.handlePermissionRequest(message, params);
      return;
    }
    if (message.method === "interaction/requestUserInput") {
      this.handleUserInputRequest(message, params);
      return;
    }
    if (message.method === "interaction/requestProviderRuntimeHeaders") {
      this.handleProviderRuntimeHeaders(message, params);
      return;
    }
    // devden holds no official-MCP identity; an honest "not applied" lets
    // the harness surface its own sign-in error instead of hanging.
    if (message.method === "interaction/requestOfficialMcpAuthHeaders") {
      this.reply(message.id, {
        headersApplied: false,
        errorMessage: "devden does not manage official MCP auth; connect the server inside ZCode.",
      });
      return;
    }
    try { this.connection?.respondError(message.id, `Unsupported ZCode request: ${message.method}`); } catch { /* closed */ }
  }

  /**
   * Account-based GLM models refresh their request auth through this
   * reverse request before every model call (the desktop host normally
   * answers it). Reply with the coding-plan api key `zcode login` stored
   * (standalone account-provider keys), falling back to the desktop-era
   * oauth token as a Bearer header. Verified against
   * standalone-account-provider-runtime.ts + provider-runtime-headers.ts.
   */
  handleProviderRuntimeHeaders(message, params) {
    void zcodeRequestAuth(params?.providerId).then((auth) => {
      this.reply(
        message.id,
        auth
          ? { headersApplied: true, requestAuth: auth }
          : {
              headersApplied: false,
              errorMessage:
                "No ZCode credentials found. Run `zcode login`, then retry.",
            },
      );
    }).catch(() =>
      this.reply(message.id, {
        headersApplied: false,
        errorMessage: "devden could not read the ZCode credential store.",
      }),
    );
  }

  handlePermissionRequest(message, params) {
    const deny = { decision: "deny" };
    const options = (params.options ?? []).map((option) => ({
      id: option.optionId,
      label: option.name ?? option.optionId,
    }));
    // Plan mode stays read-only. Otherwise trust the gate: standard mode's
    // gate self-approves (allow), manual/auto-edit actually ask.
    if (this.agentMode === "plan") {
      this.reply(message.id, deny);
      return;
    }
    const toolName = String(params.toolName ?? "tool");
    void this.approvalGate.request({
      toolName,
      title: toolName,
      detail: String(params.reason ?? ""),
      options: options.length ? options : undefined,
    }).then(({ allow, choice }) => {
      if (!allow) return this.reply(message.id, deny);
      // The chosen option carries its own protocol response (decision +
      // permissionUpdates — e.g. "always allow in project"); pass it through
      // so the harness records the rule instead of re-asking forever.
      const chosen = (params.options ?? []).find(
        (option) => option.optionId === choice,
      );
      const response = chosen?.response;
      if (response && typeof response === "object") {
        this.reply(message.id, {
          decision: response.decision ?? "allow",
          ...(Array.isArray(response.permissionUpdates)
            ? { permissionUpdates: response.permissionUpdates }
            : {}),
          ...(response.modifiedInput !== undefined
            ? { modifiedInput: response.modifiedInput }
            : {}),
          ...(response.reason ? { reason: response.reason } : {}),
        });
      } else {
        this.reply(message.id, { decision: "allow" });
      }
      // ZCode's persistent options carry permissionUpdates; remember the
      // tool so the shared gate stops asking for the rest of the process.
      if (choice && choice !== "allow" && /always|project|session/i.test(choice))
        this.approvalGate.allowedTools.add(toolName);
    }).catch(() => this.reply(message.id, deny));
  }

  /**
   * ZCode asks either free-form (prompt) or structured questions (options
   * with value/label). devden's ask card answers with the question TEXT as
   * key (normalizeAskUserQuestionResponseContent reads answers by question
   * text, with content.answer as the single-question compat path).
   */
  handleUserInputRequest(message, params) {
    const requestId = String(params.requestId ?? message.id);
    const zcodeQuestions = Array.isArray(params.questions) && params.questions.length
      ? params.questions
      : [{ question: String(params.prompt ?? ""), header: "Question", options: [] }];
    const questions = zcodeQuestions.map((question, index) => ({
      id: `q${index}`,
      header: String(question.header ?? "Question"),
      question: String(question.question ?? ""),
      ...(Array.isArray(question.options) && question.options.length
        ? {
            options: question.options.map((option) => ({
              label: String(option.label ?? option.value),
              // value rides along for the reply mapping.
              value: String(option.value ?? option.label),
            })),
          }
        : {}),
      ...(question.multiSelect ? { multiSelect: true } : {}),
    }));
    this.pendingUserInputs.set(requestId, {
      id: message.id,
      questions,
      // question text -> value per option label, for the reply mapping.
      byText: zcodeQuestions.map((question) => ({
        text: String(question.question ?? ""),
        labelToValue: new Map(
          (question.options ?? []).map((option) => [
            String(option.label ?? option.value),
            String(option.value ?? option.label),
          ]),
        ),
      })),
      freeForm: !Array.isArray(params.questions) || !params.questions.length,
    });
    this.emit({ type: "user_input_request", sessionKey: this.sessionKey, requestId, questions });
  }

  resolveUserInput(requestId, answers) {
    const entry = this.pendingUserInputs.get(String(requestId));
    if (!entry) return { ok: false, error: "No pending ZCode question with that id" };
    let result;
    if (entry.freeForm || !entry.byText?.length) {
      const text = Array.isArray(answers?.q0?.answers) ? answers.q0.answers[0] : undefined;
      result = text === undefined || text === ""
        ? { action: "decline" }
        : { action: "accept", content: { answer: String(text) } };
    } else {
      const content = {};
      const collected = [];
      entry.byText.forEach(({ text, labelToValue }, index) => {
        const picked = answers?.[`q${index}`]?.answers ?? [];
        if (!picked.length) return;
        const values = picked.map((label) => labelToValue.get(String(label)) ?? String(label));
        content[text] = values.join(", ");
        collected.push(...values);
      });
      result = collected.length
        ? { action: "accept", content: { answers: content } }
        : { action: "decline" };
    }
    this.reply(entry.id, result);
    this.pendingUserInputs.delete(String(requestId));
    this.emit({ type: "user_input_resolved", sessionKey: this.sessionKey, requestId: String(requestId) });
    return { ok: true };
  }

  dismissQuestions() {
    for (const [id, entry] of this.pendingUserInputs) {
      try { this.connection?.respond(entry.id, { action: "cancel" }); } catch { /* closed */ }
      this.emit({ type: "user_input_resolved", sessionKey: this.sessionKey, requestId: id });
    }
    this.pendingUserInputs.clear();
  }

  // ---- controls ---------------------------------------------------------

  resolveApproval(requestId, optionId) {
    return this.approvalGate.resolve(String(requestId), String(optionId));
  }

  async abort() {
    // Stop means stop: queued follow-ups wait for the user (as on every other
    // backend) instead of firing the moment the stopped turn settles.
    this.approvalGate.denyAll();
    this.holdQueue();
    if (!this.connection?.running || !this.sessionId)
      return { ok: false, error: "ZCode session is not running" };
    try {
      await this.connection.request("session/stop", { sessionId: this.sessionId });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async newSession() {
    if (!this.connection?.running) return { ok: false, error: "ZCode session is not running" };
    this.sessionId = undefined;
    this.messages = [];
    this.turn = undefined;
    try {
      // Same cursor rule as startSession: seq restarts with the new session.
      this.lastSeq = 0;
      const created = await this.connection.request("session/create", {
        workspace: {
          workspacePath: this.cwd ?? homedir(),
          workspaceKey: this.cwd ?? homedir(),
        },
        mode: MODE_FOR[this.agentMode] ?? "build",
        persistence: "immediate",
        ...(this.model?.id
          ? { model: { providerId: this.model.provider, modelId: this.model.id } }
          : {}),
      });
      this.sessionId = created?.sessionId;
      const subscribed = await this.connection.request("session/subscribe", {
        sessionId: this.sessionId,
        deliveryKind: DELIVERY_KIND,
        afterSeq: 0,
        includeSnapshot: true,
      });
      this.lastSeq = subscribed?.eventSeq ?? 0;
      return { ok: true, state: await this.getState() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async setModel(provider, modelId) {
    if (!this.connection?.running || !this.sessionId)
      return { ok: false, error: "ZCode session is not running" };
    try {
      await this.connection.request("session/setModel", {
        sessionId: this.sessionId,
        model: { providerId: provider || this.model?.provider || "zcode", modelId },
      });
      this.model = { provider: provider || this.model?.provider || "zcode", id: modelId };
      return { ok: true, state: await this.getState() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async getAvailableModels() {
    return { ok: true, models: (this.modelCatalog ?? []).map((model) => ({ ...model })) };
  }

  async getThinkingLevels() {
    return {
      ok: true,
      levels: (this.thoughtLevels ?? []).map((level) => level.id ?? level),
    };
  }

  async setThinkingLevel(level) {
    if (!this.connection?.running || !this.sessionId)
      return { ok: false, error: "ZCode session is not running" };
    try {
      await this.connection.request("session/setThoughtLevel", {
        sessionId: this.sessionId,
        thoughtLevel: String(level),
      });
      this.thinkingLevel = String(level);
      return { ok: true, state: await this.getState() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async getMessages() {
    return [...this.messages];
  }

  async getCommands() {
    return [];
  }

  async getState() {
    const state = {
      status: this.status,
      isStreaming: Boolean(this.turn),
      pendingUserInputs: [...this.pendingUserInputs.entries()].map(
        ([requestId, entry]) => ({
          requestId,
          // The ask card renders from state; keep the questions it needs.
          questions: entry.questions ?? [],
        }),
      ),
      messageCount: this.messages.filter((message) => message.role !== "toolResult").length,
      queuedMessages: this.queueSnapshot(),
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      cwd: this.cwd,
      model: this.model ? { ...this.model } : undefined,
      thinkingLevel: this.thinkingLevel,
    };
    this.lastState = state;
    return state;
  }

  // ZCode exposes no account quota. Without this, GET /api/usage threw for
  // every backend (it fans out to all five), not just zcode.
  async getUsage() {
    return { ok: true, usage: { available: false, provider: "ZCode", windows: [] } };
  }

  stop() {
    // A prompt parked on a running turn must settle, or its request hangs.
    if (this.turn) this.finishTurn({ error: "Session stopped" });
    const connection = this.connection;
    this.connection = undefined;
    this.sessionId = undefined;
    if (!connection) return;
    this.approvalGate.denyAll();
    this.dismissQuestions();
    connection.close();
    this.setStatus("stopped");
  }
}

function safeJson(text) {
  if (typeof text !== "string") return text ?? {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Build requestAuth for interaction/requestProviderRuntimeHeaders from the
 * shared ZCode credential store (~/.zcode/v2/credentials.json — the same
 * store the desktop app and `zcode login` use). Standalone coding-plan keys
 * (account-provider:coding-plan:...) carry the api key; desktop-era oauth
 * tokens fall back to a Bearer header.
 * // ponytail: the oauth bearer fallback is inferred, not verified against
 * the desktop host; drop it if the CLI rejects it.
 */
export async function zcodeRequestAuth(providerId) {
  const { readFile } = await import("node:fs/promises");
  const { homedir: home } = await import("node:os");
  const { join } = await import("node:path");
  let credentials = {};
  for (const candidate of [
    process.env.DEVDEN_ZCODE_CREDENTIALS,
    join(home(), ".zcode", "v2", "credentials.json"),
    join(home(), ".zcode", "credentials.json"),
  ]) {
    if (!candidate) continue;
    try {
      credentials = JSON.parse(await readFile(candidate, "utf8"));
      break;
    } catch {
      /* try the next path */
    }
  }
  const trim = (value) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  if (providerId) {
    const identity = trim(credentials[`account-provider:${providerId}:identity`]);
    if (identity) {
      const apiKey = trim(
        credentials[
          `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`
        ],
      );
      if (apiKey) return { apiKey };
    }
  }
  // Any standalone coding-plan key works when the provider id misses.
  for (const [key, value] of Object.entries(credentials)) {
    if (key.startsWith("account-provider:coding-plan:") && trim(value))
      return { apiKey: trim(value) };
  }
  const token = trim(
    credentials["oauth:zai:access_token"] ?? credentials["oauth:bigmodel:access_token"],
  );
  if (token) return { headers: { Authorization: `Bearer ${token}` } };
  return null;
}

export class ZcodeAgentPool extends AgentPool {
  constructor() {
    super((sessionKey) => new ZcodeAgentProcess(sessionKey));
  }
}