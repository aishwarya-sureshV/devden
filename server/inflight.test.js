import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The module resolves its state file from HOME at import time, so the fake
// home has to exist before the first import.
const home = mkdtempSync(join(tmpdir(), "pi-web-inflight-"));
process.env.HOME = home;
const { mkdirSync } = await import("node:fs");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
const STATE = join(home, ".pi", "agent", "pi-web-inflight.json");
const inflight = await import("./inflight.js");

test("a settled turn leaves nothing to resume", () => {
  inflight.noteTurnStarted({ sessionKey: "k1", backend: "pi", cwd: home });
  inflight.noteTurnContext("k1", { sessionPath: join(home, "s.jsonl") });
  assert.equal(JSON.parse(readFileSync(STATE, "utf8")).length, 1);
  inflight.noteTurnSettled("k1");
  assert.deepEqual(JSON.parse(readFileSync(STATE, "utf8")), []);
});

test("a turn with no session path is not resumable", () => {
  inflight.noteTurnStarted({ sessionKey: "k2", backend: "pi", cwd: home });
  assert.deepEqual(JSON.parse(readFileSync(STATE, "utf8")), []);
  inflight.noteTurnSettled("k2");
});

test("queued prompts ride along with the interrupted turn", () => {
  inflight.noteTurnStarted({ sessionKey: "k3", backend: "grok", cwd: home });
  inflight.noteTurnContext("k3", {
    sessionPath: join(home, "s.jsonl"),
    queued: [{ id: "q1", message: "then do the other thing" }],
  });
  const [entry] = JSON.parse(readFileSync(STATE, "utf8"));
  assert.equal(entry.queued[0].message, "then do the other thing");
  inflight.noteTurnSettled("k3");
});

test("takeInterruptedTurns drops stale and looping records, and truncates", () => {
  writeFileSync(
    STATE,
    JSON.stringify([
      {
        sessionKey: "fresh",
        cwd: home,
        sessionPath: "/s",
        startedAt: Date.now(),
      },
      {
        sessionKey: "stale",
        cwd: home,
        sessionPath: "/s",
        startedAt: Date.now() - 13 * 60 * 60_000,
      },
      {
        sessionKey: "looping",
        cwd: home,
        sessionPath: "/s",
        startedAt: Date.now(),
        resumeAttempts: 2,
      },
    ]),
  );
  assert.deepEqual(
    inflight.takeInterruptedTurns().map((entry) => entry.sessionKey),
    ["fresh"],
  );
  // Reading consumes: a resume that dies before re-registering must not be
  // retried forever.
  assert.deepEqual(inflight.takeInterruptedTurns(), []);
});

// The interrupted-turn resume calls followUp() and re-queues with enqueue()
// whatever backend the conversation used, so every pool has to offer both.
// Grok and Codex had no followUp at all, which also broke /goal check-ins.
test("every backend exposes the resume contract", async () => {
  const pools = await Promise.all([
    import("./pi-agent.js").then((m) => new m.PiAgentPool()),
    import("./claude-agent.js").then((m) => new m.ClaudeAgentPool()),
    import("./grok-agent.js").then((m) => new m.GrokAgentPool()),
    import("./codex-agent.js").then((m) => new m.CodexAgentPool()),
  ]);
  for (const pool of pools) {
    const agent = pool.get("contract-check");
    for (const method of ["followUp", "enqueue", "prompt", "start", "stop"])
      assert.equal(
        typeof agent[method],
        "function",
        `${agent.constructor.name}.${method}`,
      );
    pool.stop();
  }
});

test("takeInterruptedTurns keeps only the newest turn per session file", () => {
  writeFileSync(
    STATE,
    JSON.stringify([
      { sessionKey: "a", cwd: home, sessionPath: "/s/one", startedAt: Date.now() - 1000 },
      { sessionKey: "b", cwd: home, sessionPath: "/s/one", startedAt: Date.now() },
      { sessionKey: "c", cwd: home, sessionPath: "/s/two", startedAt: Date.now() },
    ]),
  );
  assert.deepEqual(
    inflight.takeInterruptedTurns().map((entry) => entry.sessionKey),
    ["b", "c"],
  );
});
