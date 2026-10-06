import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Never the real ~/.devden. Set before any module opens the database.
process.env.DEVDEN_HOME = mkdtempSync(join(tmpdir(), "devden-prosecutor-home-"));

const { caseBrief, createProsecutor } = await import("./prosecutor.js");
const { createProsecutorStore } = await import("./prosecutor-store.js");
const { db } = await import("./db.js");
const { takeSnapshot } = await import("./snapshots.js");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "devden-prosecutor-case-"));
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "devden-prosecutor-repo-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "kept.txt"), "original\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return dir;
}

const wait = async (cond, what) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
};

function assistant(text) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" };
}

/** A prosecutor process that answers `replies` in order and never ends a hung reply. */
function prosecutorAgent(replies) {
  const listeners = new Set();
  const agent = {
    prompts: [],
    alive: false,
    phaseAtDispatch: "",
    isAlive: () => agent.alive,
    start() {
      agent.alive = true;
      return { ok: true };
    },
    setThinkingLevel() {},
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    prompt(message) {
      agent.prompts.push(message);
      const reply = replies.shift();
      if (!reply || reply.hang) return { ok: true };
      setImmediate(() => {
        for (const fn of listeners) fn({ type: "message_end", message: assistant(reply) });
        for (const fn of listeners) fn({ type: "agent_end" });
      });
      return { ok: true };
    },
  };
  return agent;
}

const FINDING = "FINDING-TOGGLE-17 the toggle ignores false";
const GUILTY = `${FINDING}\nVERDICT: GUILTY`;

