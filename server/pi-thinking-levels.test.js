import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { supportedThinkingLevels } from "./pi-agent.js";

describe("supportedThinkingLevels", () => {
  it("non-reasoning models get off only", () => {
    assert.deepEqual(supportedThinkingLevels({ reasoning: false }), ["off"]);
    assert.deepEqual(supportedThinkingLevels({}), ["off"]);
    assert.deepEqual(supportedThinkingLevels(undefined), ["off"]);
  });

  it("reasoning models with no map expose the full ladder minus xhigh/max", () => {
    assert.deepEqual(supportedThinkingLevels({ reasoning: true }), [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("map defines xhigh/max", () => {
    assert.deepEqual(
      supportedThinkingLevels({
        reasoning: true,
        thinkingLevelMap: {
          off: "none",
          minimal: "minimal",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
      }),
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    );
  });

  it("map holes drop levels (high+max without xhigh)", () => {
    assert.deepEqual(
      supportedThinkingLevels({
        reasoning: true,
        thinkingLevelMap: { off: "none", high: "high", max: "max" },
      }),
      ["off", "minimal", "low", "medium", "high", "max"],
    );
  });

  it("mapped null hides a level", () => {
    assert.deepEqual(
      supportedThinkingLevels({
        reasoning: true,
        thinkingLevelMap: {
          off: "none",
          minimal: null,
          high: "high",
          max: "max",
        },
      }),
      ["off", "low", "medium", "high", "max"],
    );
  });
});
