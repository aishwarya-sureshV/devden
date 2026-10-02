/**
 * Display transcript kept beside compaction.
 *
 * Compact rewrites the agent's own session log so the model sees a summary.
 * The conversation UI must still show every original turn — including after
 * a reload, which otherwise rehydrates from that rewritten log.
 *
 * On compact we snapshot the pre-compact messages (`before`) and the
 * rewritten log (`after`). Later UI reads return `before` plus any turns
 * that arrived after that rewrite.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { devdenHome, docGet, docSet } from "./db.js";

/** Pre-SQLite installs kept overlays in display-history/<sha256>.json. */
function legacyOverlayPath(sessionPath) {
  const hash = createHash("sha256").update(String(sessionPath)).digest("hex");
  return join(devdenHome(), "display-history", `${hash}.json`);
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.thinking === "string") return part.thinking;
      return "";
    })
    .join("\n");
}

export function messageKey(message) {
  return `${message?.role ?? ""}\0${textOf(message)}\0${message?.toolCallId ?? ""}`;
}

function samePrefix(left, right, n) {
  for (let i = 0; i < n; i += 1) {
    if (messageKey(left[i]) !== messageKey(right[i])) return false;
  }
  return true;
}

/** How many leading messages of `after` still prefix `current`. */
export function compactPrefixLength(after, current) {
  if (!Array.isArray(after) || !Array.isArray(current)) return 0;
  for (let n = Math.min(after.length, current.length); n > 0; n -= 1) {
    if (samePrefix(after, current, n)) return n;
  }
  return 0;
}

function userTexts(messages) {
  const texts = new Set();
  for (const message of messages) {
    if (message?.role === "user") texts.add(textOf(message));
  }
  return texts;
}

/** When the compact snapshot no longer prefixes the agent log, keep originals and append only new user turns. */
export function appendNewTurns(before, current) {
  if (!Array.isArray(before) || before.length === 0)
    return Array.isArray(current) ? current : [];
  if (!Array.isArray(current) || current.length === 0) return before;
  const seen = userTexts(before);
  const start = current.findIndex(
    (message) => message?.role === "user" && !seen.has(textOf(message)),
  );
  if (start < 0) return before;
  return [...before, ...current.slice(start)];
}

export function mergeDisplay(overlay, current) {
  const live = Array.isArray(current) ? current : [];
  if (!overlay || !Array.isArray(overlay.before) || overlay.before.length === 0)
    return live;
  const after = Array.isArray(overlay.after) ? overlay.after : [];
  const prefix = compactPrefixLength(after, live);
  if (prefix === 0) return appendNewTurns(overlay.before, live);
  return [...overlay.before, ...live.slice(prefix)];
}

function validOverlay(parsed) {
  return parsed && Array.isArray(parsed.before) ? parsed : null;
}

export async function loadDisplayOverlay(sessionPath) {
  if (!sessionPath) return null;
  const stored = validOverlay(docGet("display-history", String(sessionPath)));
  if (stored) return stored;
  try {
    const legacy = validOverlay(
      JSON.parse(await readFile(legacyOverlayPath(sessionPath), "utf8")),
    );
    if (legacy) docSet("display-history", String(sessionPath), legacy);
    return legacy;
  } catch {
    return null;
  }
}

export async function saveDisplayOverlay(sessionPath, { before, after }) {
  if (!sessionPath || !Array.isArray(before) || before.length === 0) return;
  docSet("display-history", String(sessionPath), {
    sessionPath,
    before,
    after: Array.isArray(after) ? after : [],
  });
}

export async function withDisplayHistory(sessionPath, messages) {
  const live = Array.isArray(messages) ? messages : [];
  if (!sessionPath) return live;
  const overlay = await loadDisplayOverlay(sessionPath);
  return mergeDisplay(overlay, live);
}
