import test from "node:test";
import assert from "node:assert/strict";

import {
  collectSubagentRuns,
  isHeldMainNarration,
  isHeldMainTool,
  isSettledSpawnTool,
  isSubagentChatter,
  isSubagentCheckIn,
  isSubagentEcho,
  isSubagentTool,
  isSubagentToolEcho,
  subagentLabel,
  subagentPrompt,
} from "./subagents.ts";
import type { TimelineItem } from "./timeline.ts";

const tool = (
  over: Partial<Extract<TimelineItem, { kind: "tool" }>> &
    Pick<Extract<TimelineItem, { kind: "tool" }>, "id" | "name">,
): Extract<TimelineItem, { kind: "tool" }> => ({
  args: {},
  details: {},
  output: "",
  status: "running",
  startedAt: 1,
  ...over,
  kind: "tool",
});

test("Task and spawn_subagent are subagent tools", () => {
  assert.equal(isSubagentTool("Task"), true);
  assert.equal(isSubagentTool("spawn_subagent"), true);
  assert.equal(isSubagentTool("Spawn Subagent"), true);
  assert.equal(isSubagentTool("bash"), false);
  assert.equal(isSubagentTool("get_command_or_subagent_output"), false);
});

test("prompt prefers the task body over the short description", () => {
  assert.equal(
    subagentPrompt({ description: "look around", prompt: "read the files" }),
    "read the files",
  );
});

test("label uses type and description when present", () => {
  assert.equal(
    subagentLabel(
      tool({
        id: "t",
        name: "Task",
        args: { subagent_type: "explore", description: "scan the repo" },
      }),
    ),
    "explore: scan the repo",
  );
});

test("collectSubagentRuns groups nested tools and text under Task", () => {
  const items: TimelineItem[] = [
    tool({ id: "task-1", name: "Task", args: { prompt: "go" } }),
    tool({
      id: "read-1",
      name: "read",
      parentToolUseId: "task-1",
      status: "done",
    }),
    {
      id: "asst-1",
      kind: "assistant",
      text: "found it",
      live: false,
      timestamp: 2,
      parentToolUseId: "task-1",
    },
    tool({ id: "bash-1", name: "bash" }),
  ];
  const runs = collectSubagentRuns(items);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, "task-1");
  assert.equal(runs[0].items.length, 2);
  assert.equal(runs[0].status, "running");
});

test("untagged tools stay off the main transcript while a subagent is busy", () => {
  const nested = tool({ id: "grep-1", name: "grep", status: "running" });
  const spawn = tool({ id: "s1", name: "spawn_subagent", status: "running" });
  const done = tool({ id: "g2", name: "grep", status: "done" });
  const earlier = tool({ id: "r1", name: "read", status: "done" });
  assert.equal(isHeldMainTool(nested, true, [spawn, nested]), true);
  assert.equal(isHeldMainTool(nested, false, [spawn, nested]), false);
  assert.equal(isHeldMainTool(spawn, true, [spawn]), false);
  assert.equal(isHeldMainTool(done, true, [spawn, done]), true);
  assert.equal(isHeldMainTool(earlier, true, [earlier, spawn]), false);
  assert.equal(
    isHeldMainTool(
      tool({ id: "b1", name: "bash", status: "done", parentToolUseId: "s1" }),
      true,
      [spawn],
    ),
    false,
  );
});

test("main-thread check-ins on a busy subagent stay off the main transcript", () => {
  const spawn = tool({
    id: "s1",
    name: "subagent",
    args: { agent: "scout", task: "read a file" },
    status: "running",
  });
  const statusCheck = tool({
    id: "c1",
    name: "subagent",
    args: { action: "status" },
    status: "done",
  });
  const rawRead = tool({
    id: "r1",
    name: "read",
    args: { path: "/tmp/run/status.json" },
    status: "done",
  });
  const wait = tool({
    id: "w1",
    name: "subagent",
    args: { action: "wait" },
    status: "done",
  });
  const narration = {
    id: "n1",
    kind: "assistant" as const,
    text: "The scout finished. Let me read its result.",
    live: false,
    timestamp: 2,
  };
  const handover = {
    id: "n2",
    kind: "assistant" as const,
    text: "Done. The scout read Conversation.tsx and reported back.",
    live: false,
    timestamp: 3,
  };
  const items = [spawn, statusCheck, narration, rawRead, wait, handover];

  assert.equal(isSubagentCheckIn(spawn, items), false);
  assert.equal(isSubagentCheckIn(statusCheck, items), true);
  assert.equal(isSubagentCheckIn(narration, items), true);
  assert.equal(isSubagentCheckIn(rawRead, items), true);
  assert.equal(isSubagentCheckIn(wait, items), true);
  // The handover lands after the last check-in, so it survives — and keeps
  // surviving once the run settles, which a live-status test would not.
  assert.equal(isSubagentCheckIn(handover, items), false);
});

