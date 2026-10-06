import test from "node:test";
import assert from "node:assert/strict";

import { Timeline } from "./timeline.ts";
import { usageSummaryOf } from "./sessionMetrics.ts";
import type { AgentEvent } from "./api.ts";

const event = (payload: Record<string, unknown>): AgentEvent =>
  payload as unknown as AgentEvent;

test("claude turn_result usage is summed once, however many blocks streamed", () => {
  const timeline = new Timeline("conv-usage");
  for (const text of ["thinking it over", "hi"]) {
    timeline.handle(event({ type: "message_update", streamKey: "s1",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } }));
    timeline.handle(event({ type: "message_end", streamKey: "s1",
      message: { id: "msg_1", role: "assistant", content: [{ type: "text", text }] } }));
  }
  const usage = { input: 10, output: 153, cacheRead: 21005, cacheWrite: 12128, totalTokens: 33296 };
  timeline.handle(event({ type: "turn_result", ok: true, usage }));
  const summary = usageSummaryOf(timeline.items);
  assert.equal(summary?.input, 10);
  assert.equal(summary?.output, 153);
  assert.equal(summary?.cached, 21005);
  assert.equal(summary?.cacheWrite, 12128);
});

// Real turn_completed rows from a grok session whose usage.json ledger equals
// their sum. Mid-run the card sums timeline stamps; that sum must be the ledger
// of the finished turns, never more.
test("grok timeline stamps equal the usage.json ledger, mid-run and after", async () => {
  // @ts-expect-error -- plain-JS server module, no declarations
  const { usageFrom, grokSessionUsage } = await import("../../server/grok-agent.js");
  const rows = [
    { inputTokens: 2319866, outputTokens: 29606, totalTokens: 2349472, cachedReadTokens: 2199040, cacheCreationTokens: 0, apiDurationMs: 534640 },
    { inputTokens: 120000, outputTokens: 333, totalTokens: 120333, cachedReadTokens: 119424, cacheCreationTokens: 0, apiDurationMs: 7499 },
  ];
  const timeline = new Timeline("conv-grok-usage");
  const turn = (row: Record<string, number>, n: number, finish: boolean) => {
    const message = { role: "assistant", content: [], provider: "grok", usage: usageFrom(undefined) };
    // grok-agent.js prompt(): agent_start + turn_start open every prompt.
    timeline.handle(event({ type: "agent_start" }));
    timeline.handle(event({ type: "turn_start" }));
    timeline.handle(event({ type: "message_start", message }));
    timeline.handle(event({ type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `turn ${n}` } }));
    if (finish) timeline.handle(event({ type: "message_end", message: { ...message, usage: usageFrom(row) } }));
  };
  const expect = (turns: Record<string, number>[]) => {
    const ledger = grokSessionUsage(undefined, turns);
    const summary = usageSummaryOf(timeline.items);
    assert.deepEqual(
      { input: summary?.input, output: summary?.output, cached: summary?.cached, cacheWrite: summary?.cacheWrite },
      { input: ledger.input, output: ledger.output, cached: ledger.cacheRead, cacheWrite: ledger.cacheWrite });
  };
  turn(rows[0]!, 1, true);
  expect(rows.slice(0, 1));
  turn(rows[1]!, 2, false); // second turn streaming: no stamp yet
  expect(rows.slice(0, 1));
  timeline.handle(event({ type: "message_end", message: { role: "assistant", content: [], usage: usageFrom(rows[1]) } }));
  expect(rows);
});

test("claude per-call usage shows mid-run and the ledger replaces it at turn end", () => {
  const timeline = new Timeline("conv-usage-live");
  const sum = () => usageSummaryOf(timeline.items);
  // Turn 1 already billed by its ledger.
  timeline.handle(event({ type: "message_update", streamKey: "s1",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "one" } }));
  timeline.handle(event({ type: "turn_result", ok: true, usage: { input: 5, output: 50, cacheRead: 100, cacheWrite: 0, totalTokens: 155 } }));
  timeline.handle(event({ type: "agent_start" }));
  // Before turn 2 streams anything, a call's count must not touch turn 1's ledger.
  timeline.handle(event({ type: "usage_progress", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } }));
  assert.equal(sum()?.output, 50);
  timeline.handle(event({ type: "message_update", streamKey: "s2",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "two" } }));
  timeline.handle(event({ type: "usage_progress", usage: { input: 10, output: 184, cacheRead: 0, cacheWrite: 33535, totalTokens: 33729 } }));
  assert.equal(sum()?.output, 50 + 184, "first call shows mid-run");
  timeline.handle(event({ type: "usage_progress", usage: { input: 8, output: 29, cacheRead: 33535, cacheWrite: 313, totalTokens: 33885 } }));
  assert.equal(sum()?.output, 50 + 213, "second call adds on");
  timeline.handle(event({ type: "turn_result", ok: true, usage: { input: 18, output: 213, cacheRead: 33535, cacheWrite: 33848, totalTokens: 67614 } }));
  const final = sum();
  assert.deepEqual([final?.input, final?.output, final?.cached, final?.cacheWrite], [5 + 18, 50 + 213, 100 + 33535, 33848]);
  assert.ok(!timeline.items.some((item) => (item as { usage?: { provisional?: boolean } }).usage?.provisional));
});
