import test from "node:test";
import assert from "node:assert/strict";

import {
  collectSubagentRuns,
  isHeldMainNarration,
  isHeldMainTool,
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
