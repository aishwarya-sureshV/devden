import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextTokensFromJournal,
  contextWindowForModel,
  turnUsagesFromJournal,
} from "./grok-context.js";

const journal = [
  JSON.stringify({
    params: { _meta: { totalTokens: 4809 }, update: { sessionUpdate: "agent_message_chunk" } },
  }),
  JSON.stringify({
    params: {
      _meta: { totalTokens: 52669 },
      update: {
        sessionUpdate: "turn_completed",
        usage: { inputTokens: 535323, outputTokens: 9550, cachedReadTokens: 483584, apiDurationMs: 146138 },
      },
    },
  }),
  JSON.stringify({
    params: { _meta: { totalTokens: 163280 }, update: { sessionUpdate: "turn_completed" } },
  }),
  JSON.stringify({
    params: {
      _meta: { totalTokens: 163280 },
      update: {
        sessionUpdate: "turn_completed",
        usage: { inputTokens: 1757487, outputTokens: 11002, cachedReadTokens: 1735296, apiDurationMs: 196508 },
      },
    },
  }),
].join("\n");

test("context fill is the latest journal total, not the sum of turns", () => {
  assert.equal(contextTokensFromJournal(journal), 163280);
  assert.equal(contextTokensFromJournal(""), 0);
});

test("turn usages skip a completion that has no token counts", () => {
  const turns = turnUsagesFromJournal(journal);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].apiDurationMs + turns[1].apiDurationMs, 342646);
});

test("model window matches the longest catalog prefix", () => {
  const catalog = [
    { id: "grok-4.7", context_window: 256000, auto_compact_threshold_percent: 80, compaction_at_tokens: true },
    { id: "grok-4.7-build-fast", context_window: 256000, auto_compact_threshold_percent: 80, compaction_at_tokens: true },
  ];
  const window = contextWindowForModel(catalog, "grok-4.7-build");
  assert.equal(window.model, "grok-4.7");
  assert.equal(window.maxTokens, 256000);
  assert.equal(window.autoCompactThreshold, 204800);
  assert.equal(window.isAutoCompactEnabled, true);
  assert.equal(contextWindowForModel([], "grok-4.7"), null);
});
