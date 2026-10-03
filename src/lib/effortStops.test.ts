import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effortEstimate, effortScale, effortStops } from "./effortStops.ts";

describe("effortStops", () => {
  it("keeps an already-ascending ladder as-is", () => {
    assert.deepEqual(effortStops(["low", "medium", "high"], "medium"), [
      "low",
      "medium",
      "high",
    ]);
  });

  it("sorts grok-style descending catalogs ascending", () => {
    assert.deepEqual(effortStops(["xhigh", "high", "medium", "low"], "high"), [
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("inserts a missing current level at its ranked slot", () => {
    assert.deepEqual(effortStops(["low", "medium", "high"], "off"), [
      "off",
      "low",
      "medium",
      "high",
    ]);
    assert.deepEqual(effortStops(["low", "medium", "high"], "max"), [
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("holds a shared level still when another model offers fewer stops", () => {
    const wide = ["low", "medium", "high", "xhigh", "max", "ultra"];
    const scale = effortScale([wide, ["low", "medium", "high", "xhigh"]], "xhigh");
    assert.deepEqual(scale, wide);
    assert.equal(scale.indexOf("xhigh"), 3);
  });

  it("estimates by level name, not by where that level sits", () => {
    assert.equal(effortEstimate("xhigh"), "~40s");
    assert.equal(effortEstimate("high"), "~15s");
    assert.equal(effortEstimate("ultra"), "~2m");
    assert.equal(effortEstimate("nope"), "");
  });

  it("keeps unknown levels last and empty lists answer the current level", () => {
    assert.deepEqual(effortStops(["low", "turbo", "high"], "low"), [
      "low",
      "high",
      "turbo",
    ]);
    assert.deepEqual(effortStops([], "high"), ["high"]);
    assert.deepEqual(effortStops([], ""), ["off"]);
  });
});
