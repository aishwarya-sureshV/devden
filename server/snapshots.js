/**
 * Per-turn working-tree snapshots, so any backend can undo what an agent did.
 *
 * Claude's CLI checkpoints files itself (claude-agent.js rewindFiles), but
 * pi, grok and codex have nothing -- "Restore files to this point" just
 * failed on those tabs. Git already stores trees, so a snapshot is a commit
 * object parked on a private ref: no branch, no stash, nothing in the user's
 * history or `git log`.
 *
 * Both the snapshot and the restore stage into a scratch index inside .git
 * (GIT_INDEX_FILE), so the user's own staged/unstaged split is never
 * disturbed, and ignored files (node_modules, build output, .env) are never
 * captured or deleted.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const REF_PREFIX = "refs/devden/snapshots";
/**
 * Snapshots per session, under REF_PREFIX/<session tag>/<ms>. Per repo they
 * were shared: a busy session pruned a quiet one's turns, and a restore then
 * silently fell back to an older snapshot -- undoing more than was asked.
 * Flat REF_PREFIX/<ms> refs predate this and are only a fallback.
 * ponytail: refs grow with session count; drop dormant sessions' refs if
 * for-each-ref ever slows down.
 */
const KEEP = 50;
/** A snapshot is taken microseconds before the message it belongs to is
 *  logged, but clocks between the server and an agent's own log can skew. */
const SLACK_MS = 2000;

export async function git(dir, args, env) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    });
    return { ok: true, out: String(stdout).trim() };
  } catch (error) {
    return {
      ok: false,
      out: "",
      error: String(error?.stderr || error?.message || error).trim(),
    };
  }
}

/**
 * A scratch index living in .git, so `git add -A` keeps its stat cache warm
 * across turns and the real index is never written.
 */
export async function scratchEnv(dir) {
  const gitDir = await git(dir, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir.ok) return null;
  return {
    GIT_INDEX_FILE: join(gitDir.out, "devden-snapshot.index"),
    // commit-tree refuses to run without an identity, and a repo with no
    // user.name configured would otherwise never snapshot.
    GIT_AUTHOR_NAME: "devden",
    GIT_AUTHOR_EMAIL: "devden@localhost",
    GIT_COMMITTER_NAME: "devden",
    GIT_COMMITTER_EMAIL: "devden@localhost",
  };
}

/**
 * Every session in a repo shares one scratch index, so two turns ending
 * together raced on its index.lock and one `git add -A` failed. Work on the
 * scratch index runs one at a time per index file.
 */
const indexLocks = new Map();

export async function withScratchIndex(dir, fn) {
  const env = await scratchEnv(dir);
  if (!env) return { ok: false, error: "Not a git repository." };
  const key = env.GIT_INDEX_FILE;
  const previous = indexLocks.get(key) ?? Promise.resolve();
  const run = previous.then(() => fn(env));
  const settled = run.catch(() => {});
  indexLocks.set(key, settled);
  void settled.then(() => {
    if (indexLocks.get(key) === settled) indexLocks.delete(key);
  });
  return run;
}

/** Snapshot the whole working tree. Returns quietly when cwd is not a repo. */
/** Short, ref-safe tag for a session id (its session file path, else its key). */
export function sessionTag(session) {
  return createHash("sha1").update(String(session)).digest("hex").slice(0, 12);
}

export async function takeSnapshot(cwd, label = "", session = "") {
  if (!cwd) return { ok: false, error: "No working directory." };
  return withScratchIndex(cwd, (env) => snapshotWith(cwd, label, session, env));
}

async function snapshotWith(cwd, label, session, env) {
  const staged = await git(cwd, ["add", "-A"], env);
  if (!staged.ok) return { ok: false, error: staged.error };
  const tree = await git(cwd, ["write-tree"], env);
  if (!tree.ok) return { ok: false, error: tree.error };
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const args = ["commit-tree", tree.out];
  // An unborn branch (a repo with no commits yet) has no parent to hang off.
  if (head.ok) args.push("-p", head.out);
  args.push(
    "-m",
    `devden snapshot: ${label.replace(/\s+/g, " ").slice(0, 120) || "turn"}`,
  );
  const commit = await git(cwd, args, env);
  if (!commit.ok) return { ok: false, error: commit.error };
  const at = Date.now();
  const tag = session ? sessionTag(session) : null;
  const ref = tag ? `${REF_PREFIX}/${tag}/${at}` : `${REF_PREFIX}/${at}`;
  const updated = await git(cwd, ["update-ref", ref, commit.out]);
  if (!updated.ok) return { ok: false, error: updated.error };
  await prune(cwd, tag);
  return { ok: true, at, ref, commit: commit.out };
}

