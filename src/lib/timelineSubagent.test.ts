import test from "node:test";
import assert from "node:assert/strict";

import { Timeline } from "./timeline.ts";
import type { AgentEvent } from "./api.ts";
import { collectSubagentRuns } from "./subagents.ts";

const event = (payload: Record<string, unknown>): AgentEvent =>
  payload as unknown as AgentEvent;

test("subagent text is tagged so it can leave the main transcript", () => {
  const timeline = new Timeline("conv-sub");
  timeline.handle(
    event({
      type: "tool_execution_start",
      toolCallId: "task-1",
      toolName: "Task",
      args: { prompt: "look around", description: "scan" },
    }),
  );
  timeline.handle(
    event({
      type: "message_update",
      parentToolUseId: "task-1",
      streamKey: "claude-task-1-1",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "reading files",
      },
    }),
  );
  timeline.handle(
    event({
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
      parentToolUseId: "task-1",
    }),
  );

  const assistant = timeline.items.find((item) => item.kind === "assistant");
  assert.ok(assistant);
  assert.equal(assistant.parentToolUseId, "task-1");
  const nested = timeline.items.find(
    (item) => item.kind === "tool" && item.id === "read-1",
  );
  assert.ok(nested && nested.kind === "tool");
  assert.equal(nested.parentToolUseId, "task-1");

  const runs = collectSubagentRuns(timeline.items);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, "task-1");
  assert.equal(runs[0].items.length, 2);
  assert.equal(runs[0].status, "running");
});

test("a later start fills args on a stream-minted tool", () => {
  const timeline = new Timeline("conv-args");
  timeline.handle(
    event({
      type: "tool_execution_start",
      toolCallId: "bash-1",
      toolName: "Bash",
      args: {},
      parentToolUseId: "task-1",
    }),
  );
  timeline.handle(
    event({
      type: "tool_execution_start",
      toolCallId: "bash-1",
      toolName: "Bash",
      args: { command: "ls" },
      parentToolUseId: "task-1",
    }),
  );
  const nested = timeline.items.find(
    (item) => item.kind === "tool" && item.id === "bash-1",
  );
  assert.ok(nested && nested.kind === "tool");
  assert.equal(nested.args.command, "ls");
  assert.equal(nested.parentToolUseId, "task-1");
});

test("a later nested start adopts parentToolUseId on an existing tool", () => {
  const timeline = new Timeline("conv-adopt");
  timeline.handle(
    event({
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
    }),
  );
  timeline.handle(
    event({
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
      parentToolUseId: "task-1",
    }),
  );
  const nested = timeline.items.find(
    (item) => item.kind === "tool" && item.id === "read-1",
  );
  assert.ok(nested && nested.kind === "tool");
  assert.equal(nested.parentToolUseId, "task-1");
});

test("hydrate keeps parentToolUseId on nested history", () => {
  const timeline = new Timeline("conv-hist");
  timeline.hydrate(
    [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "task-1",
            name: "Task",
            arguments: { prompt: "go" },
          },
        ],
        timestamp: 1,
      },
      {
        role: "assistant",
        parent_tool_use_id: "task-1",
        content: [{ type: "text", text: "done looking" }],
        timestamp: 2,
      },
    ],
    {
      model: null,
      thinkingLevel: "off",
      isStreaming: false,
      sessionId: "s",
      messageCount: 2,
      pendingMessageCount: 0,
    },
  );
  const text = timeline.items.find((item) => item.kind === "assistant");
  assert.ok(text);
  assert.equal(text.parentToolUseId, "task-1");
});

test("a live user message_start appears only when it is new", () => {
  const timeline = new Timeline("conv-queue");
  timeline.appendUser("already shown");
  timeline.handle(
    event({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "already shown" }],
      },
    }),
  );
  assert.equal(
    timeline.items.filter((item) => item.kind === "user").length,
    1,
  );
  timeline.handle(
    event({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "fgdfgds" }],
      },
    }),
  );
  const users = timeline.items.filter((item) => item.kind === "user");
  assert.equal(users.length, 2);
  assert.equal(users[1]?.kind === "user" ? users[1].text : "", "fgdfgds");
});

test("attachment display and outbound user texts stay one bubble", () => {
  const timeline = new Timeline("conv-attach");
  const display =
    "claude keeps giving me this error.\n\nAttachments: Screenshot.png";
  const outbound =
    "claude keeps giving me this error.\n\nAttached files:\n- Screenshot.png (already attached inline — open this path only to edit the file, never to view it): /tmp/Screenshot.png";
  timeline.appendUser(display);
  timeline.handle(
    event({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: outbound }],
      },
    }),
  );
  const users = timeline.items.filter((item) => item.kind === "user");
  assert.equal(users.length, 1);
  assert.equal(users[0]?.kind === "user" ? users[0].text : "", display);
});

test("a queued follow-up still appears after an attachment turn", () => {
  const timeline = new Timeline("conv-q-attach");
  timeline.appendUser("first\n\nAttachments: a.png");
  timeline.handle(
    event({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "ok",
      },
    }),
  );
  timeline.handle(
    event({
      type: "message_start",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "second\n\nAttached files:\n- b.png: /tmp/b.png",
          },
        ],
      },
    }),
  );
  const users = timeline.items.filter((item) => item.kind === "user");
  assert.equal(users.length, 2);
  assert.equal(
    users[1]?.kind === "user" ? users[1].text : "",
    "second\n\nAttached files:\n- b.png: /tmp/b.png",
  );
});

test("a parentToolUseId arriving on a later delta still tags the block", () => {
  const timeline = new Timeline("conv-late");
  const delta = (parentToolUseId?: string) => ({
    type: "message_update",
    streamKey: "sub",
    ...(parentToolUseId ? { parentToolUseId } : {}),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "x",
    },
  });
  timeline.handle(event(delta()));
  timeline.handle(event(delta("toolu_1")));
  const block = timeline.items.find((item) => item.kind === "assistant");
  assert.equal(
    block && "parentToolUseId" in block ? block.parentToolUseId : undefined,
    "toolu_1",
  );
});
