import { strict as assert } from "node:assert";
import test from "node:test";
import {
  ollamaResets,
  sessionResetAt,
  weeklyResetAt,
} from "./ollama-resets.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** 2026-09-11 21:46:41 local -- the moment the settings page was captured. */
const SCREENSHOT = new Date(2026, 8, 11, 21, 46, 41).getTime();
/** The same page said "Resets in 43 minutes", so the grid runs through here. */
const ANCHOR = new Date(2026, 8, 11, 22, 29, 41).getTime();

test("the grid is anchored at the page's 43 minutes", () => {
  assert.equal(sessionResetAt(SCREENSHOT), ANCHOR);
});

test("the session window rolls every 5 hours", () => {
  assert.equal(sessionResetAt(ANCHOR + 1), ANCHOR + 5 * HOUR);
  assert.equal(sessionResetAt(ANCHOR + 5 * HOUR + 1), ANCHOR + 10 * HOUR);
  // Landing exactly on a grid point means the next one is a window later.
  assert.equal(sessionResetAt(ANCHOR), ANCHOR + 5 * HOUR);
});

test("the session reset is always strictly in the future", () => {
  for (let i = 0; i < 40; i += 1) {
    const now = SCREENSHOT + i * 37 * MINUTE;
    assert.ok(sessionResetAt(now) > now, `not future at ${new Date(now)}`);
  }
});

test("the week resets Monday 04:30", () => {
  const friday = new Date(2026, 8, 11, 23, 20, 0).getTime();
  const next = new Date(weeklyResetAt(friday));
  assert.equal(next.getDay(), 1);
  assert.equal(next.getDate(), 14);
  assert.equal(next.getHours(), 4);
  assert.equal(next.getMinutes(), 30);
});

test("Monday before 04:30 is the same morning, after it is a week out", () => {
  const early = new Date(2026, 8, 14, 2, 0, 0).getTime();
  assert.equal(new Date(weeklyResetAt(early)).getDate(), 14);
  const late = new Date(2026, 8, 14, 9, 0, 0).getTime();
  assert.equal(new Date(weeklyResetAt(late)).getDate(), 21);
});

test("both instants are reported and both lie ahead", () => {
  const resets = ollamaResets(SCREENSHOT);
  assert.ok(resets.session > SCREENSHOT);
  assert.ok(resets.weekly > SCREENSHOT);
  assert.equal(new Date(resets.weekly).getDay(), 1);
});
