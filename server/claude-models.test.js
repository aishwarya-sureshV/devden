import test from "node:test";
import assert from "node:assert/strict";
import {
  ClaudeAgentProcess,
  claudeModelInfo,
  parseClaudeModelIds,
  setClaudeModelsForTesting,
} from "./claude-agent.js";

test("claude's model list stays Claude-only", async () => {
  const agent = new ClaudeAgentProcess("test-session");
  // A session that recorded a foreign id (a proxied or experimental run) used
  // to have that id prepended to the list, which is how a `claude` row ended
  // up advertising GLM as its model.
  agent.model = {
    provider: "anthropic",
    id: "glm-5.3-flash",
    name: "glm 5.3 flash",
  };
  const result = await agent.getAvailableModels();
  assert.equal(result.ok, true);
  assert.ok(result.models.length > 0);
  assert.deepEqual(
    result.models.filter((model) => !model.id.startsWith("claude")),
    [],
  );
});

test("cli bundle scan keeps real ids, drops junk, sorts newest first", () => {
  const ids = parseClaudeModelIds(`
    claude-opus-4-20250514 claude-opus-4-0 claude-opus-4 claude-haiku-3-55
    claude-3-5-haiku claude-opus-5-5[1m] claude-fable-5-1 claude-opus-5
    claude-sonnet-5 claude-haiku-4-5
  `);
  assert.deepEqual(ids, [
    "claude-opus-5-5",
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
  ]);
});

test("catalog whitelist wins over dead loose ids", () => {
  const ids = parseClaudeModelIds(
    'r==="claude-opus-5-5"||r==="claude-haiku-4-5" junk claude-sonnet-3-7',
  );
  assert.deepEqual(ids, ["claude-opus-5-5", "claude-haiku-4-5"]);
});

test("point releases keep their id; only date stamps fold onto a known model", () => {
  // The scanned list can lag the CLI: it knows claude-sonnet-5, not 5-5.
  setClaudeModelsForTesting(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);
  assert.equal(claudeModelInfo("claude-sonnet-5-5").id, "claude-sonnet-5-5");
  assert.equal(claudeModelInfo("claude-sonnet-5-6").id, "claude-sonnet-5-6");
  assert.equal(claudeModelInfo("claude-sonnet-5-20260101").id, "claude-sonnet-5");
  assert.equal(claudeModelInfo("claude-sonnet-5-20260101-v1").id, "claude-sonnet-5");
  assert.equal(claudeModelInfo("claude-sonnet-5[1m]").id, "claude-sonnet-5");
  assert.equal(claudeModelInfo("sonnet").id, "claude-sonnet-5");
  assert.equal(claudeModelInfo("opus").id, "claude-opus-5");
});
