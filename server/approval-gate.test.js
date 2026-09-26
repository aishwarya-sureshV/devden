import test from "node:test";
import assert from "node:assert/strict";

import { ApprovalGate, countPendingApprovals } from "./approval-gate.js";

function fakeAgent(agentMode = "manual") {
  const agent = {
    sessionKey: "s1",
    agentMode,
    events: [],
    emit(event) {
      this.events.push(event);
    },
  };
  return agent;
}

test("gate is a no-op outside manual mode", async () => {
  const gate = new ApprovalGate(fakeAgent("standard"));
  const result = await gate.request({ toolName: "Bash" });
  assert.deepEqual(result, { allow: true, choice: undefined });
  assert.equal(gate.pending.size, 0);
});

test("request parks the turn, allow_always remembers the tool", async () => {
  const agent = fakeAgent();
  const gate = new ApprovalGate(agent);
  const pending = gate.request({ toolName: "Bash", detail: "ls" });
  // One approval_request emitted, turn parked.
  assert.equal(agent.events.length, 1);
  assert.equal(agent.events[0].type, "approval_request");
  assert.equal(gate.pending.size, 1);

  const requestId = agent.events[0].requestId;
  const resolved = gate.resolve(requestId, "allow_always");
  assert.deepEqual(resolved, { ok: true });
  assert.deepEqual(await pending, { allow: true, choice: "allow_always" });
  // The resolve itself announced to the UI: request + resolved.
  assert.equal(agent.events.length, 2);

  // Same tool is auto-allowed from now on, with no new approval ask.
  const again = await gate.request({ toolName: "Bash" });
  assert.deepEqual(again, { allow: true, choice: "allow_always" });
  assert.equal(agent.events.length, 2);

  // A different tool still asks.
  const other = gate.request({ toolName: "write" });
  assert.equal(agent.events.length, 3);
  assert.equal(agent.events[2].type, "approval_request");
  gate.resolve(agent.events[2].requestId, "deny");
  assert.deepEqual(await other, { allow: false, choice: "deny" });
});

test("unknown requestId resolves to an error, not a throw", () => {
  const gate = new ApprovalGate(fakeAgent());
  assert.deepEqual(gate.resolve("nope", "allow"), {
    ok: false,
    error: "no pending approval with that id",
  });
});

test("denyAll clears every pending ask so an aborted turn can end", async () => {
  const agent = fakeAgent();
  const gate = new ApprovalGate(agent);
  const first = gate.request({ toolName: "Bash" });
  const second = gate.request({ toolName: "write" });
  gate.denyAll();
  assert.deepEqual(await first, { allow: false, choice: "deny" });
  assert.deepEqual(await second, { allow: false, choice: "deny" });
  assert.equal(gate.pending.size, 0);
});

test("countPendingApprovals sums every live gate", () => {
  const pools = {
    pi: {
      agents: new Map([
        ["a", { approvalGate: { pending: new Map([["1", {}], ["2", {}]]) } }],
      ]),
    },
    claude: { agents: new Map([["b", { approvalGate: { pending: new Map() } }]]) },
    grok: { agents: new Map([["c", {}]]) },
  };
  assert.equal(countPendingApprovals(pools), 2);
  assert.equal(countPendingApprovals(null), 0);
});
