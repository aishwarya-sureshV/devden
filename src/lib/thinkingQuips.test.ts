import test from "node:test";
import assert from "node:assert/strict";

import {
  THINKING_QUIP_MS,
  THINKING_QUIPS,
  createThinkingQuips,
} from "./thinkingQuips.ts";

test("deals a new thinking line every 15 seconds", () => {
  assert.equal(THINKING_QUIP_MS, 15_000);
});

test("every thinking line has an emoji and stays unique", () => {
  assert.ok(THINKING_QUIPS.length >= 24);
  assert.equal(new Set(THINKING_QUIPS).size, THINKING_QUIPS.length);
  for (const line of THINKING_QUIPS) {
    assert.match(line, /\p{Extended_Pictographic}/u);
    assert.equal(line.endsWith("…"), false);
    assert.equal(line.endsWith("..."), false);
  }
});

test("a deck covers every line, then keeps dealing without repeating back to back", () => {
  const next = createThinkingQuips(mulberry32(7));
  const first = Array.from({ length: THINKING_QUIPS.length }, () => next());
  assert.deepEqual(new Set(first), new Set(THINKING_QUIPS));

  let previous = first[first.length - 1]!;
  for (let i = 0; i < THINKING_QUIPS.length * 3; i++) {
    const line = next();
    assert.notEqual(line, previous);
    assert.ok(THINKING_QUIPS.includes(line as (typeof THINKING_QUIPS)[number]));
    previous = line;
  }
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
