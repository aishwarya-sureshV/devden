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
  setQueueIdleMsForTesting,
  readJsonlFromOffset,
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

test("idle turn is not busy so a user prompt is not queued", () => {
  const agent = new GrokAgentPool().get("idle-not-busy");
  agent.sessionId = "s1";
  agent.cwd = "/tmp";
  agent.startIdleTurn();
  assert.equal(agent.turn?.idle, true);
  assert.equal(agent.isBusy(), false);
  agent.handleSessionUpdate({
    update: { sessionUpdate: "turn_completed" },
  });
});

test("session-open chunks do not start an idle turn", () => {
  const agent = new GrokAgentPool().get("opening-check");
  agent.sessionId = "s-open";
  agent.cwd = "/tmp";
  agent.opening = true;
  agent.handleSessionUpdate({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "injected user_info" },
    },
  });
  assert.equal(agent.turn, undefined);
  assert.equal(agent.status === "working", false);
  agent.opening = false;
  agent.handleSessionUpdate({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "The subagent finished." },
    },
  });
  assert.equal(agent.turn?.idle, true);
  agent.handleSessionUpdate({
    update: { sessionUpdate: "turn_completed" },
  });
});

test("idle reminder turn streams the parent's handover live", () => {
  const agent = new GrokAgentPool().get("idle-check");
  agent.sessionId = "idle-1";
  agent.cwd = "/tmp";
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

test("a follow that never drains still settles the parent turn", async () => {
  // The stall that survived every previous fix: runTurn awaits
  // waitForSubagentFollows() *after* clearing watchTurnCompletion's file
  // timer, so a follow that never calls back left the turn open with no
  // watchdog behind it — "grok is still thinking" while the reply sat on
  // disk, cleared only by a manual refresh.
  setStallMsForTesting(5);
  try {
    const agent = stubAliveAgent("drain-backstop");
    agent.followSubagent("call-never-drains", "no-such-child");
    assert.equal(agent.subagentFollows.size, 1);
    await agent.waitForSubagentFollows();
    assert.equal(
      agent.subagentFollows.size,
      0,
      "the backstop must close the pane too, or the next turn reads as busy",
    );
  } finally {
    setStallMsForTesting(DEFAULT_STALL_MS);
  }
});

test("a follow that drains normally resolves without waiting for the backstop", async () => {
  setStallMsForTesting(60_000);
  try {
    const agent = stubAliveAgent("drain-normal");
    agent.followSubagent("call-drains", "no-such-child");
    const waited = agent.waitForSubagentFollows();
    agent.stopSubagentFollows();
    await waited;
    assert.equal(agent.subagentFollows.size, 0);
  } finally {
    setStallMsForTesting(DEFAULT_STALL_MS);
  }
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

test("a hung prompt settles when grok journals turn_completed", async () => {
  // Same journal as the idle turn: ACP prompt() never returns, but grok
  // already wrote the reply. Without watching updates.jsonl on a normal
  // turn the UI stayed on "Grok is thinking" until a refresh.
  const home = mkdtempSync(join(tmpdir(), "grok-prompt-"));
  const prevHome = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  try {
    const agent = stubAliveAgent("prompt-file-check");
    agent.cwd = "/tmp/pi-web-prompt-cwd";
    agent.sessionId = "sess-prompt";
    const updates = join(
      home,
      "sessions",
      encodeURIComponent(agent.cwd),
      "sess-prompt",
      "updates.jsonl",
    );
    mkdirSync(dirname(updates), { recursive: true });
    writeFileSync(updates, "");
    const events = [];
    agent.onEvent((event) => events.push(event));
    const pending = agent.prompt("hello");
    assert.equal(agent.turn?.idle, undefined);
    appendFileSync(
      updates,
      JSON.stringify({
        method: "_x.ai/session/update",
        params: { update: { sessionUpdate: "turn_completed" } },
      }) + "\n",
    );
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(agent.turn, undefined);
    assert.ok(events.some((event) => event.type === "agent_settled"));
  } finally {
    if (prevHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

function acpLine(update, method = "session/update") {
  return JSON.stringify({ method, params: { update } }) + "\n";
}

function withGrokHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), "grok-sub-"));
    const prevHome = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      await fn(home);
    } finally {
      if (prevHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function childLayout(home, cwd, parentId, childId) {
  const root = join(home, "sessions", encodeURIComponent(cwd));
  const childDir = join(root, childId);
  const parentDir = join(root, parentId);
  mkdirSync(childDir, { recursive: true });
  mkdirSync(join(parentDir, "subagents", childId), { recursive: true });
  return {
    updates: join(childDir, "updates.jsonl"),
    output: join(parentDir, "subagents", childId, "output.json"),
    meta: join(parentDir, "subagents", childId, "meta.json"),
  };
}

test("readJsonlFromOffset tails new rows without rereading the prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsonl-tail-"));
  const path = join(dir, "updates.jsonl");
  writeFileSync(path, '{"n":1}\n');
  const first = readJsonlFromOffset(path, 0);
  assert.deepEqual(first.lines, ['{"n":1}']);
  assert.equal(first.missing, false);
  appendFileSync(path, '{"n":2}\n');
  const second = readJsonlFromOffset(path, first.offset);
  assert.deepEqual(second.lines, ['{"n":2}']);
  const empty = readJsonlFromOffset(path, second.offset);
  assert.deepEqual(empty.lines, []);
  const missing = readJsonlFromOffset(join(dir, "nope.jsonl"), 0);
  assert.equal(missing.missing, true);
  rmSync(dir, { recursive: true, force: true });
});

test(
  "pumpSubagent emits nested tools and text from the child jsonl",
  withGrokHome(async (home) => {
    const cwd = "/tmp/pi-web-pump-cwd";
    const childId = "child-pump-1";
    const files = childLayout(home, cwd, "parent-1", childId);
    writeFileSync(
      files.updates,
      acpLine({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I'll look around." },
      }) +
        acpLine({
          sessionUpdate: "tool_call",
          toolCallId: "grep-1",
          title: "grep",
          rawInput: { pattern: "health" },
        }) +
        acpLine({
          sessionUpdate: "tool_call_update",
          toolCallId: "grep-1",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "found /api/health" },
            },
          ],
        }),
    );
    const agent = stubAliveAgent("pump-jsonl-check");
    agent.cwd = cwd;
    agent.sessionId = "parent-1";
    const events = [];
    agent.onEvent((event) => events.push(event));
    agent.followSubagent("spawn-1", childId);
    assert.equal(
      events.some(
        (event) =>
          event.type === "tool_execution_start" &&
          event.toolCallId === "grep-1" &&
          event.parentToolUseId === "spawn-1",
      ),
      true,
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "tool_execution_end" && event.toolCallId === "grep-1",
      ),
      true,
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "message_update" &&
          event.parentToolUseId === "spawn-1" &&
          event.assistantMessageEvent?.delta === "I'll look around.",
      ),
      true,
    );
    agent.stopSubagentFollows();
  }),
);

