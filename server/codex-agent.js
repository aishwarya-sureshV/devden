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
import { readFile } from "node:fs/promises";
import { codexUsageFrom as usageFrom, codexUserContent as userContent, readCodexLog } from "./codex-history.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { AgentPool } from "./agent-pool.js";
import { ApprovalGate } from "./approval-gate.js";
import { attachQueue } from "./agent-queue.js";
import { unsupported } from "./agent-methods.js";
import {
  attachSubagentFollows,
  isPiSubagentTool,
  isSubagentToolName,
  noteSubagentToolEvent,
  subagentBusy,
} from "./agent-subagent.js";
import { CodexAppServer, codexRequest } from "./codex-app-server.js";
import { loadCodexUsage } from "./codex-usage.js";
import { readCodexModels } from "./codex-models.js";
import { MODEL_CATALOG_TTL_MS } from "./model-catalog.js";
import {
  repoContext,
  CO_PARTNER_PROMPT,
  CO_PARTNER_PROMPT_MANUAL,
  CLARIFY_PROMPT,
} from "./co-partner-prompt.js";

export const CODEX_SESSIONS_ROOT = () =>
  join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");

const DEFAULT_MODEL_ID = "gpt-5.6-terra";
const USAGE_CACHE_TTL_MS = 5 * 60_000;

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

/**
 * Rollout files are named rollout-<ISO timestamp>-<thread uuid>.jsonl, so a
 * saved-session path (devden's session identity) yields the threadId that
 * `thread/resume` wants without opening the file.
 */
export function threadIdFromPath(sessionPath) {
  const match = /-([0-9a-f-]{36})\.jsonl$/i.exec(basename(sessionPath ?? ""));
  return match?.[1];
}

/**
 * Every thread item that is not a message or reasoning renders as a tool
 * card. Returns the display name plus the arguments the card shows, or
 * undefined for item kinds the timeline has no card for.
 */
