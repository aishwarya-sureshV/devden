import test from "node:test";
import assert from "node:assert/strict";
import { composeUsageStatus } from "./backendUsage.ts";
import type { ProviderUsage } from "./api.ts";

const live: ProviderUsage = { available: true, windows: [] };
const none: ProviderUsage = { available: false, windows: [] };

test("usage status: whatever is on screen owns the timestamp", () => {
  // Live per-session numbers: its own fetch time, and a stale error clears.
  assert.deepEqual(
    composeUsageStatus({ at: 1_000, error: null }, true, none, 5_000),
    { at: 1_000, error: null },
  );
  // Live fetch failed but the shared fetch has data: the widget shows the
  // shared numbers, so "updated" is the shared fetch's time, error stays.
  assert.deepEqual(
    composeUsageStatus({ at: 1_000, error: "boom" }, false, live, 5_000),
    { at: 5_000, error: "boom" },
  );
  // Live failed and no shared data either: keep the last-known time.
  assert.deepEqual(
    composeUsageStatus({ at: 1_000, error: "boom" }, false, none, 5_000),
    { at: 1_000, error: "boom" },
  );
  // Shared data while the per-session fetch never ran (fresh tab).
  assert.deepEqual(
    composeUsageStatus({ at: null, error: null }, false, live, 5_000),
    { at: 5_000, error: null },
  );
  // Nothing fetched yet: no time, no error — the widget is just blank.
  assert.deepEqual(
    composeUsageStatus({ at: null, error: null }, false, undefined, 0),
    { at: null, error: null },
  );
});