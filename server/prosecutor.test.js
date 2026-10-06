import test from "node:test";
import assert from "node:assert/strict";

import { changeNote, createProsecutor, defensePrompt, SIDE_EFFECT_RULE, turnError, historyBrief, parseVerdict, sessionHistory } from "./prosecutor.js";

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

test("a failed executor turn pauses the case instead of starting a round", () => {
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
  const notices = published.filter((event) => event.type === "notice");
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /executor turn failed before round 1 \(429: 5-hour limit\).*paused, not closed/);
  assert.equal(prosecutor.armed("k").task, "fix the toggle", "case kept");
  assert.deepEqual(prosecutor.state("k").paused, { side: "executor", reason: "429: 5-hour limit", round: 0 });
  // Resume before round 1 re-sends the task itself; sending it is not a new case.
  const resumed = prosecutor.resume("k", {});
  assert.equal(resumed.prompt, "fix the toggle");
  prosecutor.noteTask("k", `Continuing a session that was running on Pi.\n\n---\n\n${resumed.prompt}`);
  assert.equal(prosecutor.armed("k").resuming, "");
  assert.equal(prosecutor.state("k").paused, null);
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

// ---- Fake backends for the switch/resume scenarios ---------------------

const wait = async (cond, what) => {
  for (let i = 0; i < 2500; i++) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const assistant = (text, error) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: error ? "error" : "end_turn",
  ...(error ? { errorMessage: error } : {}),
});

/**
 * A pool per backend. Each prosecutor agent answers its prompts from
 * `replies[backend]` in order: a string is the report, { error } a dead turn.
 */
function harness(replies) {
  const published = [];
  const agents = []; // every prosecutor process ever started, in order
  const live = new Map(); // `${backend}|${key}` -> agent
  const poolFor = (backend) => ({
    stop(key) {
      const agent = live.get(`${backend}|${key}`);
      if (agent) agent.alive = false;
      live.delete(`${backend}|${key}`);
    },
    get(key) {
      const id = `${backend}|${key}`;
      if (!live.has(id)) {
        const listeners = new Set();
        const agent = {
          backend, prompts: [], levels: [], alive: false, starts: 0,
          isAlive: () => agent.alive,
          start: (_cwd, options) => { agent.alive = true; agent.starts += 1; agent.model = options.model; return { ok: true }; },
          setThinkingLevel: (level) => agent.levels.push(level),
          onEvent: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
          prompt(message) {
            agent.prompts.push(message);
            const reply = replies[backend].shift();
            assert.ok(reply !== undefined, `${backend} got an unexpected prompt`);
            if (reply.hang) return { ok: true };
            setImmediate(() => {
              const message = reply.error ? assistant("partial notes", reply.error) : assistant(reply);
              for (const fn of [...listeners]) fn({ type: "message_end", message });
              for (const fn of [...listeners]) fn({ type: "agent_end" });
            });
            return { ok: true };
          },
        };
        agents.push(agent);
        live.set(id, agent);
      }
      return live.get(id);
    },
  });
  const prosecutor = createProsecutor({ poolFor, publish: (_key, event) => published.push(event) });
  /** An executor whose turns answer from `script` in order. */
  const executor = (model, script) => {
    const self = {
      cwd: "/nonexistent-prosecutor-test", lastState: { model: { id: model } }, prompts: [],
      getMessages: () => [],
      // A null script entry = the test answers this turn itself (ex.turn).
      prompt(message) { self.prompts.push(message); const reply = script.shift(); if (reply != null) self.turn(reply); return { ok: true }; },
      turn(reply) {
        setImmediate(() => {
          const message = reply.error ? assistant("", reply.error) : assistant(reply);
          prosecutor.onExecutorEvent("k", { type: "message_end", message }, self);
          prosecutor.onExecutorEvent("k", { type: "agent_end" }, self);
          prosecutor.onExecutorEvent("k", { type: "agent_settled" }, self);
        });
      },
    };
    return self;
  };
  const cards = () => published.filter((event) => event.type === "tool_execution_start");
  const ends = () => published.filter((event) => event.type === "tool_execution_end");
  return { prosecutor, agents, executor, published, cards, ends };
}

const isRiskMap = (prompt) => /write a risk map/.test(prompt);

