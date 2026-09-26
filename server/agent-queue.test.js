import test from "node:test";
import assert from "node:assert/strict";

import { attachQueue } from "./agent-queue.js";

/** A backend in the shape grok has: it queues, but it cannot steer. */
function fakeAgent({ steerNow } = {}) {
  const agent = {
    busy: false,
    sent: [],
    emit() {},
    prompt(message) {
      this.sent.push(message);
      return Promise.resolve({ ok: true });
    },
  };
  attachQueue(agent, {
    isBusy() {
      return this.busy;
    },
    sendNow(message) {
      return this.prompt(message);
    },
    ...(steerNow ? { steerNow } : {}),
  });
  return agent;
}

test("an interrupt holds the queue through the turn-end it causes", async () => {
  const agent = fakeAgent();
  agent.busy = true;
  await agent.enqueue("do the other thing");

  agent.holdQueue();
  agent.busy = false;
  agent.sendNextQueued(); // the aborted turn settling

  assert.deepEqual(agent.sent, [], "nothing is auto-sent after an interrupt");
  assert.equal(agent.queuedMessages.length, 1, "it stays in the queue strip");
});

test("the hold is one-shot and a new turn releases it", async () => {
  const agent = fakeAgent();
  agent.busy = true;
  await agent.enqueue("first");
  agent.holdQueue();

  // codex skips the flush entirely on a failed turn, so the hold can outlive
  // the settle it was meant for; the user's next prompt must clear it.
  agent.prompt("a fresh instruction");
  agent.busy = false;
  agent.sendNextQueued();

  assert.deepEqual(agent.sent, ["a fresh instruction", "first"]);
  assert.equal(agent.queuedMessages.length, 0);
});

test("holding an empty queue is a no-op", () => {
  const agent = fakeAgent();
  agent.holdQueue();
  assert.equal(agent.queueHeld, false);
});

test("an agent that cannot steer can still send a held message once idle", async () => {
  const agent = fakeAgent(); // no steerNow: grok
  agent.busy = true;
  await agent.enqueue("the queued one");
  agent.holdQueue();

  assert.equal(
    (await agent.steerQueued()).ok,
    false,
    "mid-turn it is steering, which this agent cannot do",
  );

  agent.busy = false;
  await agent.steerQueued();
  assert.deepEqual(agent.sent, ["the queued one"]);
  assert.equal(agent.queueHeld, false);
});

test("an agent that can steer still splices mid-turn", async () => {
  const steered = [];
  const agent = fakeAgent({
    steerNow(message) {
      steered.push(message);
      return Promise.resolve({ ok: true });
    },
  });
  agent.busy = true;
  await agent.enqueue("mid-turn note");
  await agent.steerQueued();
  assert.deepEqual(steered, ["mid-turn note"]);
  assert.deepEqual(agent.sent, []);
});

test("clearing the queue drops the hold with it", async () => {
  const agent = fakeAgent();
  agent.busy = true;
  await agent.enqueue("one");
  await agent.enqueue("two");
  agent.holdQueue();

  assert.deepEqual(agent.cancelQueued().data, { cancelled: 2 });
  assert.equal(agent.queueHeld, false);
  assert.equal(
    agent.cancelQueued("nope").ok,
    false,
    "a cancel that lost the race with the flush says so",
  );
});

test("one queued message can be dropped without touching the others", async () => {
  const agent = fakeAgent();
  agent.busy = true;
  await agent.enqueue("keep me");
  await agent.enqueue("drop me");
  const [, second] = agent.queuedMessages;

  assert.deepEqual(agent.cancelQueued(second.id).data, { cancelled: 1 });
  assert.deepEqual(
    agent.queueSnapshot().map((entry) => entry.message),
    ["keep me"],
  );
});

test("a prompt typed while an ask waits queues instead of replacing it", async () => {
  const agent = fakeAgent();
  agent.askPending = true; // the settled turn ended with an ```ask fence
  await agent.enqueue("my own idea, do this instead");

  assert.deepEqual(agent.sent, [], "it must not become a fresh prompt");
  assert.equal(agent.queuedMessages.length, 1, "it waits behind the answer");
});

test("the settle that ended in an ask does not flush the queue", async () => {
  const agent = fakeAgent();
  agent.busy = true;
  await agent.enqueue("queued mid-turn");
  agent.busy = false;
  agent.askPending = true; // the turn settled by asking the user
  agent.sendNextQueued();

  assert.deepEqual(agent.sent, [], "a queued prompt cannot answer the ask");
  assert.equal(agent.queuedMessages.length, 1);
});

test("the answer turn delivers the queued prompt after it settles", async () => {
  const agent = fakeAgent();
  agent.askPending = true;
  await agent.enqueue("queued while waiting");

  // The ask card's answer arrives as a prompt: the hold releases...
  await agent.prompt("the answer: option two");
  assert.deepEqual(agent.sent, ["the answer: option two"]);
  assert.equal(agent.askPending, false, "delivery clears the pending ask");

  // ...and the answer turn's settle flushes what queued behind it.
  agent.sendNextQueued();
  assert.deepEqual(agent.sent, [
    "the answer: option two",
    "queued while waiting",
  ]);
  assert.equal(agent.queuedMessages.length, 0);
});

test("queue Send now overrides a pending ask explicitly", async () => {
  const agent = fakeAgent();
  agent.askPending = true;
  await agent.enqueue("send this now, forget the question");

  await agent.steerQueued(); // idle -> sendNow, the manual override
  assert.deepEqual(agent.sent, ["send this now, forget the question"]);
  assert.equal(agent.askPending, false, "delivery cleared the hold");
});
