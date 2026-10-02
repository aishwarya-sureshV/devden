import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_BACKENDS,
  BACKEND_CAPABILITIES,
  backendName,
  capabilitiesFor,
  listBackends,
  sessionScope,
} from "./agent-registry.js";
import { AgentPool } from "./agent-pool.js";
import { attachQueue } from "./agent-queue.js";
import {
  agentIsAlive,
  callAgentMethod,
  claimFork,
  hasMethod,
  releaseFork,
  shouldAdoptLiveAgent,
  startOptionsFromBody,
  unsupported,
} from "./agent-methods.js";
import {
  isSubagentToolName,
  attachSubagentFollows,
  noteSubagentToolEvent,
} from "./agent-subagent.js";
import { PiSubagentFollows } from "./pi-subagent.js";
import { PiAgentPool } from "./pi-agent.js";

describe("agent-registry", () => {
  it("names known backends and defaults unknown ones to pi", () => {
    assert.equal(backendName("claude"), "claude");
    assert.equal(backendName("grok"), "grok");
    assert.equal(backendName("codex"), "codex");
    assert.equal(backendName("pi"), "pi");
    assert.equal(backendName("nope"), "pi");
    assert.equal(backendName(undefined), "pi");
    assert.equal(sessionScope("all"), "all");
    assert.equal(sessionScope("GROK"), "pi");
  });

  it("lists every backend with a capability document", async () => {
    const listed = await listBackends();
    assert.deepEqual(
      listed.map((entry) => entry.id),
      AGENT_BACKENDS,
    );
    for (const entry of listed) {
      assert.equal(typeof entry.capabilities.steer, "boolean");
      assert.equal(typeof entry.capabilities.fork, "boolean");
      assert.equal(typeof entry.capabilities.queue, "boolean");
      assert.ok(["ok", "missing", "unknown"].includes(entry.auth));
    }
    assert.equal(capabilitiesFor("grok").steer, false);
    assert.equal(capabilitiesFor("grok").fork, true);
    assert.equal(capabilitiesFor("codex").fork, true);
    assert.equal(capabilitiesFor("codex").compactInstructions, false);
    assert.equal(capabilitiesFor("claude").lazyStart, true);
    assert.equal(capabilitiesFor("claude").contextUsage, true);
    assert.equal(capabilitiesFor("grok").contextUsage, true);
    assert.equal(capabilitiesFor("pi").contextUsage, true);
    assert.equal(capabilitiesFor("pi").fork, true);
    assert.equal(BACKEND_CAPABILITIES.pi.queue, true);
    assert.equal(capabilitiesFor("grok").warmStart, true);
    assert.equal(capabilitiesFor("pi").warmStart, false);
  });
});

describe("agent-pool", () => {
  it("reuses one process per session key and stops it", () => {
    let created = 0;
    const stopped = [];
    const pool = new AgentPool((key) => {
      created += 1;
      return {
        key,
        stop() {
          stopped.push(key);
        },
      };
    });
    const a = pool.get("s1");
    const b = pool.get("s1");
    assert.equal(a, b);
    assert.equal(created, 1);
    pool.get("s2");
    assert.equal(created, 2);
    pool.stop("s1");
    assert.deepEqual(stopped, ["s1"]);
    assert.equal(pool.agents.has("s1"), false);
    pool.stop();
    assert.deepEqual(stopped, ["s1", "s2"]);
    assert.equal(pool.agents.size, 0);
  });
});

