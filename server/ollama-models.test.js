import { strict as assert } from "node:assert";
import test from "node:test";
import { isStaleThinkingLevelMap } from "./ollama-models.js";

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