test(
  "parent ACP child tools are hidden once the jsonl pump has their ids",
  withGrokHome(async (home) => {
    const cwd = "/tmp/pi-web-hide-cwd";
    const childId = "child-hide-1";
    const files = childLayout(home, cwd, "parent-1", childId);
    writeFileSync(
      files.updates,
      acpLine({
        sessionUpdate: "tool_call",
        toolCallId: "bash-1",
        title: "bash",
        rawInput: { command: "ls" },
      }),
    );
    const agent = stubAliveAgent("hide-pump-check");
    agent.cwd = cwd;
    agent.sessionId = "parent-1";
    agent.turn = {
      content: [],
      toolIndex: new Map(),
      openKind: undefined,
      message: { usage: {} },
    };
    const events = [];
    agent.onEvent((event) => events.push(event));
    agent.followSubagent("spawn-1", childId);
    events.length = 0;
    agent.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "bash-1",
        title: "bash",
        rawInput: { command: "ls" },
      },
    });
    const untagged = events.filter(
      (event) =>
        event.type === "tool_execution_start" &&
        event.toolCallId === "bash-1" &&
        !event.parentToolUseId,
    );
    assert.equal(untagged.length, 0);
    agent.stopSubagentFollows();
  }),
);

test(
  "a background follow holds the parent turn until the child is done",
  async () => {
    const agent = stubAliveAgent("hold-parent-check");
    let resolvePrompt;
    agent.connection.prompt = () =>
      new Promise((resolve) => {
        resolvePrompt = resolve;
      });
    const events = [];
    agent.onEvent((event) => events.push(event));
    const pending = agent.prompt("go");
    for (let i = 0; i < 20 && !agent.turn; i += 1) await sleep(5);
    assert.ok(agent.turn, "prompt should have opened a turn");
    agent.followSubagent("spawn-1", "no-such-child");
    assert.equal(agent.subagentFollows.size, 1);
    resolvePrompt({ stopReason: "end_turn" });
    await sleep(40);
    assert.equal(agent.subagentFollows.size, 1, "follow still live");
    assert.ok(agent.turn, "parent turn waits for the child");
    assert.equal(
      events.some((event) => event.type === "agent_settled"),
      false,
    );
    agent.stopSubagentFollows();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(agent.turn, undefined);
    assert.equal(agent.subagentFollows.size, 0);
    assert.ok(events.some((event) => event.type === "agent_settled"));
    agent.stop();
  },
);

