import test from "node:test";
import assert from "node:assert/strict";
import { CodexAgentPool } from "./codex-agent.js";
import { CodexAppServer } from "./codex-app-server.js";

test("saved unsupported Codex models recover using the CLI default", async (t) => {
  const agent = new CodexAgentPool().get("saved-model");
  agent.fetchModelCatalog = async () => [{ id: "supported", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" }];
  t.mock.method(CodexAppServer.prototype, "start", async function () { this.child = {}; });
  t.mock.method(CodexAppServer.prototype, "request", async (method, params) => {
    assert.equal(method, "thread/start");
    assert.equal(params.model, "supported");
    return { thread: { id: "thread" }, model: "supported", reasoningEffort: "low" };
  });
  t.mock.method(CodexAppServer.prototype, "close", function () { this.child = undefined; });
  t.after(() => agent.stop());
  const events = [];
  agent.onEvent((event) => events.push(event));
  const result = await agent.start(process.cwd(), { model: { id: "gpt-6-luna" }, thinkingLevel: "xhigh" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.state.model.id, "supported");
  assert.equal(result.state.thinkingLevel, "low");
  assert.match(events.find((event) => event.type === "notice").message, /switched to supported/);
});

test("resumed threads with unsupported persisted models recover before inference", async (t) => {
  const agent = new CodexAgentPool().get("resumed-model");
  agent.fetchModelCatalog = async () => [{ id: "supported", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" }];
  t.mock.method(CodexAppServer.prototype, "start", async function () { this.child = {}; });
  t.mock.method(CodexAppServer.prototype, "request", async () => ({ thread: { id: "thread", turns: [] }, model: "gpt-6-luna", reasoningEffort: "xhigh" }));
  t.mock.method(CodexAppServer.prototype, "close", function () { this.child = undefined; });
  t.after(() => agent.stop());
  const result = await agent.start(process.cwd(), { threadId: "thread" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.state.model.id, "supported");
  assert.equal(result.state.thinkingLevel, "low");
});

test("Codex rejects unsupported selections without changing the current model", async () => {
  const agent = new CodexAgentPool().get("catalog");
  agent.fetchModelCatalog = async () => [{ id: "supported", supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high" }, { id: "hidden", hidden: true }];
  agent.model = { provider: "codex", id: "supported" };
  for (const id of ["gpt-6-luna", "hidden"]) {
    assert.equal((await agent.setModel("codex", id)).ok, false);
    assert.equal(agent.model.id, "supported");
  }
  assert.equal((await agent.setModel("codex", "supported")).ok, true);
  assert.equal(agent.thinkingLevel, "high");
});

test("Codex streams reasoning, reads, shell output, edits and MCP results", async () => {
  const agent = new CodexAgentPool().get("events");
  agent.threadId = "thread";
  const events = [];
  agent.onEvent((event) => events.push(event));
  agent.beginObservedTurn({ id: "turn" });
  const notify = (method, params) => agent.handleNotification({ method, params: { threadId: "thread", ...params } });
  notify("item/started", { item: { id: "reason", type: "reasoning", summary: [], content: [] } });
  notify("item/reasoning/summaryTextDelta", { itemId: "reason", delta: "Checking the file" });
  notify("item/completed", { item: { id: "reason", type: "reasoning", summary: ["Checking the file"] } });
  const items = [
    { id: "read", type: "commandExecution", command: "cat note.txt", commandActions: [{ type: "read", path: "/tmp/note.txt" }], aggregatedOutput: "before" },
    { id: "bash", type: "commandExecution", command: "echo hello", aggregatedOutput: "hello", exitCode: 1 },
    { id: "edit", type: "fileChange", changes: [{ path: "/tmp/note.txt", kind: { type: "update" }, diff: "-before\n+after" }] },
    { id: "mcp", type: "mcpToolCall", server: "fixture", tool: "read", arguments: { path: "note.txt" }, result: { content: [{ type: "text", text: "after" }] } },
  ];
  for (const item of items) {
    notify("item/started", { item: { ...item, status: "inProgress" } });
    if (item.id === "bash") notify("item/commandExecution/outputDelta", { itemId: item.id, delta: "hello" });
    notify("item/completed", { item: { ...item, status: "completed" } });
  }
  notify("error", { error: { message: "Account rejected model" }, willRetry: false });
  notify("turn/completed", { turn: { id: "turn", status: "failed" } });
  assert.deepEqual(events.filter((event) => event.type === "tool_execution_start").map((event) => event.toolName), ["read", "shell", "apply_patch", "fixture/read"]);
  assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 4);
  assert.equal(events.find((event) => event.type === "tool_execution_end" && event.toolCallId === "bash").isError, true);
  assert.equal(events.find((event) => event.type === "tool_execution_update").partialResult.content[0].text, "hello");
  assert.equal(events.find((event) => event.assistantMessageEvent?.type === "thinking_delta").assistantMessageEvent.delta, "Checking the file");
  assert.equal(events.find((event) => event.type === "message_end").message.errorMessage, "Account rejected model");
  assert.equal(events.filter((event) => ["stderr", "notice"].includes(event.type)).length, 0);
});
