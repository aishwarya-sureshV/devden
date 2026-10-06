import assert from "node:assert/strict";
import { test } from "node:test";
import {
  usageCutoff,
  usageSummaryFromCounts,
  usageSummaryOf,
} from "./sessionMetrics.ts";
import type { TimelineItem } from "./timeline";

const assistant = (
  id: string,
  at: number,
  usage: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens: number;
    durationMs?: number;
    durationKind?: "api" | "turn";
  },
): TimelineItem => ({
  id,
  kind: "assistant",
  text: "",
  live: false,
  timestamp: at,
  usage,
});

test("a provider ledger is counted once, and speed uses model time", () => {
  const summary = usageSummaryFromCounts({
    input: 51739,
    output: 9550,
    cacheRead: 483584,
    cacheWrite: 0,
    durationMs: 146138,
  });
  assert.equal(summary?.input, 51739);
  assert.equal(summary?.cached, 483584);
  assert.equal(summary?.cacheHitPercent, (483584 / (51739 + 483584)) * 100);
  assert.equal(summary?.tokensPerSec, 9550 / 146.138);
});

test("cache hit percent = cacheRead / (input + cacheRead + cacheWrite)", () => {
  // monocode's worked example: 172.7K cached of 176.8K cacheable → 98%.
  const summary = usageSummaryOf([
    assistant("a", 0, {
      input: 4000,
      output: 55,
      cacheRead: 172700,
      totalTokens: 176755,
    }),
  ]);
  assert.equal(summary?.cacheHitPercent, (172700 / 176700) * 100);
  assert.equal(summary?.input, 4000);
  assert.equal(summary?.output, 55);
  assert.equal(summary?.cached, 172700);
  assert.equal(summary?.cacheWrite, 0);
});

test("no cache fields reported → no percent, but input/output still sum", () => {
  const summary = usageSummaryOf([
    assistant("a", 0, { input: 100, output: 20, totalTokens: 120 }),
  ]);
  assert.equal(summary?.cacheHitPercent, undefined);
  assert.equal(summary?.input, 100);
  assert.equal(summary?.output, 20);
});

test("zero-cache provider that reports fields shows 0% (monocode's first-turn display)", () => {
  const summary = usageSummaryOf([
    assistant("a", 0, {
      input: 176400,
      output: 146,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 176546,
    }),
  ]);
  assert.equal(summary?.cacheHitPercent, 0);
});

test("switching back before a message restores the original agent's usage", () => {
  const items = [
    { id: "n1", kind: "notice" as const, text: "Switched from Codex to Grok. Next message hands it the transcript.", tone: "info" as const, timestamp: 4_000 },
    { id: "n2", kind: "notice" as const, text: "Switched back to Codex.", tone: "info" as const, timestamp: 6_000 },
  ];
  assert.equal(usageCutoff(items), 0);
  assert.equal(usageCutoff(items.slice(0, 1)), 4_000);
  assert.equal(usageCutoff([], 9_000), 9_000);
});

test("switching back keeps an earlier, already-used handoff", () => {
  const notice = (id: string, text: string, timestamp: number) =>
    ({ id, kind: "notice" as const, text, tone: "info" as const, timestamp });
  const user = { id: "u", kind: "user" as const, text: "go", timestamp: 2_000 };
  // Claude → Codex (used) → Claude → back to Codex: Codex owns usage since 1_000.
  assert.equal(usageCutoff([notice("a", "Switched from Claude to Codex.", 1_000), user,
    notice("b", "Switched from Codex to Claude.", 3_000), notice("c", "Switched back to Codex.", 4_000)]), 1_000);
  // Codex → Grok → Claude → back to Codex, nothing sent: all Codex's.
  assert.equal(usageCutoff([notice("a", "Switched from Codex to Grok.", 1_000),
    notice("b", "Switched from Codex to Claude.", 2_000), notice("c", "Switched back to Codex.", 3_000)]), 0);
});

test("a backend switch does not keep the previous agent's usage", () => {
  const summary = usageSummaryOf(
    [
      assistant("codex", 1_000, {
        input: 223796,
        output: 24961,
        cacheRead: 4554880,
        cacheWrite: 0,
        totalTokens: 4803637,
      }),
      {
        id: "u",
        kind: "user",
        text: "continue",
        timestamp: 5_000,
      },
      assistant("grok", 8_000, {
        input: 12,
        output: 3,
        cacheRead: 40,
        cacheWrite: 0,
        totalTokens: 55,
      }),
    ],
    4_000,
  );
  assert.equal(summary?.input, 12);
  assert.equal(summary?.output, 3);
  assert.equal(summary?.cached, 40);
});

test("sums across turns and never double-counts shared messages", () => {
  const summary = usageSummaryOf([
    {
      id: "u1",
      kind: "user",
      text: "go",
      timestamp: 0,
    },
    assistant("a1", 4000, {
      input: 100,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 140,
      durationMs: 5000,
      durationKind: "api",
    }),
    {
      id: "t1",
      kind: "tool",
      name: "bash",
      args: {},
      details: {},
      output: "",
      status: "done",
      startedAt: 5000,
      usage: { input: 50, output: 10, totalTokens: 60, durationMs: 1000, durationKind: "api" },
    },
    {
      id: "u2",
      kind: "user",
      text: "more",
      timestamp: 8000,
    },
    assistant("a2", 12000, { input: 30, output: 60, totalTokens: 90, durationMs: 3000, durationKind: "api" }),
  ]);
  assert.equal(summary?.input, 180);
  assert.equal(summary?.output, 110);
  // Rate uses the reported model time (5s + 1s + 3s), not wall-clock gaps.
  assert.equal(summary?.tokensPerSec, 110 / 9);
});

test("no usage anywhere → null; output with no measurable time → no rate", () => {
  assert.equal(usageSummaryOf([]), null);
  assert.equal(
    usageSummaryOf([
      assistant("a", 5000, { input: 10, output: 5, totalTokens: 15 }),
    ])?.tokensPerSec,
    undefined,
  );
});
