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
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const REF_PREFIX = "refs/pi-web/snapshots";
/** Snapshots per repo. Each is one small commit; this is clutter control. */
const KEEP = 50;
/** A snapshot is taken microseconds before the message it belongs to is
 *  logged, but clocks between the server and an agent's own log can skew. */
const SLACK_MS = 2000;

async function git(dir, args, env) {
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
async function scratchEnv(dir) {
  const gitDir = await git(dir, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir.ok) return null;
  return {
    GIT_INDEX_FILE: join(gitDir.out, "pi-web-snapshot.index"),
    // commit-tree refuses to run without an identity, and a repo with no
    // user.name configured would otherwise never snapshot.
    GIT_AUTHOR_NAME: "pi-web",
    GIT_AUTHOR_EMAIL: "pi-web@localhost",
    GIT_COMMITTER_NAME: "pi-web",
    GIT_COMMITTER_EMAIL: "pi-web@localhost",
  };
}

/** Snapshot the whole working tree. Returns quietly when cwd is not a repo. */
export async function takeSnapshot(cwd, label = "") {
  if (!cwd) return { ok: false, error: "No working directory." };
  const env = await scratchEnv(cwd);
  if (!env) return { ok: false, error: "Not a git repository." };
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
    `pi-web snapshot: ${label.replace(/\s+/g, " ").slice(0, 120) || "turn"}`,
  );
  const commit = await git(cwd, args, env);
  if (!commit.ok) return { ok: false, error: commit.error };
  const at = Date.now();
  const ref = `${REF_PREFIX}/${at}`;
  const updated = await git(cwd, ["update-ref", ref, commit.out]);
  if (!updated.ok) return { ok: false, error: updated.error };
  await prune(cwd);
  return { ok: true, at, ref, commit: commit.out };
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
      const at = Number(ref?.slice(REF_PREFIX.length + 1));
      if (!Number.isFinite(at) || !commit) return null;
      return {
        at,
        ref,
        commit,
        label: subject.replace(/^pi-web snapshot: /, ""),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.at - left.at);
}

async function prune(cwd) {
  const snaps = await listSnapshots(cwd);
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
export async function restoreSnapshot(cwd, timestamp, dryRun = false) {
  const snaps = await listSnapshots(cwd);
  if (!snaps.length)
    return { ok: false, error: "No snapshots recorded for this workspace." };
  const target = Number(timestamp);
  const snap = Number.isFinite(target)
    ? snaps.find((entry) => entry.at <= target + SLACK_MS)
    : snaps[0];
  if (!snap)
    return { ok: false, error: "No snapshot from before that message." };
  const env = await scratchEnv(cwd);
  if (!env) return { ok: false, error: "Not a git repository." };
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
export async function diffSinceSnapshot(cwd, timestamp, context = 15) {
  const snaps = await listSnapshots(cwd);
  if (!snaps.length)
    return { ok: false, error: "No turn snapshots for this workspace." };
  const target = Number(timestamp);
  const snap = Number.isFinite(target)
    ? snaps.find((entry) => entry.at <= target + SLACK_MS)
    : snaps[0];
  if (!snap)
    return { ok: false, error: "No snapshot from before that turn." };
  const env = await scratchEnv(cwd);
  if (!env) return { ok: false, error: "Not a git repository." };
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
