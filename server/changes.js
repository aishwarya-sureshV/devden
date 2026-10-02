/**
 * What each turn and each session changed, kept in SQLite (db.js).
 *
 * Git can say what the tree looks like, not who changed it. With two
 * sessions in one checkout, "this session's changes" read back from git
 * includes the other session's hunks. So ownership is recorded while it is
 * still known -- when a turn ends -- instead of reconstructed later:
 *
 *   turn start  pre-turn snapshot (snapshots.js) + every path the turn's
 *               edit tools name, with the file's content at that moment
 *   turn end    diff the tree against the snapshot; keep each changed
 *               file's before/after content, deduped by hash in `blobs`
 *
 * Attribution at turn end:
 *   - a path this turn's edit tools touched        -> source "tool"
 *   - any other change, no other session active    -> source "command" (bash)
 *   - another session's tools touched it too       -> shared (diff may mix)
 *   - another session was active and claims it     -> left to that session
 *
 * Views:
 *   turn     that turn's before -> after per file
 *   session  first before -> last after per file; `exact` is false when the
 *            file changed between two of this session's turns (someone else
 *            edited it in between), `drift` when it changed since.
 *
 * Unlike a per-edit photo store this also catches files changed by shell
 * commands, and it survives snapshot-ref pruning because the contents are
 * copied out of git when the turn ends.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { db, transaction } from "./db.js";
import { git, withScratchIndex } from "./snapshots.js";

const execFileAsync = promisify(execFile);

/** Bigger files are listed but their contents are not kept. */
const MAX_FILE_BYTES = 1024 * 1024;
const KEEP_DAYS = 30;
/** Ended turns remembered in memory for the "was anyone else active" check. */
const RECENT_TURNS = 200;
const PATH_KEYS = [
  "path",
  "file_path",
  "target_file",
  "file",
  "targetFile",
  "filename",
  "notebook_path",
];

/** sessionKey -> running turn. */
const active = new Map();
/** Ended turns, newest last, for overlap checks. */
const recent = [];
/** sessionKey -> what the server last learned about the session. */
const known = new Map();
/** sessionKey -> the recording in progress, so a read can wait for it. */
const pending = new Map();