test("each subagent in a turn keeps its own check-in window", () => {
  const spawnA = tool({ id: "a", name: "subagent", args: { agent: "one" } });
  const waitA = tool({ id: "wa", name: "subagent_wait", status: "done" });
  const summaryA = {
    id: "sa",
    kind: "assistant" as const,
    text: "The first worker is done. Here is what it found.",
    live: false,
    timestamp: 2,
  };
  const spawnB = tool({ id: "b", name: "subagent", args: { agent: "two" } });
  const waitB = tool({ id: "wb", name: "subagent_wait", status: "done" });
  const summaryB = {
    id: "sb",
    kind: "assistant" as const,
    text: "The second worker is done too.",
    live: false,
    timestamp: 4,
  };
  const items = [spawnA, waitA, summaryA, spawnB, waitB, summaryB];

  assert.equal(isSubagentCheckIn(waitA, items), true);
  assert.equal(isSubagentCheckIn(waitB, items), true);
  // Neither spawn is hidden, and neither summary is swallowed by the *next*
  // run's check-ins.
  assert.equal(isSubagentCheckIn(spawnB, items), false);
  assert.equal(isSubagentCheckIn(summaryA, items), false);
  assert.equal(isSubagentCheckIn(summaryB, items), false);
});

test("narration about a running subagent is held, other work still streams", () => {
  const spawn = tool({ id: "s1", name: "subagent", args: { agent: "worker" } });
  const [run] = collectSubagentRuns([spawn]);
  assert.equal(run.status, "running");
  const live = (text: string): TimelineItem => ({
    id: "a1",
    kind: "assistant",
    text,
    live: true,
    timestamp: 1,
  });

  // Verbatim from real transcripts — every one of these flashed before.
  for (const text of [
    "The worker is running in the background on the big task. Let me wait for it to finish.",
    "The workflow wrapper finished. Let me check the child run status.",
    "The worker got confused and thinks it needs to spawn a subagent.",
    "No pending supervisor requests. Let me check the worker's status.",
    // Opens without naming the run, so the agent name cannot catch these.
    "Let me wait for it to finish so I can show you the full report.",
    "It is still running — I'll give it a moment.",
    "", // the very first token must not flash either
  ]) {
    assert.equal(isSubagentChatter(live(text), [run]), true, text);
  }

  // The main agent's own work keeps streaming token by token.
  for (const text of [
    "Let me fix the failing lint rule in api.ts.",
    "I'll read the migration and check the column default.",
    "Running the test suite now.",
  ]) {
    assert.equal(isSubagentChatter(live(text), [run]), false, text);
  }

  // The last check-in before a run ends has no tool call after it to close
  // the positional window, so it has to be held once it settles too.
  const settled: TimelineItem = {
    id: "a1",
    kind: "assistant",
    text:
      "The workflow wrapper returned early again — the scout is still running." +
      " My wake subscription on a5cb1454 is already armed.",
    live: false,
    timestamp: 1,
  };
  assert.equal(isSubagentChatter(settled, [run]), true);
  // With nothing running, everything streams.
  assert.equal(isSubagentChatter(live("The worker is running."), []), false);
});

test("a blocked run reports why it is stalled", () => {
  const spawn = tool({ id: "s1", name: "subagent", args: { agent: "worker" } });
  const notice: TimelineItem = {
    id: "n1",
    kind: "notice",
    text: "worker is waiting for a supervisor reply",
    tone: "warning",
    timestamp: 2,
    parentToolUseId: "s1",
  };
  const [run] = collectSubagentRuns([spawn, notice]);
  assert.equal(run.status, "running");
  assert.equal(run.attention, "worker is waiting for a supervisor reply");
  // The notice belongs to the run's panel, not the main transcript.
  assert.equal(run.items.length, 1);

  // A run that is no longer running is not still "needing attention".
  const done = tool({ id: "s1", name: "subagent", args: { agent: "worker" }, status: "done" });
  assert.equal(collectSubagentRuns([done, notice])[0].attention, undefined);
});