test("chained switches keep one case: round, prompt type, effort and every predecessor's context carry", async () => {
  const replies = {
    A: ["R1-A risk map done\nVERDICT: GUILTY", { error: "codex usage_limit_exceeded" }, "R4-A still broken\nVERDICT: GUILTY"],
    B: ["R2-B still broken\nVERDICT: GUILTY", { error: "429 Pro 5-hour limit" }],
    C: ["R3-C still broken\nVERDICT: GUILTY", { error: "quota" }],
  };
  const h = harness(replies);
  const { prosecutor } = h;
  prosecutor.arm("k", { backend: "A", model: { provider: "p", id: "a-model" } });
  prosecutor.noteTask("k", "make parse() handle negatives");
  const ex1 = h.executor("ex-1", [null, null]);

  // Round 1 on A: the broad risk-map round at high effort.
  ex1.turn("E1 initial change");
  await wait(() => ex1.prompts.length === 1, "round 1 defense");
  assert.equal(h.cards()[0].args.description, "Round 1: try to break the change");
  assert.ok(isRiskMap(h.agents[0].prompts[0]));
  assert.deepEqual(h.agents[0].levels, ["high"]);

  // ex-1 answers R1; round 2 on A dies on a usage limit.
  ex1.turn("E1 fixed R1");
  await wait(() => prosecutor.state("k").paused, "round 2 pause");
  assert.deepEqual(prosecutor.state("k").paused, { side: "prosecutor", reason: "codex usage_limit_exceeded", round: 2 });
  assert.equal(prosecutor.state("k").round, 1, "round 2 will re-run, not count twice");
  assert.equal(prosecutor.armed("k").task, "make parse() handle negatives");

  // Prosecutor switch #1: A -> B. The case and its log stay.
  prosecutor.arm("k", { backend: "B", model: { provider: "p", id: "b-model" } });
  assert.equal(prosecutor.state("k").round, 1);
  assert.ok(prosecutor.resume("k", ex1).ok);
  await wait(() => ex1.prompts.length === 2, "round 2 defense to ex-1");
  const b = h.agents[1];
  assert.equal(b.backend, "B");
  assert.match(b.prompts[0], /^You are joining|Round 2\./m);
  assert.match(b.prompts[0], /taking over as the PROSECUTOR.*round 2/);
  assert.match(b.prompts[0], /R1-A risk map done/, "B sees A's round 1 report");
  assert.match(b.prompts[0], /### Round 2 \(a-model\) -- died: codex usage_limit_exceeded/);
  assert.ok(!isRiskMap(b.prompts[0].split("Round 2. The task")[1]), "round>1 prompt, not a new risk map");
  assert.deepEqual(b.levels, ["medium"]);

  // ex-1 dies answering round 2 -> executor side paused.
  ex1.turn({ error: "429: 5-hour limit" });
  await wait(() => prosecutor.state("k").paused, "executor pause");
  assert.deepEqual(prosecutor.state("k").paused, { side: "executor", reason: "429: 5-hour limit", round: 2 });

  // Executor switch #1: ex-1 -> ex-2. The resume prompt carries R1 and R2.
  const ex2 = h.executor("ex-2", [null]);
  const r1 = prosecutor.resume("k", ex2);
  assert.equal(r1.side, "executor");
  assert.match(r1.prompt, /R1-A risk map done/);
  assert.match(r1.prompt, /Executor \(ex-1\) answered:\nE1 fixed R1/);
  assert.match(r1.prompt, /The prosecutor's report:\n\nR2-B still broken/);
  // The client sends it (behind its transcript handoff) via /prompt -> noteTask.
  prosecutor.noteTask("k", `Continuing a session that was running on Pi.\n\n---\n\n${r1.prompt}`);
  assert.equal(prosecutor.state("k").round, 2, "resume prompt did not open a new case");
  ex2.turn("E2 fixed R2");

  // Round 3 on B dies -> prosecutor switch #2: B -> C.
  await wait(() => prosecutor.state("k").paused?.side === "prosecutor", "round 3 pause");
  assert.equal(prosecutor.state("k").paused.round, 3);
  prosecutor.arm("k", { backend: "C", model: { provider: "p", id: "c-model" } });
  prosecutor.resume("k", ex2);
  await wait(() => ex2.prompts.length === 1, "round 3 defense to ex-2");
  const c = h.agents[2];
  assert.match(c.prompts[0], /Round 3\./);
  assert.match(c.prompts[0], /R1-A risk map done/, "C still sees the FIRST predecessor");
  assert.match(c.prompts[0], /R2-B still broken/);
  assert.match(c.prompts[0], /E1 fixed R1/);
  assert.deepEqual(c.levels, ["medium"]);
  ex2.turn("E2 fixed R3");

  // Round 4 on C dies. Prosecutor switch #3: back to A (an earlier model,
  // fresh process); then ex-2 dies answering it.
  await wait(() => prosecutor.state("k").paused?.side === "prosecutor", "round 4 pause");
  assert.equal(prosecutor.state("k").paused.round, 4);
  prosecutor.arm("k", { backend: "A", model: { provider: "p", id: "a-model" } });
  ex2.prompt = (message) => { ex2.prompts.push(message); ex2.turn({ error: "usage_limit_exceeded" }); return { ok: true }; };
  prosecutor.resume("k", ex2);
  await wait(() => prosecutor.state("k").paused?.side === "executor", "ex-2 pause");
  const a2 = h.agents[3];
  assert.equal(a2.backend, "A");
  assert.notEqual(a2, h.agents[0], "switching back means a fresh A process");
  assert.match(a2.prompts[0], /Round 4\./);
  for (const earlier of ["R1-A risk map done", "R2-B still broken", "R3-C still broken", "-- died: quota"])
    assert.ok(a2.prompts[0].includes(earlier), `A (again) sees ${earlier}`);
  assert.equal(a2.prompts[0].split("taking over as the PROSECUTOR").length, 2, "briefs do not nest");
  assert.deepEqual(a2.levels, ["medium"]);

  // Executor switch #2: ex-2 -> ex-3 gets every round, every model.
  const ex3 = h.executor("ex-3", []);
  const r2 = prosecutor.resume("k", ex3);
  for (const earlier of ["R1-A risk map done", "E1 fixed R1", "R2-B still broken", "E2 fixed R2", "R3-C still broken", "E2 fixed R3"])
    assert.ok(r2.prompt.includes(earlier), `ex-3 sees ${earlier}`);
  assert.match(r2.prompt, /The prosecutor's report:\n\nR4-A still broken/);
  prosecutor.noteTask("k", r2.prompt);
  replies.A.push("R5-A still broken\nVERDICT: GUILTY");
  ex3.turn("E3 fixed R4");

  // Round 5 is the last: MAX_ROUNDS counted across every switch.
  await wait(() => h.published.some((event) => /after 5 rounds/.test(event.message ?? "")), "MAX_ROUNDS stop");
  assert.equal(a2.prompts.length, 2, "same A process kept its memory for round 5");
  assert.match(a2.prompts[1], /^Round 5\./, "live process: no re-brief");
  assert.deepEqual(a2.levels, ["medium", "medium"]);
  assert.deepEqual(
    h.cards().map((card) => card.args.description.split(":")[0]),
    ["Round 1", "Round 2", "Round 2", "Round 3", "Round 3", "Round 4", "Round 4", "Round 5"],
  );
  assert.equal(h.cards().filter((card) => card.args.effort === "high").length, 1, "only the real round 1 ran at high");
  assert.equal(h.agents.filter((agent) => agent.prompts.some(isRiskMap)).length, 1, "one risk map in the whole case");
});

test("resume without a switch re-runs the failed round on the same model", async () => {
  const h = harness({ A: ["R1\nVERDICT: GUILTY", { error: "rate limit" }, "R2 ok\nVERDICT: ACQUITTED"] });
  h.prosecutor.arm("k", { backend: "A" });
  h.prosecutor.noteTask("k", "task");
  const ex = h.executor("ex", ["fixed"]);
  ex.turn("first");
  await wait(() => h.prosecutor.state("k").paused, "pause");
  h.agents[0].alive = true; // a limit kills the turn, not the process
  h.prosecutor.resume("k", ex);
  await wait(() => h.published.some((event) => /gave up after 2 rounds/.test(event.message ?? "")), "acquittal");
  assert.equal(h.agents.length, 1, "same process, same memory");
  assert.match(h.agents[0].prompts[2], /^Round 2\./);
  assert.deepEqual(h.agents[0].levels, ["high", "medium", "medium"]);
});

test("effort: switching only effort keeps the agent; a user pick wins on every round", async () => {
  const h = harness({ A: ["R1\nVERDICT: GUILTY", "R2\nVERDICT: ACQUITTED"] });
  h.prosecutor.arm("k", { backend: "A", model: { provider: "p", id: "m" } });
  h.prosecutor.noteTask("k", "task");
  const ex = h.executor("ex", [null]);
  ex.turn("first");
  await wait(() => ex.prompts.length === 1, "defense");
  h.prosecutor.arm("k", { backend: "A", model: { provider: "p", id: "m" }, effort: "low" });
  ex.turn("fixed");
  await wait(() => h.published.some((event) => /gave up/.test(event.message ?? "")), "acquittal");
  assert.equal(h.agents.length, 1);
  assert.equal(h.agents[0].alive, true, "effort change did not stop it");
  assert.deepEqual(h.agents[0].levels, ["high", "low"]);
});

test("a new user prompt still opens a new case, even from a paused one", async () => {
  const h = harness({ A: ["R1\nVERDICT: GUILTY"] });
  h.prosecutor.arm("k", { backend: "A" });
  h.prosecutor.noteTask("k", "task one");
  const ex = h.executor("ex", [{ error: "429" }]);
  ex.turn("first");
  await wait(() => h.prosecutor.state("k").paused, "pause");
  assert.equal(h.prosecutor.state("k").round, 1);
  h.prosecutor.noteTask("k", "task two");
  const current = h.prosecutor.armed("k");
  assert.equal(current.round, 0);
  assert.equal(current.paused, null);
  assert.deepEqual(current.log, []);
  assert.equal(current.task, "task two");
});

test("switching the prosecutor mid-round re-runs that round on the new one, not round 1", async () => {
  const h = harness({ A: ["R1\nVERDICT: GUILTY", { hang: true }], B: ["R2-B\nVERDICT: ACQUITTED"] });
  h.prosecutor.arm("k", { backend: "A" });
  h.prosecutor.noteTask("k", "task");
  const ex = h.executor("ex", ["fixed"]);
  // Round 2 on A never answers (hung), then the user switches to B.
  ex.turn("first");
  await wait(() => h.agents[0]?.prompts.length === 2, "round 2 started on A");
  h.prosecutor.arm("k", { backend: "B" });
  await wait(() => h.published.some((event) => /gave up after 2 rounds/.test(event.message ?? "")), "acquittal on B");
  assert.match(h.agents[1].prompts[0], /Round 2\./);
  assert.match(h.agents[1].prompts[0], /R1\nVERDICT: GUILTY/);
});

// ---- Server-side checks: integrity, boundary, gate, durability ----------

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prosecutionPrompt } from "./prosecutor.js";
import { checkIntegrity, isTestPath, reportedTestFiles, normalizeConfig, parseFindings, parseObjections, runGate, weakening } from "./prosecutor-checks.js";
import { takeSnapshot } from "./snapshots.js";

/** A scratch git repo: product code in src/, one existing test. */
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), "prosecutor-checks-"));
  const sh = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  sh("init", "-q");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/add.js"), "export const add = (a, b) => a + b;\n");
  sh("add", "-A");
  sh("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return { dir, write: (path, text) => writeFileSync(join(dir, path), text), read: (path) => readFileSync(join(dir, path), "utf8"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Executor/prosecutor whose turns run `act()` (edit files) then reply. */
function repoHarness(dir, prosecutorTurns, { config = null } = {}) {
  const published = [];
  const listeners = new Set();
  const agent = {
    alive: false, prompts: [],
    isAlive: () => agent.alive,
    start: () => ((agent.alive = true), { ok: true }),
    onEvent: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    prompt(message) {
      agent.prompts.push(message);
      const turn = prosecutorTurns.shift();
      assert.ok(turn, "unexpected prosecutor prompt");
      setImmediate(() => {
        turn.act?.();
        for (const fn of [...listeners]) fn({ type: "message_end", message: assistant(turn.reply) });
        for (const fn of [...listeners]) fn({ type: "agent_end" });
      });
      return { ok: true };
    },
  };
  const prosecutor = createProsecutor({
    poolFor: () => ({ get: () => agent, stop: () => (agent.alive = false) }),
    publish: (_key, event) => published.push(event),
    configFor: () => config,
  });
  const executor = (script) => {
    const self = {
      cwd: dir, prompts: [], getMessages: () => [],
      prompt(message) { self.prompts.push(message); const next = script.shift(); if (next) self.turn(next); return { ok: true }; },
      turn({ act, reply }) {
        setImmediate(() => {
          act?.();
          prosecutor.onExecutorEvent("k", { type: "message_end", message: assistant(reply) }, self);
          prosecutor.onExecutorEvent("k", { type: "agent_end" }, self);
        });
      },
    };
    return self;
  };
  const notices = () => published.filter((event) => event.type === "notice").map((event) => event.message);
  return { prosecutor, agent, executor, published, notices };
}

const TEST = "src/add.test.js";
const goodTest = `import assert from "node:assert";\nimport { add } from "./add.js";\nassert.equal(add(0.1, 0.2), 0.3);\nassert.equal(add(1, 2), 3);\n`;

test("integrity: an executor repair that edits the prosecutor's test is flagged and pauses the case", async () => {
  const repo = scratchRepo();
  try {
    const h = repoHarness(repo.dir, [
      { act: () => repo.write(TEST, goodTest), reply: `FINDING F1 | requirement: "adds numbers" | test: ${TEST}:3 add floats | command: node ${TEST}\nVERDICT: GUILTY` },
    ]);
    h.prosecutor.arm("k", { backend: "A" });
    h.prosecutor.noteTask("k", "write add()", takeSnapshot(repo.dir, "turn"));
    // The "repair" weakens the test instead of fixing add().
    const ex = h.executor([{ act: () => repo.write(TEST, goodTest.replace(/assert\.equal\(add\(0\.1.*\n/, "")), reply: "FIXED" }]);
    ex.turn({ reply: "wrote add" });
    await wait(() => h.prosecutor.state("k").paused, "integrity pause");
    const state = h.prosecutor.state("k");
    assert.equal(state.status, "stopped");
    assert.equal(state.paused.side, "executor");
    assert.match(state.paused.reason, /changed the prosecutor's tests: src\/add\.test\.js edited, 1 check line\(s\) removed/);
    assert.deepEqual(state.owned, [TEST]);
    assert.equal(state.findings[0].id, "F1");
    assert.equal(h.agent.prompts.length, 1, "no prosecutor round judged the weakened test");
    assert.equal(state.round, 1, "the failed repair did not count as a round");
    // Resume tells the executor to restore the tests before answering again.
    const resumed = h.prosecutor.resume("k", ex);
    assert.match(resumed.prompt, /restore them exactly as they were/);
    assert.match(resumed.prompt, /The prosecutor's report:/);
  } finally {
    repo.done();
  }
});

test("integrity: deletion and .skip are named", async () => {
  const repo = scratchRepo();
  try {
    repo.write(TEST, goodTest);
    repo.write("src/b.test.js", "test('x', () => { assert.ok(1) })\n");
    const snap = await takeSnapshot(repo.dir, "round end");
    rmSync(join(repo.dir, TEST));
    repo.write("src/b.test.js", "test.skip('x', () => { assert.ok(1) })\n");
    const flags = await checkIntegrity(repo.dir, snap.commit, [TEST, "src/b.test.js"]);
    assert.deepEqual(flags.map((flag) => [flag.path, flag.kind, flag.disabled ?? 0]).sort(), [
      ["src/add.test.js", "deleted", 0],
      ["src/b.test.js", "edited", 1],
    ]);
    assert.deepEqual(await checkIntegrity(repo.dir, snap.commit, []), []);
  } finally {
    repo.done();
  }
  assert.deepEqual(weakening("-  expect(x).toBe(1)\n+  it.only('y')\n"), { removedChecks: 1, disabled: 1 });
});

test("boundary: a prosecutor that edits product code is reverted, flagged and its round voided", async () => {
  const repo = scratchRepo();
  try {
    const h = repoHarness(repo.dir, [
      {
        act: () => {
          repo.write(TEST, goodTest);
          repo.write("src/add.js", "export const add = () => 42;\n");
          repo.write("src/helper.js", "junk\n");
        },
        reply: `${TEST}:3 fails\nVERDICT: GUILTY`,
      },
    ]);
    h.prosecutor.arm("k", { backend: "A" });
    h.prosecutor.noteTask("k", "write add()", takeSnapshot(repo.dir, "turn"));
    const ex = h.executor([]);
    ex.turn({ reply: "wrote add" });
    await wait(() => h.prosecutor.state("k").paused, "breach pause");
    const state = h.prosecutor.state("k");
    assert.equal(state.paused.side, "prosecutor");
    assert.match(state.paused.reason, /outside the test patterns \(M src\/add\.js, A src\/helper\.js\) -- reverted, round void/);
    assert.equal(repo.read("src/add.js"), "export const add = (a, b) => a + b;\n", "product code restored");
    assert.equal(existsSync(join(repo.dir, "src/helper.js")), false, "added file removed");
    assert.equal(repo.read(TEST), goodTest, "its own test file kept");
    assert.equal(state.round, 0, "the round re-runs");
    assert.equal(ex.prompts.length, 0, "the executor never saw the voided verdict");
    assert.equal(state.flags[0].side, "prosecutor");
  } finally {
    repo.done();
  }
});

test("gate: acquittal + failing gate is not accepted; it goes back to the executor, then verifies", async () => {
  const repo = scratchRepo();
  try {
    repo.write("check.sh", "grep -q 'a + b + 0' src/add.js || { echo 'typecheck: add is wrong'; exit 2; }\n");
    const config = normalizeConfig({ commands: [{ run: "sh check.sh", timeoutSec: 10 }, { run: "node --check {file}" }] });
    const h = repoHarness(repo.dir, [
      { act: () => repo.write(TEST, goodTest), reply: "all pass\nVERDICT: ACQUITTED" },
      { reply: "re-ran, all pass\nVERDICT: ACQUITTED" },
    ], { config });
    h.prosecutor.arm("k", { backend: "A" });
    h.prosecutor.noteTask("k", "write add()", takeSnapshot(repo.dir, "turn"));
    const ex = h.executor([{ act: () => repo.write("src/add.js", "export const add = (a, b) => a + b + 0;\n"), reply: "fixed the gate" }]);
    ex.turn({ reply: "wrote add" });
    await wait(() => ex.prompts.length === 1, "gate failure sent back");
    assert.match(ex.prompts[0], /acceptance gate after the prosecutor acquitted/);
    assert.match(ex.prompts[0], /\$ sh check\.sh\n\(exit 2\)\ntypecheck: add is wrong/);
    assert.ok(h.notices().some((text) => /gave up after 1 round, but the server's acceptance gate failed/.test(text)));
    await wait(() => h.prosecutor.state("k").status === "verified", "verified");
    const { gate } = h.prosecutor.state("k");
    assert.equal(gate.state, "verified");
    assert.deepEqual(gate.results.map((result) => result.command), ["sh check.sh", `node --check '${TEST}'`], "{file} = the prosecutor's test, quoted");
    assert.match(h.agent.prompts[1], /acceptance gate failed, so the executor was sent back/);
    assert.ok(h.notices().at(-1).includes("diff accepted"));
  } finally {
    repo.done();
  }
});

test("gate: no config = inconclusive, never accepted; a hung command times out", async () => {
  const repo = scratchRepo();
  try {
    const h = repoHarness(repo.dir, [{ reply: "VERDICT: ACQUITTED" }]);
    h.prosecutor.arm("k", { backend: "A" });
    h.prosecutor.noteTask("k", "task", takeSnapshot(repo.dir, "turn"));
    h.executor([]).turn({ reply: "done" });
    await wait(() => h.prosecutor.state("k").status === "inconclusive", "inconclusive");
    assert.match(h.notices().at(-1), /no acceptance gate configured.*NOT verified/);
    assert.equal(h.prosecutor.state("k").gate.state, "not_configured");
    assert.ok(!h.notices().some((text) => /diff accepted/.test(text)));

    const started = Date.now();
    const gate = await runGate(repo.dir, normalizeConfig({ commands: [{ run: "echo starting; sleep 30", timeoutSec: 1 }] }));
    assert.ok(Date.now() - started < 5000, "killed at the timeout");
    assert.equal(gate.ok, false);
    assert.equal(gate.results[0].timedOut, true);
    assert.match(gate.results[0].output, /starting/, "real output captured");
  } finally {
    repo.done();
  }
});

test("lenient parsing: findings, objections, verdict variants; missing verdict is asked for once", async () => {
  assert.equal(parseVerdict("Verdict - **Not guilty**"), "acquitted");
  assert.equal(parseVerdict("**VERDICT**: guilty"), "guilty");
  assert.deepEqual(parseFindings(`- **FINDING F2** | requirement: "rejects empty" | test: src/a.test.ts:12 empty | command: npm test`), [
    { id: "F2", requirement: "rejects empty", test: "src/a.test.ts:12 empty", command: "npm test" },
  ]);
  assert.deepEqual(parseFindings("fails at tests/x.spec.js:4 and tests/x.spec.js:4"), [{ id: "F1", test: "tests/x.spec.js:4" }], "fallback: path:line refs");
  assert.deepEqual(parseFindings("nothing here"), []);
  assert.deepEqual(reportedTestFiles("see file:///private/tmp/r/src/a.test.js:3, ../up.test.js:1 and ./src/b.test.js:9"), ["src/b.test.js"], "only repo-relative paths");
  assert.deepEqual(parseObjections("OBJECTION: F2 empty -- the task never says empty is invalid"), [
    { target: "F2 empty", reason: "the task never says empty is invalid" },
  ]);

  const repo = scratchRepo();
  try {
    const h = repoHarness(repo.dir, [{ reply: "I tried hard, everything passed." }, { reply: "VERDICT: ACQUITTED" }]);
    h.prosecutor.arm("k", { backend: "A" });
    h.prosecutor.noteTask("k", "task", takeSnapshot(repo.dir, "turn"));
    h.executor([]).turn({ reply: "done" });
    await wait(() => h.prosecutor.state("k").status === "inconclusive", "settled");
    assert.match(h.agent.prompts[1], /did not end with a verdict line/);
    assert.match(h.notices().at(-1), /gave up after 1 round/, "the re-asked verdict counted");
    // Structured findings with no verdict line = guilty, no stop.
    const h2 = repoHarness(repo.dir, [{ reply: `FINDING F1 | test: ${TEST}:3 x` }]);
    h2.prosecutor.arm("k", { backend: "A" });
    h2.prosecutor.noteTask("k", "task", takeSnapshot(repo.dir, "turn"));
    const ex = h2.executor([null]);
    ex.turn({ reply: "done" });
    await wait(() => ex.prompts.length === 1, "sent back");
    assert.equal(h2.agent.prompts.length, 1);
  } finally {
    repo.done();
  }
});

test("scope rules and test patterns", () => {
  const prompt = prosecutionPrompt("t", 1, "");
  assert.match(prompt, /Always in scope.*SECURITY issues.*PERFORMANCE problems/s);
  assert.match(prompt, /edge inputs are in scope when the requirements support them/);
  assert.match(prompt, /pathological or absurdly large inputs/);
  assert.match(prompt, /contrived input/);
  assert.doesNotMatch(prompt, /Not a bug:[^\n]*performance/);
  assert.match(prosecutionPrompt("t", 2, "d"), /FINDING F<n>/);
  for (const path of ["src/a.test.ts", "a.spec.js", "src/__tests__/x.js", "test/x.js", "pkg/tests/y.py"]) assert.ok(isTestPath(path), path);
  for (const path of ["src/a.ts", "testing.js", "src/contest.js"]) assert.ok(!isTestPath(path), path);
  assert.deepEqual(normalizeConfig({ commands: ["npm test", { run: "x".repeat(600) }], testPatterns: [] }).commands, [{ run: "npm test", timeoutSec: 300 }]);
});

test("after round 1 the defense asks for a side-effect check on every fix", async () => {
  assert.ok(defensePrompt("t", "r").includes(SIDE_EFFECT_RULE));
  const h = harness({ A: ["R1\nVERDICT: GUILTY"] });
  h.prosecutor.arm("k", { backend: "A" });
  h.prosecutor.noteTask("k", "task");
  const ex = h.executor("ex", [null]);
  ex.turn("first");
  await wait(() => ex.prompts.length === 1, "defense");
  assert.match(ex.prompts[0], /what else reads or writes the state you changed/);
});

test("state carries a case id per task and the last verdict, announced as they change", async () => {
  const h = harness({ A: ["R1\nVERDICT: GUILTY"] });
  h.prosecutor.arm("k", { backend: "A" });
  h.prosecutor.noteTask("k", "task one");
  assert.deepEqual(
    [h.prosecutor.state("k").caseId, h.prosecutor.state("k").verdict, h.prosecutor.state("k").round],
    [1, null, 0],
  );
  const ex = h.executor("ex", [null]);
  ex.turn("first");
  const states = () => h.published.filter((event) => event.type === "prosecutor_state");
  await wait(() => states().at(-1).verdict === "guilty", "guilty verdict announced");
  assert.equal(states().at(-1).round, 1);
  h.prosecutor.noteTask("k", "task two");
  assert.equal(h.prosecutor.state("k").caseId, 2);
  assert.equal(h.prosecutor.state("k").verdict, null);
});
