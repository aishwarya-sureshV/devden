import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CO_PARTNER_PROMPT,
  HOST_PROMPT,
  stripClarifyPrefix,
  withClarifyPrefix,
  withGrokPrefix,
} from "./co-partner-prompt.js";

describe("grok prompt prefix", () => {
  it("asks grok to narrate before tools, then strips the fence on replay", () => {
    const prefixed = withGrokPrefix("swap the logos");
    assert.match(prefixed, /Before every tool call/);
    assert.equal(prefixed.includes(CO_PARTNER_PROMPT), true);
    assert.equal(prefixed.includes(HOST_PROMPT), true);
    assert.match(prefixed, /Never kill, SIGTERM/);
    assert.equal(stripClarifyPrefix(prefixed), "swap the logos");
  });

  it("still strips the older clarify-only fence", () => {
    assert.equal(stripClarifyPrefix(withClarifyPrefix("be nice")), "be nice");
  });
});
