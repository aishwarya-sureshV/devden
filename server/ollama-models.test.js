import { strict as assert } from "node:assert";
import test from "node:test";
import { isStaleThinkingLevelMap, listOllamaModels } from "./ollama-models.js";

test("the capped map written before xhigh/max support is stale", () => {
  assert.equal(
    isStaleThinkingLevelMap({
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      max: "high",
    }),
    true,
  );
});

test("a pass-through map is not stale", () => {
  assert.equal(
    isStaleThinkingLevelMap({ off: "none", xhigh: "xhigh", max: "max" }),
    false,
  );
  assert.equal(isStaleThinkingLevelMap(undefined), false);
});

test("remapping a level Ollama rejects is left alone", () => {
  assert.equal(isStaleThinkingLevelMap({ off: "none", ultra: "max" }), false);
});

test("a cloud model that reports thinking is registered as reasoning-capable", async () => {
  // Regression guard: cloud models were excluded here while Ollama's
  // openai-completions endpoint still leaked reasoning as <think> tags in
  // content. It now returns a separate `reasoning` field on both the
  // blocking and streaming paths, so the exclusion silently cost every
  // cloud model its thinking. Nothing covered that, so it went unnoticed.
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      models: [
        {
          name: "deepseek-v4-flash:cloud",
          capabilities: ["completion", "tools", "thinking"],
        },
        { name: "llava:7b", capabilities: ["completion", "vision"] },
      ],
    }),
  });
  try {
    const models = await listOllamaModels();
    const cloud = models.find((m) => m.id === "deepseek-v4-flash:cloud");
    assert.equal(cloud.reasoning, true);
    // The daemon object has no map; reasoning models must carry the full
    // 1:1 map so supportedThinkingLevels exposes every level through max.
    assert.deepEqual(cloud.thinkingLevelMap, {
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
    assert.equal(models.find((m) => m.id === "llava:7b").reasoning, false);
  } finally {
    globalThis.fetch = original;
  }
});
