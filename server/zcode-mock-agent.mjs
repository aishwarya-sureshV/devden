/**
 * A fake `zcode agent-server` speaking the ZCode Protocol over stdio, for
 * zcode-agent.test.js. Scripts turns plus every reverse request the adapter
 * must answer (provider runtime headers, permission with a project-scope
 * option, structured user input). The test observes recorded replies through
 * MOCK_STATE_FILE. Frames verified against zai-org/ZCode v3.14.3.
 */
import { createInterface } from "node:readline";
import { renameSync, writeFileSync } from "node:fs";

const SESSION_ID = "s1";
const TURN_ID = "t1";
let seq = 0;
let turnCount = 0;
const events = [];
const add = (type, payload, extra = {}) =>
  events.push({
    eventId: `e${seq}`,
    sessionId: SESSION_ID,
    seq: seq++,
    type,
    payload,
    timestamp: Date.now(),
    ...extra,
  });
const snapshot = {
  protocol: { name: "ZCode Protocol", version: 1 },
  session: {
    sessionId: SESSION_ID,
    title: "Mock session",
    sessionKind: "interactive",
    mode: "build",
    status: "idle",
    workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  settings: {
    model: {
      current: { providerId: "zai", modelId: "GLM-5.3" },
      available: [
        {
          ref: { providerId: "zai", modelId: "GLM-5.3" },
          label: "GLM 5.3",
          contextWindow: 200000,
          reasoning: { levels: [{ value: "high", label: "High" }], defaultLevel: "high" },
          properties: {},
        },
      ],
    },
    thoughtLevel: {
      enabled: true,
      current: "high",
      available: [{ value: "high", label: "High" }],
    },
    mode: { current: "build" },
  },
  runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
  messages: [],
};

let releasedThrough = Infinity;
let promptCount = 0;
let permissionReply = null;
let permissionReplies = [];
let userInputReply = null;
let headersReply = null;
let resumedSessionId = null;
let stopCount = 0;

const stateFile = process.env.MOCK_STATE_FILE;
const persist = () => {
  if (!stateFile) return;
  try {
    // tmp + rename: the test polls this file, and a half-written read throws.
    writeFileSync(
      `${stateFile}.tmp`,
      JSON.stringify({
        promptCount,
        resumedSessionId,
        stopCount,
        permissionReply,
        permissionReplies,
        userInputReply,
        headersReply,
      }),
    );
    renameSync(`${stateFile}.tmp`, stateFile);
  } catch {
    /* test env missing; ignore */
  }
};
persist();

/** Script one turn onto the session's monotonic event log. The tool
 * result and completion are held until the permission is answered. */
function scriptTurn() {
  add("session.created", {});
  add("turn.started", { input: "hello" }, { turnId: TURN_ID });
  add("model.streaming", { kind: "reasoning_start", partId: "r1" });
  add("model.streaming", { kind: "reasoning_delta", partId: "r1", delta: "thinking " });
  add("model.streaming", { kind: "reasoning_delta", partId: "r1", delta: "hard" });
  add("model.streaming", { kind: "text_start", partId: "p1" });
  add("model.streaming", { kind: "text_delta", partId: "p1", delta: "Hello" });
  add("model.streaming", { kind: "text_delta", partId: "p1", delta: " world" });
  add("model.streaming", { kind: "tool_input_start", toolCallId: "tc1", toolName: "Bash" });
  add("model.streaming", { kind: "tool_input_delta", toolCallId: "tc1", delta: '{"command":"ls"}' });
  add("model.streaming", { kind: "tool_input_end", toolCallId: "tc1" });
  add("tool.updated", { kind: "started", toolCallId: "tc1", toolName: "Bash" });
  releasedThrough = seq - 1; // everything from here is gated on approval
  add("tool.updated", { kind: "result", toolCallId: "tc1", result: { output: "file.txt" } });
  add("turn.completed", { response: "Hello world", tokenCount: 42, resultType: "success" });
}

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => out({ id, result });
const notify = (revision) =>
  out({
    method: "state.updated",
    params: { type: "state.updated", scope: "session", sessionId: SESSION_ID, revision },
  });

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "session/create") {
    respond(message.id, { sessionId: SESSION_ID });
    return;
  }
  if (message.method === "session/resume") {
    resumedSessionId = message.params?.sessionId ?? null;
    persist();
    respond(message.id, {
      ...snapshot,
      messages: [
        {
          info: { messageId: "m1", sessionId: SESSION_ID, role: "user", time: { created: 1 }, content: "hello" },
          parts: [],
        },
        {
          info: {
            messageId: "m2",
            sessionId: SESSION_ID,
            role: "assistant",
            time: { created: 2, completed: 3 },
            model: { providerId: "zai", modelId: "GLM-5.3" },
            tokens: { total: 42 },
          },
          parts: [
            { partId: "p1", sessionId: SESSION_ID, messageId: "m2", type: "text", text: "Hello world" },
          ],
        },
      ],
      runtime: { ...snapshot.runtime, eventSeq: seq - 1 },
    });
    return;
  }
  if (message.method === "session/subscribe") {
    respond(message.id, {
      sessionId: SESSION_ID,
      eventSeq: 0,
      events: [],
      snapshot: message.params?.includeSnapshot ? snapshot : undefined,
    });
    return;
  }
  if (message.method === "session/send") {
    promptCount += 1;
    persist();
    turnCount += 1;
    scriptTurn();
    respond(message.id, { sessionId: SESSION_ID, accepted: true, stateRevision: 1 });
    notify(1);
    // Account auth refresh comes before every model call; the adapter must
    // answer it from the credential store.
    out({
      id: "mock-headers-1",
      method: "interaction/requestProviderRuntimeHeaders",
      params: {
        requestId: "rh1",
        sessionId: SESSION_ID,
        workspace: snapshot.session.workspace,
        modelSelection: { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3" },
        providerId: "account:zai-individual-coding-plan",
        reason: "model-request",
      },
    });
    // The Bash call needs permission before its result streams. The options
    // carry a project-scope response the adapter must pass through.
    out({
      id: "mock-permission-1",
      method: "interaction/requestPermission",
      params: {
        toolCallId: "tc1",
        toolName: "Bash",
        riskLevel: "medium",
        reason: "run ls",
        input: { command: "ls" },
        options: [
          { optionId: "allow", kind: "once", name: "Allow once", response: { decision: "allow" } },
          {
            optionId: "allow_project",
            kind: "always",
            name: "Always allow in project",
            response: {
              decision: "allow",
              permissionUpdates: [
                { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }] },
              ],
            },
          },
        ],
      },
    });
    // First turn only: a structured user-input question.
    if (turnCount === 1)
      out({
        id: "mock-question-1",
        method: "interaction/requestUserInput",
        params: {
          requestId: "mock-question-1",
          sessionId: SESSION_ID,
          questions: [
            {
              question: "Which file?",
              header: "Pick",
              options: [
                { value: "a.ts", label: "a.ts" },
                { value: "b.ts", label: "b.ts" },
              ],
            },
          ],
        },
      });
    return;
  }
  if (message.method === "session/events") {
    respond(message.id, {
      events: events.filter(
        (event) =>
          event.seq > (message.params.afterSeq ?? -1) &&
          event.seq <= releasedThrough,
      ),
    });
    return;
  }
  // A frame with an id but no method is one of our requests being answered.
  if (!message.method && message.id === "mock-headers-1") {
    headersReply = message.result ?? { missing: true };
    persist();
    return;
  }
  if (!message.method && message.id === "mock-permission-1") {
    permissionReply = message.result ?? { missing: true };
    permissionReplies = [...permissionReplies, permissionReply];
    persist();
    releasedThrough = Infinity;
    notify(2);
    return;
  }
  if (!message.method && message.id === "mock-question-1") {
    userInputReply = message.result ?? { missing: true };
    persist();
    return;
  }
  if (message.method === "session/setModel" || message.method === "session/setThoughtLevel") {
    respond(message.id, {});
    return;
  }
  if (message.method === "session/stop") {
    stopCount += 1;
    persist();
    respond(message.id, {});
    return;
  }
  respond(message.id, {});
});

process.on("exit", () => {
  persist();
});