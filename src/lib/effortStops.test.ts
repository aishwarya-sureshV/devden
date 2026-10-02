import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effortStops } from "./effortStops.ts";

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
