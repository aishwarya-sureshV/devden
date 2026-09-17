import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTemplate,
  defaultBackendForKind,
  enabledSteps,
  firstEnabled,
  normalizeRoute,
  roleAccess,
  templateSteps,
} from "./route.ts";

describe("route templates", () => {
  it("diagnose is cause → execute → review, execute stays on this session", () => {
    const steps = templateSteps("diagnose", "grok", () => "id");
    assert.deepEqual(
      steps.map((step) => [step.kind, step.backend, roleAccess(step.kind)]),
      [
        ["diagnose", "codex", "read-only"],
        ["execute", "grok", "writes"],
        ["review", "claude", "read-only"],
      ],
    );
  });

  it("plan is sequence → execute → review", () => {
    const steps = templateSteps("plan", "pi", () => "id");
    assert.deepEqual(
      steps.map((step) => step.kind),
      ["plan", "execute", "review"],
    );
    assert.equal(defaultBackendForKind("plan", "pi"), "claude");
    assert.equal(steps[1]?.backend, "pi");
  });

  it("fix is diagnose → execute with no review", () => {
    const route = applyTemplate("fix", "grok");
    assert.equal(route.template, "fix");
    assert.deepEqual(
      route.steps.map((step) => [step.kind, step.backend]),
      [
        ["diagnose", "codex"],
        ["execute", "grok"],
      ],
    );
  });

  it("custom starts as a single execute step on this session", () => {
    const route = applyTemplate("custom", "claude");
    assert.equal(route.template, "custom");
    assert.deepEqual(
      route.steps.map((step) => [step.kind, step.backend]),
      [["execute", "claude"]],
    );
  });
});

describe("normalizeRoute", () => {
  it("drops unknown kinds and backends, keeps disabled steps", () => {
    const route = normalizeRoute({
      enabled: true,
      template: "diagnose",
      steps: [
        { id: "a", kind: "diagnose", backend: "codex", enabled: false },
        { kind: "nope", backend: "grok" },
        { kind: "execute", backend: "nope" },
        { kind: "review", backend: "claude", modelName: "opus" },
      ],
    });
    assert.equal(route?.steps.length, 2);
    assert.equal(route?.steps[0]?.enabled, false);
    assert.equal(route?.steps[1]?.modelName, "opus");
    assert.equal(firstEnabled(route!)?.kind, "review");
    assert.equal(enabledSteps(route!).length, 1);
  });

  it("rejects junk", () => {
    assert.equal(normalizeRoute(null), null);
    assert.equal(normalizeRoute("routed"), null);
  });

  it("keeps the diagnose → execute template", () => {
    const route = normalizeRoute({
      enabled: true,
      template: "fix",
      steps: [
        { kind: "diagnose", backend: "codex" },
        { kind: "execute", backend: "grok" },
      ],
    });
    assert.equal(route?.template, "fix");
    assert.equal(route?.steps.length, 2);
  });
});