describe("agent-queue", () => {
  it("sends immediately when idle and queues when busy", async () => {
    const sent = [];
    const events = [];
    const agent = {
      sessionKey: "s",
      emit(event) {
        events.push(event);
      },
      prompt(message) {
        sent.push(message);
        return Promise.resolve({ ok: true });
      },
    };
    let busy = false;
    attachQueue(agent, {
      isBusy() {
        return busy;
      },
      sendNow(message, images) {
        return this.prompt(message, images);
      },
    });
    const idle = await agent.enqueue("hello");
    assert.equal(idle.data.queued, false);
    assert.deepEqual(sent, ["hello"]);
    busy = true;
    const queued = await agent.enqueue("later");
    assert.equal(queued.data.queued, true);
    assert.equal(agent.queueSnapshot().length, 1);
    assert.equal(events.at(-1).type, "queue_updated");
    agent.cancelQueued();
    assert.equal(agent.queueSnapshot().length, 0);
  });

  it("steers a queued message and puts it back if steer fails", async () => {
    const steered = [];
    const agent = {
      sessionKey: "s",
      emit() {},
      prompt() {
        return Promise.resolve({ ok: true });
      },
      steer(message) {
        steered.push(message);
        return Promise.resolve({ ok: true });
      },
    };
    attachQueue(agent, {
      isBusy() {
        return true;
      },
      sendNow(message, images) {
        return this.prompt(message, images);
      },
      steerNow(message, images) {
        return this.steer(message, images);
      },
    });
    await agent.enqueue("redirect");
    const id = agent.queueSnapshot()[0].id;
    const result = await agent.steerQueued(id);
    assert.equal(result.ok, true);
    assert.deepEqual(steered, ["redirect"]);
    assert.equal(agent.queueSnapshot().length, 0);

    agent.steer = () => Promise.resolve({ ok: false, error: "nope" });
    await agent.enqueue("retry");
    const failed = await agent.steerQueued(agent.queueSnapshot()[0].id);
    assert.equal(failed.ok, false);
    assert.equal(agent.queueSnapshot().length, 1);
    assert.equal(agent.queueSnapshot()[0].message, "retry");
  });

  it("pi queues only while a turn is running, not because a process exists", async () => {
    const agent = new PiAgentPool().get("pi-q");
    const sent = [];
    agent.prompt = async (message) => {
      sent.push(message);
      return { ok: true };
    };
    const idle = await agent.enqueue("hello");
    assert.equal(idle.data.queued, false);
    assert.deepEqual(sent, ["hello"]);

    agent.process = { pid: 1 };
    agent.status = "ready";
    const stillIdle = await agent.enqueue("again");
    assert.equal(
      stillIdle.data.queued,
      false,
      "a live idle pi process must send, not queue",
    );
    assert.deepEqual(sent, ["hello", "again"]);

    agent.status = "working";
    const queued = await agent.enqueue("later");
    assert.equal(queued.data.queued, true);
    assert.equal(sent.length, 2);
    agent.cancelQueued();
  });
});

describe("agent-methods", () => {
  it("reports unsupported instead of throwing", async () => {
    const agent = { forkAt: undefined, process: null, isAlive: () => false };
    assert.equal(hasMethod(agent, "forkAt"), false);
    const result = await callAgentMethod(agent, "forkAt", [], "fork");
    assert.equal(result.unsupported, true);
    assert.equal(result.ok, false);
    assert.equal(agentIsAlive(agent), false);
    assert.equal(agentIsAlive({ process: {} }), true);
    assert.equal(unsupported("steer", "nope").capability, "steer");
  });

  it("does not adopt a live agent onto a fork tab", () => {
    assert.equal(shouldAdoptLiveAgent({}), true);
    assert.equal(shouldAdoptLiveAgent({ independent: true }), false);
    assert.equal(shouldAdoptLiveAgent({ forkResume: true }), true);
  });

  it("keeps model and mode on a cold fork start, and refuses a busy fork", () => {
    const options = startOptionsFromBody({
      sessionPath: "/tmp/s.jsonl",
      model: { provider: "pi", id: "x" },
      thinkingLevel: "high",
      accessMode: "read-only",
      agentMode: "plan",
    });
    assert.equal(options.sessionPath, "/tmp/s.jsonl");
    assert.deepEqual(options.model, { provider: "pi", id: "x" });
    assert.equal(options.thinkingLevel, "high");
    assert.equal(options.accessMode, "read-only");
    assert.equal(options.agentMode, "plan");
    assert.equal(startOptionsFromBody({ agentMode: "routed" }).agentMode, undefined);

    const agent = { status: "working", queuedMessages: [] };
    assert.equal(claimFork(agent).ok, false);
    agent.status = "ready";
    assert.equal(claimFork(agent).ok, true);
    assert.equal(claimFork(agent).ok, false);
    releaseFork(agent);
    agent.queuedMessages = [{ id: "q" }];
    assert.match(claimFork(agent).error, /queued/);
    releaseFork(agent);
  });
});

describe("agent-subagent", () => {
  it("recognizes every backend's spawn tool", () => {
    assert.equal(isSubagentToolName("Task"), true);
    assert.equal(isSubagentToolName("Agent"), true);
    assert.equal(isSubagentToolName("spawn_subagent"), true);
    assert.equal(isSubagentToolName("subagent"), true);
    assert.equal(isSubagentToolName("bash"), false);
  });

  it("attaches PiSubagentFollows once", () => {
    const events = [];
    const agent = {
      sessionKey: "s",
      emit(event) {
        events.push(event);
      },
    };
    attachSubagentFollows(agent);
    attachSubagentFollows(agent);
    assert.ok(agent.subagents instanceof PiSubagentFollows);
    const { holdEnd } = noteSubagentToolEvent(agent, {
      type: "tool_execution_end",
      toolCallId: "missing",
    });
    assert.equal(holdEnd, false);
  });
});
