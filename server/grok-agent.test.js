import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sessionUpdateIsFor } from "./grok-agent.js";

describe("sessionUpdateIsFor", () => {
  it("keeps updates with no session id (legacy payloads)", () => {
    assert.equal(sessionUpdateIsFor("abc", { update: {} }), true);
    assert.equal(sessionUpdateIsFor("abc", null), true);
  });

  it("keeps updates for this session", () => {
    assert.equal(
      sessionUpdateIsFor("abc", { sessionId: "abc", update: {} }),
      true,
    );
  });

  it("drops updates for a forked sibling session", () => {
    assert.equal(
      sessionUpdateIsFor("parent", {
        sessionId: "fork-child",
        update: { sessionUpdate: "agent_thought_chunk" },
      }),
      false,
    );
  });
});