test("main-thread work before any spawn is left alone", () => {
  const earlier = tool({ id: "e1", name: "read", status: "done" });
  const spawn = tool({ id: "s9", name: "subagent", args: { agent: "x" } });
  const wait = tool({ id: "w9", name: "subagent_wait", status: "done" });
  const items = [earlier, spawn, wait];
  assert.equal(isSubagentCheckIn(earlier, items), false);
});

test("untagged child narration stays off the main transcript", () => {
  const live = {
    id: "a1",
    kind: "assistant" as const,
    text: "I'll audit the tool pipeline from events through Timeline.",
    live: true,
    timestamp: 1,
  };
  const nested = {
    ...live,
    id: "a2",
    live: false,
    parentToolUseId: "s1",
  };
  assert.equal(isHeldMainNarration(live, true), true);
  assert.equal(isHeldMainNarration({ ...live, live: false }, true), false);
  assert.equal(isSubagentEcho({ ...live, live: false }, [nested]), true);
  assert.equal(
    isSubagentEcho(
      {
        id: "p",
        kind: "assistant",
        text: "Subagent is running — I'll wait.",
        live: false,
        timestamp: 1,
      },
      [nested],
    ),
    false,
  );
});

test("untagged copies of nested tools stay off the main transcript", () => {
  const spawn = tool({ id: "s1", name: "spawn_subagent" });
  const nested = tool({
    id: "b-nested",
    name: "bash",
    args: { command: "ls" },
    parentToolUseId: "s1",
    status: "done",
  });
  const echo = tool({
    id: "b-echo",
    name: "bash",
    args: { command: "ls" },
    status: "done",
  });
  const other = tool({
    id: "b-other",
    name: "bash",
    args: { command: "pwd" },
    status: "done",
  });
  assert.equal(isSubagentToolEcho(echo, [spawn, nested, echo]), true);
  assert.equal(isSubagentToolEcho(nested, [spawn, nested, echo]), false);
  assert.equal(isSubagentToolEcho(other, [spawn, nested, echo, other]), false);
});

test("a failed spawn is not running even if a nested tool is still open", () => {
  const runs = collectSubagentRuns([
    tool({ id: "spawn-1", name: "spawn_subagent", status: "error" }),
    tool({
      id: "grep-1",
      name: "grep",
      parentToolUseId: "spawn-1",
      status: "running",
    }),
  ]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "error");
});

test("a spawn_subagent with no nested calls is still a run", () => {
  const runs = collectSubagentRuns([
    tool({
      id: "s1",
      name: "spawn_subagent",
      args: { prompt: "do the thing" },
      status: "running",
    }),
  ]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, "s1");
  assert.equal(runs[0].items.length, 0);
  assert.equal(runs[0].status, "running");
});

test("Claude names the spawn tool Agent, not Task", () => {
  assert.ok(isSubagentTool("Agent"));
  assert.ok(isSubagentTool("Task"));
  assert.ok(isSubagentTool("spawn_subagent"));
  assert.ok(!isSubagentTool("AskUserQuestion"));
});

test("a running spawn stays on the main transcript", () => {
  const spawn = tool({
    id: "s1",
    name: "spawn_subagent",
    args: { subagent_type: "explore", description: "look around" },
    status: "running",
  });
  const runs = collectSubagentRuns([spawn]);
  assert.equal(isSettledSpawnTool(spawn, runs), false);
});

test("a finished spawn leaves the main transcript", () => {
  const spawn = tool({
    id: "s1",
    name: "spawn_subagent",
    args: { subagent_type: "explore", description: "look around" },
    status: "done",
  });
  const nested = tool({
    id: "r1",
    name: "read",
    parentToolUseId: "s1",
    status: "done",
  });
  const runs = collectSubagentRuns([spawn, nested]);
  assert.equal(runs[0]?.status, "done");
  assert.equal(isSettledSpawnTool(spawn, runs), true);
  assert.equal(isSettledSpawnTool(nested, runs), false);
});

test("a spawn with live nested work is not settled", () => {
  const spawn = tool({
    id: "s1",
    name: "spawn_subagent",
    status: "done",
  });
  const nested = tool({
    id: "r1",
    name: "read",
    parentToolUseId: "s1",
    status: "running",
  });
  const runs = collectSubagentRuns([spawn, nested]);
  assert.equal(runs[0]?.status, "running");
  assert.equal(isSettledSpawnTool(spawn, runs), false);
});
