import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  continueList,
  imageIds,
  inCodeFence,
  indentAt,
  joinSegments,
  noteTitle,
  parseSegments,
  startCodeBlock,
} from "./notes.ts";

describe("continueList", () => {
  it("continues numbered lists", () => {
    const result = continueList("1. hello", 8);
    assert.deepEqual(result, { text: "1. hello\n2. ", caret: 12 });
  });

  it("continues lettered lists", () => {
    const result = continueList("a. hello", 8);
    assert.deepEqual(result, { text: "a. hello\nb. ", caret: 12 });
  });

  it("keeps the indent of nested items", () => {
    const result = continueList("1. top\n   a. inner", 18);
    assert.deepEqual(result, {
      text: "1. top\n   a. inner\n   b. ",
      caret: 25,
    });
  });

  it("supports ) as the marker punctuation", () => {
    const result = continueList("A) capped", 9);
    assert.deepEqual(result, { text: "A) capped\nB) ", caret: 13 });
  });

  it("continues from the caret line, not the first line", () => {
    const result = continueList("1. one\nplain line", 16);
    assert.equal(result, null);
  });

  it("drops the marker when Enter is pressed on an empty item", () => {
    const result = continueList("1. one\n2. ", 10);
    assert.deepEqual(result, { text: "1. one\n\n", caret: 8 });
  });

  it("returns null for lines without a marker", () => {
    assert.equal(continueList("just text", 9), null);
  });

  it("replaces the selection instead of keeping it", () => {
    // "bc" selected inside "1. abc def": the selection is deleted, the list
    // still has content, so it continues with the incremented marker.
    const result = continueList("1. abc def", 4, 6);
    assert.deepEqual(result, { text: "1. a\n2.  def", caret: 8 });
  });

  it("wraps z to aa", () => {
    const result = continueList("z. item", 7);
    assert.deepEqual(result, { text: "z. item\naa. ", caret: 12 });
  });
});

describe("noteTitle", () => {
  it("uses the first body line", () => {
    assert.equal(
      noteTitle({ id: "x", body: "Groceries\nmilk", updatedAt: 1 }),
      "Groceries",
    );
  });

  it("falls back for empty notes", () => {
    assert.equal(noteTitle({ id: "x", body: "", updatedAt: 1 }), "New note");
  });
});

describe("indentAt", () => {
  it("indents the whole line when the caret sits after a list marker", () => {
    const result = indentAt("1. top\n2. ", 10);
    assert.deepEqual(result, { text: "1. top\n  2. ", caret: 12 });
  });

  it("indents a blank line at the line start", () => {
    const result = indentAt("hello\n", 6);
    assert.deepEqual(result, { text: "hello\n  ", caret: 8 });
  });

  it("inserts spaces at the caret mid-line (code context)", () => {
    const result = indentAt("const x = 1", 6);
    assert.deepEqual(result, { text: "const   x = 1", caret: 8 });
  });
});

describe("startCodeBlock", () => {
  it("opens a fence with the closer in place; block at the segment start", () => {
    const result = startCodeBlock("```", 3);
    assert.deepEqual(result, { text: "```\n\n```", caret: 4, blockAt: 0 });
  });

  it("keeps the language suffix; block after preceding text", () => {
    const result = startCodeBlock("before\n```js", 12);
    assert.deepEqual(result, {
      text: "before\n```js\n\n```",
      caret: 13,
      blockAt: 1,
    });
  });

  it("does not trigger for lines that are not a bare fence opener", () => {
    assert.equal(startCodeBlock("some ``` text", 13), null);
  });
});

describe("inCodeFence", () => {
  it("detects the inside of an open fence", () => {
    assert.equal(inCodeFence("```\ncode", 6), true);
    assert.equal(inCodeFence("```\ncode\n```\nafter", 14), false);
  });

  it("stops list continuation inside a fence", () => {
    assert.equal(continueList("```\n1. code", 10), null);
  });
});

describe("parseSegments", () => {
  it("splits text and fenced code", () => {
    assert.deepEqual(parseSegments("a\n```\ncode\n```\nd"), [
      { kind: "text", text: "a" },
      { kind: "code", text: "code", lang: undefined },
      { kind: "text", text: "d" },
    ]);
  });

  it("captures the language of a closed fence", () => {
    assert.deepEqual(parseSegments("```js\nx\n```"), [
      { kind: "code", text: "x", lang: "js" },
      { kind: "text", text: "" },
    ]);
  });

  it("keeps an unclosed fence as plain text so Enter can trigger it", () => {
    assert.deepEqual(parseSegments("```js\nx\nunclosed"), [
      { kind: "text", text: "```js\nx\nunclosed" },
    ]);
  });

  it("always leaves a trailing text segment after a code block", () => {
    const segments = parseSegments("```\nc\n```");
    assert.equal(segments.at(-1)!.kind, "text");
    assert.equal(segments.at(-1)!.text, "");
  });

  it("parses an empty body into a single empty text segment", () => {
    assert.deepEqual(parseSegments(""), [{ kind: "text", text: "" }]);
  });
});

describe("joinSegments", () => {
  it("round-trips a body with a code block", () => {
    const body = "a\n```\ncode\n```\nd";
    assert.equal(joinSegments(parseSegments(body)), body);
  });

  it("drops the auto-added tail and leaves unclosed fences untouched", () => {
    assert.equal(
      joinSegments(parseSegments("```js\nx\nunclosed")),
      "```js\nx\nunclosed",
    );
    assert.equal(joinSegments(parseSegments("")), "");
  });
});

describe("imageIds", () => {
  it("collects dropped-image markers in body order", () => {
    const body =
      "intro\n![shot.png](image:abc-1)\ntext\n![dot.png](image:abc-2)";
    assert.deepEqual(imageIds(body), ["abc-1", "abc-2"]);
  });

  it("is empty when a note has no images", () => {
    assert.deepEqual(imageIds("plain note"), []);
  });
});