test("a queued follow-up waits until the spawn follow has finished printing", async () => {
  setQueueIdleMsForTesting(20);
  try {
    const agent = stubAliveAgent("queue-follow-check");
    const prompts = [];
    let resolvePrompt;
    agent.connection.prompt = (args) => {
      prompts.push(args);
      return new Promise((resolve) => {
        resolvePrompt = resolve;
      });
    };
    const first = agent.prompt("spawn it");
    for (let i = 0; i < 20 && !agent.turn; i += 1) await sleep(5);
    agent.followSubagent("spawn-1", "no-such-child");
    const queued = await agent.enqueue("fgdfgds");
    assert.equal(queued.data?.queued, true);
    assert.equal(agent.queuedMessages.length, 1);
    assert.equal(prompts.length, 1);
    resolvePrompt({ stopReason: "end_turn" });
    await sleep(40);
    assert.equal(agent.queuedMessages.length, 1, "must not flush mid-follow");
    assert.equal(prompts.length, 1);
    agent.stopSubagentFollows();
    const result = await first;
    assert.equal(result.ok, true);
    await sleep(80);
    assert.equal(prompts.length, 2, "queued prompt sends after the follow");
    const second = JSON.stringify(prompts[1] ?? {});
    assert.match(second, /fgdfgds/);
    agent.stop();
  } finally {
    setQueueIdleMsForTesting(500);
  }
});

test("waitForSubagentFollows wakes every waiter when the last follow ends", async () => {
  const agent = stubAliveAgent("multi-wait-check");
  agent.followSubagent("a", "no-such-a");
  agent.followSubagent("b", "no-such-b");
  const first = agent.waitForSubagentFollows();
  const second = agent.waitForSubagentFollows();
  agent.stopSubagentFollows();
  await Promise.all([first, second]);
  assert.equal(agent.subagentFollows.size, 0);
});

test(
  "parent ACP chunks during a follow do not start an idle turn",
  withGrokHome(async (home) => {
    const cwd = "/tmp/pi-web-noidle-cwd";
    const childId = "child-noidle-1";
    childLayout(home, cwd, "parent-1", childId);
    const agent = stubAliveAgent("no-idle-while-follow");
    agent.cwd = cwd;
    agent.sessionId = "parent-1";
    agent.followSubagent("spawn-1", childId);
    agent.handleSessionUpdate({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I'll look around." },
      },
    });
    assert.equal(agent.turn, undefined);
    agent.stopSubagentFollows();
  }),
);

test(
  "turn_completed waits for a late output.json before finishing",
  withGrokHome(async (home) => {
    setStallMsForTesting(5 * 60_000);
    try {
    const cwd = "/tmp/pi-web-output-cwd";
    const childId = "child-output-1";
    const files = childLayout(home, cwd, "parent-1", childId);
    writeFileSync(
      files.updates,
      acpLine({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "chatter only" },
      }) +
        acpLine(
          { sessionUpdate: "turn_completed" },
          "_x.ai/session/update",
        ),
    );
    const agent = stubAliveAgent("output-retry-check");
    agent.cwd = cwd;
    agent.sessionId = "parent-1";
    const events = [];
    agent.onEvent((event) => events.push(event));
    agent.followSubagent("spawn-1", childId);
    assert.equal(agent.subagentFollows.size, 1, "should wait for output.json");
    writeFileSync(
      files.output,
      JSON.stringify({ output: "## What I found\n- 42" }),
    );
    await sleep(400);
    assert.equal(agent.subagentFollows.size, 0);
    const end = events.find(
      (event) =>
        event.type === "tool_execution_end" && event.toolCallId === "spawn-1",
    );
    assert.match(String(end?.result?.content?.[0]?.text ?? ""), /What I found/);
    } finally {
      setStallMsForTesting(DEFAULT_STALL_MS);
    }
  }),
);
