import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtCount, toolLook } from "./workbenchLook.ts";

test("handoff tool looks remain stable, strip MCP prefixes and select family icons", () => {
  assert.deepEqual(toolLook("read"), { color: "#7ab8ff", icon: "read" });
  assert.deepEqual(toolLook("mcp·linear"), toolLook("linear"));
  assert.deepEqual(toolLook("mcp__linear"), toolLook("linear"));
  assert.equal(toolLook("custom_search").icon, "grep");
  assert.equal(toolLook("screenshot").icon, "_unknown");
  assert.equal(toolLook("lint").color, toolLook("lint").color);
});
test("Delta counts use full numbers below 10k and compact large counts", () => {
  assert.deepEqual([0, 8061, 10000, 24300, 182000, 1200000].map(fmtCount), ["0", "8,061", "10k", "24.3k", "182k", "1.2M"]);
});
