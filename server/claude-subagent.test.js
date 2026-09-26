import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClaudeAgentProcess,
  isAsyncAgentLaunch,
  parseClaudeAgentId,
  parseTaskNotification,
  setStallMsForTesting,
  taskNotificationFromEvent,
} from "./claude-agent.js";

function eventsOf(agent) {
  const events = [];
  agent.onEvent((event) => events.push(event));
  return events;
}

function line(event) {
  return JSON.stringify(event);
}

const NOTIFICATION = `<task-notification>
<task-id>a09c3bb66893b9e8c</task-id>
<tool-use-id>toolu_01R9SGQWAyJzoQT5ojv979AE</tool-use-id>
<status>completed</status>
<summary>Agent finished</summary>
<result>found the files</result>
</task-notification>`;

test("parseTaskNotification reads a background Agent completion", () => {
  const parsed = parseTaskNotification(NOTIFICATION);
  assert.equal(parsed?.toolUseId, "toolu_01R9SGQWAyJzoQT5ojv979AE");
  assert.equal(parsed?.taskId, "a09c3bb66893b9e8c");
  assert.equal(parsed?.status, "completed");
  assert.equal(parsed?.result, "found the files");
  assert.equal(parseTaskNotification("hello"), null);
});

test("taskNotificationFromEvent reads queue-operation and attachment shapes", () => {
  assert.equal(
    taskNotificationFromEvent({
      type: "queue-operation",
      operation: "enqueue",
      content: NOTIFICATION,
    })?.toolUseId,
    "toolu_01R9SGQWAyJzoQT5ojv979AE",
  );
  assert.equal(
    taskNotificationFromEvent({
      type: "attachment",
      attachment: { type: "queued_command", commandMode: "task-notification", prompt: NOTIFICATION },
    })?.status,
    "completed",
  );
  assert.equal(
    taskNotificationFromEvent({ type: "queue-operation", operation: "dequeue", content: "" }),
    null,
  );
});

function launchBackground(agent, toolCallId = "toolu_1") {
  agent.handleLine(
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: toolCallId,
            name: "Agent",
            input: {
              description: "scan",
              subagent_type: "Explore",
              run_in_background: true,
            },
          },
        ],
      },
    }),
  );
  agent.handleLine(
    line({
      type: "user",
      toolUseResult: {
        isAsync: true,
        status: "async_launched",
        agentId: "abc",
      },
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            content:
              "Async agent launched successfully.\nagentId: abc (internal ID)",
          },
        ],
      },
    }),
  );
}

test("isAsyncAgentLaunch reads the spawn receipt grok-style", () => {
  assert.equal(
    isAsyncAgentLaunch("Async agent launched successfully.\nagentId: abc"),
    true,
  );
  assert.equal(
    isAsyncAgentLaunch("done", { isAsync: true, status: "async_launched" }),
    true,
  );
  assert.equal(isAsyncAgentLaunch("listed the files"), false);
  assert.equal(
    parseClaudeAgentId("agentId: abc123 (internal)", {}),
    "abc123",
  );
  assert.equal(parseClaudeAgentId("", { agentId: "from-details" }), "from-details");
});

test("a background Agent launch holds tool_execution_end until the notification", () => {
  const agent = new ClaudeAgentProcess("claude-hold-end");
  const events = eventsOf(agent);
  agent.handleLine(
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Agent",
            input: {
              description: "scan",
              subagent_type: "Explore",
              run_in_background: true,
            },
          },
        ],
      },
    }),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "tool_execution_start" && event.toolCallId === "toolu_1",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "subagent_start" && event.parentToolUseId === "toolu_1",
    ),
  );
  events.length = 0;
  agent.handleLine(
    line({
      type: "user",
      toolUseResult: {
        isAsync: true,
        status: "async_launched",
        agentId: "abc",
      },
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content:
              "Async agent launched successfully.\nagentId: abc (internal ID)",
          },
        ],
      },
    }),
  );
  assert.equal(
    events.filter((event) => event.type === "tool_execution_end").length,
    0,
  );
  agent.handleLine(
    line({
      type: "user",
      message: {
        role: "user",
        content: `<task-notification>
<task-id>abc</task-id>
<tool-use-id>toolu_1</tool-use-id>
<status>completed</status>
<summary>Agent finished</summary>
<result>found the files</result>
</task-notification>`,
      },
    }),
  );
  const end = events.find((event) => event.type === "tool_execution_end");
  assert.equal(end?.toolCallId, "toolu_1");
  assert.equal(end?.isError, false);
  assert.match(end?.result?.content?.[0]?.text ?? "", /found the files/);
  assert.ok(!events.some((event) => event.type === "message_start"));
  agent.stop();
});