/**
 * The next turn's snapshot after a forked reply. A snapshot taken just
 * before this reply can land up to SLACK_MS after the reply's timestamp
 * (server clock vs agent log). When a later snapshot exists past that
 * window, the in-window one is this turn's own pre-prompt tree — skip it.
 * A lone snapshot inside the window is the next turn happening quickly.
 * ponytail: a skewed pre-prompt snapshot with no later turn is still chosen;
 * distinguishing it needs the snapshot to store which message it belongs to.
 */
export function snapshotAfterFork(snaps, timestamp) {
  const target = Number(timestamp);
  const after = (Array.isArray(snaps) ? snaps : [])
    .filter((entry) => Number.isFinite(entry?.at) && entry.at > target)
    .sort((left, right) => left.at - right.at);
  if (!Number.isFinite(target) || after.length === 0) return undefined;
  const beyond = after.find((entry) => entry.at > target + SLACK_MS);
  return beyond ?? after[0];
}

/**
 * The tree as of a forked reply: the next turn's pre-prompt snapshot if one
 * exists (that is the working tree after this turn finished), otherwise a
 * fresh snapshot of the tree right now. Forks branch from this commit so the
 * child checkout matches the parent at that point, dirty files included.
 */
export async function commitForFork(cwd, timestamp, sessions = []) {
  const all = await listSnapshots(cwd);
  // Another session's next snapshot is not this session's tree; a fresh
  // snapshot of right now is the safe fallback.
  const tags = sessions.filter(Boolean).map(sessionTag);
  const snaps = tags.length ? all.filter((snap) => tags.includes(snap.session)) : all;
  const next = snapshotAfterFork(snaps, timestamp);
  if (next)
    return { ok: true, commit: next.commit, at: next.at, ref: next.ref };
  const fresh = await takeSnapshot(cwd, "fork");
  if (!fresh.ok) return { ok: false, error: fresh.error };
  return {
    ok: true,
    commit: fresh.commit,
    at: fresh.at,
    ref: fresh.ref,
  };
}

