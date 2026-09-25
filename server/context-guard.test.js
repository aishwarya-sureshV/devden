import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildReassertion,
  carriedIn,
  deadZoneStats,
  findDroppedInstructions,
  instructionSnippet,
  isStandingInstruction,
  liveFailures,
  parseSessionCompactions,
} from "./context-guard.js";

test("isStandingInstruction flags constraint-like user text only", () => {
  assert.ok(isStandingInstruction("Always run tests before saying done."));
  assert.ok(isStandingInstruction("Never push directly to main."));
  assert.ok(isStandingInstruction("From now on, prefer stdlib helpers."));
  assert.equal(isStandingInstruction("What does this file do?"), false);
  assert.equal(isStandingInstruction(""), false);
  assert.equal(isStandingInstruction("/compact"), false);
});

test("instructionSnippet flattens and truncates", () => {
  assert.equal(instructionSnippet("a\n\n  b"), "a b");
  const long = instructionSnippet("x".repeat(400));
  assert.equal(long.length, 240);
  assert.ok(long.endsWith("…"));
});

test("carriedIn needs two significant-word hits", () => {
  const hay =
    "The assistant must always run the test suite before declaring work done.";
  assert.ok(carriedIn(hay, "Always run tests before declaring done.")); // always + test + declaring
  assert.equal(
    carriedIn(
      "unrelated summary text here",
      "Always run tests before declaring done.",
    ),
    false,
  );
  assert.equal(carriedIn("", "Always run tests."), false);
});

test("findDroppedInstructions keeps only uncarried instructions", () => {
  const userMessages = [
    {
      role: "user",
      content: "Always run npm test before declaring work done.",
    },
    { role: "user", content: "Never force-push to main." },
    { role: "user", content: "What files did you touch?" },
    { role: "assistant", content: "I will remember." },
  ];
  const dropped = findDroppedInstructions({
    summary: "The session covered running npm test before finishing work.",
    liveText: "",
    userMessages,
  });
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].text, /Never force-push/);
});

test("parseSessionCompactions resolves cuts and counts the dead zone", () => {
  const iso = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  const contents = [
    JSON.stringify({
      type: "message",
      id: "u1",
      timestamp: iso(1),
      message: { role: "user", content: "Always keep the port at 4319." },
    }),
    JSON.stringify({
      type: "message",
      id: "t1",
      timestamp: iso(2),
      message: {
        role: "toolResult",
        toolName: "grep",
        isError: true,
        content: "no match",
      },
    }),
    JSON.stringify({
      type: "compaction",
      id: "c1",
      timestamp: iso(3),
      summary: "Port stays 4319.",
      firstKeptEntryId: "u2",
      tokensBefore: 84_000,
    }),
    JSON.stringify({
      type: "message",
      id: "u2",
      timestamp: iso(4),
      message: { role: "user", content: "Continue." },
    }),
  ].join("\n");
  const { compactions, entries } = parseSessionCompactions(contents);
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].tokensBefore, 84_000);
  assert.equal(compactions[0].summary, "Port stays 4319.");
  const cut = compactions[0].cutTimestamp;
  assert.ok(cut > 0);
  assert.equal(Date.parse(iso(4)), cut);
  const stats = deadZoneStats(entries, cut);
  assert.equal(stats.userMessages, 1);
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.failedToolCalls, 1);
  assert.deepEqual(liveFailures(entries, cut), []);
  const dead = liveFailures(entries, 0);
  assert.equal(dead[0].name, "grep");
  assert.equal(dead[0].count, 1);
});

test("deadZoneStats without a cut is empty", () => {
  assert.deepEqual(deadZoneStats([], null), {
    messages: 0,
    userMessages: 0,
    toolCalls: 0,
    failedToolCalls: 0,
  });
});

test("buildReassertion lists each dropped instruction", () => {
  const text = buildReassertion([{ text: "Never force-push to main." }]);
  assert.match(text, /context guard/);
  assert.match(text, /- Never force-push to main\./);
});
