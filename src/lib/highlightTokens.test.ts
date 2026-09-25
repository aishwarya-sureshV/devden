import { strict as assert } from "node:assert";
import { test } from "node:test";
import { highlightToHtml, tokenizeCode } from "./highlightTokens.ts";

test("ts tokens distinguish keywords, types, functions, strings, comments", () => {
  const code = `/** docs */\nimport type { TimelineItem } from "./timeline.ts";\nfunction toolPath() { return "x"; }`;
  const kinds = tokenizeCode(code, "ts")
    .filter((t) => t.kind)
    .map((t) => `${t.kind}:${t.text}`);
  assert.ok(kinds.some((k) => k.startsWith("comment:")));
  assert.ok(kinds.includes("keyword:import"));
  assert.ok(kinds.includes("keyword:type"));
  assert.ok(kinds.includes("type:TimelineItem"));
  assert.ok(kinds.includes("keyword:function"));
  assert.ok(kinds.includes("func:toolPath"));
  assert.ok(kinds.includes("keyword:return"));
  assert.ok(kinds.some((k) => k.startsWith("string:")));
});

test("html escapes raw markup inside tokens", () => {
  const html = highlightToHtml(`const x = "<script>";`, "ts");
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /tok-keyword/);
  assert.match(html, /&lt;script&gt;/);
});