function hashOf(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function remember(sessionKey, patch) {
  const entry = known.get(sessionKey) ?? {};
  for (const [key, value] of Object.entries(patch))
    if (value) entry[key] = value;
  known.set(sessionKey, entry);
  return entry;
}

/** The session file and cwd arrive on `state` events, after the turn began. */
export function noteSessionContext(sessionKey, { cwd, sessionPath } = {}) {
  const learned = sessionPath && known.get(sessionKey)?.sessionPath !== sessionPath;
  remember(sessionKey, { cwd, sessionPath });
  const turn = active.get(sessionKey);
  if (turn && sessionPath) turn.sessionPath = sessionPath;
  // A brand-new conversation's first turns can end before its session file
  // exists; claim them now so the session view still finds them. `state`
  // events are frequent, so only when the path is new.
  if (learned)
    db()
      .prepare(
        "UPDATE turns SET session_path = ? WHERE session_key = ? AND session_path IS NULL",
      )
      .run(sessionPath, sessionKey);
}

/**
 * Start recording a turn. `snapshot` is the pending takeSnapshot() for the
 * tree before the prompt; when omitted one is taken here (a queued prompt
 * that started on its own). A turn already running for the key wins.
 */
export function beginTurn({ sessionKey, cwd, label = "", snapshot, takeSnapshot }) {
  if (!sessionKey || active.has(sessionKey)) return;
  const context = remember(sessionKey, { cwd });
  if (!context.cwd) return;
  const snap =
    snapshot ??
    (takeSnapshot
      ? takeSnapshot(context.cwd, label).catch(() => ({ ok: false }))
      : Promise.resolve({ ok: false }));
  active.set(sessionKey, {
    sessionKey,
    sessionPath: context.sessionPath ?? null,
    cwd: context.cwd,
    label: String(label).replace(/\s+/g, " ").slice(0, 200),
    startedAt: Date.now(),
    endedAt: 0,
    snapshot: snap,
    repo: git(context.cwd, ["rev-parse", "--show-toplevel"]).then((result) =>
      result.ok ? result.out : null,
    ),
    /** absolute path -> { at, content: Buffer | null } at first edit */
    touched: new Map(),
  });
}

function isEditTool(name) {
  const key = String(name ?? "").toLowerCase();
  if (/read|view|search|grep|glob|list|fetch/.test(key)) return false;
  return /edit|write|patch|replace|create|insert|notebook/.test(key);
}

export function toolPaths(args) {
  if (!args || typeof args !== "object") return [];
  const paths = [];
  for (const key of PATH_KEYS)
    if (typeof args[key] === "string" && args[key]) paths.push(args[key]);
  for (const list of [args.changes, args.edits])
    if (Array.isArray(list))
      for (const item of list)
        for (const key of PATH_KEYS)
          if (typeof item?.[key] === "string" && item[key]) paths.push(item[key]);
  return paths;
}

function readCapped(path) {
  try {
    const content = readFileSync(path);
    return content.length > MAX_FILE_BYTES ? undefined : content;
  } catch (error) {
    // A file that does not exist yet is a real "before": the turn creates it.
    return error?.code === "ENOENT" ? null : undefined;
  }
}

/**
 * An edit tool is about to run. Remember the path, and the file's content
 * now: the pre-turn snapshot is taken off the first-token path, so the first
 * edit can land before `git add -A` reads that file.
 */
export function noteToolCall(sessionKey, toolName, args) {
  if (!isEditTool(toolName)) return;
  const turn = active.get(sessionKey);
  if (!turn) return;
  for (const raw of toolPaths(args)) {
    const path = isAbsolute(raw) ? raw : resolve(turn.cwd, raw);
    if (turn.touched.has(path)) continue;
    turn.touched.set(path, { at: Date.now(), content: readCapped(path) });
  }
}

/** A reload re-keys the conversation; its running turn moves with it. */
export function rekeyChanges(oldKey, newKey) {
  if (oldKey === newKey) return;
  const turn = active.get(oldKey);
  if (turn) {
    active.delete(oldKey);
    active.set(newKey, { ...turn, sessionKey: newKey });
  }
  const context = known.get(oldKey);
  if (context) known.set(newKey, { ...context, ...known.get(newKey) });
  db()
    .prepare("UPDATE turns SET session_key = ? WHERE session_key = ?")
    .run(newKey, oldKey);
}

/** The turn is over, however it ended. Recording runs in the background. */
export function endTurn(sessionKey) {
  const turn = active.get(sessionKey);
  if (!turn) return Promise.resolve();
  active.delete(sessionKey);
  turn.endedAt = Date.now();
  recent.push(turn);
  if (recent.length > RECENT_TURNS) recent.splice(0, recent.length - RECENT_TURNS);
  const previous = pending.get(sessionKey) ?? Promise.resolve();
  const run = previous
    .then(() => recordTurn(turn))
    .catch(() => {
      // Losing one turn's record must never break the conversation.
    });
  pending.set(sessionKey, run);
  void run.then(() => {
    if (pending.get(sessionKey) === run) pending.delete(sessionKey);
  });
  return run;
}

async function blobAt(repo, commit, path) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repo, "cat-file", "blob", `${commit}:${path}`],
      { encoding: "buffer", maxBuffer: MAX_FILE_BYTES * 2, timeout: 30_000 },
    );
    return stdout;
  } catch {
    return undefined;
  }
}

/** Symlinks resolved (macOS /var -> /private/var), even for a new file. */
function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

