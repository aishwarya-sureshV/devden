import test from "node:test";
import assert from "node:assert/strict";
import { explainUpdateError, newer } from "./harness-update.js";

test("newer() compares versions so the update toast fires only when stale", () => {
  assert.equal(newer("0.160.0", "0.147.0"), true);
  assert.equal(newer("2.1.288", "2.1.287"), true);
  assert.equal(newer("1.0.0", "1.0.0"), false);
  assert.equal(newer("1.0.0", "1.0.1"), false);
  assert.equal(newer("0.147", "0.147.0"), false, "missing patch defaults to 0");
  assert.equal(newer("1.10.0", "1.9.9"), true, "numeric, not lexical compare");
  assert.equal(newer(null, "1.0.0"), false, "unknown latest never fires");
  assert.equal(newer("1.0.0", null), false);
});
test("newer() ignores a 0.0.0 placeholder build so the toast can't nag forever", () => {
  assert.equal(newer("0.160.0", "0.0.0"), false);
  assert.equal(newer("0.160.0", "codex-cli 0.0.0"), false);
});

test("explainUpdateError() turns npm noise into one readable line", () => {
  assert.match(explainUpdateError({ stderr: "npm error code EACCES" }), /Permission denied/);
  assert.match(explainUpdateError({ killed: true }), /Timed out/);
  assert.match(explainUpdateError({ stderr: "npm error code ENOTFOUND" }), /registry/);
  assert.equal(explainUpdateError({ stderr: "\n boom \nmore" }), "boom");
});
