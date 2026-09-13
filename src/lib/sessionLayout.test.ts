import { strict as assert } from "node:assert";
import test from "node:test";
import { sessionPaneLayout } from "./sessionLayout.ts";

test("one and two panes stay full-width on a single row", () => {
  const one = sessionPaneLayout(1);
  assert.equal(one.density, "full");
  assert.deepEqual(one.rowSizes, [1]);
  assert.deepEqual(one.spans, [1]);

  const two = sessionPaneLayout(2);
  assert.equal(two.density, "full");
  assert.deepEqual(two.rowSizes, [2]);
  assert.deepEqual(two.spans, [1, 1]);
});

test("three panes condense; four hit the per-row ceiling", () => {
  const three = sessionPaneLayout(3);
  assert.equal(three.density, "compact");
  assert.deepEqual(three.rowSizes, [3]);

  const four = sessionPaneLayout(4);
  assert.equal(four.density, "dense");
  assert.equal(four.cols, 4);
  assert.deepEqual(four.rowSizes, [4]);
});

test("past four, rows split evenly and panes stay at least a quarter wide", () => {
  const five = sessionPaneLayout(5);
  assert.equal(five.density, "dense");
  assert.deepEqual(five.rowSizes, [3, 2]);
  assert.equal(five.track, 6);
  assert.deepEqual(five.spans, [2, 2, 2, 3, 3]);
  assert.ok(five.spans.every((span) => span / five.track >= 0.25 - 1e-9));

  const six = sessionPaneLayout(6);
  assert.deepEqual(six.rowSizes, [3, 3]);

  const seven = sessionPaneLayout(7);
  assert.deepEqual(seven.rowSizes, [4, 3]);
  assert.ok(seven.spans.every((span) => span / seven.track >= 0.25 - 1e-9));

  const eight = sessionPaneLayout(8);
  assert.deepEqual(eight.rowSizes, [4, 4]);
});
