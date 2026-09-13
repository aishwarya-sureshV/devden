import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  appendNewTurns,
  compactPrefixLength,
  mergeDisplay,
  saveDisplayOverlay,
  withDisplayHistory,
} from "./display-history.js";

const user = (text) => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistant = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

describe("mergeDisplay", () => {
  const before = [user("fix the bug"), assistant("done")];
  const after = [user("summary of the work")];

  it("keeps originals when the agent log is still the compact summary", () => {
    assert.deepEqual(mergeDisplay({ before, after }, after), before);
  });

  it("appends turns that arrived after compact", () => {
    const current = [...after, user("keep going"), assistant("next")];
    assert.deepEqual(mergeDisplay({ before, after }, current), [
      ...before,
      user("keep going"),
      assistant("next"),
    ]);
  });

  it("returns the live log when there is no overlay", () => {
    const live = [user("hello")];
    assert.deepEqual(mergeDisplay(null, live), live);
    assert.deepEqual(mergeDisplay({ before: [] }, live), live);
  });

  it("does not duplicate when compact did not rewrite the log", () => {
    const overlay = { before, after: before };
    const current = [...before, user("next"), assistant("ok")];
    assert.deepEqual(mergeDisplay(overlay, current), current);
  });
});

describe("compactPrefixLength", () => {
  it("matches a leading rewrite", () => {
    const after = [user("summary")];
    const current = [user("summary"), user("next")];
    assert.equal(compactPrefixLength(after, current), 1);
  });

  it("is zero when the rewrite is gone", () => {
    assert.equal(compactPrefixLength([user("summary")], [user("other")]), 0);
  });
});

describe("appendNewTurns", () => {
  it("keeps originals when every live user turn is already on screen", () => {
    const before = [user("a"), assistant("b")];
    assert.deepEqual(appendNewTurns(before, [user("a"), assistant("summary")]), before);
  });

  it("appends from the first unseen user turn", () => {
    const before = [user("a"), assistant("b")];
    const current = [user("a"), assistant("summary"), user("c"), assistant("d")];
    assert.deepEqual(appendNewTurns(before, current), [
      ...before,
      user("c"),
      assistant("d"),
    ]);
  });
});

describe("withDisplayHistory persistence", () => {
  let previousHome;
  let home;

  before(async () => {
    previousHome = process.env.PI_WEB_HOME;
    home = await mkdtemp(join(tmpdir(), "pi-web-display-"));
    process.env.PI_WEB_HOME = home;
  });

  after(async () => {
    if (previousHome === undefined) delete process.env.PI_WEB_HOME;
    else process.env.PI_WEB_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  it("reloads originals plus later turns from the overlay", async () => {
    const sessionPath = "/tmp/fake-session.jsonl";
    const before = [user("fix the bug"), assistant("done")];
    const after = [user("summary")];
    await saveDisplayOverlay(sessionPath, { before, after });
    const live = [...after, user("continue"), assistant("sure")];
    assert.deepEqual(await withDisplayHistory(sessionPath, live), [
      ...before,
      user("continue"),
      assistant("sure"),
    ]);
  });

  it("leaves a session with no overlay untouched", async () => {
    const live = [user("hello")];
    assert.deepEqual(await withDisplayHistory("/no-such-session.jsonl", live), live);
  });
});
