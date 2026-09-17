import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diffSinceSnapshot, listSnapshots, restoreSnapshot, takeSnapshot } from "./snapshots.js";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-snap-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, ".gitignore"), "ignored/\n");
  writeFileSync(join(dir, "kept.txt"), "original\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { dir, git };
}

test("restores the tree the agent started from", async () => {
  const { dir, git } = repo();
  const snap = await takeSnapshot(dir, "do the thing");
  assert.equal(snap.ok, true);

  // What an agent turn does: edit, create, delete.
  writeFileSync(join(dir, "kept.txt"), "rewritten by the agent\n");
  writeFileSync(join(dir, "new.txt"), "agent made this\n");
  rmSync(join(dir, ".gitignore"));

  const preview = await restoreSnapshot(dir, snap.at + 1000, true);
  assert.equal(preview.data.canRewind, true);
  assert.deepEqual(preview.data.filesChanged.sort(), [
    ".gitignore",
    "kept.txt",
    "new.txt",
  ]);
  assert.equal(existsSync(join(dir, "new.txt")), true, "dry run must not touch files");

  const done = await restoreSnapshot(dir, snap.at + 1000);
  assert.equal(done.ok, true);
  assert.equal(readFileSync(join(dir, "kept.txt"), "utf8"), "original\n");
  assert.equal(existsSync(join(dir, "new.txt")), false, "files added since must go");
  assert.equal(existsSync(join(dir, ".gitignore")), true, "deleted files come back");
  assert.equal(git("status", "--porcelain").trim(), "", "tree matches the commit again");
  rmSync(dir, { recursive: true, force: true });
});

test("leaves the user's own staging and ignored files alone", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "staged.txt"), "mine\n");
  git("add", "staged.txt");
  const snap = await takeSnapshot(dir, "turn");
  execFileSync("mkdir", ["-p", join(dir, "ignored")]);
  writeFileSync(join(dir, "ignored", "node_modules.txt"), "expensive\n");
  writeFileSync(join(dir, "kept.txt"), "agent edit\n");

  await restoreSnapshot(dir, snap.at + 1000);
  assert.equal(readFileSync(join(dir, "kept.txt"), "utf8"), "original\n");
  assert.match(git("status", "--porcelain"), /^A {2}staged\.txt$/m);
  assert.equal(existsSync(join(dir, "ignored", "node_modules.txt")), true);
  rmSync(dir, { recursive: true, force: true });
});

test("picks the snapshot before the message, and prunes nothing under the cap", async () => {
  const { dir } = repo();
  const first = await takeSnapshot(dir, "turn one");
  writeFileSync(join(dir, "kept.txt"), "after turn one\n");
  const second = await takeSnapshot(dir, "turn two");
  writeFileSync(join(dir, "kept.txt"), "after turn two\n");

  assert.equal((await listSnapshots(dir)).length, 2);
  assert.equal((await listSnapshots(dir))[0].label, "turn two");
  // A message stamped just after the second turn started rewinds to it,
  // not all the way back to the first.
  await restoreSnapshot(dir, second.at + 500);
  assert.equal(readFileSync(join(dir, "kept.txt"), "utf8"), "after turn one\n");
  // No timestamp at all means "undo the last turn".
  writeFileSync(join(dir, "kept.txt"), "later still\n");
  await restoreSnapshot(dir);
  assert.equal(readFileSync(join(dir, "kept.txt"), "utf8"), "after turn one\n");
  assert.ok(first.at <= second.at);
  rmSync(dir, { recursive: true, force: true });
});

test("diffSinceSnapshot is this turn only, not leftover dirty files", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "kept.txt"), "leftover from yesterday\n");
  const snap = await takeSnapshot(dir, "this turn");
  writeFileSync(join(dir, "kept.txt"), "this turn rewrite\n");
  writeFileSync(join(dir, "turn-only.txt"), "new in this turn\n");
  const isolated = await diffSinceSnapshot(dir, snap.at + 50);
  assert.equal(isolated.ok, true);
  assert.match(isolated.diff, /turn-only\.txt/);
  assert.match(isolated.diff, /\+this turn rewrite/);
  // Baseline is the snapshot, so yesterday's leftover is the minus line —
  // the original committed text must not appear as this turn's change.
  assert.doesNotMatch(isolated.diff, /^-original/m);
  rmSync(dir, { recursive: true, force: true });
});

test("a directory that is not a repo fails without throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-snap-bare-"));
  assert.equal((await takeSnapshot(dir, "x")).ok, false);
  assert.equal((await restoreSnapshot(dir)).ok, false);
  rmSync(dir, { recursive: true, force: true });
});
