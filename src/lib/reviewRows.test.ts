import assert from "node:assert/strict";
import test from "node:test";
import { reviewRows } from "./reviewRows.ts";
import type { ToolDiff } from "./toolCards.ts";

test("full-file reviews keep exact lines, both line numbers, and navigable hunks", () => {
  const diff: ToolDiff = { added: 2, removed: 1, lines: [
    { kind: "meta", text: "@@ -2 +2,2 @@" },
    { kind: "remove", text: "old" },
    { kind: "add", text: "new" },
    { kind: "add", text: "extra" },
  ] };
  const rows = reviewRows(diff, "first\nnew\nextra\nlast\n");
  assert.deepEqual(rows.map(({ kind, oldNo, newNo, text }) => [kind, oldNo, newNo, text]), [
    ["context", "1", "1", "first"],
    ["meta", "", "", "@@ -2 +2,2 @@"],
    ["remove", "2", "", "old"],
    ["add", "", "2", "new"],
    ["add", "", "3", "extra"],
    ["context", "3", "4", "last"],
  ]);
  assert.equal(rows[1]!.hunk, 0);
  assert.deepEqual(reviewRows(diff, "first\nchanged later\nlast\n"), reviewRows(diff));
  const inserted = reviewRows({ added: 1, removed: 0, lines: [
    { kind: "meta", text: "@@ -0,0 +1 @@" },
    { kind: "add", text: "new" },
  ] }, "new\nfirst\n");
  assert.deepEqual(inserted.at(-1), { kind: "context", hunk: -1, oldNo: "1", newNo: "2", text: "first" });
});

test("edit-tool diffs are placed in the whole file by finding their new text", () => {
  const diff: ToolDiff = { added: 2, removed: 1, lines: [
    { kind: "remove", text: "b", lineNo: 1 },
    { kind: "add", text: "B", lineNo: 1 },
    { kind: "add", text: "x", lineNo: 1 },
  ] };
  const rows = reviewRows(diff, "a\nB\nx\nc\n");
  assert.deepEqual(rows.filter((r) => r.kind !== "meta").map(({ kind, oldNo, newNo, text }) => [kind, oldNo, newNo, text]), [
    ["context", "1", "1", "a"],
    ["remove", "2", "", "b"],
    ["add", "", "2", "B"],
    ["add", "", "3", "x"],
    ["context", "3", "4", "c"],
  ]);
  // The file no longer holds the new text: fall back to the snippet.
  assert.equal(reviewRows(diff, "a\nc\n").some((r) => r.kind === "context"), false);
});
