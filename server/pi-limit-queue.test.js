import test from "node:test";
import assert from "node:assert/strict";

import { PiAgentProcess } from "./pi-agent.js";

const LIMIT =
  "you (aishuaish1998) have reached your session usage limit, upgrade for higher limits: https://ollama.com/upgrade";

test("a usage-limit settle holds a queued prompt until a real finish", async () => {
  const agent = new PiAgentProcess("limit-queue");
  const sent = [];
  agent.prompt = (message) => {
    sent.push(message);
    return Promise.resolve({ ok: true });
  };
  agent.getState = async () => ({ isStreaming: false });
  agent.status = "working";
  await agent.enqueue("follow-up while the turn was running");

  agent.handleLine(
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", errorMessage: LIMIT },
    }),
  );
  agent.handleLine(JSON.stringify({ type: "agent_settled" }));

  assert.deepEqual(sent, [], "the follow-up must not be sent into the wall");
  assert.equal(agent.queuedMessages.length, 1);

  // The resumed turn actually finishes. Now the held prompt can go.
  agent.status = "working";
  agent.handleLine(JSON.stringify({ type: "agent_settled" }));
  assert.deepEqual(sent, ["follow-up while the turn was running"]);
  assert.equal(agent.queuedMessages.length, 0);
});

test("an ordinary settle still delivers the queue", async () => {
  const agent = new PiAgentProcess("limit-queue-normal");
  const sent = [];
  agent.prompt = (message) => {
    sent.push(message);
    return Promise.resolve({ ok: true });
  };
  agent.getState = async () => ({ isStreaming: false });
  agent.status = "working";
  await agent.enqueue("next");
  agent.handleLine(JSON.stringify({ type: "agent_settled" }));
  assert.deepEqual(sent, ["next"]);
});
