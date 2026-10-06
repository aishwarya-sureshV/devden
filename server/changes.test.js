import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.DEVDEN_HOME = mkdtempSync(join(tmpdir(), "devden-changes-home-"));
const changes = await import("./changes.js");
const { listSnapshots, sessionTag, takeSnapshot } = await import("./snapshots.js");
const { db } = await import("./db.js");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "devden-changes-repo-"));
  const run = (...args) => execFileSync("git", ["-C", dir, ...args]);
  run("init", "-q");
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "shared.txt"), "base\n");
  run("add", "-A");
  run("commit", "-qm", "init");
  return dir;
}

const start = (sessionKey, cwd) =>
  changes.beginTurn({ sessionKey, cwd, label: "go", takeSnapshot });
const edit = (sessionKey, cwd, file, content) => {
  changes.noteToolCall(sessionKey, "Edit", { file_path: join(cwd, file) });
  writeFileSync(join(cwd, file), content);
};
const byPath = (view) => Object.fromEntries(view.files.map((f) => [f.path, f]));

test("session provenance requires a turn and survives late paths outside git", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "devden-session-origin-"));
  const has = (path) => Boolean(db().prepare("SELECT 1 FROM docs WHERE ns = 'devden-sessions' AND key = ?").get(path));
  const opened = join(cwd, "opened.jsonl");
  changes.noteSessionContext("opened-only", { cwd, sessionPath: opened });
  assert.equal(has(opened), false);
  start("opened-only", cwd);
  assert.equal(has(opened), false);
  changes.noteSessionActivity("opened-only");
  assert.equal(has(opened), true);
  await changes.endTurn("opened-only");
  const next = join(cwd, "empty-next.jsonl");
  changes.noteSessionContext("opened-only", { cwd, sessionPath: next });
  assert.equal(has(next), false);
  start("late-path", cwd);
  changes.noteSessionActivity("late-path");
  await changes.endTurn("late-path");
  const late = join(cwd, "late.jsonl");
  changes.noteSessionContext("late-path", { sessionPath: late });
  assert.equal(has(late), true);
});

test("a turn killed before any state event still marks a path known at start", () => {
  const path = join(mkdtempSync(join(tmpdir(), "devden-killed-")), "chat_history.jsonl");
  changes.noteSessionActivity("killed-first-turn", path);
  const row = db().prepare("SELECT value FROM docs WHERE ns = 'devden-sessions' AND key = ?").get(path);
  assert.equal(row?.value, '"activity"');
});

test("turn and session views, tool vs command attribution", async () => {
  const cwd = repo();
  start("s1", cwd);
  await new Promise((r) => setTimeout(r, 300)); // let the snapshot land
  edit("s1", cwd, "a.txt", "two\n");
  writeFileSync(join(cwd, "made-by-bash.txt"), "x\n"); // no tool named it
  await changes.endTurn("s1");

  const turn = byPath(await changes.readChanges({ sessionKey: "s1", scope: "turn" }));
  assert.equal(turn["a.txt"].source, "tool");
  assert.equal(turn["a.txt"].additions, 1);
  assert.match(turn["a.txt"].diff, /-one\n\+two/);
  assert.equal(turn["made-by-bash.txt"].source, "command");
  assert.equal(turn["made-by-bash.txt"].status, "added");

  start("s1", cwd);
  await new Promise((r) => setTimeout(r, 300));
  edit("s1", cwd, "a.txt", "three\n");
  await changes.endTurn("s1");

  const latest = byPath(await changes.readChanges({ sessionKey: "s1", scope: "turn" }));
  assert.deepEqual(Object.keys(latest), ["a.txt"]);
  const session = byPath(await changes.readChanges({ sessionKey: "s1", scope: "session" }));
  assert.match(session["a.txt"].diff, /-one\n\+three/); // first before -> last after
  assert.equal(session["a.txt"].exact, true);
  assert.equal(session["a.txt"].turns, 2);
});

