import { strict as assert } from "node:assert";
import test from "node:test";
import { formatCountdown } from "./time.ts";

const NOW = Date.parse("2026-09-11T21:46:41+05:30");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

test("a countdown reads at the granularity of its distance", () => {
  assert.equal(formatCountdown(NOW + 35 * MINUTE, NOW), "35m");
  assert.equal(formatCountdown(NOW + (HOUR + 35 * MINUTE), NOW), "1h 35m");
  assert.equal(formatCountdown(NOW + (6 * DAY + 3 * HOUR), NOW), "6d 3h");
});

test("the boundaries land where they should", () => {
  assert.equal(formatCountdown(NOW, NOW), "now");
  assert.equal(formatCountdown(NOW + 20_000, NOW), "now");
  assert.equal(formatCountdown(NOW + 59 * MINUTE, NOW), "59m");
  assert.equal(formatCountdown(NOW + 60 * MINUTE, NOW), "1h 0m");
  assert.equal(formatCountdown(NOW + 23 * HOUR, NOW), "23h 0m");
  assert.equal(formatCountdown(NOW + 24 * HOUR, NOW), "1d 0h");
});

test("a past (or unusable) instant never renders a negative countdown", () => {
  assert.equal(formatCountdown(NOW - 5 * MINUTE, NOW), "now");
  assert.equal(formatCountdown(NOW - 3 * DAY, NOW), "now");
  assert.equal(formatCountdown(Number.NaN, NOW), "now");
});
