import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasAskBlock } from "./ask-block.js";

const bare = JSON.stringify({
  questions: [{ question: "Which?", options: ["a", "b"] }],
});

describe("hasAskBlock", () => {
  it("reads an ask fence, bare JSON, and a json fence", () => {
    assert.equal(hasAskBlock(["```ask", bare, "```"].join("\n")), true);
    assert.equal(hasAskBlock(bare), true);
    assert.equal(hasAskBlock(["```json", bare, "```"].join("\n")), true);
    assert.equal(hasAskBlock(["```JSON", bare, "```"].join("\n")), true);
  });

  it("ignores json that is not an ask", () => {
    assert.equal(hasAskBlock("```json\n{}\n```"), false);
    assert.equal(hasAskBlock('```json\n{"foo":1}\n```'), false);
    assert.equal(hasAskBlock("A question?"), false);
  });
});
