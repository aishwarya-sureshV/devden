// A backend switch's handoff rides at the end of the first message the new
// backend gets, so that backend's own session log keeps it (restart, resume
// and compaction all carry it). The timeline shows the user's words plus a
// one-line expandable notice instead. server/index.js strips the same block.
const BLOCK = /\n*<handoff from="([^"]*)" to="([^"]*)">\n([\s\S]*)\n<\/handoff>\s*$/;

export const HANDOFF_NOTICE = /^Handed off from /;

export function wrapHandoff(message: string, record: string, from: string, to: string): string {
  return `${message}\n\n<handoff from="${from}" to="${to}">\n${record}\n</handoff>`;
}

export function splitHandoff(text: string): {
  text: string;
  handoff?: { from: string; to: string; record: string };
} {
  const match = BLOCK.exec(text);
  if (!match) return { text };
  return {
    text: text.slice(0, match.index),
    handoff: { from: match[1], to: match[2], record: match[3] },
  };
}

export function handoffNotice({ from, to, record }: { from: string; to: string; record: string }): string {
  const turns = record.match(/^### Turn /gm)?.length ?? 0;
  return `Handed off from ${from} to ${to} · ${turns} turn${turns === 1 ? "" : "s"}`;
}
