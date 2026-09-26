import { strict as assert } from "node:assert";
import test from "node:test";
import { messagesFromCodexLog } from "./sessions.js";
import { threadIdFromPath } from "./codex-agent.js";

const line = (payload, type = "response_item") =>
  JSON.stringify({ timestamp: "2026-09-06T20:48:50.000Z", type, payload });

const log = [
  line({ type: "message", role: "developer", content: [{ text: "system" }] }),
  line({
    type: "message",
    role: "user",
    content: [
      { text: "<recommended_plugins>\nAirtable\n</recommended_plugins>" },
    ],
  }),
  line({
    type: "message",
    role: "user",
    content: [
      {
        text: "[devden harness instruction — this block is not part of the user's message; do not quote, repeat, or reference it]\nblah\n[end devden harness instruction]\nrun echo pong",
      },
    ],
  }),
  line({ type: "reasoning", summary: [], encrypted_content: "opaque" }),
  line({
    type: "message",
    role: "assistant",
    content: [{ text: "Running it now." }],
  }),
  line({ type: "custom_tool_call", call_id: "c1", name: "exec", input: "{}" }),
  line({
    type: "custom_tool_call_output",
    call_id: "c1",
    output: [{ text: "pong\n" }],
  }),
  line({ type: "message", role: "assistant", content: [{ text: "done" }] }),
  // event_msg entries differ per rollout vintage and must not be read.
  line({ type: "agent_message", message: "ignored" }, "event_msg"),
].join("\n");

test("reads a rollout's response items into timeline messages", () => {
  const messages = messagesFromCodexLog(log);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  // The harness prefix and codex's injected context never reach the preview.
  assert.equal(messages[0].content[0].text, "run echo pong");
  assert.equal(messages[1].content[0].text, "Running it now.");
  assert.equal(messages[1].content[1].name, "exec");
  assert.equal(messages[2].toolName, "exec");
  assert.equal(messages[2].content[0].text, "pong\n");
});

test("recovers the thread id from a rollout path", () => {
  assert.equal(
    threadIdFromPath(
      "/Users/x/.codex/sessions/2026/09/06/rollout-2026-09-06T20-48-49-01a0774c-fcd3-7073-90c7-8e40dc764182.jsonl",
    ),
    "01a0774c-fcd3-7073-90c7-8e40dc764182",
  );
  assert.equal(threadIdFromPath("/Users/x/notes.jsonl"), undefined);
});
