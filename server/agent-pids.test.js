import assert from "node:assert/strict";
import { test } from "node:test";
import { orphansToKill, parseEtime } from "./agent-pids.js";

test("parseEtime handles ps formats", () => {
  assert.equal(parseEtime("05"), 5);
  assert.equal(parseEtime("01:05"), 65);
  assert.equal(parseEtime("2:01:05"), 7265);
  assert.equal(parseEtime("1-00:00:01"), 86401);
});

test("orphansToKill keeps only the same, orphaned process", () => {
  const now = 1_000_000_000;
  const entries = [
    { pid: 10, serverPid: 2, startedAt: now - 60_000 }, // orphan, group leader
    { pid: 11, serverPid: 2, startedAt: now - 60_000 }, // parent still alive
    { pid: 12, serverPid: 2, startedAt: now - 60_000 }, // pid reused later
    { pid: 13, serverPid: 2, startedAt: now - 60_000 }, // gone
    { pid: 14, serverPid: 2, startedAt: now - 60_000 }, // orphan, shares group
  ];
  const table = new Map([
    [10, { ppid: 1, pgid: 10, etime: 60 }],
    [11, { ppid: 2, pgid: 11, etime: 60 }],
    [12, { ppid: 1, pgid: 12, etime: 3 }],
    [14, { ppid: 1, pgid: 2, etime: 61 }],
    [20, { ppid: 10, pgid: 20, etime: 30 }], // tool shell, own group
    [21, { ppid: 20, pgid: 20, etime: 30 }], // its sleep
    [30, { ppid: 11, pgid: 30, etime: 30 }], // child of a live agent
  ]);
  assert.deepEqual(orphansToKill(entries, table, now), [
    { pid: 10, group: true },
    { pid: 14, group: false },
    { pid: 20, group: true },
    { pid: 21, group: false },
  ]);
});
