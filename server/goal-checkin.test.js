import { strict as assert } from "node:assert";
import test from "node:test";
import { assistantText } from "./pi-agent.js";

/**
 * The standing-goal loop stops when the agent says GOAL DONE, and index.js
 * finds that sentinel with assistantText(). Every backend emits its assistant
 * message as `content: [{ type: "text", text }]`, so a change to that
 * extraction silently un-terminates the loop for whichever backend it breaks
 * -- which is a full-context turn re-billed every two hours, not a cosmetic
 * bug. This is that check.
 */
const sentinel = (message) => assistantText(message).includes("GOAL DONE");

test("finds the sentinel in every backend's assistant message shape", () => {
  // pi / Claude / Grok / Codex all build content as text parts.
  assert.ok(
    sentinel({
      role: "assistant",
      content: [{ type: "text", text: 'GOAL DONE — tests pass, 42 green.' }],
    }),
  );
  // Mixed content: the sentinel arrives after a tool call in the same message.
  assert.ok(
    sentinel({
      role: "assistant",
      content: [
        { type: "toolCall", id: "1", name: "Bash", arguments: {} },
        { type: "text", text: "GOAL DONE" },
      ],
    }),
  );
  // Older/plain shape.
  assert.ok(sentinel({ role: "assistant", content: "GOAL DONE" }));
});

test("does not fire on ordinary progress reports", () => {
  assert.ok(
    !sentinel({
      role: "assistant",
      content: [{ type: "text", text: "Still working on it; two files left." }],
    }),
  );
  // Tool arguments are not text parts, so a grep for the phrase is not a hit.
  assert.ok(
    !sentinel({
      role: "assistant",
      content: [
        { type: "toolCall", id: "1", name: "Bash", arguments: { command: 'grep "GOAL DONE" .' } },
      ],
    }),
  );
  assert.ok(!sentinel({ role: "assistant", content: [] }));
  assert.ok(!sentinel({ role: "assistant" }));
});
