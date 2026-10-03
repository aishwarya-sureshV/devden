import { test } from "node:test";
import assert from "node:assert/strict";
import { messagesFromClaudeLog } from "./claude-agent.js";

test("claude usage is normalized and counted once per message id", () => {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 2 };
  const entry = (content) => JSON.stringify({ type: "assistant", timestamp: "2026-10-03T00:00:00Z",
    message: { id: "m1", role: "assistant", content, usage } });
  const log = [entry([{ type: "text", text: "a" }]), entry([{ type: "tool_use", id: "t", name: "Bash", input: {} }])].join("\n");
  const withUsage = messagesFromClaudeLog(log).filter((message) => message.usage);
  assert.equal(withUsage.length, 1);
  assert.deepEqual(withUsage[0].usage, { input: 10, output: 5, cacheRead: 90, cacheWrite: 2, totalTokens: 107 });
});
