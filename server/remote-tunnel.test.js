import test from "node:test";
import assert from "node:assert/strict";
import { assetNameFor, extractTunnelUrl } from "./remote-tunnel.js";

test("extractTunnelUrl finds the trycloudflare URL in cloudflared output", () => {
  const noisy = `2026-09-13T19:00:00Z INF Starting tunnel tunnelID=abc
2026-09-13T19:00:00Z INF +--------------------------------------------------------------------------------------------+
2026-09-13T19:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-09-13T19:00:00Z INF |  https://example-hello-world-123.trycloudflare.com                                                   |
2026-09-13T19:00:00Z INF +--------------------------------------------------------------------------------------------+`;
  assert.equal(
    extractTunnelUrl(noisy),
    "https://example-hello-world-123.trycloudflare.com",
  );
});

test("extractTunnelUrl ignores unrelated https URLs and returns null", () => {
  assert.equal(
    extractTunnelUrl("see https://developers.cloudflare.com for docs"),
    null,
  );
  assert.equal(extractTunnelUrl(""), null);
});

test("assetNameFor maps every supported platform", () => {
  assert.equal(assetNameFor("darwin", "arm64"), "cloudflared-darwin-arm64.tgz");
  assert.equal(assetNameFor("darwin", "x64"), "cloudflared-darwin-amd64.tgz");
  assert.equal(assetNameFor("linux", "x64"), "cloudflared-linux-amd64");
  assert.equal(assetNameFor("linux", "arm64"), "cloudflared-linux-arm64");
  assert.equal(assetNameFor("win32", "x64"), "cloudflared-windows-amd64.exe");
  assert.throws(() => assetNameFor("sunos", "x64"));
});
