import test from "node:test";
import assert from "node:assert/strict";

import { shouldShowThinkingRow } from "./thinkingRow.ts";

test("shows the thinking row as soon as the turn is working", () => {
  assert.equal(shouldShowThinkingRow({ streaming: true }), true);
});

test("hides the thinking row while assistant text is still growing", () => {
  assert.equal(
    shouldShowThinkingRow({ streaming: true, showingLiveText: true }),
    false,
  );
});

test("shows the thinking row once live text has stalled", () => {
  assert.equal(
    shouldShowThinkingRow({
      streaming: true,
      showingLiveText: true,
      liveTextStalled: true,
    }),
    true,
  );
});

test("hides the thinking row when the turn is idle", () => {
  assert.equal(
    shouldShowThinkingRow({
      streaming: false,
      showingLiveText: true,
      liveTextStalled: true,
    }),
    false,
  );
});

test("defers to the shell / subagent / compacting indicators", () => {
  assert.equal(
    shouldShowThinkingRow({ streaming: true, runningShell: true }),
    false,
  );
  assert.equal(
    shouldShowThinkingRow({ streaming: true, subagentRunning: true }),
    false,
  );
  assert.equal(
    shouldShowThinkingRow({ streaming: true, compacting: true }),
    false,
  );
});
