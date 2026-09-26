import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadRoute, normalizeRoute, saveRoute } from "./session-route.js";

describe("normalizeRoute", () => {
  it("keeps a diagnose → execute template", () => {
    const route = normalizeRoute({
      enabled: true,
      template: "fix",
      steps: [
        { kind: "diagnose", backend: "codex" },
        { kind: "execute", backend: "grok" },
      ],
    });
    assert.equal(route.template, "fix");
    assert.equal(route.steps.length, 2);
  });

  it("keeps a diagnose chain and drops junk steps", () => {
    const route = normalizeRoute({
      enabled: 1,
      template: "diagnose",
      steps: [
        { id: "d", kind: "diagnose", backend: "codex" },
        { kind: "execute", backend: "mystery" },
        { id: "e", kind: "execute", backend: "grok", enabled: false },
      ],
    });
    assert.equal(route.enabled, true);
    assert.equal(route.steps.length, 2);
    assert.equal(route.steps[1].enabled, false);
  });
});

describe("saveRoute / loadRoute", () => {
  it("round-trips by session file even under a new conversation key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "devden-route-"));
    const saved = await saveRoute(
      "tab-1",
      "/tmp/session.jsonl",
      {
        enabled: true,
        template: "plan",
        steps: [{ kind: "plan", backend: "claude", modelName: "opus" }],
      },
      dir,
    );
    assert.equal(saved.ok, true);
    const fromNewKey = await loadRoute("tab-9", "/tmp/session.jsonl", dir);
    assert.equal(fromNewKey.template, "plan");
    assert.equal(fromNewKey.steps[0].modelName, "opus");
    const fromOldKey = await loadRoute("tab-1", "", dir);
    assert.equal(fromOldKey.template, "plan");
  });
});
