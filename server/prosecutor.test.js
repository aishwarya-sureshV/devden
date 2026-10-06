import test from "node:test";
import assert from "node:assert/strict";

import { changeNote, createProsecutor, turnError, historyBrief, parseVerdict, sessionHistory } from "./prosecutor.js";

test("parseVerdict reads the last verdict line", () => {
  assert.equal(parseVerdict("tried things\nVERDICT: GUILTY"), "guilty");
  assert.equal(parseVerdict("not VERDICT: GUILTY yet\nVERDICT: **ACQUITTED**"), "acquitted");
  assert.equal(parseVerdict("no verdict here"), null);
  assert.equal(parseVerdict(undefined), null);
});

test("sessionHistory keeps the user's turns, drops this task and our defense prompts", () => {
  const user = (text) => ({ role: "user", content: text });
  const reply = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
  const turns = sessionHistory(
    [
      user("build an LRU cache"),
      { role: "toolResult", content: "ok" },
      reply("built LRUCache"),
      user("make get() throw on miss"),
      reply("get now throws"),
      user("The prosecutor wrote failing tests against your change. Your task was: ..."),
      reply("OBJECTION: out of scope"),
      user("now add ttl"),
      reply("added ttl"),
    ],
    "now add ttl",
  );
  assert.deepEqual(
    turns.map(({ prompt, reply }) => [prompt, reply]),
    [
      ["build an LRU cache", "built LRUCache"],
      ["make get() throw on miss", "get now throws"],
    ],
  );
  assert.match(historyBrief(turns), /### Turn 2\nUser: make get\(\) throw on miss\nExecutor: get now throws/);
  assert.equal(historyBrief([]), "");
});

test("a failed executor turn stops the loop instead of starting a round", () => {
  const published = [];
  const prosecutor = createProsecutor({
    poolFor: () => ({ stop() {}, get: () => assert.fail("no round should start") }),
    publish: (_key, event) => published.push(event),
  });
  prosecutor.arm("k", { backend: "codex" });
  prosecutor.noteTask("k", "fix the toggle");
  prosecutor.onExecutorEvent("k", {
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429: 5-hour limit" },
  });
  prosecutor.onExecutorEvent("k", { type: "agent_end" }, {});
  prosecutor.onExecutorEvent("k", { type: "agent_settled" }, {});
  assert.equal(published.length, 1);
  assert.match(published[0].message, /429: 5-hour limit.*loop stopped/);
  assert.equal(prosecutor.armed("k").task, "");
});

test("changeNote points both sides at exactly what changed", () => {
  assert.equal(changeNote(null, "abc", 1), "", "git failed: say nothing, let it explore");
  assert.match(changeNote("", "abc123", 2), /changed no files since your last round/);
  assert.equal(changeNote("", "abc123", 1), "", "round 1 may have raced the turn: never claim nothing changed");
  const note = changeNote("M\tsrc/a.ts\nA\tsrc/b.ts", "abc123", 1);
  assert.match(note, /in this turn/);
  assert.match(note, /M\tsrc\/a\.ts\nA\tsrc\/b\.ts/);
  assert.match(note, /git diff abc123 -- <file>/);
  const many = Array.from({ length: 90 }, (_, i) => `M\tf${i}`).join("\n");
  assert.match(changeNote(many, "abc", 1), /and 10 more/);
});

test("turnError recognises a dead turn on every backend's shape", () => {
  assert.equal(turnError({ stopReason: "end_turn" }), "");
  assert.equal(turnError({ stopReason: "error", errorMessage: "429: 5-hour limit" }), "429: 5-hour limit");
  assert.equal(turnError({ stopReason: "failed" }), "the turn failed");
  assert.equal(turnError({ stopReason: "end_turn", errorMessage: "usage limit" }), "usage limit");
});
