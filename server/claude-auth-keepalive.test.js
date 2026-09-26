import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startClaudeAuthKeepalive,
  subscriptionEnvironment,
} from "./claude-agent.js";

const dir = mkdtempSync(join(tmpdir(), "devden-keepalive-"));

function fakeClaude(name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Run one keepalive tick against a stand-in CLI and collect what it warned. */
async function tick(bin) {
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  process.env.DEVDEN_CLAUDE_BIN = bin;
  try {
    clearInterval(startClaudeAuthKeepalive());
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } finally {
    console.warn = original;
  }
  return warnings.join("\n");
}

test("a healthy CLI keeps the keepalive quiet", async () => {
  assert.equal(await tick(fakeClaude("ok", "exit 0")), "");
});

test("a logged-out CLI warns with the fix", async () => {
  const warned = await tick(
    fakeClaude("dead", 'echo "Invalid API key · Please run /login" >&2\nexit 1'),
  );
  assert.match(warned, /auth keepalive failed/);
  assert.match(warned, /Invalid API key/);
  assert.match(warned, /\/login/);
});

test("subscriptionEnvironment strips Claude Desktop host-auth", () => {
  const keys = [
    "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
    "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH = "1";
    process.env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH = "1";
    process.env.CLAUDE_CODE_CHILD_SESSION = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "claude-desktop";
    process.env.CLAUDE_CODE_MESSAGING_TOKEN = "desktop-session";
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = "/tmp/cc-socks/x.sock";
    process.env.CLAUDE_CODE_HOST_SESSION_ID = "host-session";
    process.env.CLAUDE_CODE_SESSION_ID = "child-session";
    process.env.CLAUDE_CODE_EXECPATH = "/Applications/Claude.app/claude";
    process.env.CLAUDE_PID = "123";
    process.env.CLAUDE_CODE_OAUTH_SCOPES = "user:inference user:sessions:claude_code";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "keep-me";
    process.env.ANTHROPIC_API_KEY = "sk-test";

    const env = subscriptionEnvironment();
    assert.equal(env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH, undefined);
    assert.equal(env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH, undefined);
    assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined);
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(env.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
    assert.equal(env.CLAUDE_CODE_MESSAGING_SOCKET, undefined);
    assert.equal(env.CLAUDE_CODE_HOST_SESSION_ID, undefined);
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(env.CLAUDE_CODE_EXECPATH, undefined);
    assert.equal(env.CLAUDE_PID, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "keep-me");
    assert.equal(
      env.CLAUDE_CODE_OAUTH_SCOPES,
      "user:inference user:sessions:claude_code",
    );
    assert.equal(env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING, "true");
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("subscriptionEnvironment drops Desktop session scopes without a token", () => {
  const keys = [
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_SCOPES = "user:inference user:sessions:claude_code";
    const env = subscriptionEnvironment();
    assert.equal(env.CLAUDE_CODE_OAUTH_SCOPES, undefined);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
