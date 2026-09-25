import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mdToHtml } from "./markdown.ts";

test("inline code, bold, and numbered lists render as tags", () => {
  const html = mdToHtml(
    "so `old_string` / `new_string` showed up.\n\n1. **DIFF first** — red `-` / green `+`\n2. **INPUT** — like `file_path`",
  );
  assert.match(html, /<code>old_string<\/code>/);
  assert.match(html, /<strong>DIFF first<\/strong>/);
  assert.match(html, /<ol class="md-list">/);
  assert.match(html, /<code>\+<\/code>/);
  assert.equal(html.includes("**DIFF"), false);
  assert.equal(html.includes("`old_string`"), false);
});

test("fenced code becomes a pre block, not literal backticks", () => {
  const html = mdToHtml("looks like:\n\n```\n-  return\n+  return\n```\n\nand a `file_path` field");
  assert.match(html, /<pre class="md-code"><code>/);
  assert.match(html, /-  return/);
  assert.match(html, /<code>file_path<\/code>/);
  assert.equal(html.includes("```"), false);
});

test("headings, bullets, tables, links, and strike", () => {
  const html = mdToHtml(
    "# Title\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n~~gone~~ [docs](https://example.com)",
  );
  assert.match(html, /<h3 class="md-h">Title<\/h3>/);
  assert.match(html, /<ul class="md-list"><li>one<\/li>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<del>gone<\/del>/);
  assert.match(html, /href="https:\/\/example.com"/);
});

test("raw HTML in a message is escaped", () => {
  const html = mdToHtml("</script><img src=x onerror=alert(1)>");
  assert.equal(html.includes("<img"), false);
  assert.equal(html.includes("</script>"), false);
  assert.match(html, /&lt;\/script&gt;/);
});

test("unmatched fence stays prose so talk about markdown is not swallowed", () => {
  const html = mdToHtml("an opener ```\nstays text");
  assert.equal(html.includes("<pre"), false);
  assert.match(html, /an opener ```/);
});
