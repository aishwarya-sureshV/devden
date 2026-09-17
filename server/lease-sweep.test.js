import { strict as assert } from "node:assert";
import test from "node:test";
import {
  LEASE_GRACE_MS,
  LEASE_TIMEOUT_MS,
  leaseVerdict,
} from "./lease-sweep.js";

const now = 1_000_000;

test("a fresh heartbeat is never reaped and clears any stale grace", () => {
  const verdict = leaseVerdict({
    lastHeartbeat: now - LEASE_TIMEOUT_MS,
    status: "ready",
    now,
    deadline: now + 5,
  });
  assert.deepEqual(verdict, { reap: false, deadline: undefined });
});

test("a completed session whose lease lapsed is spared, not reaped on the spot", () => {
  // The reported bug: a background tab's heartbeat stalled, the turn finished,
  // and the sweep stopped the agent on the very next pass because only
  // "working" agents were spared.
  const verdict = leaseVerdict({
    lastHeartbeat: now - LEASE_TIMEOUT_MS - 1,
    status: "ready",
    now,
    deadline: undefined,
  });
  assert.equal(verdict.reap, false);
  assert.equal(verdict.deadline, now + LEASE_GRACE_MS);
});

test("a lapsed lease spares working and starting agents too", () => {
  for (const status of ["working", "starting"]) {
    const verdict = leaseVerdict({
      lastHeartbeat: now - LEASE_TIMEOUT_MS - 1,
      status,
      now,
      deadline: undefined,
    });
    assert.equal(verdict.reap, false, status);
    assert.equal(verdict.deadline, now + LEASE_GRACE_MS);
  }
});

test("a spared session is reaped once its grace deadline passes", () => {
  const verdict = leaseVerdict({
    lastHeartbeat: now - LEASE_TIMEOUT_MS - 1,
    status: "ready",
    now: now + LEASE_GRACE_MS + 1,
    deadline: now + LEASE_GRACE_MS,
  });
  assert.deepEqual(verdict, { reap: true, deadline: undefined });
});

test("stopped or errored agents, and keys with no agent, are reaped immediately", () => {
  for (const status of ["stopped", "error", undefined]) {
    const verdict = leaseVerdict({
      lastHeartbeat: now - LEASE_TIMEOUT_MS - 1,
      status,
      now,
      deadline: now + LEASE_GRACE_MS,
    });
    assert.deepEqual(
      verdict,
      { reap: true, deadline: undefined },
      String(status),
    );
  }
});
