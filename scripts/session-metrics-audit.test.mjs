// Run separately: node --test scripts/session-metrics-audit.test.mjs
// Accuracy audit: failing cases are deliberately retained for future fixes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeUsage, messagesFromClaudeLog } from "../server/claude-agent.js";
import { codexUsageFrom, readCodexLog } from "../server/codex-history.js";
import { usageFrom as grokUsage } from "../server/grok-agent.js";
import { contextTokensFromPiMessages } from "../server/pi-context.js";
import { Timeline } from "../src/lib/timeline.ts";
import { usageSummaryOf, usageSummaryFromCounts } from "../src/lib/sessionMetrics.ts";

const state = { model: null, thinkingLevel: "off", isStreaming: false,
  sessionId: "audit", sessionFile: "", messageCount: 0, pendingMessageCount: 0 };
function summary(messages) {
  const timeline = new Timeline("metrics-audit");
  timeline.hydrate(messages, state);
  return usageSummaryOf(timeline.items);
}

test("all four backends preserve token buckets through history and aggregation", () => {
  const expected = { input: 10, output: 5, cached: 90, cacheWrite: 2 };
  const usages = {
    pi: { input: 10, output: 5, cacheRead: 90, cacheWrite: 2, totalTokens: 107 },
    claude: claudeUsage({ input_tokens: 10, output_tokens: 5,
      cache_read_input_tokens: 90, cache_creation_input_tokens: 2 }),
    grok: grokUsage({ inputTokens: 102, outputTokens: 5,
      cachedReadTokens: 90, cacheCreationTokens: 2, totalTokens: 107 }),
    codex: codexUsageFrom({ inputTokens: 100, outputTokens: 5,
      cachedInputTokens: 90, totalTokens: 105 }),
  };
  for (const [backend, usage] of Object.entries(usages)) {
    const actual = summary([{ role: "assistant", timestamp: 1000, usage,
      content: [{ type: "thinking", thinking: "reason" }, { type: "text", text: "reply" }] }]);
    const buckets = backend === "codex" ? { ...expected, cacheWrite: 0 } : expected;
    for (const [key, value] of Object.entries(buckets)) assert.equal(actual[key], value, `${backend}: ${key}`);
    assert.equal(actual.cacheHitPercent, 90 / (backend === "codex" ? 100 : 102) * 100, backend);
  }
});

test("Codex cumulative counts subtract the previous turn including cached tokens", () => {
  assert.deepEqual(codexUsageFrom(
    { inputTokens: 300, outputTokens: 30, cachedInputTokens: 250, totalTokens: 330 },
    { inputTokens: 100, outputTokens: 10, cachedInputTokens: 90, totalTokens: 110 },
  ), { input: 40, output: 20, cacheRead: 160, cacheWrite: 0, totalTokens: 220 });
});

test("Pi context is latest successful reply, independent of cumulative usage", () => {
  assert.equal(contextTokensFromPiMessages([
    { role: "assistant", usage: { totalTokens: 10000 } },
    { role: "assistant", usage: { totalTokens: 107 } },
    { role: "assistant", stopReason: "error", usage: { totalTokens: 90000 } },
  ]), 107);
});

test("Grok ledger speed uses the supplied API duration", () => {
  assert.equal(usageSummaryFromCounts({ input: 10, output: 100,
    cacheRead: 90, durationMs: 10000 }).tokensPerSec, 10);
});

test("follow-up with a cache miss adds fresh input without deleting past cache usage", () => {
  const turns = {
    pi: [
      { input: 10, output: 5, cacheRead: 90, totalTokens: 105 },
      { input: 100, output: 5, cacheRead: 0, totalTokens: 105 },
    ],
    claude: [90, 0].map(cache => claudeUsage({ input_tokens: 100 - cache,
      output_tokens: 5, cache_read_input_tokens: cache })),
    grok: [90, 0].map(cache => grokUsage({ inputTokens: 100,
      outputTokens: 5, cachedReadTokens: cache, totalTokens: 105 })),
    codex: [
      codexUsageFrom({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 90, totalTokens: 105 }),
      codexUsageFrom({ inputTokens: 200, outputTokens: 10, cachedInputTokens: 90, totalTokens: 210 },
        { inputTokens: 100, outputTokens: 5, cachedInputTokens: 90, totalTokens: 105 }),
    ],
  };
  for (const [backend, usages] of Object.entries(turns)) {
    const actual = summary(usages.flatMap((usage, index) => [
      { role: "user", timestamp: index * 10000, content: "continue" },
      { role: "assistant", timestamp: index * 10000 + 1000, usage,
        content: [{ type: "text", text: "reply" }] },
    ]));
    assert.equal(actual.input, 110, backend);
    assert.equal(actual.output, 10, backend);
    assert.equal(actual.cached, 90, backend);
    assert.equal(actual.cacheHitPercent, 45, backend);
  }
});

test("Claude repeated message blocks retain the final output count", () => {
  const log = [5, 20].map((output_tokens, index) => JSON.stringify({
    type: "assistant", timestamp: new Date(1000 + index * 1000).toISOString(),
    message: { id: "same-message", content: [{ type: "text", text: `block ${index}` }],
      usage: { input_tokens: 10, output_tokens, cache_read_input_tokens: 90 } },
  })).join("\n");
  assert.equal(summary(messagesFromClaudeLog(log)).output, 20);
});

test("Codex saved speed reflects completion time rather than first response time", () => {
  const entry = (at, type, payload) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload });
  const log = [
    entry(1000, "event_msg", { type: "task_started", turn_id: "t" }),
    entry(1000, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }),
    entry(2000, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "reply" }] }),
    entry(11000, "event_msg", { type: "token_count", info: {
      total_token_usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110 },
    } }),
    entry(11000, "event_msg", { type: "task_complete", turn_id: "t" }),
  ].join("\n");
  assert.equal(summary(readCodexLog(log).messages).tokensPerSec, 10);
});

test("an unrelated notice after a completed turn does not change its speed", () => {
  const items = [
    { id: "u", kind: "user", text: "go", timestamp: 1000 },
    { id: "a", kind: "assistant", text: "reply", timestamp: 11000,
      usage: { input: 10, output: 100, totalTokens: 110 } },
  ];
  const before = usageSummaryOf(items).tokensPerSec;
  items.push({ id: "n", kind: "notice", text: "Saved", timestamp: 101000 });
  assert.equal(usageSummaryOf(items).tokensPerSec, before);
});

test("the popover distinguishes reported zero cached tokens from unknown usage", async () => {
  const { createServer } = await import("vite");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  try {
    const { SessionDetails } = await server.ssrLoadModule("/src/components/SessionHeader.tsx");
    // useSessionStatus omits the cached label when the reported count is zero.
    const html = renderToStaticMarkup(createElement(SessionDetails, {
      title: "Audit", statusLabel: "Idle", statusTone: "idle", pathLabel: "/tmp/audit",
      branchLabel: null, contextLabel: "100 of 1k tokens (10%)",
      usageLabel: "0% cache hit · 10 input · 5 output", onCopyId: () => {},
    }));
    assert.equal(html.match(/<span>Cached<\/span><b[^>]*>(.*?)<\/b>/)?.[1], "0");
  } finally {
    await server.close();
  }
});
