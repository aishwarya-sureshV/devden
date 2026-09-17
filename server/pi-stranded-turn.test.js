import { test } from "node:test";
import assert from "node:assert/strict";
import { PiAgentProcess } from "./pi-agent.js";

/**
 * A turn whose RPC response came back but whose agent_settled never did used
 * to leave the agent on "working" forever -- the spinner every user hit.
 */
const settled = (agent) =>
  new Promise((resolve) => {
    agent.onEvent((event) => {
      if (event.type === "agent_settled") resolve(event);
    });
  });

test("settles a turn whose completion event never arrived", async () => {
  const agent = new PiAgentProcess("test-key");
  agent.status = "working";
  // pi says the turn is over; only agent_settled went missing.
  agent.getState = async () => ({ isStreaming: false });
  const done = settled(agent);
  agent.settleAfterResponse(5);
  await done;
  assert.equal(agent.status, "ready");
});

test("keeps asking until pi reports the turn over", async () => {
  const agent = new PiAgentProcess("test-key");
  agent.status = "working";
  let calls = 0;
  // First poll finds the turn live (ack-style responses arm the backstop
  // 5s into every healthy turn); the second finds it over. The old one-shot
  // gave up after the first and the agent stayed "working" forever.
  agent.getState = async () => ({ isStreaming: ++calls < 2 });
  const done = settled(agent);
  agent.settleAfterResponse(5);
  await done;
  assert.equal(agent.status, "ready");
  // Two polls (live, then over) plus settleTurn's own state read.
  assert.ok(calls >= 2, "the first poll must re-arm, not give up");
});

test("does not settle a turn pi still reports as streaming", async () => {
  const agent = new PiAgentProcess("test-key");
  agent.status = "working";
  agent.getState = async () => ({ isStreaming: true });
  let settles = 0;
  agent.onEvent((event) => {
    if (event.type === "agent_settled") settles += 1;
  });
  // prompt responses are acks on current pi, so this timer fires 5s into
  // every live turn -- it must leave a genuinely running turn alone.
  agent.settleAfterResponse(5);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settles, 0, "live turn must not be settled");
  assert.equal(agent.status, "working");
});

test("leaves the real completion event to do the settling", async () => {
  const agent = new PiAgentProcess("test-key");
  agent.status = "working";
  let synthetic = 0;
  agent.onEvent((event) => {
    if (event.type === "agent_settled") synthetic += 1;
  });
  agent.settleAfterResponse(5);
  // pi's own event beats the grace window, as it does on every healthy turn.
  agent.settleTurn();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(agent.status, "ready");
  assert.equal(synthetic, 0, "backstop must not fire once the turn settled");
});

test("stays quiet when the completion event beat the response", async () => {
  const agent = new PiAgentProcess("test-key");
  let notices = 0;
  agent.onEvent((event) => {
    if (event.type === "notice" || event.type === "agent_settled") notices += 1;
  });
  // pi's normal ordering: agent_settled first, the RPC response after.
  agent.status = "ready";
  agent.settleAfterResponse(5);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(notices, 0, "a healthy turn must produce no backstop notice");
});

test("never settles a turn it was not armed for", async () => {
  const agent = new PiAgentProcess("test-key");
  let settles = 0;
  agent.onEvent((event) => {
    if (event.type === "agent_settled") settles += 1;
  });
  // Turn 1's response arms the backstop while still working...
  agent.turnSeq = 1;
  agent.status = "working";
  agent.settleAfterResponse(20);
  // ...then turn 2 starts before it fires.
  agent.turnSeq = 2;
  agent.status = "working";
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(settles, 0, "turn 1's backstop must not touch turn 2");
  assert.equal(agent.status, "working", "turn 2 must still be running");
});
