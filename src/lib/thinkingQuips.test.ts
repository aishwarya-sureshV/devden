import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import {
  THINKING_QUIP_MS,
  THINKING_QUIPS,
  createThinkingQuips,
  thinkingLineParts,
} from "./thinkingQuips.ts";

test("deals a new thinking line every 15 seconds", () => {
  assert.equal(THINKING_QUIP_MS, 15_000);
});

test("the bank has at least 2000 distinct emoji lines", () => {
  assert.ok(THINKING_QUIPS.length >= 2000);
  assert.equal(new Set(THINKING_QUIPS).size, THINKING_QUIPS.length);
  const perEmoji = new Map<string, number>();
  for (const line of THINKING_QUIPS) {
    assert.match(line, /\p{Extended_Pictographic}/u);
    assert.equal(line.endsWith("…"), false);
    assert.equal(line.endsWith("..."), false);
    const { emoji, text } = thinkingLineParts(line);
    assert.ok(text.length > 0);
    assert.ok(text.length <= 56, text);
    perEmoji.set(emoji, (perEmoji.get(emoji) ?? 0) + 1);
  }
  assert.ok(perEmoji.size >= 40);
  for (const [emoji, count] of perEmoji) {
    assert.ok(count >= 40, `${emoji} ${count}`);
  }
});

test("a deck covers every line, then keeps dealing without repeating back to back", () => {
  const next = createThinkingQuips(mulberry32(7));
  const first = Array.from({ length: THINKING_QUIPS.length }, () => next());
  assert.deepEqual(new Set(first), new Set(THINKING_QUIPS));

  const known = new Set(THINKING_QUIPS);
  let previous = first[first.length - 1]!;
  for (let i = 0; i < THINKING_QUIPS.length * 3; i++) {
    const line = next();
    assert.notEqual(line, previous);
    assert.ok(known.has(line));
    previous = line;
  }
});

test("each emoji has its own animation", () => {
  const css = readFileSync(
    new URL("../styles/thinkingEmoji.css", import.meta.url),
    "utf8",
  );
  const motionForEmoji = new Map<string, string>();
  for (const line of THINKING_QUIPS) {
    const parts = thinkingLineParts(line);
    assert.equal(`${parts.emoji} ${parts.text}`, line);
    assert.match(parts.motion, /^[a-z]+$/);
    const prior = motionForEmoji.get(parts.emoji);
    if (prior) assert.equal(prior, parts.motion);
    else motionForEmoji.set(parts.emoji, parts.motion);
    assert.ok(css.includes(`.thinking__emoji--${parts.motion} {`));
    assert.ok(css.includes(`@keyframes emoji-${parts.motion} {`));
  }
  assert.equal(new Set(motionForEmoji.values()).size, motionForEmoji.size);
  assert.equal(css.includes(".thinking.thinking--"), false);
  const rowCss = readFileSync(
    new URL("../styles/conversation/tool-cards.css", import.meta.url),
    "utf8",
  );
  assert.match(rowCss, /\.thinking__line,\s*\.thinking__dots\s*\{[^}]*--g-highlight/);
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
