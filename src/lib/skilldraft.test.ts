import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DISTILL_SKILL_PROMPT,
  firstSkillDraftPayload,
  parseSkillDraft,
} from "./skilldraft.ts";

const REPLY = [
  "Here's the recipe distilled from this session.",
  "",
  "```skilldraft",
  JSON.stringify({
    name: "UI fix pipeline",
    description: "Fix a UI bug end to end with repro, plan, fix, verify.",
    body: "1. Reproduce with playwright\n2. Fix\n3. Verify",
  }),
  "```",
].join("\n");

describe("skilldraft payload", () => {
  it("extracts the first complete fence", () => {
    const payload = firstSkillDraftPayload(REPLY);
    assert.ok(payload);
    assert.deepEqual(parseSkillDraft(payload), {
      name: "UI fix pipeline",
      description: "Fix a UI bug end to end with repro, plan, fix, verify.",
      body: "1. Reproduce with playwright\n2. Fix\n3. Verify",
    });
  });

  it("returns null while the fence is still streaming", () => {
    const half = REPLY.slice(
      0,
      REPLY.indexOf("```skilldraft") + "```skilldraft".length,
    );
    assert.equal(firstSkillDraftPayload(half), null);
  });

  it("rejects malformed or empty-field payloads", () => {
    assert.equal(parseSkillDraft("not json"), null);
    assert.equal(
      parseSkillDraft(
        JSON.stringify({ name: "x", description: "", body: "y" }),
      ),
      null,
    );
    assert.equal(parseSkillDraft("[]"), null);
  });

  it("ignores other fences and plain prose", () => {
    assert.equal(firstSkillDraftPayload("```js\nconst x = 1;\n```"), null);
    assert.equal(firstSkillDraftPayload("no fences here"), null);
  });

  it("keeps the distill prompt honest about one-off sessions", () => {
    assert.match(DISTILL_SKILL_PROMPT, /one-off/);
    assert.match(DISTILL_SKILL_PROMPT, /do not emit any block/);
    assert.match(DISTILL_SKILL_PROMPT, /\$ARGUMENTS/);
    assert.match(DISTILL_SKILL_PROMPT, /never line numbers/);
  });
});
