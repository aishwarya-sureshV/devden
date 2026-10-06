import assert from "node:assert/strict";
import { test } from "node:test";
import sessionContext from "./pi-extensions/session-context.ts";
import { PiAgentProcess } from "./pi-agent.js";

test("context budgets use backend capacities and stay in each session", async () => {
  const base = { provider: "example", id: "model", contextWindow: 512000 };
  let model = base, branch = [], thinking = "high";
  const events = {};
  let command;
  const context = {
    get model() { return model; },
    modelRegistry: { find: () => base },
    sessionManager: { getBranch: () => branch },
    isIdle: () => true,
  };
  sessionContext({
    on: (name, handler) => { events[name] = handler; },
    registerCommand: (_name, options) => { command = options.handler; },
    setModel: async selected => { model = selected; thinking = "off"; return true; },
    getThinkingLevel: () => thinking,
    setThinkingLevel: level => { thinking = level; },
    appendEntry: (customType, data) => { branch.push({ type: "custom", customType, data }); },
  });
  const choose = tokens => command(JSON.stringify({ provider: "example", id: "model", contextWindow: tokens }), context);
  await choose(132000);
  assert.equal(model.contextWindow, 132000);
  assert.equal(base.contextWindow, 512000, "catalog stays untouched");
  assert.equal(thinking, "high");
  model = base;
  await events.session_start({}, context);
  assert.equal(model.contextWindow, 132000, "saved session restores its choice");
  branch = [];
  await events.session_start({}, context);
  assert.equal(model.contextWindow, 512000, "another session uses its own default");
  await choose(256000);
  await choose(null);
  assert.equal(model.contextWindow, 512000);
  await assert.rejects(choose(512001), /between/);
  await assert.rejects(choose(1.5), /between/);
  await assert.rejects(choose(-1), /between/);
  context.isIdle = () => false;
  await assert.rejects(choose(132000), /finish/);
});

test("cold and live controls do not write shared overrides or send an unregistered prompt", async () => {
  const agent = new PiAgentProcess("session-context-test");
  agent.getAvailableModels = async () => ({ ok: true, models: [{ provider: "example", id: "model", contextWindow: 256000 }] });
  assert.equal((await agent.setSessionContextWindow("example", "model", 132000)).data.contextWindow, 132000);
  assert.equal(agent.sessionContextChoice.contextWindow, 132000);
  assert.equal((await agent.setSessionContextWindow("example", "model", 512000)).ok, false);
  agent.process = {};
  const calls = [];
  agent.runCommand = async command => { calls.push(command.type); return { ok: true, data: { commands: [] } }; };
  assert.equal((await agent.setSessionContextWindow("example", "model", 132000)).ok, false);
  assert.deepEqual(calls, ["get_commands"]);
});
