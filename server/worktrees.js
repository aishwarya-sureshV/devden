/**
 * Git worktrees, one per session or per board card.
 *
 * Snapshots (snapshots.js) give a session undo along the time axis; this is
 * the space axis. Every agent call already carries a `cwd` -- start, prompt,
 * rewind, git-changes, git ops -- so pointing a tab at a worktree isolates it
 * from every other tab with no per-backend work at all.
 *
 * Worktrees live at <main repo>/worktrees/<slug>, the name the file picker
 * and workspace search already skip (index.js SKIP_DIRS), and are excluded
 * through .git/info/exclude so the user's own .gitignore is never edited.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFile,
  cp,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

const DIR = "worktrees";
const BRANCH_PREFIX = "pi";
/** Ignored files git will not carry into a fresh checkout but a dev server
 *  needs on its first run. ponytail: top level only; add a glob walk when
 *  somebody keeps env files in subdirectories. */
const COPY_ON_SEED = /^\.env($|\.)/;

async function git(dir, args) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
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
 * Flatten a card title or session label into a directory name. Mirrors
 * safeTranscriptName's trust-boundary rule -- everything but [a-z0-9._-] goes,
 * which removes every separator, so no title can escape the worktrees dir.
 */
export function slugFor(label, fallback = "task") {
  const slug = String(label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

/**
 * The main working tree of whatever repo `dir` belongs to. A session already
 * running inside a worktree has to create siblings next to the main checkout,
 * not nested inside itself.
 */
export async function mainRepoOf(dir) {
  const common = await git(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!common.ok) return null;
  // <main>/.git for a normal checkout; a bare repo has no working tree.
  return basename(common.out) === ".git" ? dirname(common.out) : null;
}

/** Keep `worktrees/` out of git status without touching the user's .gitignore. */
async function excludeWorktreeDir(repo) {
  const gitDir = await git(repo, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir.ok) return;
  const exclude = join(gitDir.out, "info", "exclude");
  try {
    const current = await readFile(exclude, "utf8");
    if (current.split("\n").some((line) => line.trim() === `${DIR}/`)) return;
    await appendFile(exclude, `\n# pi-web session worktrees\n${DIR}/\n`);
  } catch {
    /* no info/exclude (a worktree's own gitdir): nothing to keep clean */
  }
}

/**
 * Only ever keep what the new checkout itself ignores. Anything else would
 * show up as the agent's own change in the very first diff the user reviews
 * -- and it is the destination that decides: a `node_modules/` rule matches
 * the main repo's real directory but not the symlink standing in for it here.
 * Checked after the fact because that is the only way to ask about the path
 * as it actually landed.
 */
async function keepIfIgnored(path, name) {
  const { ok } = await git(path, ["check-ignore", "-q", "--", name]);
  if (ok) return true;
  await rm(join(path, name), { force: true, recursive: false }).catch(() => {});
  return false;
}

/**
 * node_modules is symlinked rather than copied: it is the whole reason a
 * fresh checkout cannot run, and copying it costs minutes and gigabytes.
 * ponytail: a task that CHANGES dependencies writes through the link into the
 * main tree -- reinstall in the worktree when that matters.
 */
async function seed(repo, path) {
  const seeded = [];
  const modules = join(repo, "node_modules");
  if (existsSync(modules) && !existsSync(join(path, "node_modules"))) {
    try {
      await symlink(modules, join(path, "node_modules"), "dir");
      if (await keepIfIgnored(path, "node_modules"))
        seeded.push("node_modules (symlink)");
    } catch {
      /* a filesystem without symlinks: the agent can still npm install */
    }
  }
  let entries = [];
  try {
    entries = await readdir(repo, { withFileTypes: true });
  } catch {
    return seeded;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !COPY_ON_SEED.test(entry.name)) continue;
    if (existsSync(join(path, entry.name))) continue;
    try {
      await cp(join(repo, entry.name), join(path, entry.name));
      if (await keepIfIgnored(path, entry.name)) seeded.push(entry.name);
    } catch {
      /* unreadable env file: not worth failing the whole worktree over */
    }
  }
  return seeded;
}

/**
 * Create a worktree on a fresh branch. `options.commit` is the tree to check
 * out (a snapshot commit at a fork point); omitted, it is the repo's HEAD.
 * Returns the path to hand a session as its cwd.
 */
export async function createWorktree(dir, label, options = {}) {
  const repo = await mainRepoOf(dir);
  if (!repo) return { ok: false, error: "Not a git repository." };
  const start =
    typeof options.commit === "string" && options.commit
      ? options.commit
      : (await git(repo, ["rev-parse", "HEAD"])).out;
  if (!start)
    return {
      ok: false,
      error: "This repository has no commits yet to branch from.",
    };
  const existing = await listWorktrees(dir);
  const taken = new Set(existing.map((tree) => basename(tree.path)));
  // A removed worktree leaves its branch behind (branch -d refuses unmerged
  // work), and `git worktree add -b` fails on an existing branch name — so
  // those slugs count as taken too.
  const branches = await git(repo, [
    "for-each-ref",
    `refs/heads/${BRANCH_PREFIX}`,
    "--format=%(refname:short)",
  ]);
  if (branches.ok)
    for (const name of branches.out.split("\n"))
      if (name.startsWith(`${BRANCH_PREFIX}/`))
        taken.add(name.slice(BRANCH_PREFIX.length + 1));
  const base = slugFor(label);
  let slug = base;
  for (let n = 2; taken.has(slug) || existsSync(join(repo, DIR, slug)); n += 1)
    slug = `${base}-${n}`;
  const path = join(repo, DIR, slug);
  const branch = `${BRANCH_PREFIX}/${slug}`;
  const added = await git(repo, ["worktree", "add", "-b", branch, path, start]);
  if (!added.ok) return { ok: false, error: added.error };
  await excludeWorktreeDir(repo);
  // The commit the task branched from, so the review diff can show the whole
  // task rather than only what is still uncommitted.
  await git(repo, ["config", `pi-web.worktree.${slug}.base`, start]);
  const seeded = await seed(repo, path);
  return { ok: true, data: { path, branch, base: start, repo, seeded } };
}

/**
 * Git's own name for the checkout `dir` sits in. The browser may hand over a
 * path through a symlink (/tmp vs /private/tmp on macOS) and `worktree list`
 * always answers with the resolved one, so callers matching a cwd against
 * that list have to ask git rather than compare strings.
 */
export async function toplevelOf(dir) {
  const top = await git(dir, ["rev-parse", "--show-toplevel"]);
  return top.ok ? top.out : dir;
}

/** Every worktree of this repo, main checkout first. */
export async function listWorktrees(dir) {
  const rows = await git(dir, ["worktree", "list", "--porcelain"]);
  if (!rows.ok) return [];
  const trees = [];
  let current = null;
  for (const line of rows.out.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), branch: "", head: "" };
      trees.push(current);
    } else if (!current) continue;
    else if (line.startsWith("branch "))
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line.startsWith("HEAD ")) current.head = line.slice(5);
  }
  return trees.map((tree, index) => ({ ...tree, main: index === 0 }));
}

