/** Playful stand-in for "Claude is thinking". One line is dealt every
 *  THINKING_QUIP_MS from a large bank. The deck refills in a new order
 *  forever, and the line that just showed is never dealt next.
 *  Header form in the bank: `motion emoji`. */
import { THINKING_QUIP_LINES } from "./thinkingQuipLines.ts";

export const THINKING_QUIP_MS = 15_000;

type QuipRow = readonly [string, string, string];

function loadThinkingQuipDeck(raw: string): QuipRow[] {
  const deck: [string, string, string][] = [];
  let emoji = "";
  let motion = "";
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("# ")) {
      const header = line.slice(2);
      const space = header.indexOf(" ");
      motion = header.slice(0, space);
      emoji = header.slice(space + 1).trim();
      continue;
    }
    if (!emoji || !motion) throw new Error(`Quip before header: ${line}`);
    deck.push([emoji, motion, line]);
  }
  return deck;
}

const THINKING_QUIP_DECK = loadThinkingQuipDeck(THINKING_QUIP_LINES);

export const THINKING_QUIPS: readonly string[] = THINKING_QUIP_DECK.map(
  ([emoji, , text]) => `${emoji} ${text}`,
);

const THINKING_LINE_PARTS = new Map(
  THINKING_QUIP_DECK.map(([emoji, motion, text]) => [
    `${emoji} ${text}`,
    { emoji, text, motion },
  ]),
);

export function thinkingLineParts(line: string): {
  emoji: string;
  text: string;
  motion: string;
} {
  return (
    THINKING_LINE_PARTS.get(line) ?? { emoji: "", text: line, motion: "" }
  );
}

function shuffle(items: readonly string[], random: () => number): string[] {
  const next = items.slice();
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = next[i]!;
    next[i] = next[j]!;
    next[j] = swap;
  }
  return next;
}

export function createThinkingQuips(
  random: () => number = Math.random,
): () => string {
  let bag: string[] = [];
  let previous = "";

  const refill = () => {
    bag = shuffle(THINKING_QUIPS, random);
    if (bag.length > 1 && bag[bag.length - 1] === previous) {
      bag.unshift(bag.pop()!);
    }
  };

  return () => {
    if (bag.length === 0) refill();
    previous = bag.pop()!;
    return previous;
  };
}