function toolCallOf(item) {
  switch (item.type) {
    case "collabAgentToolCall":
      return {
        name: item.tool === "spawnAgent" ? "spawn_subagent" : item.tool,
        arguments: { prompt: item.prompt, model: item.model, agents: item.receiverThreadIds },
        output: JSON.stringify(item.agentsStates ?? {}), failed: item.status === "failed",
      };
    case "imageGeneration":
    case "sleep":
    case "enteredReviewMode":
    case "exitedReviewMode":
      return { name: item.type, arguments: item, output: item.result ?? item.review ?? "", failed: item.status === "failed" };
    case "commandExecution": {
      const action = item.commandActions?.length === 1 ? item.commandActions[0] : undefined;
      return {
        name: ({ read: "read", search: "grep", listFiles: "ls" })[action?.type] ?? "shell",
        execKind: "execute",
        arguments: { command: item.command, cwd: item.cwd, ...(action?.path ? { path: action.path } : {}), ...(action?.query ? { pattern: action.query } : {}) },
        output: item.aggregatedOutput ?? "",
        failed: item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0),
      };
    }
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

function turnStamp(turn) {
  const candidates = [
    turn?.timestamp,
    turn?.completedAt,
    turn?.startedAt,
    turn?.createdAt,
  ];
  for (const value of candidates) {
    const n = typeof value === "number" ? value : Date.parse(value ?? "");
    if (Number.isFinite(n) && n > 0) return n;
  }
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const value = items[i]?.timestamp;
    const n = typeof value === "number" ? value : Date.parse(value ?? "");
    if (Number.isFinite(n) && n > 0) return n;
  }
  return NaN;
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
    this.agentMode = undefined;
    this.approvalGate = new ApprovalGate(this);
    this.sessionFile = undefined;
    this.lastState = undefined;
    this.listeners = new Set();
    this.turn = undefined;
    this.pendingUserInputs = new Map();
    this.nativeApprovals = new Map();
    this.nativeChildren = new Map();
    this.openSubagents = new Set();
    this.nativeToolEnds = new Map();
    this.tokenUsage = undefined;
    // See GrokAgentProcess: replayed history is returned synchronously from
    // start(), so re-emitting it as live events would double-render it.
    this.suppressReplayEvents = false;
    this.accessMode = "workspace-write";
    this.modelCatalog = undefined;
    this.skills = [];
    this.messages = [];
    // {id, timestamp} per completed turn: codex's thread/fork cuts history
    // at a turn boundary (lastTurnId), but the UI asks by message timestamp.
    this.turnRecords = [];
    this.queuedMessages = [];
    this.queueSeq = 0;
    attachQueue(this, {
      isBusy() {
        return Boolean(this.turn) || subagentBusy(this);
      },
      sendNow(message, images) {
        return this.prompt(message, images);
      },
      steerNow(message, images) {
        return this.steer(message, images);
      },
    });
    attachSubagentFollows(this);
    this.usageCache = { at: 0, result: undefined };
    this.usageRequest = undefined;
  }

  // index.js treats `process` as "is this agent alive"; the app-server
  // connection is this backend's equivalent.
  get process() {
    return this.connection?.running ? this.connection : undefined;
  }

  isAlive() {
    return Boolean(this.connection?.running && this.threadId);
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

  start(cwd, options = {}) {
    if (this.starting) return this.starting;
    this.starting = this.startSession(cwd, options).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  threadConfig(cwd = this.cwd) {
    return {
      cwd, sandbox: this.agentMode === "plan" ? "read-only" : this.accessMode,
      approvalPolicy: this.approvalGate.enabled ? "untrusted" : "never",
      developerInstructions: [
        this.agentMode === "manual" ? CO_PARTNER_PROMPT_MANUAL : CO_PARTNER_PROMPT,
        CLARIFY_PROMPT, repoContext(cwd),
        this.agentMode === "plan" ? "Plan only. Inspect and explain the proposed changes; do not edit files or execute changes." : "",
      ].filter(Boolean).join("\n"),
      ...(this.model?.id ? { model: this.model.id } : {}),
    };
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
    if (options.accessMode)
      this.accessMode =
        options.accessMode === "read-only" ? "read-only" : "workspace-write";
    if (options.agentMode) this.agentMode = options.agentMode;
    if (options.model?.id)
      this.model = { provider: "codex", id: options.model.id };
    if (options.thinkingLevel) this.thinkingLevel = options.thinkingLevel;

    this.setStatus("starting");
    const connection = new CodexAppServer({
      executable: this.executable,
      envExtra: this.envExtra,
    });
    this.connection = connection;
    connection.onNotification((message) => this.handleNotification(message));
    connection.onServerRequest((message) => this.handleServerRequest(message));
    connection.onFailure((error) => this.connectionFailed(error));
    try {
      await connection.start();
      await this.ensureAvailableModel(true);
      const config = this.threadConfig(effectiveCwd);
      this.tokenUsage = undefined;
      this.historyStats = undefined;
      this.messages = [];
      this.turnRecords = [];
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
      await this.ensureAvailableModel();
      // The composer's placeholder effort for a not-yet-started session is
      // "off", which codex has no equivalent for -- and each model advertises
      // its own ladder (gpt-5.6-terra has "max", gpt-5.5 stops at "xhigh"),
      // so anything unsupported falls back to the model's own default.
      this.thinkingLevel = await this.resolveEffort(
        this.model.id,
        options.thinkingLevel && options.thinkingLevel !== "off"
          ? options.thinkingLevel
          : opened.reasoningEffort,
      );
      if (resumeId && this.sessionFile) {
        try {
          const history = readCodexLog(await readFile(this.sessionFile, "utf8"));
          this.tokenUsage = history.tokenUsage;
          this.historyStats = new Map(history.turns.filter((turn) => turn.id).map((turn) => [turn.id, turn]));
        } catch { /* remote/ephemeral threads may have no readable rollout */ }
      }
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
      this.stop();
      this.setStatus("error", message);
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
    this.turnRecords = [];
    const replayed = this.buildTurnMessages(turns);
    this.messages = [...replayed];
    return replayed;
  }

  /**
   * Turn a list of persisted turns into the same (user, assistant) message
   * pairs a live turn produces, without touching this.messages. Also updates
   * turnRecords so a later fork-at-timestamp can find the turn boundary.
   * Restores this.turn/the replay-suppression flag so a fork read cannot
   * corrupt an in-flight turn.
   */
  buildTurnMessages(turns, options = {}) {
    const record = options.record !== false;
    const replayed = [];
    const savedTurn = this.turn;
    const savedSuppress = this.suppressReplayEvents;
    this.suppressReplayEvents = true;
    // A tight replay loop can stamp several turns with the same millisecond,
    // and forkAt's closest-timestamp match would then bind a mid-history
    // fork to the wrong turn boundary. Keep replayed timestamps strictly
    // increasing. Prefer the turn's own time when the app-server sent one;
    // a clock stamped at replay time cuts differently after every resume.
    let replayClock = 0;
    try {
      for (const turn of turns) {
        const stats = this.historyStats?.get(turn.id);
        const stamped = turnStamp(stats ?? turn);
        replayClock = Number.isFinite(stamped)
          ? Math.max(stamped, replayClock + 1)
          : Math.max(Date.now(), replayClock + 1);
        const users = (turn.items ?? []).filter((item) => item.type === "userMessage").map((item, index) => ({
          role: "user", content: userContent(item.content), timestamp: replayClock + index,
        }));
        const assistantMessage = this.newAssistantMessage();
        assistantMessage.timestamp = replayClock;
        assistantMessage.usage = stats?.usage ?? turn.usage;
        assistantMessage.model = stats?.model ?? turn.model ?? assistantMessage.model;
        replayClock += Math.max(0, users.length - 1);
        this.turn = {
          content: assistantMessage.content,
          message: assistantMessage,
          openKind: undefined,
          openIndex: undefined,
          itemIndex: new Map(), results: [],
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
        if (record && turn.id)
          this.turnRecords.push({
            id: turn.id,
            timestamp: assistantMessage.timestamp,
          });
        replayed.push(...users, assistantMessage, ...this.turn.results);
      }
    } finally {
      this.turn = savedTurn;
      this.suppressReplayEvents = savedSuppress;
    }
    return replayed;
  }

  newAssistantMessage() {
    return {
      role: "assistant",
      content: [],
      api: "codex",
      provider: "codex",
      model: this.model?.id ?? DEFAULT_MODEL_ID,
      usage: undefined,
      stopReason: "pending",
      timestamp: Date.now(),
    };
  }

  // ---- notification handling -------------------------------------------

  reply(id, result, connection = this.connection) {
    try { connection?.respond(id, result); } catch { /* transport already closed */ }
  }

  handleServerRequest(message) {
    const connection = this.connection;
    const params = message.params ?? {};
    if (message.method === "item/tool/requestUserInput") {
      const requestId = String(message.id);
      const questions = (params.questions ?? []).map((question) => ({ ...question, options: question.options ?? [] }));
      this.pendingUserInputs.set(requestId, { id: message.id, questions, connection, threadId: params.threadId ?? this.threadId });
      this.emit({ type: "user_input_request", sessionKey: this.sessionKey, requestId, questions });
      return;
    }
    const legacy = ["execCommandApproval", "applyPatchApproval"].includes(message.method);
    const command = message.method === "execCommandApproval" || message.method === "item/commandExecution/requestApproval";
    const patch = message.method === "applyPatchApproval" || message.method === "item/fileChange/requestApproval";
    const permissions = message.method === "item/permissions/requestApproval";
    if (command || patch || permissions) {
      const deny = permissions ? { permissions: {}, scope: "turn" } : { decision: legacy ? "denied" : "decline" };
      if (!this.approvalGate.enabled || this.agentMode === "plan") { this.reply(message.id, deny, connection); return; }
      const requestId = `codex-${message.id}`;
      this.nativeApprovals.set(requestId, params.threadId ?? this.threadId);
      void this.approvalGate.request({
        requestId,
        toolName: patch ? "Edit" : "Bash",
        title: patch ? "patch" : permissions ? "additional permissions" : "command",
        detail: params.command ?? params.reason ?? JSON.stringify(params.permissions ?? params.changes ?? {}),
        options: [{ id: "allow", label: "Allow once" }, { id: "acceptForSession", label: "Allow for this session" }, { id: "deny", label: "Deny" }],
      }).then(({ allow, choice }) => {
        this.nativeApprovals.delete(requestId);
        if (!allow) return this.reply(message.id, deny, connection);
        this.reply(message.id, permissions
          ? { permissions: params.permissions ?? {}, scope: choice === "acceptForSession" ? "session" : "turn" }
          : { decision: legacy ? "approved" : choice === "acceptForSession" ? "acceptForSession" : "accept" }, connection);
      }).catch(() => { this.nativeApprovals.delete(requestId); this.reply(message.id, deny, connection); });
      return;
    }
    if (message.method === "mcpServer/elicitation/request") {
      const requestId = String(message.id);
      const request = params.request ?? params;
      const schema = request.requestedSchema ?? {};
      const properties = Object.entries(schema.properties ?? {});
      if (request.mode !== "url" && properties.some(([, property]) => !["string", "number", "integer", "boolean"].includes(property.type))) {
        this.reply(message.id, { action: "decline", content: null, _meta: null }, connection);
        this.emit({ type: "notice", sessionKey: this.sessionKey, message: "MCP requested a form with unsupported fields. It was declined.", tone: "warning" });
        return;
      }
      const questions = request.mode === "url"
        ? [{ id: "authorize", header: "MCP", question: request.message ?? "Complete authorization", link: request.url, options: [{ label: "Authorization completed" }] }]
        : properties.map(([id, property]) => ({ id, header: params.serverName ?? "MCP", question: property.title ?? property.description ?? id, isSecret: property.format === "password", options: (property.enum ?? (property.type === "boolean" ? [true, false] : [])).map((value) => ({ label: String(value) })) }));
      this.pendingUserInputs.set(requestId, { id: message.id, connection, threadId: params.threadId ?? this.threadId, elicitation: request, questions });
      this.emit({ type: "user_input_request", sessionKey: this.sessionKey, requestId, questions });
      return;
    }
    try { connection?.respondError(message.id, `Unsupported Codex request: ${message.method}`); } catch { /* closed */ }
  }

  resolveUserInput(requestId, answers) {
    const entry = this.pendingUserInputs.get(String(requestId));
    if (!entry) return { ok: false, error: "No pending Codex question with that id" };
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return { ok: false, error: "answers must be an object" };
    const clean = {};
    for (const [id, answer] of Object.entries(answers)) {
      if (!entry.questions.some((question) => question.id === id) || !Array.isArray(answer?.answers) || answer.answers.some((text) => typeof text !== "string"))
        return { ok: false, error: "Invalid question answer" };
      clean[id] = { answers: answer.answers };
    }
    let result = { answers: clean };
    if (entry.elicitation) {
      const request = entry.elicitation;
      const content = {};
      const properties = request.requestedSchema?.properties ?? {};
      for (const [id, answer] of Object.entries(clean)) {
        const value = answer.answers[0];
        if (value === undefined) continue;
        const property = properties[id];
        if (!property && request.mode === "url") continue;
        const typed = ["number", "integer"].includes(property.type) ? Number(value) : property.type === "boolean" ? value === "true" : value;
        if ((property.type === "integer" && !Number.isInteger(typed)) || (property.type === "number" && !Number.isFinite(typed)) || (property.enum && !property.enum.includes(typed))) return { ok: false, error: `Invalid value for ${id}` };
        content[id] = typed;
      }
      const accepted = Object.values(clean).some((answer) => answer.answers.length);
      if (accepted && request.mode !== "url" && (request.requestedSchema?.required ?? []).some((id) => !(id in content))) return { ok: false, error: "Complete all required MCP fields" };
      result = { action: accepted ? "accept" : "decline", content: accepted && request.mode !== "url" ? content : null, _meta: null };
    }
    this.reply(entry.id, result, entry.connection);
    this.pendingUserInputs.delete(String(requestId));
    this.emit({ type: "user_input_resolved", sessionKey: this.sessionKey, requestId: String(requestId) });
    return { ok: true };
  }

  dismissQuestions(threadId) {
    for (const [id, entry] of this.pendingUserInputs) if (!threadId || entry.threadId === threadId) this.resolveUserInput(id, {});
  }

  denyTurnApprovals(threadId) {
    for (const [requestId, owner] of this.nativeApprovals) if (owner === threadId) this.approvalGate.resolve(requestId, "deny");
  }

  connectionFailed(error) {
    this.approvalGate.denyAll();
    this.dismissQuestions();
    this.holdQueue();
    for (const child of this.nativeChildren.values()) child.agent.connectionFailed(error);
    this.openSubagents.clear();
    this.finishTurn({ status: "failed", error: { message: String(error?.message ?? error) } });
    this.setStatus("error", String(error?.message ?? error));
  }

  handleNotification(message) {
    const params = message.params ?? {};
    if (message.method === "skills/changed") { this.skills = []; return; }
    if (params.threadId && params.threadId !== this.threadId) {
      const child = this.nativeChildren.get(params.threadId);
      if (child) {
        if (child.loading) child.notifications.push(message);
        else child.agent.handleNotification(message);
      }
      return;
    }
    const turn = this.turn;
    switch (message.method) {
      case "serverRequest/resolved": {
        const requestId = String(params.requestId);
        this.pendingUserInputs.delete(requestId);
        this.approvalGate.resolve(`codex-${requestId}`, "deny");
        this.emit({ type: "user_input_resolved", sessionKey: this.sessionKey, requestId });
        return;
      }
      case "turn/started":
        if (turn) {
          turn.id = params.turn?.id;
          if (turn.abortRequested) void this.abort();
        }
        else this.beginObservedTurn(params.turn);
        return;
      case "thread/status/changed":
        if (params.status?.type === "idle" && !turn && this.parentToolUseId) this.emit({ type: "agent_settled", sessionKey: this.sessionKey });
        return;
      case "item/started":
        if (params.item?.type === "contextCompaction") this.compactionStarted();
        if (params.item?.type === "subAgentActivity") this.followNativeAgents({ id: params.item.id, tool: params.item.kind === "started" ? "spawnAgent" : "sendInput", receiverThreadIds: [params.item.agentThreadId], agentsStates: { [params.item.agentThreadId]: { status: params.item.kind === "completed" ? "completed" : params.item.kind === "interrupted" ? "interrupted" : "running" } } });
        if (params.item?.type === "collabAgentToolCall") this.followNativeAgents(params.item);
        if (turn) this.startItem(params.item);
        return;
      case "item/completed":
        if (params.item?.type === "contextCompaction" && !turn?.compacting) this.compactionCompleted();
        if (params.item?.type === "subAgentActivity") this.followNativeAgents({ id: params.item.id, tool: params.item.kind === "started" ? "spawnAgent" : "sendInput", receiverThreadIds: [params.item.agentThreadId], agentsStates: { [params.item.agentThreadId]: { status: params.item.kind === "completed" ? "completed" : params.item.kind === "interrupted" ? "interrupted" : "running" } } });
        if (params.item?.type === "collabAgentToolCall") this.followNativeAgents(params.item);
        if (turn) this.completeItem(params.item);
        return;
      case "item/plan/delta":
      case "item/agentMessage/delta":
        if (turn) this.appendItemDelta(params, "text");
        return;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        if (turn) this.appendItemDelta(params, "thinking");
        return;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        const tracked = turn?.itemIndex.get(params.itemId);
        if (tracked) {
          tracked.output = `${tracked.output ?? ""}${params.delta ?? ""}`;
          this.emit({ type: "tool_execution_update", sessionKey: this.sessionKey, toolCallId: params.itemId, partialResult: { content: [{ type: "text", text: tracked.output }], details: {} } });
        }
        return;
      }
      case "item/commandExecution/terminalInteraction":
        this.emit({ type: "notice", sessionKey: this.sessionKey, message: `Terminal input: ${params.stdin ?? ""}` });
        return;
      case "item/mcpToolCall/progress":
        this.emit({ type: "tool_execution_update", sessionKey: this.sessionKey, toolCallId: params.itemId, partialResult: { content: [{ type: "text", text: params.message ?? "" }], details: params } });
        return;
      case "turn/plan/updated": {
        if (!turn) return;
        const item = { type: "dynamicToolCall", id: `plan-${params.turnId ?? turn.id}`, tool: "TodoWrite", arguments: { todos: (params.plan ?? []).map((step, index) => ({ id: String(index), content: step.step, status: step.status === "inProgress" ? "in_progress" : step.status })) }, contentItems: [{ type: "text", text: params.explanation ?? "" }] };
        if (!turn.itemIndex.has(item.id)) this.startItem(item);
        this.completeItem(item);
        return;
      }
      case "turn/diff/updated":
        this.turnDiff = params.diff;
        this.emit({ type: "turn_diff", sessionKey: this.sessionKey, diff: params.diff });
        return;
      case "thread/tokenUsage/updated":
        this.tokenUsage = params.tokenUsage;
        if (turn) turn.message.usage = usageFrom(params.tokenUsage?.total ?? params.tokenUsage?.last, turn.usageBaseline);
        this.emitUpdate({ type: "usage" });
        return;
      case "turn/completed":
        this.finishTurn(params.turn);
        return;
      case "thread/name/updated":
        this.emit({
          type: "session_name",
          sessionKey: this.sessionKey,
          name: params.threadName ?? params.name,
        });
        return;
      case "error": {
        // A turn that errors still reports turn/completed afterwards, so the
        // message is stashed on the turn and surfaced when it settles --
        // otherwise a failed turn renders as an empty assistant bubble.
        const text = String(params.error?.message ?? params.message ?? "");
        if (turn && params.willRetry !== true) turn.error = text;
        else this.emit({ type: "notice", sessionKey: this.sessionKey, message: text, tone: params.willRetry ? "warning" : "error" });
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
    if (!turn || !item || turn.itemIndex.has(item.id)) return;
    if (item.type === "userMessage") return;
    if (item.type === "agentMessage" || item.type === "plan") {
      this.appendDelta(turn, "text", item.text ?? "");
      turn.itemIndex.set(item.id, { kind: "text", index: turn.openIndex });
      return;
    }
    if (item.type === "reasoning") {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].join(
        "\n",
      );
      this.appendDelta(turn, "thinking", text);
      turn.itemIndex.set(item.id, { kind: "thinking", index: turn.openIndex });
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
    noteSubagentToolEvent(this, {
      type: "tool_execution_start",
      toolCallId: item.id,
      toolName: call.name,
      args: call.arguments,
    });
    if (isSubagentToolName(call.name) && !isPiSubagentTool(call.name)) {
      this.emit({
        type: "subagent_start",
        sessionKey: this.sessionKey,
        parentToolUseId: item.id,
      });
    }
  }

  completeItem(item) {
    const turn = this.turn;
    if (!turn || !item) return;
    const tracked = turn.itemIndex.get(item.id);
    if (item.type === "agentMessage" || item.type === "plan") {
      // The deltas already built the block; only an item we never saw start
      // (a non-streamed message) still needs its text.
      if (tracked?.index !== undefined && turn.content[tracked.index]?.type === "text") {
        turn.content[tracked.index].text = item.text ?? turn.content[tracked.index].text;
        this.emitUpdate({ type: "text_end", contentIndex: tracked.index, content: turn.content[tracked.index].text });
      } else if (!tracked || (tracked.index === undefined && item.text)) this.appendDelta(turn, "text", item.text ?? "");
      this.closeOpenBlock(turn);
      return;
    }
    if (item.type === "reasoning") {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
      if (tracked?.index !== undefined && turn.content[tracked.index]?.type === "thinking" && text) {
        turn.content[tracked.index].thinking = text;
        this.emitUpdate({ type: "thinking_end", contentIndex: tracked.index, content: text });
      } else if (!tracked || tracked.index === undefined) this.appendDelta(turn, "thinking", text);
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
    const endEvent = {
      type: "tool_execution_end",
      sessionKey: this.sessionKey,
      toolCallId: item.id,
      result: {
        content: [{ type: "text", text: call.output || tracked?.output || "" }],
        details: item,
      },
      isError: Boolean(call.failed),
    };
    const resultMessage = { role: "toolResult", toolCallId: item.id, toolName: call.name, content: endEvent.result.content, details: item, isError: endEvent.isError, timestamp: Date.now() };
    turn.results ??= [];
    const previous = turn.results.findIndex((result) => result.toolCallId === item.id);
    if (previous >= 0) turn.results[previous] = resultMessage;
    else turn.results.push(resultMessage);
    if (!this.suppressReplayEvents && item.type === "collabAgentToolCall" && item.tool === "spawnAgent" && (item.receiverThreadIds ?? []).some((id) => this.openSubagents.has(id))) {
      this.nativeToolEnds.set(item.id, endEvent);
      return;
    }
    if (noteSubagentToolEvent(this, endEvent).holdEnd) return;
    this.emit(endEvent);
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

  appendItemDelta(params, kind) {
    const turn = this.turn;
    this.appendDelta(turn, kind, params.delta);
    if (params.itemId && turn) {
      const tracked = turn.itemIndex.get(params.itemId) ?? { kind };
      tracked.index ??= turn.openIndex;
      turn.itemIndex.set(params.itemId, tracked);
    }
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

  beginObservedTurn(nativeTurn = {}) {
    const message = this.newAssistantMessage();
    this.turn = { id: nativeTurn.id, message, content: message.content, itemIndex: new Map(), results: [], extraUsers: [], usageBaseline: this.tokenUsage?.total };
    this.emit({ type: "message_start", sessionKey: this.sessionKey, message });
    this.setStatus("working");
  }

  settleWhenIdle(sendQueue = true) {
    if (!sendQueue) this.queueHeld = true;
    if (this.isBusy()) {
      this.setStatus("working");
      return;
    }
    this.setStatus(this.connection?.running ? "ready" : "error");
    this.emit({ type: "agent_settled", sessionKey: this.sessionKey });
    if (sendQueue) this.sendNextQueued();
  }

  followNativeAgents(item) {
    for (const id of item.receiverThreadIds ?? []) {
      const state = item.agentsStates?.[id];
      const terminal = ["completed", "errored", "interrupted", "shutdown", "notFound"].includes(state?.status);
      let child = this.nativeChildren.get(id);
      if (!child) {
        if (item.tool !== "spawnAgent" && item.tool !== "resumeAgent" && item.tool !== "sendInput" && item.tool !== "followupTask") continue;
        const agent = new CodexAgentProcess(this.sessionKey);
        agent.connection = this.connection;
        agent.threadId = id;
        agent.parentToolUseId = item.id;
        agent.cwd = this.cwd;
        agent.model = { provider: "codex", id: item.model ?? this.model?.id };
        agent.agentMode = this.agentMode;
        agent.approvalGate = this.approvalGate;
        agent.pendingUserInputs = this.pendingUserInputs;
        agent.nativeApprovals = this.nativeApprovals;
        child = { agent, parentToolUseId: item.id, loading: true, notifications: [] };
        this.nativeChildren.set(id, child);
        this.openSubagents.add(id);
        this.emit({ type: "subagent_start", sessionKey: this.sessionKey, parentToolUseId: item.id });
        agent.onEvent((event) => {
          if (event.type === "agent_settled") {
            child.settledDuringLoad = child.loading;
            this.nativeChildFinished(id, Boolean(agent.lastTurnError));
            return;
          }
          if (["__status", "state", "agent_start", "agent_end", "turn_start", "queue_updated"].includes(event.type)) return;
          const tagged = { ...event, parentToolUseId: child.parentToolUseId, streamKey: `codex-${id}-${agent.turn?.message.timestamp ?? event.message?.timestamp ?? "child"}` };
          if (event.message) tagged.message = { ...event.message, parentToolUseId: child.parentToolUseId };
          this.emit(tagged);

        });
        void this.connection.request("thread/resume", { threadId: id }).then((response) => {
          // Resume also subscribes this connection to a running native child.
          for (const turn of response.thread?.turns ?? []) {
            agent.beginObservedTurn(turn);
            for (const entry of turn.items ?? []) {
              agent.startItem(entry);
              if (entry.status !== "inProgress") agent.completeItem(entry);
            }
            if (turn.status !== "inProgress") agent.finishTurn(turn);
          }
          child.loading = false;
          for (const notification of child.notifications) agent.handleNotification(notification);
          child.notifications = [];
          if (child.abortWhenLoaded) void agent.abort();
          if (!agent.turn && (child.terminal || child.settledDuringLoad || response.thread?.status?.type === "idle")) this.nativeChildFinished(id, Boolean(agent.lastTurnError));
        }).catch((error) => {
          child.loading = false;
          this.emit({ type: "notice", sessionKey: this.sessionKey, parentToolUseId: child.parentToolUseId, message: `Could not follow Codex child: ${error.message}`, tone: "error" });
          this.nativeChildFinished(id, true);
        });
      } else if (!terminal && ["resumeAgent", "sendInput", "followupTask"].includes(item.tool)) {
        this.openSubagents.add(id);
      }
      if (terminal) {
        child.terminal = true;
        if (!child.loading && !child.agent.turn) this.nativeChildFinished(id, ["errored", "interrupted"].includes(state.status));
      }
    }
  }

  nativeChildFinished(id, failed = false) {
    const child = this.nativeChildren.get(id);
    if (!child || child.loading || !this.openSubagents.delete(id)) return;
    this.messages.push(...child.agent.messages.slice(child.savedCount ?? 0).map((message) => ({ ...message, parentToolUseId: child.parentToolUseId })));
    child.savedCount = child.agent.messages.length;
    for (const [toolId, event] of this.nativeToolEnds) {
      if ([...this.nativeChildren].some(([threadId, other]) => other.parentToolUseId === toolId && this.openSubagents.has(threadId))) continue;
      this.nativeToolEnds.delete(toolId);
      this.emit({ ...event, isError: event.isError || failed });
    }
    this.settleWhenIdle(!failed);
    void this.getState().then((state) => this.emit({ type: "state", sessionKey: this.sessionKey, state }));
  }

  // ---- turns ------------------------------------------------------------

  async runTurn(kind, message, images) {
    if (!this.connection?.running || !this.threadId)
      return { ok: false, error: "Codex session is not running" };
    if (this.isBusy() && kind !== "steer")
      return { ok: false, error: "A Codex turn is already in progress" };

    const input = [
      {
        type: "text",
        text: message,
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

    // Slash commands refer to the native skill inventory for this workspace.
    const command = /^\/([^\s]+)(?:\s|$)/.exec(message ?? "");
    if (command && kind === "prompt") {
      if (!this.skills.length) await this.getCommands();
      const skill = this.skills.find((entry) => entry.name === command[1]);
      if (skill) {
        input[0].text = String(message).replace(/^\//, "$");
        input.push({ type: "skill", name: skill.name, path: skill.path });
      }
    }

    if (kind === "steer") {
      if (!this.turn) return { ok: false, error: "No Codex turn to steer" };
      try {
        await this.connection.request("turn/steer", {
          threadId: this.threadId,
          expectedTurnId: this.turn.id,
          input,
        });
        const steered = { role: "user", content: userContent(input), timestamp: Date.now() };
        this.turn?.extraUsers?.push(steered);
        for (const type of ["message_start", "message_end"]) this.emit({ type, sessionKey: this.sessionKey, message: steered });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }

    const userMessage = {
      role: "user",
      content: userContent(input).map((part) => part.type === "text" ? { ...part, text: message } : part),
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
      settled, results: [], extraUsers: [], usageBaseline: this.tokenUsage?.total,
    };
    const activeTurn = this.turn;
    this.setStatus("working");

    try {
      const started = await this.connection.request("turn/start", {
        threadId: this.threadId,
        input,
        cwd: this.cwd,
        sandboxPolicy: this.agentMode === "plan" || this.accessMode === "read-only" ? { type: "readOnly" } : { type: "workspaceWrite", writableRoots: [this.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        ...(this.agentMode === "plan" ? { collaborationMode: { mode: "plan", settings: { model: this.model?.id ?? DEFAULT_MODEL_ID, reasoning_effort: this.thinkingLevel ?? null, developer_instructions: null } } } : {}),
        approvalPolicy: this.approvalGate.enabled ? "untrusted" : "never",
        ...(this.model?.id ? { model: this.model.id } : {}),
        ...(this.thinkingLevel ? { effort: this.thinkingLevel } : {}),
      });
      if (this.turn === activeTurn) {
        activeTurn.id = started.turn.id;
        if (activeTurn.abortRequested) await this.connection.request("turn/interrupt", { threadId: this.threadId, turnId: activeTurn.id });
      }
      return await settled.promise;
    } catch (error) {
      if (this.turn === activeTurn) this.finishTurn({ status: "failed", error: { message: String(error?.message ?? error) } });
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  finishTurn(completed) {
    const turn = this.turn;
    if (!turn || (completed?.id && turn.id && completed.id !== turn.id)) return;
    clearTimeout(turn.compactTimer);
    if (completed?.status === "failed" || completed?.status === "interrupted") turn.error ??= completed?.error?.message ?? `Codex turn ${completed.status}`;
    this.denyTurnApprovals(this.threadId);
    this.dismissQuestions(this.threadId);
    this.lastTurnError = turn.error;
    if (turn.compacting) {
      this.compactionCompleted(Boolean(turn.error));
      this.turn = undefined;
      this.setStatus("ready");
      this.settleWhenIdle(!turn.error);
      void this.getState().then((state) => { this.emit({ type: "state", sessionKey: this.sessionKey, state }); turn.settled?.resolve(turn.error ? { ok: false, error: turn.error } : { ok: true, state }); });
      return;
    }
    this.closeOpenBlock(turn);
    turn.message.stopReason =
      completed?.status === "completed"
        ? "end_turn"
        : (completed?.status ?? "end_turn");
    if (turn.error) turn.message.errorMessage = turn.error;
    this.emit({ type: "message_end", sessionKey: this.sessionKey, message: turn.message });
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
    this.messages.push(...[turn.userMessage, ...(turn.extraUsers ?? []), turn.message, ...(turn.results ?? [])].filter(Boolean));
    if (turn.id)
      this.turnRecords.push({
        id: turn.id,
        timestamp: turn.message.timestamp,
      });
    this.turn = undefined;
    this.settleWhenIdle(!turn.error);
    void this.getState().then((state) => {
      this.emit({ type: "state", sessionKey: this.sessionKey, state });
      turn.settled?.resolve(
        turn.error ? { ok: false, error: turn.error } : { ok: true, state },
      );
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

  // ---- session management ----------------------------------------------

  compactionStarted() {
    if (this.compaction) return;
    this.compaction = { tokensBefore: Number(this.tokenUsage?.last?.totalTokens ?? this.tokenUsage?.last?.total_tokens ?? 0) };
    this.emit({ type: "compaction_start", sessionKey: this.sessionKey });
  }

  compactionCompleted(aborted = false) {
    if (!this.compaction) return;
    this.emit({ type: "compaction_end", sessionKey: this.sessionKey, reason: this.turn?.compacting ? "manual" : "auto", aborted, result: { ...this.compaction, estimatedTokensAfter: Number(this.tokenUsage?.last?.totalTokens ?? this.tokenUsage?.last?.total_tokens ?? 0) } });
    this.compaction = undefined;
  }

  async compact() {
    if (!this.connection?.running || !this.threadId) return { ok: false, error: "Codex session is not running" };
    if (this.isBusy()) return { ok: false, error: "Wait for the current Codex turn before compacting" };
    const settled = Promise.withResolvers();
    const message = this.newAssistantMessage();
    const turn = this.turn = { compacting: true, settled, content: message.content, message, itemIndex: new Map() };
    this.setStatus("working");
    this.compactionStarted();
    turn.compactTimer = setTimeout(() => {
      this.holdQueue();
      void this.abort();
      this.finishTurn({ status: "failed", error: { message: "Codex compaction timed out" } });
    }, 5 * 60_000);
    turn.compactTimer.unref?.();
    try {
      await this.connection.request("thread/compact/start", { threadId: this.threadId });
      return await settled.promise;
    } catch (error) {
      if (this.turn === turn) this.finishTurn({ status: "failed", error: { message: String(error?.message ?? error) } });
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async abort() {
    this.approvalGate.denyAll();
    this.dismissQuestions();
    this.holdQueue();
    const childResults = await Promise.all([...this.nativeChildren.values()].filter((child) => this.openSubagents.has(child.agent.threadId)).map((child) => { child.abortWhenLoaded = child.loading; return child.agent.abort(); }));
    const childError = childResults.find((result) => !result.ok);
    if (this.turn && !this.turn.id) this.turn.abortRequested = true;
    if (!this.connection?.running || !this.threadId || !this.turn?.id)
      return childError ?? { ok: true };
    try {
      if (this.turn.interruptRequested) return childError ?? { ok: true };
      this.turn.interruptRequested = true;
      await this.connection.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.turn.id,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** Manual-mode answer from POST /api/<key>/approve. */
  resolveApproval(requestId, optionId) {
    return this.approvalGate.resolve(requestId, optionId);
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
      if (this.isBusy()) return { ok: false, error: "Wait for the current turn before starting a new session" };
      const started = await this.connection.request("thread/start", this.threadConfig());
      this.threadId = started.thread.id;
      this.sessionFile = started.thread.path;
      this.messages = [];
      this.turnRecords = [];
      this.tokenUsage = undefined;
      this.historyStats = undefined;
      return { ok: true, state: await this.getState() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async forkAt(timestamp, context = {}) {
    if (!this.connection?.running || !this.threadId)
      return { ok: false, error: "No Codex session is available to fork." };
    // thread/fork copies stored history into a new thread, optionally cut
    // at a turn boundary. The UI asks by message timestamp, so map it to the
    // turn that produced the forked response (inclusive: history through
    // that assistant reply is kept).
    const requested = Number(timestamp);
    const records = this.turnRecords ?? [];
    const boundary =
      Number.isFinite(requested) && records.length > 0
        ? records.reduce((closest, candidate) =>
            Math.abs(candidate.timestamp - requested) <
            Math.abs(closest.timestamp - requested)
              ? candidate
              : closest,
          )
        : undefined;
    try {
      const forked = await this.connection.request("thread/fork", {
        threadId: this.threadId,
        ...this.threadConfig(context.forkCwd || this.cwd),
        ...(boundary?.id ? { lastTurnId: boundary.id } : {}),
      });
      const thread = forked?.thread;
      if (!thread?.id) throw new Error("thread/fork returned no thread");
      // Never fall back to the parent's file: the fork tab would resume it
      // and both processes would append to one transcript.
      if (!thread.path) throw new Error("thread/fork returned no session file");
      const messages = this.buildTurnMessages(thread.turns ?? [], {
        record: false,
      });
      const state = {
        ...(await this.getState()),
        sessionId: thread.id,
        sessionFile: thread.path,
      };
      return {
        ok: true,
        restored: true,
        state,
        messages,
        forkCwd: context.forkCwd || this.cwd,
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async truncateAt() {
    return unsupported(
      "truncate",
      "Rewinding a Codex conversation isn't supported yet.",
    );
  }

  async getState() {
    const state = {
      status: this.status,
      isStreaming: Boolean(this.turn) || subagentBusy(this),
      pendingUserInputs: [...this.pendingUserInputs].map(([requestId, entry]) => ({ requestId, questions: entry.questions })),
      messageCount: this.messages.filter((message) => message.role !== "toolResult").length,
      ...(this.tokenUsage?.modelContextWindow ? { contextWindow: this.tokenUsage.modelContextWindow } : {}),
      ...(this.turnDiff ? { turnDiff: this.turnDiff } : {}),
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

  async request(method, params) {
    return this.connection?.running ? this.connection.request(method, params) : codexRequest(method, params);
  }

  async getCommands(cwd = this.cwd ?? process.cwd()) {
    try {
      const response = await this.request("skills/list", { cwds: [cwd], forceReload: true });
      this.skills = (response?.data ?? []).flatMap((group) => group.skills ?? []).filter((entry) => entry.enabled !== false && entry.name && entry.path);
      return { ok: true, commands: [...new Map(this.skills.map((entry) => [entry.name, { name: entry.name, description: entry.interface?.shortDescription ?? entry.description ?? "", source: "skill" }])).values()] };
    } catch (error) { return { ok: false, error: String(error?.message ?? error), commands: [] }; }
  }

  async getContextUsage() {
    const total = Number(this.tokenUsage?.last?.totalTokens ?? this.tokenUsage?.last?.total_tokens);
    const max = Number(this.tokenUsage?.modelContextWindow);
    if (!Number.isFinite(total) || !Number.isFinite(max) || max <= 0) return { ok: false, error: "Codex has not reported context usage yet" };
    return { ok: true, data: { totalTokens: total, maxTokens: max, percent: Math.round(total / max * 100), model: this.model?.id ?? "", isAutoCompactEnabled: true, categories: [] } };
  }

  async getSettings() {
    try {
      const response = await this.request("config/read", { cwd: this.cwd ?? process.cwd(), includeLayers: true });
      const files = {};
      const sources = (response.layers ?? []).map((layer, index) => {
        const source = `${layer.name?.type ?? "config"}-${index}`;
        if (layer.name?.file) files[source] = layer.name.file;
        return { source, settings: layer.config, disabledReason: layer.disabledReason };
      });
      return { ok: true, data: { effective: response.config ?? {}, sources, files, localSettings: {}, hooks: [] } };
    } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
  }

  async getMcpServers() {
    try {
      const servers = [];
      let cursor;
      do {
        const response = await this.request("mcpServerStatus/list", { ...(cursor ? { cursor } : {}), limit: 100 });
        servers.push(...(response.data ?? []).map((server) => ({ name: server.name, status: server.serverInfo ? "connected" : server.authStatus === "notLoggedIn" ? "needs authentication" : "unavailable", scope: "codex", error: server.error ?? "", version: server.serverInfo?.version ?? "", toolCount: Object.keys(server.tools ?? {}).length })));
        cursor = response.nextCursor;
      } while (cursor);
      return { ok: true, data: { servers } };
    } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
  }

  // ---- models and effort ------------------------------------------------

  async ensureAvailableModel(refresh = false) {
    if (!this.model?.id) return;
    const models = await this.fetchModelCatalog(refresh);
    if (models.some((model) => model.id === this.model.id && !model.hidden)) return;
    const fallback = models.find((model) => model.isDefault && !model.hidden) ?? models.find((model) => !model.hidden);
    if (!fallback) throw new Error("Codex returned no available models");
    this.emit({ type: "notice", sessionKey: this.sessionKey, message: `${this.model.id} is unavailable in this Codex CLI; switched to ${fallback.displayName ?? fallback.id}.`, tone: "warning" });
    this.model = { provider: "codex", id: fallback.id };
  }

  async fetchModelCatalog(refresh = false) {
    if (!refresh && this.modelCatalog && Date.now() - this.modelCatalogAt < MODEL_CATALOG_TTL_MS)
      return this.modelCatalog;
    // The running CLI defines which models it understands: its entries keep
    // their effort ladder and metadata. A newer remote catalog supplies
    // context sizes and adds new slugs the service accepts even when this
    // CLI build (custom builds report 0.0.0 and get a legacy list) doesn't
    // know them yet -- verified: thread/start echoes unknown slugs back.
    const models = [];
    let cursor;
    do {
      const response = await this.request("model/list", { ...(cursor ? { cursor } : {}) });
      models.push(...(response?.data ?? []));
      cursor = response?.nextCursor;
    } while (cursor);
    try {
      const remote = await readCodexModels();
      for (const model of models) {
        const metadata = remote.find((entry) => entry.id === model.id);
        if (metadata?.contextWindow) model.contextWindow = metadata.contextWindow;
      }
      for (const entry of remote)
        if (!entry.hidden && !models.some((model) => model.id === entry.id)) models.push(entry);
    } catch { /* offline or non-file auth: the CLI catalog is sufficient */ }
    this.modelCatalog = models;
    this.modelCatalogAt = Date.now();
    return this.modelCatalog;
  }

  async getAvailableModels() {
    try {
      const raw = await this.fetchModelCatalog(true);
      return {
        ok: true,
        models: raw
          .filter((model) => !model.hidden)
          .map((model) => ({
            provider: "codex",
            id: model.id,
            name: model.displayName ?? model.id,
            levels: (model.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort),
            contextWindow: model.contextWindow,
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
    try {
      const models = await this.fetchModelCatalog();
      if (!models.some((model) => model.id === modelId && !model.hidden))
        return { ok: false, error: `${modelId} is unavailable in this Codex CLI. Choose a listed model or update Codex.` };
    } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
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
    this.approvalGate.denyAll();
    this.dismissQuestions();
    clearTimeout(this.turn?.compactTimer);
    for (const child of this.nativeChildren.values()) { child.agent.connection = undefined; child.agent.stop(); }
    this.nativeChildren.clear();
    this.openSubagents.clear();
    this.nativeToolEnds.clear();
    this.turn?.settled?.resolve({
      ok: false,
      error: "Codex session stopped",
    });
    this.turn = undefined;
    this.subagents?.stopAll();
    this.connection?.close();
    this.connection = undefined;
    this.threadId = undefined;
    this.setStatus("stopped");
  }
}

export class CodexAgentPool extends AgentPool {
  constructor() {
    super((sessionKey) => new CodexAgentProcess(sessionKey));
  }
}