/** The commit a worktree was cut from, for a task-wide diff. */
export async function baseOf(dir) {
  const repo = await mainRepoOf(dir);
  if (!repo) return null;
  const stored = await git(repo, [
    "config",
    `pi-web.worktree.${basename(dir)}.base`,
  ]);
  if (stored.ok && stored.out) return stored.out;
  // Not one of ours, or the config was pruned: fall back to where this branch
  // left the checkout's default branch.
  const head = await git(dir, ["symbolic-ref", "--short", "HEAD"]);
  if (!head.ok) return null;
  for (const candidate of ["main", "master"]) {
    const merged = await git(dir, ["merge-base", "HEAD", candidate]);
    if (merged.ok && merged.out) return merged.out;
  }
  return null;
}

/**
 * Remove a worktree and, unless it still holds unmerged commits, its branch.
 * Refuses a dirty tree without `force` -- discarding an agent's uncommitted
 * work silently is the one mistake here that costs somebody a whole task.
 */
export async function removeWorktree(dir, target, force = false) {
  const repo = await mainRepoOf(dir);
  if (!repo) return { ok: false, error: "Not a git repository." };
  const trees = await listWorktrees(repo);
  const tree = trees.find((entry) => entry.path === target && !entry.main);
  if (!tree)
    return { ok: false, error: "That path is not a worktree of this repo." };
  if (!force) {
    const dirty = await git(target, ["status", "--porcelain"]);
    if (dirty.ok && dirty.out)
      return {
        ok: false,
        error: "This worktree has uncommitted changes. Commit them first.",
        dirty: true,
      };
  }
  const args = ["worktree", "remove", target];
  if (force) args.splice(2, 0, "--force");
  const removed = await git(repo, args);
  if (!removed.ok) return { ok: false, error: removed.error };
  // -d, never -D: a branch whose commits are not merged anywhere stays, so a
  // finished-but-unmerged task is recoverable.
  if (tree.branch) await git(repo, ["branch", "-d", tree.branch]);
  await git(repo, [
    "config",
    "--unset",
    `pi-web.worktree.${basename(target)}.base`,
  ]);
  return { ok: true, data: { path: target, branch: tree.branch } };
}
