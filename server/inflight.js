/**
 * Crash-durable record of turns that were running when the server stopped.
 *
 * Every pool, lease and goal in index.js lives in memory, so a restart --
 * a deploy, a crash, the machine being switched off -- silently drops
 * whatever the agent was in the middle of. Nothing on disk said a turn had
 * ever started, so the conversation just sat there until the user asked
 * again. This file is that missing record: one entry per running turn,
 * written when it starts and removed when it settles, so anything still
 * present at boot is by definition an interrupted turn.
 *
 * Entries are keyed by session file, not by session key: a browser reload
 * mints a new conversation key, so the session file is the only identity
 * that survives both restarts. index.js resumes from these records and
 * adoptLiveAgent() rebinds the running agent to whatever key the page comes
 * back with.
 */
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { docGet, docSet } from "./db.js";

/** Where pre-SQLite installs kept the record; adopted once at boot. */
const LEGACY_PATH = join(homedir(), ".pi", "agent", "devden-inflight.json");
// A turn interrupted days ago is stale context, not work in progress; the
// user has moved on and silently spending tokens on it would be worse than
// dropping it.
const MAX_RESUME_AGE_MS = 12 * 60 * 60_000;
// A resume that dies again is a crash loop (a poisoned prompt, a cwd that
// wedges the agent). Two attempts, then the record is dropped.
const MAX_RESUME_ATTEMPTS = 2;

/** sessionKey -> record. The session key is how live events address a turn. */
const running = new Map();

function persist() {
  try {
    const entries = [...running.values()].filter((entry) => entry.sessionPath);
    docSet("inflight", "running", entries);
  } catch {
    // Losing the record only costs the auto-resume; never fail a live turn
    // because this file could not be written.
  }
}

/** Called when a turn begins. Replaces any earlier record for that key. */
export function noteTurnStarted(record) {
  if (!record?.sessionKey) return;
  running.set(record.sessionKey, {
    ...record,
    startedAt: Date.now(),
    resumeAttempts: record.resumeAttempts ?? 0,
    queued: [],
  });
  persist();
}

/**
 * Fill in details discovered after the turn began -- most importantly the
 * session file, which a brand-new conversation only has once its agent has
 * started, and the queue, which is the rest of the work the user lined up.
 */
export function noteTurnContext(sessionKey, patch) {
  const entry = running.get(sessionKey);
  if (!entry) return;
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || entry[key] === value) continue;
    if (key === "queued" && sameQueue(entry.queued, value)) continue;
    entry[key] = value;
    changed = true;
  }
  if (changed) persist();
}

function sameQueue(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((entry, index) => entry?.id === right[index]?.id);
}

/** Called when a turn ends, however it ends. */
export function noteTurnSettled(sessionKey) {
  if (!running.delete(sessionKey)) return;
  persist();
}

/**
 * Move a record onto the key that adopted its agent. A page reload mints a
 * new conversation key, so without this the abandoned key's record never
 * settles -- and every later boot resumes a turn that finished long ago,
 * stealing the turn slot from whatever the user types next.
 */
export function rekeySession(oldKey, newKey) {
  const entry = running.get(oldKey);
  if (!entry || oldKey === newKey) return;
  running.delete(oldKey);
  running.set(newKey, { ...entry, sessionKey: newKey });
  persist();
}

export function forgetSession(sessionKey) {
  noteTurnSettled(sessionKey);
}

/** Session files that currently have a live turn. The sidebar uses this to
 *  blink every running row, not only the ones already open as tabs. */
export function runningSessionPaths() {
  const paths = new Set();
  for (const entry of running.values()) {
    if (entry.sessionPath) paths.add(entry.sessionPath);
  }
  return paths;
}

/**
 * Turns that were running when this process's predecessor stopped. Reading
 * clears the file, so the records only survive if the resume itself
 * re-registers them.
 */
export function takeInterruptedTurns() {
  let entries = [];
  try {
    const stored = docGet("inflight", "running");
    if (Array.isArray(stored)) entries = stored;
  } catch {
    // An unreadable database only costs the auto-resume.
  }
  try {
    const legacy = JSON.parse(readFileSync(LEGACY_PATH, "utf8"));
    if (Array.isArray(legacy)) entries = [...entries, ...legacy];
    rmSync(LEGACY_PATH, { force: true });
  } catch {
    // No legacy record: the usual case.
  }
  persist(); // the live map is empty at boot, so this truncates the record
  const now = Date.now();
  const live = entries.filter(
    (entry) =>
      entry?.sessionPath &&
      entry.cwd &&
      now - Number(entry.startedAt ?? 0) < MAX_RESUME_AGE_MS &&
      Number(entry.resumeAttempts ?? 0) < MAX_RESUME_ATTEMPTS,
  );
  // A browser reload mints a new conversation key, so one session that was
  // prompted a few times can leave several records behind. Resuming each of
  // them would start that many agents on one session file, all fighting over
  // it. Only the newest turn is still worth finishing.
  const newestPerSession = new Map();
  for (const entry of live) {
    const seen = newestPerSession.get(entry.sessionPath);
    if (!seen || Number(entry.startedAt ?? 0) > Number(seen.startedAt ?? 0))
      newestPerSession.set(entry.sessionPath, entry);
  }
  return [...newestPerSession.values()];
}
