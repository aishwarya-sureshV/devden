import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { TimelineItem } from "./timeline.ts";
import {
  formatWorkedAt,
  isSessionPath,
  isTurnComplete,
  isTurnLogOpen,
  splitFilePath,
  splitTurns,
  turnEndedAt,
  turnKey,
  turnSummaryItems,
} from "./turnFold.ts";

const user = (
  id: string,
  text: string,
  timestamp: number,
): TimelineItem => ({ id, kind: "user", text, timestamp });

const assistant = (
  id: string,
  text: string,
  timestamp: number,
): TimelineItem => ({
  id,
  kind: "assistant",
  text,
  live: false,
  timestamp,
});

const rationale = (
  id: string,
  text: string,
  timestamp: number,
): TimelineItem => ({
  id,
  kind: "rationale",
  text,
  live: false,
  timestamp,
});

const tool = (
  id: string,
  name: string,
  path: string,
  timestamp: number,
  extra: Partial<Extract<TimelineItem, { kind: "tool" }>> = {},
): TimelineItem => ({
  id,
  kind: "tool",
  name,
  args: { path, ...("args" in extra ? extra.args : {}) },
  details: extra.details ?? {},
  output: extra.output ?? "ok",
  status: extra.status ?? "done",
  startedAt: timestamp,
  elapsed: extra.elapsed,
});

test("splitTurns cuts on each user message", () => {
  const items: TimelineItem[] = [
    user("u1", "one", 1),
    assistant("a1", "reply", 2),
    user("u2", "two", 3),
    tool("t1", "read", "src/a.ts", 4),
    assistant("a2", "done", 5),
  ];
  const turns = splitTurns(items);
  assert.equal(turns.length, 2);
  assert.equal(turnKey(turns[0]!), "u1");
  assert.equal(turnKey(turns[1]!), "u2");
  assert.deepEqual(
    turns[1]!.map((item) => item.id),
    ["u2", "t1", "a2"],
  );
});

test("interrupted or stopped turns stay open and are not complete", () => {
  const cutOff: TimelineItem[] = [
    user("u", "go", 1),
    tool("t", "edit", "src/a.ts", 2, {
      status: "error",
      output: "(interrupted — no result was recorded)",
    }),
  ];
  assert.equal(isTurnComplete(cutOff), false);
  assert.equal(
    isTurnLogOpen({ live: false, isLast: false, complete: false }),
    true,
  );
  const stopped: TimelineItem[] = [
    user("u", "go", 1),
    tool("t", "read", "src/a.ts", 2),
    {
      id: "n",
      kind: "notice",
      text: "The backend stopped before answering. Send the message again to restart it.",
      tone: "error",
      timestamp: 3,
    },
  ];
  assert.equal(isTurnComplete(stopped), false);
  const finished: TimelineItem[] = [
    user("u", "go", 1),
    tool("t", "edit", "src/a.ts", 2),
    assistant("a", "done", 3),
  ];
  assert.equal(isTurnComplete(finished), true);
  assert.equal(
    isTurnLogOpen({ live: false, isLast: false, complete: true }),
    false,
  );
});

test("last finished turn is open; older turns fold until expanded", () => {
  assert.equal(isTurnLogOpen({ live: true, isLast: true }), true);
  assert.equal(isTurnLogOpen({ live: false, isLast: true }), true);
  assert.equal(isTurnLogOpen({ live: false, isLast: false }), false);
  assert.equal(
    isTurnLogOpen({ live: false, isLast: false, explicit: true }),
    true,
  );
  assert.equal(
    isTurnLogOpen({ live: false, isLast: true, explicit: false }),
    false,
  );
  assert.equal(
    isTurnLogOpen({ live: true, isLast: true, explicit: false }),
    true,
  );
});

test("turnSummaryItems keeps trailing prose and drops the tool log", () => {
  const turn: TimelineItem[] = [
    user("u", "go", 1),
    assistant("mid", "reading first", 2),
    rationale("r", "think", 3),
    tool("t", "edit", "src/a.ts", 4),
    assistant("final", "Host kill is blocked.", 5),
    assistant("tail", "Suite is green.", 6),
  ];
  assert.deepEqual(
    turnSummaryItems(turn).map((item) => item.id),
    ["final", "tail"],
  );
});

test("turnSummaryItems keeps trailing notices so fork errors stay visible", () => {
  const turn: TimelineItem[] = [
    user("u", "go", 1),
    tool("t", "edit", "src/a.ts", 2),
    assistant("final", "done", 3),
    {
      id: "n",
      kind: "notice",
      text: "Pi process is not running",
      tone: "error",
      timestamp: 4,
    },
  ];
  assert.deepEqual(
    turnSummaryItems(turn).map((item) => item.id),
    ["final", "n"],
  );
});

test("a turn with no tools keeps every assistant message as the summary", () => {
  const turn: TimelineItem[] = [
    user("u", "what is this", 1),
    assistant("a", "a web workbench", 2),
  ];
  assert.deepEqual(
    turnSummaryItems(turn).map((item) => item.id),
    ["a"],
  );
});

test("turnEndedAt uses the last tool finish or assistant timestamp", () => {
  const turn: TimelineItem[] = [
    user("u", "go", 1_000),
    tool("t", "read", "src/a.ts", 1_500, { elapsed: 400 }),
    assistant("a", "done", 2_200),
  ];
  assert.equal(turnEndedAt(turn), 2_200);
});

test("formatWorkedAt is empty for missing timestamps", () => {
  assert.equal(formatWorkedAt(0), "");
  assert.ok(formatWorkedAt(Date.now()).length > 0);
});

test("splitFilePath keeps the parent folder and the basename", () => {
  assert.deepEqual(splitFilePath("src/lib/turnFold.ts"), {
    dir: "lib/",
    name: "turnFold.ts",
  });
  assert.deepEqual(splitFilePath("README.md"), { dir: "", name: "README.md" });
});

test("isSessionPath matches absolute and relative tool paths to git's paths", () => {
  const cwd = "/repo/app/";
  assert.equal(isSessionPath("src/a.ts", ["/repo/app/src/a.ts"], cwd), true);
  assert.equal(isSessionPath("src/a.ts", ["./src/a.ts"], cwd), true);
  assert.equal(isSessionPath("lib/a.ts", ["/repo/app/otherlib/a.ts"], cwd), false);
  assert.equal(isSessionPath("src/a.ts", ["/repo/application/src/a.ts"], cwd), false);
});
