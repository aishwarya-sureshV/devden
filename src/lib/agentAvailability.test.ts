import test from "node:test";
import assert from "node:assert/strict";
import {
  backendUsable,
  handoffTarget,
  pickerBackendIds,
} from "./agentAvailability.ts";
import type { BackendInfo } from "./api.ts";

function row(
  id: string,
  overrides: Partial<BackendInfo> = {},
): BackendInfo {
  return {
    id: id as BackendInfo["id"],
    name: id,
    command: id,
    args: [],
    path: "/bin/cli",
    pathLabel: "/bin/cli",
    version: "1.0",
    auth: "ok",
    installCommand: null,
    loginCommand: null,
    capabilities: {} as BackendInfo["capabilities"],
    ...overrides,
  };
}

test("usable needs path, auth and enabled", () => {
  assert.equal(backendUsable(row("claude")), true);
  assert.equal(backendUsable(row("claude", { path: null })), false);
  assert.equal(backendUsable(row("claude", { auth: "missing" })), false);
  assert.equal(backendUsable(row("claude", { enabled: false })), false);
  assert.equal(backendUsable(undefined), false);
});

test("pickers hide disabled agents and fall back when the catalog is empty", () => {
  const catalog = [row("pi"), row("claude", { enabled: false }), row("codex")];
  assert.deepEqual(pickerBackendIds(catalog), ["pi", "codex"]);
  // No `enabled` field (old server) keeps everything offered.
  assert.deepEqual(pickerBackendIds([row("grok")]), ["grok"]);
  // Empty catalog must not empty the picker.
  assert.ok(pickerBackendIds([]).length > 0);
  // Every agent disabled also falls back rather than locking the UI out.
  assert.ok(
    pickerBackendIds(catalog.map((entry) => ({ ...entry, enabled: false })))
      .length > 0,
  );
});

test("handoff offers the preferred agent, else the first usable one", () => {
  const catalog = [
    row("pi"),
    row("claude", { auth: "missing" }),
    row("codex", { enabled: false }),
    row("grok"),
  ];
  // Current agent fine → no handoff.
  assert.equal(handoffTarget("pi", catalog, "grok"), null);
  // Claude is signed out: prefer the default when it can take over.
  assert.equal(handoffTarget("claude", catalog, "grok"), "grok");
  // Default unusable → first usable.
  assert.equal(handoffTarget("claude", catalog, "codex"), "pi");
  // Disabled agent's session: offer a live one.
  assert.equal(handoffTarget("codex", catalog, undefined), "pi");
  // Nothing usable → nothing to offer.
  assert.equal(handoffTarget("claude", catalog.map((e) => ({ ...e, auth: "missing" as const }))), null);
  assert.equal(handoffTarget("claude", [], "grok"), null);
});