/** Repo-relative, forward slashes; null when outside the repo. */
function inRepo(repo, absolute) {
  const rel = relative(canonical(repo), canonical(absolute));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** Other sessions' turns in the same repo whose time overlapped this one. */
async function overlapping(turn, repo) {
  const others = [];
  for (const other of [...active.values(), ...recent]) {
    if (other === turn || other.sessionKey === turn.sessionKey) continue;
    const end = other.endedAt || Number.POSITIVE_INFINITY;
    if (end < turn.startedAt || other.startedAt > turn.endedAt) continue;
    if ((await other.repo) !== repo) continue;
    others.push(other);
  }
  return others;
}

async function recordTurn(turn) {
  const [snap, repo] = await Promise.all([turn.snapshot, turn.repo]);
  if (!repo) return;
  const mine = new Map();
  for (const [absolute, capture] of turn.touched) {
    const rel = inRepo(repo, absolute);
    if (rel) mine.set(rel, capture);
  }
  const others = await overlapping(turn, repo);
  const theirs = new Set();
  for (const other of others)
    for (const absolute of other.touched.keys()) {
      const rel = inRepo(repo, absolute);
      if (rel) theirs.add(rel);
    }

  // Changed paths: what git sees against the snapshot, plus anything the
  // tools named (an ignored file like .env never shows up in git's list).
  const changed = new Set(mine.keys());
  if (snap?.ok) {
    const listed = await withScratchIndex(repo, async (env) => {
      const staged = await git(repo, ["add", "-A"], env);
      if (!staged.ok) return null;
      return git(
        repo,
        ["diff", "--cached", "--name-only", "--no-renames", "-z", snap.commit],
        env,
      );
    });
    if (listed?.ok)
      for (const path of listed.out.split("\0")) if (path) changed.add(path);
  }

  const files = [];
  for (const path of changed) {
    const toolTouched = mine.has(path);
    let source = "tool";
    let shared = theirs.has(path);
    if (!toolTouched) {
      if (others.length === 0) source = "command";
      else if (shared) continue; // the other session's edit, not ours
      else {
        source = "command";
        shared = true; // a command, but whose cannot be told
      }
    }
    // Before: the snapshot, unless the tool saw the file earlier than the
    // snapshot finished reading the tree.
    const capture = mine.get(path);
    let before;
    if (capture && (!snap?.ok || capture.at < snap.at)) before = capture.content;
    else if (snap?.ok) before = (await blobAt(repo, snap.commit, path)) ?? null;
    else before = capture?.content;
    const after = readCapped(join(repo, path));
    if (before !== undefined && after !== undefined) {
      if (before === null && after === null) continue;
      if (before && after && before.equals(after)) continue;
    }
    const skipped = before === undefined || after === undefined;
    files.push({
      path,
      source,
      shared,
      skipped,
      before: before ?? null,
      after: after ?? null,
    });
  }

  const conn = db();
  transaction(conn, () => {
    const { lastInsertRowid } = conn
      .prepare(
        `INSERT INTO turns (session_key, session_path, repo, started_at,
           ended_at, label, concurrent) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.sessionKey,
        turn.sessionPath ?? known.get(turn.sessionKey)?.sessionPath ?? null,
        repo,
        turn.startedAt,
        turn.endedAt,
        turn.label,
        others.length > 0 ? 1 : 0,
      );
    const putBlob = conn.prepare(
      "INSERT OR IGNORE INTO blobs (hash, data) VALUES (?, ?)",
    );
    const putFile = conn.prepare(
      `INSERT INTO turn_files (turn_id, path, before_hash, after_hash, source,
         shared, skipped) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const file of files) {
      let beforeHash = null;
      let afterHash = null;
      if (!file.skipped) {
        if (file.before) {
          beforeHash = hashOf(file.before);
          putBlob.run(beforeHash, file.before);
        }
        if (file.after) {
          afterHash = hashOf(file.after);
          putBlob.run(afterHash, file.after);
        }
      }
      putFile.run(
        lastInsertRowid,
        file.path,
        beforeHash,
        afterHash,
        file.source,
        file.shared ? 1 : 0,
        file.skipped ? 1 : 0,
      );
    }
  });
}

function sessionWhere(sessionKey, sessionPath) {
  if (sessionPath)
    return {
      sql: "(t.session_path = ? OR (t.session_path IS NULL AND t.session_key = ?))",
      args: [sessionPath, sessionKey ?? ""],
    };
  return { sql: "t.session_key = ?", args: [sessionKey ?? ""] };
}

function blob(conn, hash) {
  if (!hash) return null;
  return conn.prepare("SELECT data FROM blobs WHERE hash = ?").get(hash)?.data ?? null;
}

/** Unified diffs for [{path, before, after}], one git process for all. */
async function unifiedDiffs(entries) {
  if (entries.length === 0) return new Map();
  const root = await mkdtemp(join(tmpdir(), "devden-changes-"));
  try {
    for (const entry of entries)
      for (const [side, content] of [
        ["a", entry.before],
        ["b", entry.after],
      ]) {
        if (!content) continue;
        const file = join(root, side, entry.path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content);
      }
    await mkdir(join(root, "a"), { recursive: true });
    await mkdir(join(root, "b"), { recursive: true });
    let out = "";
    try {
      const result = await execFileAsync(
        "git",
        [
          "-C",
          root,
          "diff",
          "--no-index",
          "--no-renames",
          "--no-prefix",
          "-U15",
          "a",
          "b",
        ],
        { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
      );
      out = String(result.stdout ?? "");
    } catch (error) {
      // `git diff` exits 1 when there are differences.
      if (error?.code !== 1) throw error;
      out = String(error.stdout ?? "");
    }
    // With --no-prefix the temp dirs "a"/"b" are the prefixes; a new file
    // has only a "+++ b/<path>" side and a deleted one only "--- a/<path>".
    const byPath = new Map();
    for (const chunk of out.split(/^(?=diff --git )/m)) {
      const plus = chunk.match(/^\+\+\+ b\/(.+)$/m)?.[1];
      const minus = chunk.match(/^--- a\/(.+)$/m)?.[1];
      const path = plus ?? minus;
      if (!path) continue;
      byPath.set(
        path,
        chunk.replace(/^diff --git .*$/m, `diff --git a/${path} b/${path}`),
      );
    }
    return byPath;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function countLines(diff) {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * The turn view (latest turn that changed files, or `turnId`) or the
 * session view. Waits for a recording still in flight so a client that asks
 * right as the turn settles sees it.
 */
export async function readChanges({ sessionKey, sessionPath, scope, turnId }) {
  await pending.get(sessionKey);
  const conn = db();
  const where = sessionWhere(sessionKey, sessionPath);
  const turns = conn
    .prepare(
      `SELECT t.id, t.started_at AS startedAt, t.ended_at AS endedAt, t.label,
         t.repo, t.concurrent, COUNT(f.path) AS files
       FROM turns t LEFT JOIN turn_files f ON f.turn_id = t.id
       WHERE ${where.sql} GROUP BY t.id ORDER BY t.started_at DESC LIMIT 200`,
    )
    .all(...where.args);
  const running = active.has(sessionKey);

  let rows;
  let turn = null;
  if (scope === "turn") {
    turn =
      turns.find((entry) => entry.id === Number(turnId)) ??
      turns.find((entry) => entry.files > 0) ??
      null;
    rows = turn
      ? conn
          .prepare("SELECT * FROM turn_files WHERE turn_id = ? ORDER BY path")
          .all(turn.id)
      : [];
  } else {
    rows = conn
      .prepare(
        `SELECT f.*, t.repo FROM turn_files f JOIN turns t ON t.id = f.turn_id
         WHERE ${where.sql} ORDER BY t.started_at, t.id`,
      )
      .all(...where.args);
  }

  // Collapse to one entry per file: the turn view has one row per path
  // already; the session view spans first before -> last after.
  const byPath = new Map();
  for (const row of rows) {
    const seen = byPath.get(row.path);
    if (!seen) {
      byPath.set(row.path, {
        path: row.path,
        repo: row.repo ?? turn?.repo,
        beforeHash: row.before_hash,
        afterHash: row.after_hash,
        source: row.source,
        shared: Boolean(row.shared),
        skipped: Boolean(row.skipped),
        exact: !row.shared && !row.skipped,
        turns: 1,
      });
      continue;
    }
    // Someone else changed the file between this session's two turns.
    if (row.before_hash !== seen.afterHash) seen.exact = false;
    if (row.shared) seen.shared = true;
    if (row.skipped) seen.skipped = true;
    if (row.source === "tool") seen.source = "tool";
    seen.afterHash = row.after_hash;
    seen.turns += 1;
    if (seen.shared || seen.skipped) seen.exact = false;
  }

  const files = [];
  for (const entry of byPath.values()) {
    if (!entry.skipped && entry.beforeHash === entry.afterHash) continue;
    const current = entry.repo ? readCapped(join(entry.repo, entry.path)) : undefined;
    const currentHash = current ? hashOf(current) : current === null ? null : undefined;
    files.push({
      ...entry,
      status:
        entry.beforeHash === null && !entry.skipped
          ? "added"
          : entry.afterHash === null && !entry.skipped
            ? "deleted"
            : "modified",
      drift:
        !entry.skipped &&
        currentHash !== undefined &&
        currentHash !== entry.afterHash,
    });
  }
  const diffs = await unifiedDiffs(
    files
      .filter((file) => !file.skipped)
      .map((file) => ({
        path: file.path,
        before: blob(conn, file.beforeHash),
        after: blob(conn, file.afterHash),
      })),
  );
  return {
    ok: true,
    scope,
    running,
    turn,
    turns: turns.map(({ repo: _repo, ...entry }) => entry),
    files: files.map(({ beforeHash: _b, afterHash: _a, repo: _r, ...file }) => {
      const diff = diffs.get(file.path) ?? "";
      return { ...file, ...countLines(diff), diff: diff.slice(0, 200_000) };
    }),
  };
}

function collectBlobs(conn) {
  conn.exec(
    `DELETE FROM blobs WHERE hash NOT IN (
       SELECT before_hash FROM turn_files WHERE before_hash IS NOT NULL
       UNION SELECT after_hash FROM turn_files WHERE after_hash IS NOT NULL)`,
  );
  conn.exec("PRAGMA incremental_vacuum");
}

/** The session was deleted: its history goes with it. */
export function forgetSessionChanges(sessionPath) {
  if (!sessionPath) return;
  const conn = db();
  conn.prepare("DELETE FROM turns WHERE session_path = ?").run(sessionPath);
  collectBlobs(conn);
}

/** Drop turns older than KEEP_DAYS and any content nothing points at. */
export function pruneChanges(now = Date.now()) {
  const conn = db();
  conn
    .prepare("DELETE FROM turns WHERE ended_at < ?")
    .run(now - KEEP_DAYS * 24 * 60 * 60_000);
  collectBlobs(conn);
}
