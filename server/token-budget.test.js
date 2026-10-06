import { test } from "node:test";
import assert from "node:assert/strict";
import { tail, DEFAULT_LINES } from "./pi-extensions/background-tasks.ts";

test("tool output keeps the tail, caps chars, and says how to get more", () => {
  assert.equal(tail("a\nb", DEFAULT_LINES), "a\nb", "short output untouched");
  const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const out = tail(log, DEFAULT_LINES).split("\n");
  assert.match(out[0], /^\[400 earlier lines omitted/);
  assert.equal(out.at(-1), "line 499");
  assert.equal(out.length, DEFAULT_LINES + 1);
  const minified = tail("x".repeat(1_000_000), DEFAULT_LINES);
  assert.ok(minified.length < 400);
  assert.match(minified, /\[999700 chars cut\]$/);
});