test("a queue-operation enqueue finishes a held background Agent", () => {
  const agent = new ClaudeAgentProcess("claude-queue-end");
  const events = eventsOf(agent);
  launchBackground(agent, "toolu_1");
  events.length = 0;
  agent.handleLine(
    line({
      type: "queue-operation",
      operation: "enqueue",
      content: `<task-notification>
<task-id>abc</task-id>
<tool-use-id>toolu_1</tool-use-id>
<status>completed</status>
<summary>Agent finished</summary>
<result>found the files</result>
</task-notification>`,
    }),
  );
  const end = events.find((event) => event.type === "tool_execution_end");
  assert.equal(end?.toolCallId, "toolu_1");
  assert.equal(end?.isError, false);
  assert.match(end?.result?.content?.[0]?.text ?? "", /found the files/);
  agent.stop();
});

test("a session-log task-notification finishes a held Agent the stream missed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "devden-claude-bg-"));
  const sessionFile = join(dir, "s.jsonl");
  await writeFile(sessionFile, "");
  const agent = new ClaudeAgentProcess("claude-jsonl-end");
  agent.sessionFile = sessionFile;
  const events = eventsOf(agent);
  try {
    launchBackground(agent, "toolu_1");
    events.length = 0;
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        content: `<task-notification>
<task-id>abc</task-id>
<tool-use-id>toolu_1</tool-use-id>
<status>completed</status>
<summary>Agent finished</summary>
<result>from the session log</result>
</task-notification>`,
      })}\n`,
    );
    agent.pollBackgroundAgents();
    const end = events.find((event) => event.type === "tool_execution_end");
    assert.equal(end?.toolCallId, "toolu_1");
    assert.match(end?.result?.content?.[0]?.text ?? "", /from the session log/);
  } finally {
    agent.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a silent held Agent is closed by the stall watchdog", () => {
  const agent = new ClaudeAgentProcess("claude-stall-end");
  const events = eventsOf(agent);
  setStallMsForTesting(0);
  try {
    launchBackground(agent, "toolu_stall");
    events.length = 0;
    agent.pollBackgroundAgents();
    const end = events.find(
      (event) =>
        event.type === "tool_execution_end" && event.toolCallId === "toolu_stall",
    );
    assert.equal(end?.isError, true);
  } finally {
    setStallMsForTesting(5 * 60_000);
    agent.stop();
  }
});

test("a blocking Agent result still ends the tool immediately", () => {
  const agent = new ClaudeAgentProcess("claude-block-end");
  const events = eventsOf(agent);
  agent.handleLine(
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "Task",
            input: { description: "scan" },
          },
        ],
      },
    }),
  );
  events.length = 0;
  agent.handleLine(
    line({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: "listed the workspace",
          },
        ],
      },
    }),
  );
  const end = events.find((event) => event.type === "tool_execution_end");
  assert.equal(end?.toolCallId, "toolu_2");
  assert.match(end?.result?.content?.[0]?.text ?? "", /listed the workspace/);
});

test("nested tool_use stream events emit a live start with parentToolUseId", () => {
  const agent = new ClaudeAgentProcess("claude-stream-tool");
  const events = eventsOf(agent);
  agent.handleLine(
    line({
      type: "stream_event",
      parent_tool_use_id: "toolu_1",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "bash-1",
          name: "Bash",
          input: {},
        },
      },
    }),
  );
  const start = events.find((event) => event.type === "tool_execution_start");
  assert.equal(start?.toolCallId, "bash-1");
  assert.equal(start?.toolName, "Bash");
  assert.equal(start?.parentToolUseId, "toolu_1");
  events.length = 0;
  agent.handleLine(
    line({
      type: "stream_event",
      parent_tool_use_id: "toolu_1",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"command":"ls"}',
        },
      },
    }),
  );
  agent.handleLine(
    line({
      type: "stream_event",
      parent_tool_use_id: "toolu_1",
      event: { type: "content_block_stop", index: 0 },
    }),
  );
  const filled = events.find((event) => event.type === "tool_execution_start");
  assert.equal(filled?.args?.command, "ls");
});

test("stop errors an in-flight background Agent so the card does not stay running", () => {
  const agent = new ClaudeAgentProcess("claude-stop-hold");
  const events = eventsOf(agent);
  agent.handleLine(
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_stop",
            name: "Agent",
            input: { run_in_background: true },
          },
        ],
      },
    }),
  );
  agent.handleLine(
    line({
      type: "user",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "z" },
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_stop",
            content: "Async agent launched successfully.\nagentId: z",
          },
        ],
      },
    }),
  );
  events.length = 0;
  agent.stop();
  const end = events.find(
    (event) =>
      event.type === "tool_execution_end" && event.toolCallId === "toolu_stop",
  );
  assert.equal(end?.isError, true);
});

/**
 * Just enough CLI to exercise the control channel: record everything written
 * to stdin, and answer an interrupt request the way the real one does —
 * control_response first, then the turn's `result`.
 */
function attachFakeCli(agent, written) {
  // A restart would spawn the real CLI; these tests must never reach one.
  agent.spawnProcess = async () => {
    throw new Error("abort must not restart the session");
  };
  agent.process = {
    stdin: {
      writable: true,
      write(chunk, cb) {
        written.push(JSON.parse(chunk));
        cb?.(null);
        const sent = written.at(-1);
        if (sent.type !== "control_request") return true;
        agent.handleLine(
          line({
            type: "control_response",
            response: { subtype: "success", request_id: sent.request_id },
          }),
        );
        agent.handleLine(
          line({ type: "result", subtype: "error_during_execution", is_error: true }),
        );
        return true;
      },
    },
  };
  return agent;
}

test("interrupt holds the queued message instead of answering it", async () => {
  const agent = new ClaudeAgentProcess("claude-interrupt-plain");
  const written = [];
  attachFakeCli(agent, written);

  void agent.prompt("write the migration");
  assert.equal((await agent.enqueue("stop, do the rollback first")).data.queued, true);
  assert.equal((await agent.abort()).ok, true);

  // The whole point of the queue: an interrupt must not decide for the user
  // that the message they lined up still applies to a turn they cancelled.
  assert.deepEqual(
    agent.queuedMessages.map((entry) => entry.message),
    ["stop, do the rollback first"],
    "the queue survives the interrupt, unsent",
  );
  const delivered = written.filter((entry) => entry.type === "user");
  assert.equal(delivered.length, 1, "only the original prompt reached the CLI");
  assert.ok(agent.process, "the session survives an interrupt");
  assert.equal(
    written.filter((entry) => entry.type === "control_request").length,
    1,
    "one interrupt, no restart",
  );

  // "Send now" on the queue strip is what delivers it. Not awaited: the fake
  // CLI answers control requests only, so the turn it starts never settles.
  void agent.steerQueued();
  assert.equal(
    written.filter((entry) => entry.type === "user").at(-1).message.content[0]
      .text,
    "stop, do the rollback first",
  );
  assert.equal(agent.queuedMessages.length, 0);
});

test("interrupt closes a running subagent and keeps the queue", async () => {
  const agent = new ClaudeAgentProcess("claude-interrupt-subagent");
  const written = [];
  attachFakeCli(agent, written);

  void agent.prompt("do the thing");
  // A root-level Task spawned by that turn, still running.
  agent.handleLine(
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_task", name: "Task", input: {} },
        ],
      },
    }),
  );
  await agent.enqueue("actually, do this instead");

  const events = eventsOf(agent);
  assert.equal((await agent.abort()).ok, true);

  const taskEnd = events.find(
    (event) =>
      event.type === "tool_execution_end" && event.toolCallId === "toolu_task",
  );
  assert.equal(taskEnd?.isError, true, "the interrupted Task must stop running");
  assert.equal(agent.queuedMessages.length, 1, "the queue must not be dropped");
  assert.equal(
    written.filter((entry) => entry.type === "user").length,
    1,
    "nothing is auto-sent on interrupt",
  );
});

test("a message sent while a background subagent runs queues, and flushes when it ends", async () => {
  const agent = new ClaudeAgentProcess("claude-subagent-busy");
  const written = [];
  attachFakeCli(agent, written);

  agent.handleLine(
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_bg",
            name: "Agent",
            input: { run_in_background: true },
          },
        ],
      },
    }),
  );
  agent.handleLine(
    line({
      type: "user",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "z" },
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_bg",
            content: "Async agent launched successfully.\nagentId: z",
          },
        ],
      },
    }),
  );
  // The parent turn is over; only the child is still working.
  agent.handleLine(line({ type: "result", subtype: "success" }));

  assert.equal(agent.isBusy(), true, "a live child keeps the agent busy");
  const queued = await agent.enqueue("what are you doing?");
  assert.equal(
    queued.data.queued,
    true,
    "it becomes a queue chip, not a transcript bubble",
  );
  assert.equal(written.filter((entry) => entry.type === "user").length, 0);

  // The child finishing is the only "now idle" signal this message will get.
  agent.finishBackgroundAgent({
    toolUseId: "toolu_bg",
    status: "completed",
    result: "done",
  });
  assert.equal(
    written.at(-1).message.content[0].text,
    "what are you doing?",
    "it is sent once nothing is running",
  );
  assert.equal(agent.queuedMessages.length, 0);
});