test("migration adds cases and case_rounds on top of a shipped database", () => {
  const fresh = tempHome();
  const conn = db(fresh);
  assert.equal(conn.prepare("PRAGMA user_version").get().user_version, 2);
  const columns = (table) => conn.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  for (const name of [
    "id", "session_id", "cwd", "task", "prosecutor_backend", "prosecutor_model",
    "prosecutor_effort", "executor_backend", "executor_model", "round", "phase",
    "baseline_commit", "last_report", "last_defense", "updated_at", "extra",
  ])
    assert.ok(columns("cases").includes(name), name);
  for (const name of ["case_id", "seq", "round", "by", "prompt", "report", "reply", "reply_by", "died", "findings"])
    assert.ok(columns("case_rounds").includes(name), name);

  // A database that already shipped migration 1 gains the new tables and
  // keeps its rows. The shipped migration text is not re-run.
  const upgraded = tempHome();
  const file = join(upgraded, "devden.db");
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE docs (
    ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (ns, key)
  )`);
  raw.exec(`INSERT INTO docs (ns, key, value, updated_at) VALUES ('keep', 'me', '"hi"', 1)`);
  raw.exec("PRAGMA user_version = 1");
  raw.close();
  const next = db(upgraded);
  assert.equal(next.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(next.prepare("SELECT value FROM docs WHERE ns = 'keep' AND key = 'me'").get().value, '"hi"');
  assert.ok(next.prepare("SELECT name FROM sqlite_master WHERE name = 'cases'").get());
});

test("case_rounds round-trip into caseBrief, including extra fields and findings", () => {
  const home = tempHome();
  const store = createProsecutorStore(home);
  const gate = { state: "running", round: 2, configured: true, ok: false, at: 10, results: [{ name: "suite" }] };
  store.save({
    id: "case-1",
    sessionId: "/tmp/sessions/toggle.jsonl",
    cwd: "/tmp/repo",
    task: "handle negatives",
    backend: "codex",
    model: { provider: "openai", id: "gpt" },
    effort: "high",
    executorBackend: "pi",
    executorModel: { provider: "anthropic", id: "sonnet" },
    round: 2,
    phase: "verification_pending",
    baselineCommit: "abc",
    defense: "fixed the sign",
    lastReport: "still fails",
    paused: { side: "prosecutor", reason: "limit", round: 2, note: "switch model" },
    status: "verifying",
    gate,
    owned: ["parse.test.js"],
    findings: [{ id: "case-f", requirement: "negatives" }],
    flags: [{ round: 1, side: "prosecutor", text: "flaky" }],
    gateNote: "rerun",
    extra: { customProbe: { untouched: true }, status: "verifying" },
    log: [
      {
        round: 1,
        by: "gpt",
        prompt: "map the risks",
        report: "sign bug\nVERDICT: GUILTY",
        reply: "fixed the sign",
        replyBy: "sonnet",
        findings: [{ id: "f1", requirement: "negatives", test: "parse.test.js:4", command: "npm test" }],
      },
      {
        round: 2,
        by: "acceptance gate",
        prompt: "check acceptance",
        report: "gate output",
        findings: [{ id: "g1", test: "gate.test.js:1" }],
      },
    ],
    // A process handle must not be serialized with the case.
    executor: { pid: 999, kill() {} },
    busy: true,
  });

  const loaded = store.loadBySession("/tmp/sessions/toggle.jsonl");
  assert.equal(loaded.backend, "codex");
  assert.deepEqual(loaded.model, { provider: "openai", id: "gpt" });
  assert.equal(loaded.effort, "high");
  assert.equal(loaded.executorBackend, "pi");
  assert.deepEqual(loaded.executorModel, { provider: "anthropic", id: "sonnet" });
  assert.equal(loaded.baselineCommit, "abc");
  assert.equal(loaded.defense, "fixed the sign");
  assert.equal(loaded.lastReport, "still fails");
  assert.equal(loaded.paused.note, "switch model");
  assert.equal(loaded.status, "verifying");
  assert.deepEqual(loaded.gate, gate);
  assert.deepEqual(loaded.owned, ["parse.test.js"]);
  assert.deepEqual(loaded.findings, [{ id: "case-f", requirement: "negatives" }]);
  assert.deepEqual(loaded.flags, [{ round: 1, side: "prosecutor", text: "flaky" }]);
  assert.equal(loaded.gateNote, "rerun");
  assert.deepEqual(loaded.customProbe, { untouched: true });
  assert.equal(loaded.executor, undefined);
  assert.equal(loaded.busy, false);
  assert.deepEqual(loaded.log[0].findings, [
    { id: "f1", requirement: "negatives", test: "parse.test.js:4", command: "npm test" },
  ]);
  assert.equal(loaded.log[1].by, "acceptance gate");
  assert.deepEqual(loaded.log[1].findings, [{ id: "g1", test: "gate.test.js:1" }]);

  const brief = caseBrief(loaded.log, 3);
  assert.match(brief, /acceptance gate/);
  assert.match(brief, /sign bug/);
  assert.match(brief, /gate output/);
  assert.match(brief, /fixed the sign/);

  loaded.extra.another = { y: 2 };
  loaded.gate = { ...loaded.gate, ok: true };
  loaded.executor = { pid: 999, kill() {} };
  store.save(loaded);
  const again = store.loadBySession("/tmp/sessions/toggle.jsonl");
  assert.equal(again.extra.another.y, 2);
  assert.equal(again.customProbe.untouched, true);
  assert.equal(again.gate.ok, true);
  assert.equal(again.executor, undefined);
  const raw = db(home).prepare("SELECT extra FROM cases WHERE id = 'case-1'").get();
  assert.equal(raw.extra.includes("999"), false);
  assert.equal(raw.extra.includes("kill"), false);
});

test("a baseline promise is saved only once it resolves", async () => {
  const home = tempHome();
  const store = createProsecutorStore(home);
  const sessionId = "/tmp/sessions/base.jsonl";
  let resolveSnap;
  const snapshot = new Promise((resolve) => {
    resolveSnap = resolve;
  });
  const prosecutor = createProsecutor({
    poolFor: () => ({ stop() {}, get: () => assert.fail("no round") }),
    publish() {},
    store,
    sessionInfo: () => ({ sessionId, cwd: "/tmp/repo", executorBackend: "pi" }),
  });
  prosecutor.arm("tab-key", { backend: "codex" });
  prosecutor.noteTask("tab-key", "fix the toggle", snapshot);
  const early = db(home).prepare("SELECT baseline_commit, extra FROM cases").get();
  assert.ok(early, "the case is stored before the snapshot finishes");
  assert.equal(early.baseline_commit, null);
  assert.equal(JSON.parse(early.extra).base, undefined);
  resolveSnap({ ok: true, commit: "abc123" });
  await snapshot;
  await new Promise((resolve) => setImmediate(resolve));
  const late = db(home).prepare("SELECT baseline_commit FROM cases").get();
  assert.equal(late.baseline_commit, "abc123");
});

test("a saved failing report survives a restart and resumes the repair", async () => {
  const home = tempHome();
  const dir = repo();
  const sessionId = "/tmp/sessions/crash.jsonl";
  const inner = createProsecutorStore(home);
  const phases = [];
  const store = {
    save(current) {
      phases.push(current.phase);
      inner.save(current);
    },
    loadBySession: (id) => inner.loadBySession(id),
    unfinished: () => inner.unfinished(),
  };
  const agent = prosecutorAgent([GUILTY]);
  let prosecutorGets = 0;
  const first = createProsecutor({
    poolFor: () => ({
      stop() {},
      get() {
        prosecutorGets += 1;
        agent.phaseAtDispatch = phases.at(-1) ?? "";
        return agent;
      },
    }),
    publish() {},
    store,
    sessionInfo: () => ({
      sessionId,
      cwd: dir,
      executorBackend: "codex",
      executorModel: { provider: "p", id: "exec-model" },
    }),
  });
  const snap = await takeSnapshot(dir, "before the task");
  assert.equal(snap.ok, true);
  first.arm("tab-1", { backend: "A", model: { provider: "p", id: "p-model" } });
  first.noteTask("tab-1", "fix the toggle", snap);
  const executor = {
    cwd: dir,
    sessionFile: sessionId,
    lastState: { model: { id: "exec-model", provider: "p" } },
    prompts: [],
    phaseAtDispatch: "",
    getMessages: () => [],
    prompt(message) {
      executor.prompts.push(message);
      executor.phaseAtDispatch = phases.at(-1) ?? "";
      executor.savedAtDispatch = inner.loadBySession(sessionId);
      return { ok: true };
    },
  };
  const reply = assistant("I changed the toggle");
  first.onExecutorEvent("tab-1", { type: "message_end", message: reply }, executor);
  first.onExecutorEvent("tab-1", { type: "agent_end" }, executor);
  first.onExecutorEvent("tab-1", { type: "agent_settled" }, executor);
  await wait(() => executor.prompts.length === 1, "repair dispatch");

  assert.equal(agent.phaseAtDispatch, "review_pending");
  assert.equal(executor.phaseAtDispatch, "repair_pending");
  assert.match(executor.savedAtDispatch.lastReport, /FINDING-TOGGLE-17/);
  assert.equal(executor.savedAtDispatch.phase, "repair_pending");
  const reviewPending = phases.indexOf("review_pending");
  const reviewRunning = phases.indexOf("review_running");
  const repairPending = phases.indexOf("repair_pending");
  const repairRunning = phases.lastIndexOf("repair_running");
  assert.ok(reviewPending !== -1 && reviewPending < reviewRunning);
  assert.ok(reviewRunning < repairPending && repairPending < repairRunning);
  assert.equal(inner.loadBySession(sessionId).phase, "repair_running");

  // The repair was in progress. The workspace then moved. Restart.
  writeFileSync(join(dir, "kept.txt"), "half edited\n");
  writeFileSync(join(dir, "leaked.txt"), "created mid repair\n");
  const before = prosecutorGets;
  let resumedGets = 0;
  const restarted = createProsecutor({
    poolFor: () => ({
      stop() {},
      get() {
        resumedGets += 1;
        assert.fail("repair resume must not start a prosecutor round");
      },
    }),
    publish() {},
    store: inner,
    sessionInfo: () => ({ sessionId, cwd: dir }),
  });
  const recovered = await restarted.recover();
  assert.equal(recovered.length, 1);
  assert.equal(prosecutorGets, before);
  assert.equal(resumedGets, 0, "recover does not resume");
  assert.equal(recovered[0].round, 1, "the finished guilty round still counts");
  assert.equal(recovered[0].phase, "paused");
  assert.equal(recovered[0].interrupted, true);
  assert.match(recovered[0].log[0].report, /FINDING-TOGGLE-17/);
  assert.match(recovered[0].changes, /kept\.txt/);
  assert.match(recovered[0].changes, /leaked\.txt/);
  assert.notEqual(recovered[0].phase, "accepted");

  // A refreshed tab has a new key. The session file is what finds the case.
  const viewed = restarted.state("tab-2", sessionId);
  assert.equal(viewed.armed, true);
  assert.equal(viewed.interrupted, true);
  assert.equal(viewed.open, true);
  assert.match(viewed.changes, /leaked\.txt/);

  // The composer arms before the session file is known. That shell must not
  // hide the case once the file arrives.
  const late = createProsecutor({
    poolFor: () => ({ stop() {}, get: () => assert.fail("shell") }),
    publish() {},
    store: inner,
    sessionInfo: () => ({ sessionId: "", cwd: dir }),
  });
  late.arm("tab-late", { backend: "A", model: { provider: "p", id: "p-model" } });
  assert.equal(late.state("tab-late").interrupted, false);
  assert.equal(late.state("tab-late", sessionId).interrupted, true);
  // changedSince is async; the file list arrives on the next prosecutor_state.
  await wait(
    () => (late.state("tab-late").changes ?? "").includes("leaked.txt"),
    "changed files after the session file arrives",
  );
  assert.match(late.state("tab-late").changes, /leaked\.txt/);
  assert.match(late.armed("tab-late").log[0].report, /FINDING-TOGGLE-17/);

  const again = createProsecutor({
    poolFor: () => ({ stop() {}, get: () => assert.fail("second recover") }),
    publish() {},
    store: inner,
    sessionInfo: () => ({ sessionId, cwd: dir }),
  });
  const twice = await again.recover();
  assert.equal(twice[0].round, 1, "a second restart does not drop the round again");
  assert.match(twice[0].log[0].report, /FINDING-TOGGLE-17/);

  // A tab opening the session arms with its own saved pick. That attaches;
  // it must not swap the stored prosecutor. A later pick on that tab does.
  const ui = createProsecutor({
    poolFor: () => ({ stop() {}, get: () => assert.fail("ui attach") }),
    publish() {},
    store: inner,
    sessionInfo: () => ({ sessionId, cwd: dir }),
  });
  await ui.recover();
  ui.arm("tab-ui", { backend: "B", sessionFile: sessionId });
  assert.equal(ui.state("tab-ui").backend, "A");
  assert.equal(ui.state("tab-ui").model.id, "p-model");
  assert.equal(ui.state("tab-ui").interrupted, true);
  ui.arm("tab-ui", { backend: "B", sessionFile: sessionId });
  assert.equal(ui.state("tab-ui").backend, "B", "a pick on the attached tab switches");

  const result = restarted.resume("tab-2", executor, sessionId);
  assert.equal(result.ok, true);
  assert.equal(result.side, "executor");
  assert.match(result.prompt, /FINDING-TOGGLE-17/);
  assert.match(result.prompt, /Recheck the files and re-run the tests before repeating an edit/);
  assert.match(result.prompt, /Never assume a command that was in progress finished/);
  assert.match(result.prompt, /leaked\.txt/);
  assert.doesNotMatch(result.prompt, /diff accepted|gave up/);
  assert.notEqual(restarted.state("tab-2").phase, "accepted");
  assert.equal(resumedGets, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("each phase recovers explicitly, and a running round does not count", async () => {
  const guilty = {
    round: 1,
    by: "p-model",
    prompt: "round 1 prompt",
    report: `${FINDING}\nVERDICT: GUILTY`,
    reply: "fixed the toggle",
    replyBy: "ex-model",
    findings: [{ id: "f1", requirement: "toggle off", test: "toggle.test.js:4", command: "npm test" }],
  };
  const acquittal = {
    round: 2,
    by: "p-model",
    prompt: "round 2 prompt",
    report: "nothing left\nVERDICT: ACQUITTED",
    findings: [{ id: "f2", test: "toggle.test.js:9" }],
  };
  const specs = [
    {
      phase: "executor_running",
      round: 0,
      log: [],
      expectRound: 0,
      side: "executor",
      prompt: /fix the toggle/,
    },
    {
      phase: "review_pending",
      round: 0,
      log: [],
      expectRound: 0,
      side: "prosecutor",
      prompt: /write a risk map/,
    },
    {
      phase: "review_pending",
      round: 1,
      log: [guilty],
      expectRound: 1,
      side: "prosecutor",
      prompt: /Round 2\./,
    },
    {
      phase: "review_running",
      round: 2,
      log: [guilty],
      expectRound: 1,
      side: "prosecutor",
      prompt: /Round 2\./,
    },
    {
      phase: "repair_pending",
      round: 1,
      log: [guilty],
      expectRound: 1,
      side: "executor",
      prompt: /FINDING-TOGGLE-17/,
    },
    {
      phase: "repair_running",
      round: 1,
      log: [guilty],
      expectRound: 1,
      side: "executor",
      prompt: /FINDING-TOGGLE-17/,
    },
    {
      phase: "paused",
      round: 1,
      log: [guilty],
      paused: { side: "executor", reason: "429: limit", round: 1, note: "try another model" },
      expectRound: 1,
      side: "executor",
      prompt: /FINDING-TOGGLE-17/,
    },
    {
      phase: "verification_pending",
      round: 2,
      log: [guilty, acquittal],
      expectRound: 1,
      side: "prosecutor",
      prompt: /Round 2\./,
    },
    { phase: "accepted", round: 2, log: [guilty, acquittal], finished: true },
    { phase: "stopped", round: 2, log: [guilty], finished: true },
  ];

  for (const spec of specs) {
    const home = tempHome();
    const store = createProsecutorStore(home);
    const sessionId = `/tmp/sessions/${spec.phase}-${spec.round}.jsonl`;
    store.save({
      id: `case-${spec.phase}-${spec.round}`,
      sessionId,
      cwd: "",
      task: "fix the toggle",
      backend: "A",
      model: { provider: "p", id: "p-model" },
      effort: null,
      executorBackend: "codex",
      executorModel: { provider: "p", id: "ex-model" },
      round: spec.round,
      phase: spec.phase,
      baselineCommit: null,
      defense: "executor said it was done",
      lastReport: spec.log.at(-1)?.report ?? "",
      log: spec.log,
      paused: spec.paused ?? null,
      extra: spec.paused ? { paused: spec.paused } : {},
    });
    const agent = prosecutorAgent([{ hang: true }]);
    let gets = 0;
    const open = (publish = () => {}) =>
      createProsecutor({
        poolFor: () => ({
          stop() {},
          get() {
            gets += 1;
            return agent;
          },
        }),
        publish,
        store,
        sessionInfo: () => ({ sessionId, cwd: "" }),
      });
    const first = open();
    const recovered = await first.recover();
    assert.equal(gets, 0, `${spec.phase} resumed itself`);
    if (spec.finished) {
      assert.equal(recovered.length, 0, spec.phase);
      assert.equal(store.loadBySession(sessionId), null, spec.phase);
      continue;
    }
    assert.equal(recovered.length, 1, spec.phase);
    assert.equal(recovered[0].round, spec.expectRound, spec.phase);
    assert.equal(recovered[0].interrupted, true, spec.phase);
    assert.equal(recovered[0].phase, "paused", spec.phase);
    if (spec.phase === "verification_pending") {
      const entry = recovered[0].log.find((item) => item.round === 2);
      assert.match(entry.died, /verification/);
      assert.match(entry.report, /ACQUITTED/);
      assert.deepEqual(entry.findings, [{ id: "f2", test: "toggle.test.js:9" }]);
    }
    if (spec.phase === "paused") {
      assert.equal(recovered[0].paused.reason, "429: limit");
      assert.equal(recovered[0].paused.note, "try another model");
      assert.equal(recovered[0].paused.round, 1);
    }
    if (spec.log[0]?.findings)
      assert.deepEqual(recovered[0].log[0].findings, spec.log[0].findings, spec.phase);

    const second = open();
    const twice = await second.recover();
    assert.equal(twice[0].round, spec.expectRound, `${spec.phase} counted twice`);
    if (spec.phase === "verification_pending")
      assert.equal(twice[0].log.filter((entry) => entry.died).length, 1);

    const published = [];
    const live = open((_key, event) => published.push(event));
    await live.recover();
    const executor = {
      cwd: "",
      prompts: [],
      getMessages: () => [],
      prompt(message) {
        executor.prompts.push(message);
        return { ok: true };
      },
    };
    const getsBefore = gets;
    const result = live.resume("fresh-tab", executor, sessionId);
    assert.equal(result.ok, true, spec.phase);
    assert.equal(result.side, spec.side, spec.phase);
    assert.equal(published.some((event) => /diff accepted|gave up/.test(event.message ?? "")), false, spec.phase);
    if (spec.side === "executor") {
      assert.match(result.prompt, spec.prompt, spec.phase);
      assert.match(result.prompt, /Recheck the files and re-run the tests before repeating an edit/);
      assert.match(result.prompt, /Never assume a command that was in progress finished/);
      assert.doesNotMatch(result.prompt, /diff accepted|gave up/);
      assert.equal(gets, getsBefore, spec.phase);
      assert.equal(live.state("fresh-tab").phase === "accepted", false);
    } else {
      await wait(() => agent.prompts.length === 1, spec.phase);
      assert.match(agent.prompts[0], spec.prompt, spec.phase);
      assert.match(agent.prompts[0], /Recheck the files/);
      assert.match(agent.prompts[0], /FINDING-TOGGLE-17|write a risk map/);
      assert.doesNotMatch(agent.prompts[0], /diff accepted/);
      assert.notEqual(live.state("fresh-tab").phase, "accepted");
    }
  }
});
