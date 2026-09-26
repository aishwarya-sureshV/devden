/**
 * forkAt wiring per backend. These stub the live CLI/ACP connection; they
 * do not run claude/grok/codex/pi binaries.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ClaudeAgentProcess } from "./claude-agent.js";
import { CodexAgentPool } from "./codex-agent.js";
import { GrokAgentPool } from "./grok-agent.js";
import { PiAgentProcess } from "./pi-agent.js";

const WORKTREE = "/tmp/devden-fork-worktree";

describe("Claude forkAt", () => {
  const home = mkdtempSync(join(tmpdir(), "claude-fork-home-"));
  let prevHome;
  before(() => {
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });
  after(() => {
    process.env.HOME = prevHome;
  });

  it("writes the sliced jsonl under the worktree project dir", async () => {
    const project = join(home, ".claude", "projects", "-tmp-parent");
    mkdirSync(project, { recursive: true });
    const source = join(project, "src.jsonl");
    writeFileSync(
      source,
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          sessionId: "src",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "one" }] },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: "src",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "first" }],
          },
        }),
      ].join("\n") + "\n",
    );
    const agent = new ClaudeAgentProcess("claude-fork");
    agent.cwd = "/tmp/parent";
    agent.sessionFile = source;
    agent.sessionId = "src";
    const result = await agent.forkAt(Date.parse("2026-01-01T00:00:01.000Z"), {
      forkCwd: WORKTREE,
    });
    assert.equal(result.ok, true);
    assert.equal(result.forkCwd, WORKTREE);
    assert.match(result.state.sessionFile, /devden-fork-worktree/);
    assert.match(readFileSync(result.state.sessionFile, "utf8"), /first/);
  });

  it("finds sessions inside dot-folders, where Claude encodes the dot as a dash", async () => {
    // /tmp/.dot-parent → Claude writes transcripts under -tmp--dot-parent;
    // slash-only encoding looks in -tmp-.dot-parent and never finds them.
    const project = join(home, ".claude", "projects", "-tmp--dot-parent");
    mkdirSync(project, { recursive: true });
    const source = join(project, "src.jsonl");
    writeFileSync(
      source,
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        sessionId: "src",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "dot" }],
        },
      }) + "\n",
    );
    const agent = new ClaudeAgentProcess("claude-fork-dot");
    agent.cwd = "/tmp/.dot-parent";
    agent.sessionFile = undefined;
    agent.sessionId = "src";
    const result = await agent.forkAt(
      Date.parse("2026-01-01T00:00:01.000Z"),
      {},
    );
    assert.equal(result.ok, true);
    assert.match(readFileSync(result.state.sessionFile, "utf8"), /dot/);
  });
});

describe("Grok forkAt", () => {
  const grokHome = mkdtempSync(join(tmpdir(), "grok-fork-home-"));
  let prevHome;
  before(() => {
    prevHome = process.env.GROK_HOME;
    process.env.GROK_HOME = grokHome;
  });
  after(() => {
    if (prevHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevHome;
  });

  it("forks ACP into newCwd and seeds journals there", async () => {
    const parentCwd = "/tmp/parent-repo";
    const sourceDir = join(
      grokHome,
      "sessions",
      encodeURIComponent(parentCwd),
      "src-id",
    );
    mkdirSync(sourceDir, { recursive: true });
    const sourceFile = join(sourceDir, "chat_history.jsonl");
    writeFileSync(
      sourceFile,
      JSON.stringify({
        type: "user",
        prompt_index: 0,
        content: [{ type: "text", text: "<user_query>one</user_query>" }],
      }) +
        "\n" +
        JSON.stringify({
          type: "assistant",
          content: [{ type: "text", text: "first" }],
        }) +
        "\n",
    );
    const pool = new GrokAgentPool();
    const agent = pool.get("grok-fork");
    agent.cwd = parentCwd;
    agent.sessionId = "src-id";
    agent.sessionFile = sourceFile;
    agent.process = { exitCode: null, signalCode: null };
    let forkArgs;
    agent.connection = {
      extMethod: async (method, args) => {
        forkArgs = { method, args };
        return { newSessionId: "fork-id" };
      },
    };
    const result = await agent.forkAt(Date.now(), { forkCwd: WORKTREE });
    assert.equal(result.ok, true);
    assert.equal(forkArgs.method, "x.ai/session/fork");
    assert.equal(forkArgs.args.newCwd, WORKTREE);
    assert.equal(forkArgs.args.sourceCwd, parentCwd);
    assert.equal(result.forkCwd, WORKTREE);
    assert.match(result.state.sessionFile, /fork-id/);
    assert.ok(result.state.sessionFile.includes(encodeURIComponent(WORKTREE)));
  });

  it("reads sourceCwd from the session file when the live process is elsewhere", async () => {
    const parentCwd = "/tmp/parent-repo";
    const sourceDir = join(
      grokHome,
      "sessions",
      encodeURIComponent(parentCwd),
      "src-id",
    );
    mkdirSync(sourceDir, { recursive: true });
    const sourceFile = join(sourceDir, "chat_history.jsonl");
    writeFileSync(
      sourceFile,
      JSON.stringify({
        type: "user",
        prompt_index: 0,
        content: [{ type: "text", text: "<user_query>one</user_query>" }],
      }) + "\n",
    );
    const pool = new GrokAgentPool();
    const agent = pool.get("grok-fork-cwd");
    agent.cwd = "/tmp/somewhere-else";
    agent.sessionId = "src-id";
    agent.sessionFile = sourceFile;
    agent.process = { exitCode: null, signalCode: null };
    agent.switchSession = async () => ({ ok: true });
    let sourceCwd;
    agent.connection = {
      extMethod: async (_method, args) => {
        sourceCwd = args.sourceCwd;
        return { newSessionId: "fork-cwd" };
      },
    };
    const result = await agent.forkAt(Date.now(), {
      forkCwd: WORKTREE,
      sessionPath: sourceFile,
    });
    assert.equal(result.ok, true);
    assert.equal(sourceCwd, parentCwd);
  });

  it("does not seed a second copy when ACP wrote the fork under the source cwd", async () => {
    const parentCwd = "/tmp/parent-repo";
    const sourceDir = join(
      grokHome,
      "sessions",
      encodeURIComponent(parentCwd),
      "src-id",
    );
    mkdirSync(sourceDir, { recursive: true });
    const sourceFile = join(sourceDir, "chat_history.jsonl");
    writeFileSync(
      sourceFile,
      JSON.stringify({
        type: "user",
        prompt_index: 0,
        content: [{ type: "text", text: "<user_query>one</user_query>" }],
      }) + "\n",
    );
    const pool = new GrokAgentPool();
    const agent = pool.get("grok-fork-phantom");
    agent.cwd = parentCwd;
    agent.sessionId = "src-id";
    agent.sessionFile = sourceFile;
    agent.process = { exitCode: null, signalCode: null };
    const written = join(
      grokHome,
      "sessions",
      encodeURIComponent(parentCwd),
      "fork-real",
      "chat_history.jsonl",
    );
    agent.connection = {
      extMethod: async () => {
        mkdirSync(join(written, ".."), { recursive: true });
        writeFileSync(
          written,
          JSON.stringify({
            type: "user",
            prompt_index: 0,
            content: [{ type: "text", text: "<user_query>one</user_query>" }],
          }) + "\n",
        );
        return { newSessionId: "fork-real" };
      },
    };
    const result = await agent.forkAt(Date.now(), {
      forkCwd: WORKTREE,
      sessionPath: sourceFile,
    });
    assert.equal(result.ok, true);
    assert.equal(result.state.sessionFile, written);
    assert.equal(result.forkCwd, parentCwd);
    assert.equal(
      existsSync(
        join(
          grokHome,
          "sessions",
          encodeURIComponent(WORKTREE),
          "fork-real",
        ),
      ),
      false,
    );
  });

  it("does not treat the same id in another directory as the current session", async () => {
    const parentCwd = "/tmp/parent-repo";
    const sourceFile = join(
      grokHome,
      "sessions",
      encodeURIComponent(parentCwd),
      "src-id",
      "chat_history.jsonl",
    );
    const pool = new GrokAgentPool();
    const agent = pool.get("grok-same-id");
    agent.cwd = "/tmp/other";
    agent.sessionId = "src-id";
    agent.process = { exitCode: null, signalCode: null };
    agent.connection = {};
    let switched = "";
    agent.switchSession = async (path) => {
      switched = path;
      return { ok: true };
    };
    const result = await agent.ensureRunning(sourceFile);
    assert.equal(result.ok, true);
    assert.equal(switched, sourceFile);
  });
});

describe("Codex forkAt", () => {
  it("keeps thread/fork and reports the worktree as forkCwd", async () => {
    const pool = new CodexAgentPool();
    const agent = pool.get("codex-fork");
    agent.cwd = "/tmp/parent";
    agent.threadId = "thread-1";
    agent.connection = {
      running: true,
      close() {},
      request: async (method, args) => {
        assert.equal(method, "thread/fork");
        assert.equal(args.threadId, "thread-1");
        return {
          thread: {
            id: "thread-fork",
            path: "/tmp/fork.jsonl",
            turns: [],
          },
        };
      },
    };
    const result = await agent.forkAt(1, { forkCwd: WORKTREE });
    assert.equal(result.ok, true);
    assert.equal(result.forkCwd, WORKTREE);
    assert.equal(result.state.sessionId, "thread-fork");
    pool.stop();
  });

  it("errors when thread/fork omits the session file, and does not duplicate turn records", async () => {
    const pool = new CodexAgentPool();
    const agent = pool.get("codex-fork-guard");
    agent.cwd = "/tmp/parent";
    agent.threadId = "thread-1";
    agent.sessionFile = "/tmp/parent.jsonl";
    agent.turnRecords = [{ id: "t1", timestamp: 10 }];
    agent.connection = {
      running: true,
      close() {},
      request: async () => ({ thread: { id: "thread-fork", turns: [] } }),
    };
    const missing = await agent.forkAt(10, { forkCwd: WORKTREE });
    assert.equal(missing.ok, false);
    assert.equal(agent.sessionFile, "/tmp/parent.jsonl");
    assert.equal(agent.turnRecords.length, 1);

    agent.connection.request = async () => ({
      thread: {
        id: "thread-fork",
        path: "/tmp/fork.jsonl",
        turns: [
          { id: "t1", timestamp: 10, items: [], status: "completed" },
          { id: "t2", timestamp: 20, items: [], status: "completed" },
        ],
      },
    });
    const again = await agent.forkAt(10, { forkCwd: WORKTREE });
    assert.equal(again.ok, true);
    assert.equal(again.state.sessionFile, "/tmp/fork.jsonl");
    assert.deepEqual(
      agent.turnRecords.map((record) => record.id),
      ["t1"],
    );
    assert.equal(agent.turnRecords[0].timestamp, 10);
    pool.stop();
  });

  it("gives replayed turns distinct timestamps so a mid-history fork binds to the right turn", () => {
    const pool = new CodexAgentPool();
    const agent = pool.get("codex-replay-ts");
    agent.replayHistory([
      { id: "t1", items: [], status: "completed" },
      { id: "t2", items: [], status: "completed" },
      { id: "t3", items: [], status: "completed" },
    ]);
    const stamps = agent.turnRecords.map((record) => record.timestamp);
    assert.equal(stamps.length, 3);
    assert.equal(
      new Set(stamps).size,
      3,
      `replayed turns share a timestamp: ${stamps}`,
    );
    // Fork the middle reply: the boundary must be its own turn, not a tie.
    const middle = stamps[1];
    const records = agent.turnRecords;
    const boundary = records.reduce((closest, candidate) =>
      Math.abs(candidate.timestamp - middle) <
      Math.abs(closest.timestamp - middle)
        ? candidate
        : closest,
    );
    assert.equal(boundary.id, "t2");
    pool.stop();
  });
});

describe("Pi forkAt", () => {
  it("clones the session then reports the worktree as forkCwd, and points the branch header at it", async () => {
    const agent = new PiAgentProcess("pi-fork");
    agent.process = {};
    agent.cwd = "/tmp/parent";
    agent.lastState = { sessionFile: "/tmp/parent.jsonl" };
    // pi restores its cwd from the session header on --session; the branch
    // file is a copy whose header still names the parent tree.
    const branch = join(tmpdir(), "pi-fork-branch.jsonl");
    writeFileSync(
      branch,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "fork",
          cwd: "/tmp/parent",
        }),
        JSON.stringify({
          type: "message",
          id: "a1",
          message: { role: "assistant", text: "hi" },
        }),
      ].join("\n") + "\n",
    );
    agent.getEntries = async () => [
      {
        type: "message",
        id: "a1",
        message: { role: "assistant", timestamp: 2 },
      },
    ];
    agent.runSessionCommand = async (command) => {
      assert.equal(command.type, "clone");
      return {
        ok: true,
        state: { sessionFile: branch },
        messages: [],
      };
    };
    agent.switchSession = async (path) => {
      assert.equal(path, "/tmp/parent.jsonl");
      return { ok: true };
    };
    const result = await agent.forkAt(2, { forkCwd: WORKTREE });
    assert.equal(result.ok, true);
    assert.equal(result.forkCwd, WORKTREE);
    assert.equal(result.state.sessionFile, branch);
    const header = JSON.parse(readFileSync(branch, "utf8").split("\n")[0]);
    assert.equal(header.cwd, WORKTREE);
  });

  it("does not fork a live turn, and keeps the worktree when restore fails", async () => {
    const agent = new PiAgentProcess("pi-fork-busy");
    agent.process = {};
    agent.status = "working";
    agent.runSessionCommand = async () => {
      throw new Error("fork must not run during a turn");
    };
    const busy = await agent.forkAt(2, { forkCwd: WORKTREE });
    assert.equal(busy.ok, false);
    assert.match(busy.error, /finish/);

    const branch = join(tmpdir(), "pi-fork-orphan.jsonl");
    writeFileSync(
      branch,
      JSON.stringify({ type: "session", id: "fork", cwd: "/tmp/parent" }) + "\n",
    );
    const restoring = new PiAgentProcess("pi-fork-restore");
    restoring.process = {};
    restoring.status = "ready";
    restoring.cwd = "/tmp/parent";
    restoring.lastState = { sessionFile: "/tmp/parent.jsonl" };
    restoring.getEntries = async () => [
      {
        type: "message",
        id: "a1",
        message: { role: "assistant", timestamp: 2 },
      },
    ];
    restoring.runSessionCommand = async () => ({
      ok: true,
      state: { sessionFile: branch },
      messages: [],
    });
    restoring.switchSession = async () => ({ ok: false, error: "switch failed" });
    const failed = await restoring.forkAt(2, { forkCwd: WORKTREE });
    assert.equal(failed.ok, false);
    assert.equal(failed.keepWorktree, true);
    assert.match(failed.error, /pi-fork-orphan/);
    const header = JSON.parse(readFileSync(branch, "utf8").split("\n")[0]);
    assert.equal(header.cwd, "/tmp/parent");
  });

  it("ignores an unparseable first timestamp and pins the reply that was clicked", async () => {
    const agent = new PiAgentProcess("pi-fork-nan");
    agent.process = {};
    agent.status = "ready";
    agent.cwd = "/tmp/parent";
    agent.lastState = { sessionFile: "/tmp/parent.jsonl" };
    const branch = join(tmpdir(), "pi-fork-nan.jsonl");
    writeFileSync(
      branch,
      JSON.stringify({ type: "session", id: "fork", cwd: "/tmp/parent" }) + "\n",
    );
    agent.getEntries = async () => [
      {
        type: "message",
        id: "a1",
        message: { role: "assistant", timestamp: "not-a-time" },
      },
      {
        type: "message",
        id: "u2",
        message: { role: "user", timestamp: 40 },
      },
      {
        type: "message",
        id: "a2",
        message: { role: "assistant", timestamp: 50 },
      },
    ];
    let command;
    agent.runSessionCommand = async (cmd) => {
      command = cmd;
      return { ok: true, state: { sessionFile: branch }, messages: [] };
    };
    agent.switchSession = async () => ({ ok: true });
    const result = await agent.forkAt(50, { forkCwd: WORKTREE });
    assert.equal(result.ok, true);
    assert.equal(command.type, "clone");
  });

  it("does not publish the branch file as the parent's session while forking", async () => {
    const agent = new PiAgentProcess("pi-fork-hold");
    agent.lastState = { sessionFile: "/tmp/parent.jsonl" };
    agent.queueSnapshot = () => [];
    agent.suppressForkState = true;
    agent.send = async () => ({
      success: true,
      data: { sessionFile: "/tmp/fork.jsonl", isStreaming: false },
    });
    const state = await agent.getState();
    assert.equal(state.sessionFile, "/tmp/fork.jsonl");
    assert.equal(agent.lastState.sessionFile, "/tmp/parent.jsonl");
  });
});
