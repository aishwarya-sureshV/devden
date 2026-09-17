import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CO_PARTNER_PROMPT,
  repoContext,
  stripClarifyPrefix,
  withClarifyPrefix,
  withGrokPrefix,
} from "./co-partner-prompt.js";

describe("grok prompt prefix", () => {
  it("asks grok to narrate before tools, then strips the fence on replay", () => {
    const prefixed = withGrokPrefix("swap the logos");
    assert.match(prefixed, /Before every tool call/);
    assert.equal(prefixed.includes(CO_PARTNER_PROMPT), true);
    assert.equal(prefixed.includes("Never kill, SIGTERM"), false);
    assert.equal(stripClarifyPrefix(prefixed), "swap the logos");
  });

  it("still strips the older clarify-only fence", () => {
    assert.equal(stripClarifyPrefix(withClarifyPrefix("be nice")), "be nice");
  });
});

describe("repo context", () => {
  it("reads the workspace CLAUDE.md for ACP backends", () => {
    const context = repoContext(process.cwd());
    assert.match(context, /CLAUDE\.md/);
  });

  it("returns empty context when the workspace has no CLAUDE.md", () => {
    const empty = mkdtempSync(join(tmpdir(), "repo-context-"));
    assert.equal(repoContext(join(empty, "nowhere")), "");
  });

  it("injects CLAUDE.md inside the strip-able fence", () => {
    const prefixed = withClarifyPrefix("be nice", repoContext(process.cwd()));
    assert.match(prefixed, /Project instructions \(CLAUDE\.md\)/);
    assert.equal(stripClarifyPrefix(prefixed), "be nice");
  });

  it("keeps the no-context prefix identical to before", () => {
    assert.equal(stripClarifyPrefix(withGrokPrefix("x", "")), "x");
  });
});