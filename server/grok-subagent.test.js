import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  GrokAgentPool,
  parseSubagentId,
  parentToolBelongsToFollow,
  parentTextAfterChild,
  subagentFindings,
  setStallMsForTesting,
} from "./grok-agent.js";

test("parseSubagentId reads the background spawn receipt", () => {
  const output = [
    "Subagent started in background.",
    "subagent_id: 01a08623-8b4b-73d1-94c2-3e8d43a3840d",
    "type: explore",
    "description: Find health endpoint wiring",
  ].join("\n");
  assert.equal(parseSubagentId(output), "01a08623-8b4b-73d1-94c2-3e8d43a3840d");
});

test("parseSubagentId ignores unrelated tool output", () => {
  assert.equal(parseSubagentId("found 4 matches"), "");
});

test("parentTextAfterChild keeps the handover and drops nested copy", () => {
  const child = "Traced prompt → SSE → Conversation. Sixty-one tool calls.";
  const held = [
    "A read-only explore subagent is running.",
    child,
    "The explore subagent finished. Brief map: Turn start is POST /api/prompt.",
  ].join("\n");
  const leftover = parentTextAfterChild(held, child);
  assert.match(leftover, /subagent is running/);
  assert.match(leftover, /Brief map/);
  assert.equal(leftover.includes(child), false);
  assert.equal(parentTextAfterChild(child, child), "");
  assert.equal(parentTextAfterChild("short", child), "short");
});

test("parent child-tool calls are hidden while a follow is active", () => {
  const follows = new Map([
    [
      "spawn-1",
      {
        parentToolUseId: "spawn-1",
        toolNames: new Map([["bash-1", "bash"]]),
      },
    ],
  ]);
  assert.equal(
    parentToolBelongsToFollow(
      follows,
      { toolCallId: "bash-1", title: "bash" },
      { toolIndex: new Map() },
    ),
    true,
  );
  assert.equal(
    parentToolBelongsToFollow(
      follows,
      { toolCallId: "spawn-1", title: "spawn_subagent" },
      { toolIndex: new Map() },
    ),
    false,
  );
  assert.equal(
    parentToolBelongsToFollow(
      follows,
      { toolCallId: "parent-read", title: "read" },
      { toolIndex: new Map() },
    ),
    false,
  );
  assert.equal(
    parentToolBelongsToFollow(
      new Map(),
      { toolCallId: "bash-1", title: "bash" },
      { toolIndex: new Map() },
    ),
    false,
  );
});

test("subagentFindings surfaces the official output over the narration", () => {
  const { blocks, resultText } = subagentFindings(
    "I'll look around.",
    "## What I found\n- the answer",
  );
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].content, "I'll look around.");
  assert.equal(blocks[0].contentIndex, 0);
  assert.equal(blocks[1].contentIndex, 1);
  assert.equal(blocks[1].content, "## What I found\n- the answer");
  assert.equal(resultText, "## What I found\n- the answer");
});

test("subagentFindings keeps one copy and falls back to narration", () => {
  const same = subagentFindings("the answer", "the answer");
  assert.equal(same.blocks.length, 1);
  assert.equal(same.resultText, "the answer");
  assert.equal(subagentFindings("", "").resultText, "Subagent finished.");
  assert.equal(
    subagentFindings("only narration", "").resultText,
    "only narration",
  );
  assert.equal(subagentFindings("narration", "").blocks.length, 1);
});

test("subagentFindings drops the block when the stream carried the findings", () => {
  // Real shape: the child streams "I'll …" plus its full findings as chunks,
  // and output.json repeats the findings minus the chatter. Emitting the
  // block again printed the same report twice in the panel.
  const findings = "## 1. What I did\n- one grep\n\n## 2. What I found\n- 42";
  const { blocks, resultText } = subagentFindings(
    ["I'll take a quick look." + findings],
    findings,
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].contentIndex, 0);
  assert.equal(resultText, findings);
});

test("subagentFindings keeps streamed blocks in order, appending only absent findings", () => {
  const findings = "## 2. What I found\n- 42";
  const { blocks, resultText } = subagentFindings(
    ["I'll take a quick look.", findings, ""],
    findings,
  );
  // The empty trailing segment drops out; the findings block is not
  // re-added because a streamed block already contains it.
  assert.deepEqual(
    blocks.map((block) => block.contentIndex),
    [0, 1],
  );
  assert.equal(blocks[0].content, "I'll take a quick look.");
  assert.equal(blocks[1].content, findings);
  assert.equal(resultText, findings);
});

test("idle reminder turn streams the parent's handover live", () => {
  const agent = new GrokAgentPool().get("idle-check");
  const events = [];
  agent.onEvent((event) => events.push(event));
  // The background-subagent completion reminder triggers a parent turn with
  // no prompt from this side; it used to be dropped because no turn was
  // attached, so the findings only appeared after a page refresh.
  agent.handleSessionUpdate({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "The subagent finished. Found: 42." },
    },
  });
  assert.equal(agent.turn?.idle, true);
  assert.ok(events.some((event) => event.type === "turn_start"));
  assert.ok(
    events.some(
      (event) =>
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_delta",
    ),
  );
  agent.handleSessionUpdate({
    update: { sessionUpdate: "turn_completed" },
  });
  assert.equal(agent.turn, undefined);
  assert.ok(events.some((event) => event.type === "agent_settled"));
  const finalText = events
    .filter(
      (event) =>
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_end",
    )
    .map((event) => event.assistantMessageEvent.content)
    .join("");
  assert.match(finalText, /Found: 42/);
});

