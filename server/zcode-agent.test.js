/**
 * Drives ZcodeAgentProcess against zcode-mock-agent.mjs (a fake
 * `zcode agent-server`): start -> prompt -> stream -> approve -> question ->
 * queue flush, plus resume, stop-settles-its-prompt, and the catalog and
 * auth reverse-request contracts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ZcodeAgentProcess, zcodeRequestAuth } from "./zcode-agent.js";

const MOCK_ARGS = [new URL("./zcode-mock-agent.mjs", import.meta.url).pathname];

// A failed assertion skips a test's own stop() calls; the live mock children
// then keep the file's process (and the whole `npm test`) open forever.
const spawned = [];
after(() => spawned.forEach((agent) => agent.stop()));

function spawnAgent(sessionKey, { stateFile, agentMode } = {}) {
  const agent = new ZcodeAgentProcess(sessionKey, {
    executable: process.execPath,
    args: MOCK_ARGS,
    envExtra: stateFile ? { MOCK_STATE_FILE: stateFile } : undefined,
    ...(agentMode ? {} : {}),
  });
  spawned.push(agent);
  return agent;
}

function collect(agent) {
  const events = [];
  agent.onEvent((event) => events.push(event));
  return events;
}

const readState = (path) => JSON.parse(readFileSync(path, "utf8"));

async function waitFor(predicate, { timeoutMs = 10_000, step = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = predicate();
    } catch {
      last = undefined;
    }
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  assert.ok(Boolean(last), "timed out waiting for condition");
  return last;
}

test("full cycle: streaming, approval, question, headers, queue, resume, stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-test-"));
  const stateFile = join(dir, "state.json");
  const credentialsFile = join(dir, "credentials.json");
  writeFileSync(
    credentialsFile,
    JSON.stringify({
      "account-provider:account:zai-individual-coding-plan:identity": "me@test",
      "account-provider:coding-plan:account:zai-individual-coding-plan:account:me%40test:api-key":
        "test-key",
    }),
  );
  process.env.DEVDEN_ZCODE_CREDENTIALS = credentialsFile;

  const agent = spawnAgent("z-full", { stateFile });
  const events = collect(agent);

  // --- start + catalog contract (routes send these results verbatim) ---
  const started = await agent.start(process.cwd(), { agentMode: "manual" });
  assert.equal(started.ok, true);
  assert.equal(agent.status, "ready");
  assert.equal(agent.sessionFile, "zcode:s1");

  const models = await agent.getAvailableModels();
  assert.equal(models.ok, true);
  assert.equal(models.models.length, 1);
  assert.equal(models.models[0].id, "GLM-5.3");
  assert.equal(models.models[0].contextWindow, 200000);
  const levels = await agent.getThinkingLevels();
  assert.equal(levels.ok, true);
  assert.deepEqual(levels.levels, ["high"]);

  // --- turn 1: streaming + permission + question ---
  const settled = agent.prompt("hello");
  const approval = await waitFor(() =>
    events.find((event) => event.type === "approval_request"),
  );
  // Backend-provided options pass through (fix 12).
  assert.deepEqual(
    approval.options.map((option) => option.id),
    ["allow", "allow_project"],
  );

  const question = await waitFor(() =>
    events.find((event) => event.type === "user_input_request"),
  );
  assert.equal(question.questions[0].question, "Which file?");
  assert.deepEqual(
    question.questions[0].options.map((option) => option.label),
    ["a.ts", "b.ts"],
  );
  // The structured answer maps labels -> values and takes the accept shape.
  assert.equal(
    agent.resolveUserInput(question.requestId, { q0: { answers: ["b.ts"] } }).ok,
    true,
  );

  // Queue a follow-up mid-turn; it must send itself once the turn settles.
  const queued = await agent.enqueue("follow up");
  assert.equal(queued.data.queued, true);

  agent.resolveApproval(approval.requestId, "allow_project");
  const result = await settled;
  assert.equal(result.ok, true, JSON.stringify(result));

  // model.streaming drove the blocks: streamed thinking, text, tool args.
  const assistantEnd = events
    .filter((event) => event.type === "message_end")
    .find((event) => event.message?.role === "assistant");
  const content = assistantEnd.message.content;
  assert.equal(content.find((block) => block.type === "thinking").thinking, "thinking hard");
  assert.equal(content.find((block) => block.type === "text").text, "Hello world");
  const toolBlock = content.find((block) => block.type === "toolCall");
  assert.equal(toolBlock.name, "Bash");
  assert.deepEqual(toolBlock.arguments, { command: "ls" });

  // --- the queue flushed itself after the turn settled ---
  await waitFor(() => readState(stateFile).promptCount === 2);
  await waitFor(
    () =>
      events.filter((event) => event.type === "agent_end").length === 2,
  );
  // The remembered "always allow in project" tool: no second approval card.
  assert.equal(events.filter((event) => event.type === "approval_request").length, 1);

  // --- what the mock actually received on the wire ---
  const state = readState(stateFile);
  // Provider runtime headers answered from the credential store (fix 1).
  assert.equal(state.headersReply.headersApplied, true);
  assert.equal(state.headersReply.requestAuth.apiKey, "test-key");
  // The project-scope option's own response went through (fix 12).
  assert.equal(state.permissionReplies[0].decision, "allow");
  assert.ok(Array.isArray(state.permissionReplies[0].permissionUpdates));
  // The remembered rule meant turn 2's approval was auto-allowed.
  assert.equal(state.permissionReplies.length, 2);
  assert.deepEqual(state.permissionReplies[1], { decision: "allow" });
  // The structured answer mapped to zcode's expected accept shape (fix 7).
  assert.deepEqual(state.userInputReply, {
    action: "accept",
    content: { answers: { "Which file?": "b.ts" } },
  });

  // --- stop settles an in-flight prompt instead of hanging it (fix 10) ---
  // A fresh agent: manual mode parks the turn on the approval card, then
  // stop() must settle the parked prompt (not leave it hanging forever).
  const stoppedEvents = [];
  const stopper = spawnAgent("z-stop", { stateFile: join(dir, "state3.json") });
  stopper.onEvent((event) => stoppedEvents.push(event));
  await stopper.start(process.cwd(), { agentMode: "manual" });
  const hanging = stopper.prompt("pending");
  const pendingApproval = await waitFor(() =>
    stoppedEvents.find((event) => event.type === "approval_request"),
  );
  stopper.stop();
  const stopped = await hanging;
  assert.equal(stopped.ok, false);
  assert.match(String(stopped.error), /stopped/i);

  // --- resume restores a session by its durable reference (fix 3/4) ---
  const events2 = [];
  const resumed = spawnAgent("z-resume", { stateFile: join(dir, "state2.json") });
  resumed.onEvent((event) => events2.push(event));
  const openResult = await resumed.start(process.cwd(), {
    agentMode: "manual",
    sessionPath: "zcode:s1",
  });
  assert.equal(openResult.ok, true);
  assert.equal(resumed.sessionFile, "zcode:s1");
  // The snapshot's history replayed into devden messages (fix 3).
  const replayed = await resumed.getMessages();
  assert.equal(replayed[0].role, "user");
  assert.equal(replayed[0].content[0].text, "hello");
  assert.equal(replayed.at(-1).role, "assistant");
  assert.equal(replayed.at(-1).content[0].text, "Hello world");
  // The cursor reset with the resumed session: a fresh prompt still settles
  // (the old cursor would skip its completion event — fix 4).
  const resumedPrompt = resumed.prompt("again");
  const approval2 = await waitFor(() =>
    events2.find((event) => event.type === "approval_request"),
  );
  resumed.resolveApproval(approval2.requestId, "allow");
  const againResult = await resumedPrompt;
  assert.equal(againResult.ok, true, JSON.stringify(againResult));
  assert.equal(readState(join(dir, "state2.json")).resumedSessionId, "s1");
  resumed.stop();
  agent.stop();

  delete process.env.DEVDEN_ZCODE_CREDENTIALS;
});

test("zcodeRequestAuth prefers standalone keys and falls back to oauth", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-auth-"));
  const file = join(dir, "credentials.json");
  process.env.DEVDEN_ZCODE_CREDENTIALS = file;

  writeFileSync(
    file,
    JSON.stringify({
      "account-provider:account:zai-individual-coding-plan:identity": "me@test",
      "account-provider:coding-plan:account:zai-individual-coding-plan:account:me%40test:api-key":
        "test-key",
    }),
  );
  assert.deepEqual(
    await zcodeRequestAuth("account:zai-individual-coding-plan"),
    { apiKey: "test-key" },
  );

  writeFileSync(file, JSON.stringify({ "oauth:zai:access_token": "tok" }));
  assert.deepEqual(await zcodeRequestAuth("anyone"), {
    headers: { Authorization: "Bearer tok" },
  });

  writeFileSync(file, JSON.stringify({}));
  assert.equal(await zcodeRequestAuth("anyone"), null);

  delete process.env.DEVDEN_ZCODE_CREDENTIALS;
});

test("steer is unsupported and setModel/setThinkingLevel round-trip", async () => {
  const agent = spawnAgent("z-models");
  collect(agent);
  await agent.start(process.cwd(), {});

  const steered = await agent.steer("mid turn");
  assert.equal(steered.unsupported, true);

  const set = await agent.setModel("zai", "GLM-5.3-flash");
  assert.equal(set.ok, true);
  assert.equal(agent.model.id, "GLM-5.3-flash");

  const thinking = await agent.setThinkingLevel("high");
  assert.equal(thinking.ok, true);
  assert.equal(agent.thinkingLevel, "high");

  const aborted = await agent.abort();
  assert.equal(aborted.ok, true);
  agent.stop();
});