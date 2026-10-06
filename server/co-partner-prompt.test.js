import assert from "node:assert/strict";
import { it } from "node:test";
import { stripClarifyPrefix } from "./co-partner-prompt.js";

it("strips harness fences that older sessions recorded", () => {
  const fence = (body) =>
    `[devden harness instruction — x]\n${body}\n[end devden harness instruction]\n`;
  assert.equal(stripClarifyPrefix(fence("a") + fence("b") + "swap the logos"), "swap the logos");
  assert.equal(stripClarifyPrefix("plain text"), "plain text");
});