test("two sessions in one checkout: shared files are flagged, others' files left out", async () => {
  const cwd = repo();
  start("A", cwd);
  start("B", cwd);
  await new Promise((r) => setTimeout(r, 400));
  edit("A", cwd, "a.txt", "from A\n");
  edit("B", cwd, "shared.txt", "from B\n");
  changes.noteToolCall("A", "Write", { path: "shared.txt" });
  writeFileSync(join(cwd, "shared.txt"), "from B\nfrom A\n");
  await changes.endTurn("A");
  await changes.endTurn("B");

  const a = byPath(await changes.readChanges({ sessionKey: "A", scope: "session" }));
  assert.equal(a["a.txt"].exact, true);
  assert.equal(a["shared.txt"].shared, true);
  assert.equal(a["shared.txt"].exact, false);
  const b = byPath(await changes.readChanges({ sessionKey: "B", scope: "session" }));
  assert.equal(b["a.txt"], undefined); // A's file, not B's
  assert.equal(b["shared.txt"].shared, true);
});

test("an edit by someone else between two turns marks the file inexact", async () => {
  const cwd = repo();
  start("C", cwd);
  await new Promise((r) => setTimeout(r, 300));
  edit("C", cwd, "a.txt", "c1\n");
  await changes.endTurn("C");
  writeFileSync(join(cwd, "a.txt"), "user typed this\n"); // between turns
  start("C", cwd);
  await new Promise((r) => setTimeout(r, 300));
  edit("C", cwd, "a.txt", "c2\n");
  await changes.endTurn("C");
  const view = byPath(await changes.readChanges({ sessionKey: "C", scope: "session" }));
  assert.equal(view["a.txt"].exact, false);
  writeFileSync(join(cwd, "a.txt"), "edited after\n");
  const after = byPath(await changes.readChanges({ sessionKey: "C", scope: "session" }));
  assert.equal(after["a.txt"].drift, true);
});

test("pruning drops old turns and the content only they referenced", async () => {
  const cwd = repo();
  start("old", cwd);
  await new Promise((r) => setTimeout(r, 300));
  edit("old", cwd, "a.txt", "unique-to-old\n");
  await changes.endTurn("old");
  const blobs = () => db().prepare("SELECT COUNT(*) AS n FROM blobs").get().n;
  const before = blobs();
  changes.pruneChanges(Date.now() + 31 * 24 * 60 * 60_000);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM turns").get().n, 0);
  assert.ok(blobs() < before);
  assert.equal(blobs(), 0);
});

test("claude: no path at turn start, the path on a mid-turn state event still lists the session", () => {
  // Claude learns its session file from the init message during the first
  // turn and emits `state` then; a kill after that must not lose the row.
  const path = join(mkdtempSync(join(tmpdir(), "devden-claude-first-")), "claude.jsonl");
  changes.noteSessionActivity("claude-first-turn", "");
  changes.noteSessionContext("claude-first-turn", { sessionPath: path });
  const row = db().prepare("SELECT value FROM docs WHERE ns = 'devden-sessions' AND key = ?").get(path);
  assert.equal(row?.value, '"activity"');
});

test("learning the session file moves the first turn's tab-keyed snapshot under it", async () => {
  const cwd = repo();
  changes.noteSessionContext("fresh-tab", { cwd });
  start("fresh-tab", cwd);
  const path = join(cwd, "late-session.jsonl");
  changes.noteSessionContext("fresh-tab", { sessionPath: path });
  let sessions = [];
  // Wait for the move to finish (new ref written, old one deleted), not
  // just begin; git is slow when the whole suite runs in parallel.
  for (let i = 0; i < 250 && !(sessions.length === 1 && sessions[0] === sessionTag(path)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    sessions = (await listSnapshots(cwd)).map((snap) => snap.session);
  }
  assert.deepEqual(sessions, [sessionTag(path)]);
  await changes.endTurn("fresh-tab");
});
