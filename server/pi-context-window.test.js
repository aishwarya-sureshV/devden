// Runs as a standalone script (node server/pi-context-window.test.js):
// setContextWindow writes ~/.pi/agent/models.json via homedir(), so the
// suite fakes HOME first — before any devden import resolves it.
const { mkdtemp, readFile } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const assert = (await import("node:assert/strict")).default;

const home = await mkdtemp(join(tmpdir(), "pi-ctx-home-"));
process.env.HOME = home;

const { PiAgentProcess } = await import("./pi-agent.js");
const agent = new PiAgentProcess("pi-context-window-test");
assert.equal(agent.process, undefined, "cold session has no process");

// Cold session: nothing live to restart; the override is still written.
const set = await agent.setContextWindow("openai-codex", "gpt-5.5", 123000);
assert.equal(set.ok, true, set.error);
assert.equal(set.data.contextWindow, 123000);
const models = JSON.parse(
  await readFile(join(home, ".pi", "agent", "models.json"), "utf8"),
);
assert.equal(
  models.providers["openai-codex"].modelOverrides["gpt-5.5"].contextWindow,
  123000,
);

// null removes the override again.
const reset = await agent.setContextWindow("openai-codex", "gpt-5.5", null);
assert.equal(reset.ok, true, reset.error);
const cleared = JSON.parse(
  await readFile(join(home, ".pi", "agent", "models.json"), "utf8"),
);
assert.equal(
  cleared.providers["openai-codex"].modelOverrides?.["gpt-5.5"],
  undefined,
);

// Missing model is rejected before touching the file.
const bad = await agent.setContextWindow("", "", 1000);
assert.equal(bad.ok, false);

// A live idle session restarts with its complete launch settings: a context
// change must not silently drop plan/manual/read-only controls or the
// saved session path / thinking level. start() derives the read-only tool
// set and the manual-approval extension from exactly these options.
const live = new PiAgentProcess("pi-context-window-live");
live.agentMode = "plan";
live.accessMode = "read-only";
live.lastState = { sessionFile: "/tmp/saved.jsonl", thinkingLevel: "high" };
live.process = { pid: 1 }; // pretend a live child
let captured;
live.stop = () => {
  live.process = undefined;
};
live.start = async (cwd, options) => {
  captured = { cwd, options };
  return { ok: true };
};
live.getState = async () => ({ model: { provider: "openai-codex", id: "gpt-5.5", contextWindow: 64000 } });
live.usageCache = { at: 0, result: undefined };
const restarted = await live.setContextWindow("openai-codex", "gpt-5.5", 64000);
assert.equal(restarted.ok, true, restarted.error);
assert.equal(restarted.state.model.contextWindow, 64000);
assert.equal(captured.options.model.id, "gpt-5.5");
assert.equal(captured.options.sessionPath, "/tmp/saved.jsonl");
assert.equal(captured.options.thinkingLevel, "high");
assert.equal(captured.options.agentMode, "plan", "plan mode must survive the restart");
assert.equal(captured.options.accessMode, "read-only", "read-only must survive the restart");

console.log("pi setContextWindow: cold-path assertions passed");
