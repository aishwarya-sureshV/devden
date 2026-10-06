import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openAcpClient } from "./acp-agent.js";
import { GrokAgentPool, sessionUpdateIsFor } from "./grok-agent.js";

describe("sessionUpdateIsFor", () => {
  it("keeps updates with no session id (legacy payloads)", () => {
    assert.equal(sessionUpdateIsFor("abc", { update: {} }), true);
    assert.equal(sessionUpdateIsFor("abc", null), true);
  });

  it("keeps updates for this session", () => {
    assert.equal(
      sessionUpdateIsFor("abc", { sessionId: "abc", update: {} }),
      true,
    );
  });

  it("drops updates for a forked sibling session", () => {
    assert.equal(
      sessionUpdateIsFor("parent", {
        sessionId: "fork-child",
        update: { sessionUpdate: "agent_thought_chunk" },
      }),
      false,
    );
  });
});

// A minimal ACP agent: answers initialize and set_config_option, and records
// every method it receives so the test can see what actually hit the wire.
const FAKE_ACP_AGENT = `
const seen = [];
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  seen.push(msg.method);
  const result =
    msg.method === "initialize" ? { protocolVersion: 1 }
    : msg.method === "session/set_config_option" ? { configOptions: [{ id: msg.params.configId, currentValue: msg.params.value }], seen }
    : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});`;

describe("grok model selection", () => {
  it("sends session/set_config_option over the wire and returns its reply", async () => {
    const { child, connection } = await openAcpClient({
      command: process.execPath,
      args: ["-e", FAKE_ACP_AGENT],
      handlers: () => ({}),
    });
    try {
      const reply = await connection.setSessionConfigOption({
        sessionId: "s1",
        configId: "model",
        value: "grok-4.6",
      });
      assert.deepEqual(reply.configOptions, [{ id: "model", currentValue: "grok-4.6" }]);
      assert.deepEqual(reply.seen, ["initialize", "session/set_config_option"]);
    } finally {
      child.kill();
    }
  });

  it("setModel pushes model then effort as config options, never set_mode", async () => {
    const agent = new GrokAgentPool().get("grok-config-order");
    const calls = [];
    agent.connection = {
      setSessionConfigOption: async (params) => calls.push(params),
      setSessionMode: async () => assert.fail("grok ignores set_mode for models"),
    };
    agent.sessionId = "s1";
    agent.resolveEffort = async () => "high";
    agent.getState = async () => ({});
    assert.equal((await agent.setModel("grok", "grok-4.6")).ok, true);
    assert.deepEqual(
      calls.map(({ sessionId, configId, value }) => [sessionId, configId, value]),
      [["s1", "model", "grok-4.6"], ["s1", "reasoning_effort", "high"]],
    );
  });
});

describe("grok turn usage", () => {
  it("message_end carries the usage grok put on the prompt response", async () => {
    const agent = new GrokAgentPool().get("grok-turn-usage");
    // Shape captured from grok 1.0.46: the live turn_completed is an ext
    // notification the SDK never routes here, but the prompt reply has it.
    agent.connection = {
      prompt: async () => ({
        stopReason: "end_turn",
        _meta: {
          usage: { inputTokens: 20026, outputTokens: 25, totalTokens: 20051, cachedReadTokens: 2432, cacheCreationTokens: 0, apiDurationMs: 2518 },
        },
      }),
    };
    agent.process = { exitCode: null, signalCode: null, kill() {}, once() {}, on() {} };
    agent.sessionId = "s1";
    agent.cwd = "/tmp";
    agent.getState = async () => ({});
    const ends = [];
    agent.onEvent((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") ends.push(event.message.usage);
    });
    assert.equal((await agent.prompt("hi")).ok, true);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].input, 20026 - 2432);
    assert.equal(ends[0].output, 25);
    assert.equal(ends[0].cacheRead, 2432);
    assert.equal(ends[0].totalTokens, 20051);
  });
});

describe("grok idle turn completion", () => {
  it("waits for the stream to drain past the journaled turn_completed", async () => {
    const { mkdtempSync, mkdirSync, appendFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const home = mkdtempSync(join(tmpdir(), "grok-idle-home-"));
    const previous = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const agent = new GrokAgentPool().get("grok-idle-drain");
      agent.sessionId = "s1";
      agent.cwd = "/tmp/proj";
      agent.getState = async () => ({});
      const dir = join(home, "sessions", encodeURIComponent("/tmp/proj"), "s1");
      mkdirSync(dir, { recursive: true });
      const journal = join(dir, "updates.jsonl");
      appendFileSync(journal, "");
      const chunk = (n, text) => ({
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        _meta: { eventId: `s1-${n}` },
      });
      const ended = [];
      agent.onEvent((event) => {
        if (event.type === "agent_end") ended.push(event.messages[0]);
      });
      agent.handleSessionUpdate(chunk(10, "Hello"));
      // grok journals the whole reply + turn_completed before the pipe drains.
      const line = (method, sessionUpdate, n) =>
        JSON.stringify({ method, params: { sessionId: "s1", update: { sessionUpdate }, _meta: { eventId: `s1-${n}` } } }) + "\n";
      appendFileSync(journal, line("session/update", "agent_message_chunk", 12) + line("_x.ai/session/update", "turn_completed", 13));
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.equal(ended.length, 0, "closed before the tail chunk arrived");
      agent.handleSessionUpdate(chunk(12, " world"));
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.equal(ended.length, 1);
      assert.equal(ended[0].content.map((block) => block.text).join(""), "Hello world");
      assert.equal(agent.turn, undefined, "no phantom idle turn left open");
    } finally {
      if (previous === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = previous;
    }
  });
});