/** Newest first. */
export async function listSnapshots(cwd) {
  if (!cwd) return [];
  const rows = await git(cwd, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)%09%(subject)",
    REF_PREFIX,
  ]);
  if (!rows.ok || !rows.out) return [];
  return rows.out
    .split("\n")
    .map((row) => {
      const [ref, commit, subject = ""] = row.split("\t");
      const parts = String(ref ?? "").slice(REF_PREFIX.length + 1).split("/");
      const at = Number(parts.at(-1));
      if (!Number.isFinite(at) || !commit || parts.length > 2) return null;
      return {
        at,
        session: parts.length === 2 ? parts[0] : null,
        ref,
        commit,
        label: subject.replace(/^devden snapshot: /, ""),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.at - left.at);
}

/**
 * A brand-new session's first turn is snapshotted before its session file
 * exists, so it is filed under the tab key. Once the file is known, move
 * those refs under the file's tag: tab keys change on refresh, the file
 * doesn't, and revert/fork look a session up by its file.
 */
export async function retagSnapshots(cwd, from, to) {
  if (!cwd || !from || !to || from === to) return 0;
  const fromTag = sessionTag(from);
  const toTag = sessionTag(to);
  const snaps = (await listSnapshots(cwd)).filter((snap) => snap.session === fromTag);
  for (const snap of snaps) {
    const moved = await git(cwd, ["update-ref", `${REF_PREFIX}/${toTag}/${snap.at}`, snap.commit]);
    if (moved.ok) await git(cwd, ["update-ref", "-d", snap.ref]);
  }
  if (snaps.length) await prune(cwd, toTag);
  return snaps.length;
}

async function prune(cwd, tag) {
  const snaps = (await listSnapshots(cwd)).filter((snap) => snap.session === tag);
  for (const snap of snaps.slice(KEEP))
    await git(cwd, ["update-ref", "-d", snap.ref]);
}

function countChanges(numstat) {
  const filesChanged = [];
  let insertions = 0;
  let deletions = 0;
  for (const row of numstat.split("\n")) {
    const [added, removed, path] = row.split("\t");
    if (!path) continue;
    filesChanged.push(path);
    insertions += Number(added) || 0;
    deletions += Number(removed) || 0;
  }
  return { filesChanged, insertions, deletions };
}

/**
 * Restore the tree to the snapshot taken for `timestamp` -- the newest one
 * at or before that message. Omit the timestamp for "undo the last turn".
 * `dryRun` reports what would change without touching anything.
 */
/**
 * The snapshot taken before the message at `timestamp`, from this session's
 * own snapshots (`sessions`: its session file path and/or key). Flat legacy
 * refs are used only when the session has none old enough AND never pruned
 * any -- i.e. the message predates per-session snapshots. A pruned turn is
 * refused rather than answered with an older snapshot that undoes more.
 */
export function pickSnapshot(snaps, timestamp, sessions = []) {
  const target = Number(timestamp);
  const before = (list) =>
    Number.isFinite(target)
      ? list.find((entry) => entry.at <= target + SLACK_MS)
      : list[0];
  const tags = sessions.filter(Boolean).map(sessionTag);
  if (!tags.length) return before(snaps);
  const own = snaps.filter((snap) => tags.includes(snap.session));
  const mine = before(own);
  if (mine) return mine;
  if (own.length >= KEEP) return undefined;
  return before(snaps.filter((snap) => snap.session === null));
}

/**
 * `git diff --name-status` from `commit` to the working tree, new files
 * included (staged into the scratch index, never the user's). Null when git
 * fails. Prosecutor rounds hand this to both sides so neither re-explores.
 */
export async function changedSince(cwd, commit) {
  if (!cwd || !commit) return null;
  const result = await withScratchIndex(cwd, async (env) => {
    const staged = await git(cwd, ["add", "-A"], env);
    if (!staged.ok) return staged;
    return git(cwd, ["diff", "--cached", "--name-status", "--no-renames", commit], env);
  });
  return result?.ok ? result.out : null;
}

export async function restoreSnapshot(cwd, timestamp, dryRun = false, sessions = []) {
  const snaps = await listSnapshots(cwd);
  if (!snaps.length)
    return { ok: false, error: "No snapshots recorded for this workspace." };
  const snap = pickSnapshot(snaps, timestamp, sessions);
  if (!snap)
    return { ok: false, error: "No snapshot from before that message in this session." };
  return withScratchIndex(cwd, (env) => restoreWith(cwd, snap, dryRun, env));
}

async function restoreWith(cwd, snap, dryRun, env) {
  // The scratch index has to describe the tree as it is now, or read-tree
  // has no idea which files the agent added and should therefore delete.
  const staged = await git(cwd, ["add", "-A"], env);
  if (!staged.ok) return { ok: false, error: staged.error };
  // -R because the interesting direction is now -> snapshot, not snapshot -> now.
  const diff = await git(
    cwd,
    ["diff", "-R", "--cached", "--numstat", "--no-renames", snap.commit],
    env,
  );
  if (!diff.ok) return { ok: false, error: diff.error };
  const counts = countChanges(diff.out);
  if (dryRun)
    return {
      ok: true,
      data: {
        ...counts,
        canRewind: counts.filesChanged.length > 0,
        dryRun: true,
        snapshotAt: snap.at,
      },
    };
  const applied = await git(
    cwd,
    ["read-tree", "--reset", "-u", snap.commit],
    env,
  );
  if (!applied.ok) return { ok: false, error: applied.error };
  return { ok: true, data: { ...counts, dryRun: false, snapshotAt: snap.at } };
}

/**
 * Unified diff of what this turn changed: snapshot taken as the user
 * message landed → current working tree. `git diff` exits 1 when there
 * are hunks, so stdout is kept on that status.
 */
export async function diffSinceSnapshot(cwd, timestamp, context = 15, sessions = []) {
  const snaps = await listSnapshots(cwd);
  if (!snaps.length)
    return { ok: false, error: "No turn snapshots for this workspace." };
  const snap = pickSnapshot(snaps, timestamp, sessions);
  if (!snap)
    return { ok: false, error: "No snapshot from before that turn." };
  return withScratchIndex(cwd, (env) => diffWith(cwd, snap, context, env));
}

async function diffWith(cwd, snap, context, env) {
  const staged = await git(cwd, ["add", "-A"], env);
  if (!staged.ok) return { ok: false, error: staged.error };
  const depth = Number.isFinite(context) ? Math.max(3, Math.min(50, context)) : 15;
  let out = "";
  try {
    const result = await execFileAsync(
      "git",
      [
        "-C",
        cwd,
        "diff",
        `-U${depth}`,
        "--cached",
        "--no-renames",
        snap.commit,
      ],
      {
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ...env },
      },
    );
    out = String(result.stdout ?? "");
  } catch (error) {
    const status = error?.status ?? error?.code;
    if (status !== 1 && status !== "1")
      return {
        ok: false,
        error: String(error?.stderr || error?.message || error).trim(),
      };
    out = String(error?.stdout ?? "");
  }
  return {
    ok: true,
    diff: out,
    snapshotAt: snap.at,
    commit: snap.commit,
  };
}
