import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { takeSnapshot } from "./snapshots.js";
import {
  baseOf,
  createWorktree,
  listWorktrees,
  mainRepoOf,
  removeWorktree,
  slugFor,
  toplevelOf,
} from "./worktrees.js";

function repo(ignore = "node_modules\n.env\n") {
  // realpath: macOS hands out /var/... which is a symlink to /private/var,
  // and git reports the resolved form back.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "devden-wt-")));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, ".gitignore"), ignore);
  writeFileSync(join(dir, "app.js"), "original\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "dep.js"), "dep\n");
  git("add", "app.js", ".gitignore");
  git("commit", "-qm", "base");
  return { dir, git };
}

test("a worktree is an isolated checkout, seeded with what git will not carry", async () => {
  const { dir } = repo();
  const made = await createWorktree(dir, "Fix the sidebar typo!");
  assert.equal(made.ok, true);
  const { path, branch } = made.data;

  assert.equal(branch, "pi/fix-the-sidebar-typo");
  assert.equal(path, join(dir, "worktrees", "fix-the-sidebar-typo"));
  // Ignored files git never checks out, but a dev server needs on first run.
  assert.equal(readFileSync(join(path, ".env"), "utf8"), "SECRET=1\n");
  assert.equal(lstatSync(join(path, "node_modules")).isSymbolicLink(), true);

  // The isolation claim: an edit here is invisible to the main checkout.
  writeFileSync(join(path, "app.js"), "changed by the agent\n");
  assert.equal(readFileSync(join(dir, "app.js"), "utf8"), "original\n");

  // And neither tree shows the plumbing: not the main checkout (worktrees/
  // is excluded) nor the new one (nothing unignored was seeded into it).
  const status = (at) =>
    execFileSync("git", ["-C", at, "status", "--porcelain"], {
      encoding: "utf8",
    });
  assert.equal(status(dir).includes("worktrees"), false);
  assert.equal(status(path).trim(), "M app.js");
});

test("seeding rolls back anything the new checkout would report as a change", async () => {
  // A `node_modules/` rule matches a directory, not the symlink standing in
  // for it. Leaving that link would put node_modules in the task's own diff.
  const { dir } = repo("node_modules/\n.env\n");
  const made = await createWorktree(dir, "trailing slash");
  assert.equal(existsSync(join(made.data.path, "node_modules")), false);
  assert.equal(made.data.seeded.includes("node_modules (symlink)"), false);
  assert.equal(made.data.seeded.includes(".env"), true);
  const status = execFileSync(
    "git",
    ["-C", made.data.path, "status", "--porcelain"],
    { encoding: "utf8" },
  );
  assert.equal(status.trim(), "");
});

test("names collide without clobbering, and a nested create goes to the main repo", async () => {
  const { dir } = repo();
  const first = await createWorktree(dir, "same name");
  const second = await createWorktree(dir, "same name");
  assert.equal(second.ok, true);
  assert.notEqual(first.data.path, second.data.path);
  assert.equal(second.data.branch, "pi/same-name-2");

  // A session already running inside a worktree makes siblings, not nests.
  assert.equal(await mainRepoOf(first.data.path), dir);
  const third = await createWorktree(first.data.path, "from inside");
  assert.equal(third.data.path, join(dir, "worktrees", "from-inside"));

  const trees = await listWorktrees(dir);
  assert.equal(trees.length, 4);
  assert.equal(trees[0].main, true);
  assert.equal(trees[0].path, dir);
});

test("a worktree can check out a snapshot commit, not only HEAD", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "app.js"), "dirty at fork\n");
  const snap = await takeSnapshot(dir, "fork");
  assert.equal(snap.ok, true);
  writeFileSync(join(dir, "app.js"), "later parent edit\n");

  const made = await createWorktree(dir, "from-snap", { commit: snap.commit });
  assert.equal(made.ok, true);
  assert.equal(
    readFileSync(join(made.data.path, "app.js"), "utf8"),
    "dirty at fork\n",
  );
  assert.equal(
    readFileSync(join(dir, "app.js"), "utf8"),
    "later parent edit\n",
  );
  assert.equal(made.data.base, snap.commit);
});

test("the base commit is recorded, so a task diff can span its commits", async () => {
  const { dir } = repo();
  const made = await createWorktree(dir, "task");
  const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assert.equal(await baseOf(made.data.path), head);

  writeFileSync(join(made.data.path, "app.js"), "task work\n");
  execFileSync("git", ["-C", made.data.path, "commit", "-qam", "work"], {
    encoding: "utf8",
  });
  // Still the fork point after the branch moves on -- not HEAD.
  assert.equal(await baseOf(made.data.path), head);
});

test("removal refuses to throw away uncommitted work", async () => {
  const { dir } = repo();
  const made = await createWorktree(dir, "risky");
  writeFileSync(join(made.data.path, "app.js"), "unsaved agent work\n");

  const refused = await removeWorktree(dir, made.data.path);
  assert.equal(refused.ok, false);
  assert.equal(refused.dirty, true);
  assert.equal(existsSync(made.data.path), true);

  const forced = await removeWorktree(dir, made.data.path, true);
  assert.equal(forced.ok, true);
  assert.equal(existsSync(made.data.path), false);
  // The branch survives while its commits are unmerged, so nothing is lost.
  assert.equal((await listWorktrees(dir)).length, 1);
});

test("removal refuses a path that is not a worktree of this repo", async () => {
  const { dir } = repo();
  assert.equal((await removeWorktree(dir, dir)).ok, false);
  assert.equal((await removeWorktree(dir, "/tmp")).ok, false);
});

test("a leftover branch from a removed worktree does not block a recreate", async () => {
  const { dir } = repo();
  // A worktree cut from a snapshot commit holds commits main never sees, so
  // its branch is unmerged and survives removal — the collision case.
  writeFileSync(join(dir, "app.js"), "dirty before fork\n");
  const snap = await takeSnapshot(dir);
  assert.equal(snap.ok, true);
  const first = await createWorktree(dir, "twice", { commit: snap.commit });
  assert.equal(first.ok, true);
  assert.equal((await removeWorktree(dir, first.data.path, true)).ok, true);
  // Same label again: the stale pi/twice branch must not fail worktree add.
  const second = await createWorktree(dir, "twice");
  assert.equal(second.ok, true);
  assert.equal(second.data.branch, "pi/twice-2");
  assert.notEqual(second.data.path, first.data.path);
});

test("a cwd reached through a symlink still matches the worktree list", async () => {
  const { dir } = repo();
  const made = await createWorktree(dir, "linked");
  // What the browser may send: /tmp/... where git always answers /private/tmp.
  const viaLink = made.data.path.replace("/private/var/", "/var/");
  const resolved = await toplevelOf(viaLink);
  const trees = await listWorktrees(dir);
  assert.equal(
    trees.some((tree) => tree.path === resolved),
    true,
  );
});

test("slugs cannot escape the worktrees directory", () => {
  assert.equal(slugFor("../../etc/passwd"), "etc-passwd");
  assert.equal(slugFor("   "), "task");
  assert.equal(slugFor("a".repeat(80)).length, 48);
});
