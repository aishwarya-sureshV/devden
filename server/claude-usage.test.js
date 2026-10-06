import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAgentProcess, messagesFromClaudeLog } from "./claude-agent.js";

test("claude usage is normalized and counted once per message id", () => {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 2 };
  const entry = (content) => JSON.stringify({ type: "assistant", timestamp: "2026-10-03T00:00:00Z",
    message: { id: "m1", role: "assistant", content, usage } });
  const log = [entry([{ type: "text", text: "a" }]), entry([{ type: "tool_use", id: "t", name: "Bash", input: {} }])].join("\n");
  const withUsage = messagesFromClaudeLog(log).filter((message) => message.usage);
  assert.equal(withUsage.length, 1);
  assert.deepEqual(withUsage[0].usage, { input: 10, output: 5, cacheRead: 90, cacheWrite: 2, totalTokens: 107 });
});

// Recorded 2026-10-04 from `claude -p --input-format stream-json
// --include-partial-messages` (haiku, two prompts on one process). Each
// content block is its own assistant event repeating the message_start
// snapshot (output 6); message_delta and result carry the final 153 / 139.
// modelUsage on the second result is cumulative (inputTokens 20).
test("live claude usage is billed once per turn from the result ledger", () => {
  const agent = new ClaudeAgentProcess("claude-usage-ledger");
  const events = [];
  agent.onEvent((event) => events.push(event));
  const feed = (event) => agent.handleLine(JSON.stringify(event));
  const turn = (id, cacheWrite, cacheRead, output, cumulative) => {
    const snapshot = { input_tokens: 10, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: 6 };
    const final = { ...snapshot, output_tokens: output };
    feed({ type: "stream_event", event: { type: "message_start", message: { id, usage: snapshot } } });
    feed({ type: "assistant", message: { id, role: "assistant", content: [{ type: "thinking", thinking: "…" }], usage: snapshot } });
    feed({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text: "hi" }], usage: snapshot } });
    feed({ type: "stream_event", event: { type: "message_delta", usage: final } });
    feed({ type: "result", subtype: "success", result: "hi", usage: final,
      modelUsage: { "claude-haiku-4-5-20251001": cumulative } });
  };
  turn("msg_1", 12128, 21005, 153,
    { inputTokens: 10, outputTokens: 153, cacheReadInputTokens: 21005, cacheCreationInputTokens: 12128 });
  turn("msg_2", 971, 33133, 139,
    { inputTokens: 20, outputTokens: 292, cacheReadInputTokens: 54138, cacheCreationInputTokens: 13099 });

  const ends = events.filter((event) => event.type === "message_end");
  assert.equal(ends.length, 4);
  assert.ok(ends.every((event) => event.message.usage === undefined), "per-block snapshots are not billed");
  assert.deepEqual(events.filter((event) => event.type === "turn_result").map((event) => event.usage), [
    { input: 10, output: 153, cacheRead: 21005, cacheWrite: 12128, totalTokens: 33296 },
    { input: 10, output: 139, cacheRead: 33133, cacheWrite: 971, totalTokens: 34253 },
  ]);
});

// Recorded 2026-10-05 from `claude -p --include-partial-messages` (haiku, one
// prompt, two model calls around a Bash tool). Each message_delta carries the
// call's final usage; the two sum exactly to result.usage / modelUsage.
test("each finished model call is billed live, summing to the turn ledger", () => {
  const agent = new ClaudeAgentProcess("claude-usage-live");
  const events = [];
  agent.onEvent((event) => events.push(event));
  const feed = (event) => agent.handleLine(JSON.stringify(event));
  const call = (id, start, final) => {
    feed({ type: "stream_event", event: { type: "message_start", message: { id, usage: start } } });
    feed({ type: "stream_event", event: { type: "message_delta", usage: final } });
  };
  call("msg_a", { input_tokens: 10, cache_creation_input_tokens: 33535, cache_read_input_tokens: 0, output_tokens: 4 },
    { input_tokens: 10, cache_creation_input_tokens: 33535, cache_read_input_tokens: 0, output_tokens: 184 });
  call("msg_b", { input_tokens: 8, cache_creation_input_tokens: 313, cache_read_input_tokens: 33535, output_tokens: 1 },
    { input_tokens: 8, cache_creation_input_tokens: 313, cache_read_input_tokens: 33535, output_tokens: 29 });
  feed({ type: "result", subtype: "success", result: "done",
    usage: { input_tokens: 18, cache_creation_input_tokens: 33848, cache_read_input_tokens: 33535, output_tokens: 213 },
    modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 18, outputTokens: 213, cacheReadInputTokens: 33535, cacheCreationInputTokens: 33848 } } });

  const live = events.filter((event) => event.type === "usage_progress").map((event) => event.usage);
  assert.deepEqual(live, [
    { input: 10, output: 184, cacheRead: 0, cacheWrite: 33535, totalTokens: 33729 },
    { input: 8, output: 29, cacheRead: 33535, cacheWrite: 313, totalTokens: 33885 },
  ]);
  const ledger = events.find((event) => event.type === "turn_result").usage;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
    assert.equal(live[0][key] + live[1][key], ledger[key], key);
});