const DEFAULT_STALL_MS = 5 * 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stubAliveAgent(sessionKey) {
  const agent = new GrokAgentPool().get(sessionKey);
  // A hung RPC: the connection exists but never answers — the exact shape
  // that used to wedge the turn open forever.
  agent.connection = { prompt: () => new Promise(() => {}) };
  agent.process = {
    exitCode: null,
    signalCode: null,
    kill() {},
    once() {},
    on() {},
  };
  agent.sessionId = "parent-1";
  agent.cwd = "/tmp";
  return agent;
}

test("stop settles a turn hung on a dead RPC and clears the UI", async () => {
  const agent = stubAliveAgent("stop-hung-check");
  const events = [];
  agent.onEvent((event) => events.push(event));
  const turn = agent.prompt("hello");
  assert.equal(agent.turn?.reject instanceof Function, true);
  agent.stop();
  const result = await turn;
  assert.equal(result.ok, false);
  assert.match(result.error, /stopped/);
  assert.equal(agent.turn, undefined);
  assert.equal(agent.status, "stopped");
  assert.ok(events.some((event) => event.type === "agent_settled"));
  const state = events.find(
    (event) => event.type === "state" && event.state?.status === "stopped",
  );
  assert.equal(state?.state.isStreaming, false);
});

test("abort ends an in-flight follow so the spawn tool does not stay running", async () => {
  const agent = stubAliveAgent("abort-follow-check");
  agent.connection.cancel = async () => {};
  const events = [];
  agent.onEvent((event) => events.push(event));
  agent.followSubagent("call-abort-1", "no-such-child");
  assert.equal(agent.subagentFollows.size, 1);
  const result = await agent.abort();
  assert.equal(result.ok, true);
  assert.equal(agent.subagentFollows.size, 0);
  const end = events.find(
    (event) =>
      event.type === "tool_execution_end" &&
      event.toolCallId === "call-abort-1",
  );
  assert.equal(end?.isError, true);
});

test("stop emits tool_execution_end on an in-flight follow", () => {
  const agent = stubAliveAgent("stop-follow-check");
  const events = [];
  agent.onEvent((event) => events.push(event));
  agent.followSubagent("call-stop-1", "no-such-child");
  assert.equal(agent.subagentFollows.size, 1);
  agent.stop();
  assert.equal(agent.subagentFollows.size, 0);
  const end = events.find(
    (event) =>
      event.type === "tool_execution_end" &&
      event.toolCallId === "call-stop-1",
  );
  assert.equal(end?.isError, true);
});

test("a silent subagent follow bails out instead of wedging the turn", async () => {
  setStallMsForTesting(1);
  try {
    const agent = stubAliveAgent("stall-follow-check");
    const events = [];
    agent.onEvent((event) => events.push(event));
    // No child session file exists at all: the pump never sees a single
    // byte of progress, so the stall watchdog must end the follow.
    agent.followSubagent("call-stall-1", "no-such-child");
    await sleep(500);
    assert.equal(agent.subagentFollows.size, 0);
    const end = events.find(
      (event) =>
        event.type === "tool_execution_end" &&
        event.toolCallId === "call-stall-1",
    );
    assert.equal(end?.isError, true);
  } finally {
    setStallMsForTesting(DEFAULT_STALL_MS);
  }
});

test("an idle reminder turn whose stream dies closes on the stall watchdog", async () => {
  setStallMsForTesting(20);
  try {
    const agent = stubAliveAgent("idle-stall-check");
    const events = [];
    agent.onEvent((event) => events.push(event));
    agent.handleSessionUpdate({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "The subagent finished." },
      },
    });
    assert.equal(agent.turn?.idle, true);
    await sleep(200);
    assert.equal(agent.turn, undefined);
    assert.ok(events.some((event) => event.type === "turn_end"));
    assert.ok(events.some((event) => event.type === "agent_settled"));
  } finally {
    setStallMsForTesting(DEFAULT_STALL_MS);
  }
});

test("idle turn closes as soon as grok journals turn_completed", async () => {
  // grok journals its turn marker with the non-ACP `_x.ai/session/update`
  // method, so the completion notification never reaches
  // handleSessionUpdate. The session file is the ground truth: without
  // reading it, every prompt typed during a reminder turn gets queued
  // behind a turn nobody is executing.
  const home = mkdtempSync(join(tmpdir(), "grok-idle-"));
  const prevHome = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  try {
    const agent = stubAliveAgent("idle-file-check");
    agent.cwd = "/tmp/pi-web-idle-cwd";
    agent.sessionId = "sess-1";
    const updates = join(
      home,
      "sessions",
      encodeURIComponent(agent.cwd),
      "sess-1",
      "updates.jsonl",
    );
    mkdirSync(dirname(updates), { recursive: true });
    writeFileSync(
      updates,
      JSON.stringify({
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk" } },
      }) + "\n",
    );
    const events = [];
    agent.onEvent((event) => events.push(event));
    agent.handleSessionUpdate({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "The subagent finished." },
      },
    });
    assert.equal(agent.turn?.idle, true);
    appendFileSync(
      updates,
      JSON.stringify({
        method: "_x.ai/session/update",
        params: { update: { sessionUpdate: "turn_completed" } },
      }) + "\n",
    );
    await sleep(600);
    assert.equal(agent.turn, undefined);
    assert.ok(events.some((event) => event.type === "turn_end"));
    assert.ok(events.some((event) => event.type === "agent_settled"));
    const settled = events.filter((event) => event.type === "agent_settled");
    assert.equal(settled.length, 1);
  } finally {
    if (prevHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
