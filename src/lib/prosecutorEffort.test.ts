import test from "node:test";
import assert from "node:assert/strict";

import type { ProsecutorState } from "./api.ts";
import { belowFloor, effortFloor, liftedEffort, nudgeChoices, showLowerNudge } from "./prosecutorEffort.ts";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const at = (patch: Partial<ProsecutorState>): ProsecutorState => ({ armed: true, round: 0, open: true, caseId: 1, verdict: null, ...patch });

test("round-1 effort floor: levels below High are locked only in prosecutor mode", () => {
  const floor = effortFloor("prosecutor", at({}));
  assert.equal(floor, "high");
  assert.deepEqual(LEVELS.filter((level) => belowFloor(level, floor)), ["off", "minimal", "low", "medium"]);
  for (const mode of ["standard", "plan", "routed", "manual", "auto-edit"])
    assert.equal(effortFloor(mode, at({})), null, mode);
  assert.equal(belowFloor("low", null), false);
});

test("round-1 floor holds until round 1's verdict and comes back for each new task", () => {
  assert.equal(effortFloor("prosecutor", null), "high", "no case yet: the next message is round 1");
  assert.equal(effortFloor("prosecutor", at({ open: false })), "high");
  assert.equal(effortFloor("prosecutor", at({ round: 1 })), "high", "round 1 still pending");
  assert.equal(effortFloor("prosecutor", at({ round: 1, verdict: "guilty" })), null);
  // Acquitted closes the task; the next message is a new task at High again.
  assert.equal(effortFloor("prosecutor", at({ open: false, verdict: "acquitted" })), "high");
  // The server's noteTask resets the verdict for the new case.
  assert.equal(effortFloor("prosecutor", at({ caseId: 2, verdict: null })), "high");
});

test("lifting picks the lowest offered level at or above the floor", () => {
  assert.equal(liftedEffort(LEVELS, "low", "high"), "high");
  assert.equal(liftedEffort(["low", "xhigh", "max"], "low", "high"), "xhigh");
  assert.equal(liftedEffort(LEVELS, "xhigh", "high"), null, "already above");
  assert.equal(liftedEffort(LEVELS, "low", null), null, "no floor");
  assert.equal(liftedEffort(["off", "low"], "low", "high"), null, "model has nothing high");
});

test("lower-effort nudge: once per task after the first guilty verdict, never in normal mode", () => {
  const guilty = at({ round: 1, verdict: "guilty" });
  assert.equal(showLowerNudge("prosecutor", guilty, null, "high"), true);
  assert.equal(showLowerNudge("standard", guilty, null, "high"), false);
  assert.equal(showLowerNudge("prosecutor", at({ round: 1 }), null, "high"), false, "before the verdict");
  assert.equal(showLowerNudge("prosecutor", at({ round: 1, verdict: "acquitted", open: false }), null, "high"), false);
  assert.equal(showLowerNudge("prosecutor", guilty, null, "medium"), true, "shown regardless of the current level");
  // Answered (applied or dismissed) for case 1: later rounds of it stay quiet...
  assert.equal(showLowerNudge("prosecutor", at({ round: 3, verdict: "guilty" }), 1, "high"), false);
  // ...and the next task asks again.
  assert.equal(showLowerNudge("prosecutor", at({ caseId: 2, round: 1, verdict: "guilty" }), 1, "high"), true);
});

test("dismissing the nudge is a no-op: effort and the floor are untouched", () => {
  const guilty = at({ round: 1, verdict: "guilty" });
  const effort = "high";
  let handled: number | null = null;
  const dismiss = () => { handled = guilty.caseId ?? null; }; // what the nudge's Not now / x do
  dismiss();
  assert.equal(effort, "high");
  assert.equal(showLowerNudge("prosecutor", guilty, handled, effort), false);
  assert.equal(effortFloor("prosecutor", guilty), null, "the picker stays free to lower it later");
});

test("nudge choices are the levels below the current one, medium preselected", () => {
  assert.deepEqual(nudgeChoices(LEVELS, "high"), { choices: ["off", "minimal", "low", "medium"], preset: "medium" });
  assert.deepEqual(nudgeChoices(["low", "high"], "high"), { choices: ["low"], preset: "low" });
});
