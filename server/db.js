/**
 * DevDen's own durable state: one SQLite file, `<devdenHome>/devden.db`.
 *
 * Before this, every module kept its own JSON file (onboarding.json,
 * routes/<hash>.json, display-history/<hash>.json, the inflight record),
 * each with its own tmp-file/rename dance and none of them atomic with each
 * other. node:sqlite is built in (Node >= 22.13, no native module to rebuild
 * for Electron) and synchronous, so it drops into the same call sites.
 *
 * What does NOT live here: agent transcripts (owned by each backend's CLI),
 * the markdown transcript exports (meant to be opened as files) and the
 * fault log (meant to be tailed).
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function devdenHome() {
  if (process.env.DEVDEN_HOME) return process.env.DEVDEN_HOME;
  const next = join(homedir(), ".devden");
  const previous = join(homedir(), ".pi-web");
  if (existsSync(next) || !existsSync(previous)) return next;
  return previous;
}

/**
 * Append-only: a shipped migration is never edited, the next one is added.
 * `PRAGMA user_version` records how many have run.
 */
const MIGRATIONS = [
  `CREATE TABLE docs (
     ns TEXT NOT NULL,
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (ns, key)
   );
   CREATE TABLE blobs (
     hash TEXT PRIMARY KEY,
     data BLOB NOT NULL
   );
   CREATE TABLE turns (
     id INTEGER PRIMARY KEY,
     session_key TEXT NOT NULL,
     session_path TEXT,
     repo TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     ended_at INTEGER NOT NULL,
     label TEXT NOT NULL DEFAULT '',
     concurrent INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX turns_by_key ON turns (session_key);
   CREATE INDEX turns_by_path ON turns (session_path);
   CREATE INDEX turns_by_end ON turns (ended_at);
   CREATE TABLE turn_files (
     turn_id INTEGER NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
     path TEXT NOT NULL,
     before_hash TEXT,
     after_hash TEXT,
     source TEXT NOT NULL,
     shared INTEGER NOT NULL DEFAULT 0,
     skipped INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (turn_id, path)
   );
   CREATE INDEX turn_files_before ON turn_files (before_hash);
   CREATE INDEX turn_files_after ON turn_files (after_hash);`,
];

/** One connection per file; tests point DEVDEN_HOME (or a dir) elsewhere. */
const open = new Map();

export function db(home = devdenHome()) {
  const file = join(home, "devden.db");
  const cached = open.get(file);
  if (cached) return cached;
  mkdirSync(home, { recursive: true });
  const conn = new DatabaseSync(file);
  // auto_vacuum only takes effect on an empty file, so it goes first;
  // without it, pruned snapshots would never give the space back.
  conn.exec("PRAGMA auto_vacuum = INCREMENTAL");
  conn.exec("PRAGMA journal_mode = WAL");
  conn.exec("PRAGMA busy_timeout = 5000");
  conn.exec("PRAGMA foreign_keys = ON");
  const version = conn.prepare("PRAGMA user_version").get().user_version;
  for (let index = version; index < MIGRATIONS.length; index += 1) {
    conn.exec("BEGIN");
    try {
      conn.exec(MIGRATIONS[index]);
      conn.exec(`PRAGMA user_version = ${index + 1}`);
      conn.exec("COMMIT");
    } catch (error) {
      conn.exec("ROLLBACK");
      throw error;
    }
  }
  open.set(file, conn);
  return conn;
}

/** Run `fn` in one transaction; a throw rolls everything back. */
export function transaction(conn, fn) {
  conn.exec("BEGIN");
  try {
    const result = fn();
    conn.exec("COMMIT");
    return result;
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
}

/** Small JSON documents keyed by (namespace, key). */
export function docGet(ns, key, home) {
  const row = db(home)
    .prepare("SELECT value FROM docs WHERE ns = ? AND key = ?")
    .get(ns, key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

export function docSet(ns, key, value, home) {
  db(home)
    .prepare(
      `INSERT INTO docs (ns, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .run(ns, key, JSON.stringify(value), Date.now());
}

export function docDelete(ns, key, home) {
  db(home).prepare("DELETE FROM docs WHERE ns = ? AND key = ?").run(ns, key);
}
