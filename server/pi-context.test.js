import assert from "node:assert/strict";
import { test } from "node:test";
import { contextTokensFromPiMessages } from "./pi-context.js";

test("context fill is the last assistant usage, not the session sum", () => {
  const messages = [
    { role: "user", content: [] },
    { role: "assistant", stopReason: "error", usage: { totalTokens: 99999 } },
    { role: "assistant", usage: { totalTokens: 12000, input: 100, output: 20 } },
    { role: "assistant", usage: { input: 400, output: 50, cacheRead: 8000, cacheWrite: 0 } },
  ];
  assert.equal(contextTokensFromPiMessages(messages), 8450);
  assert.equal(contextTokensFromPiMessages([]), 0);
});
