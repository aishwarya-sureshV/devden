import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { connectionCommand, clearDetectionCache, detectBuiltins } from "./agent-detect.js";

test("Connect quotes executable paths and accepts only known subscription backends", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "devden-connect-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const executable = join(folder, "codex with 'quotes'");
  await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const { stdout } = await promisify(execFile)("/bin/sh", ["-c", connectionCommand("codex", executable)]);
  assert.equal(stdout, "login\n--device-auth\n");
  assert.throws(() => connectionCommand("codex; echo injected"), /Unknown agent/);
  assert.match(connectionCommand("claude"), /auth login --claudeai/);
  assert.match(connectionCommand("grok"), /login --device-auth/);
  assert.match(connectionCommand("pi"), /pi-login\.js/);
  assert.match(connectionCommand("codex"), /--prefix "\$HOME\/\.local"/);
  assert.doesNotMatch(connectionCommand("codex"), /sudo|--with-api-key/);
});

test("detection does not report API-key accounts as connected subscriptions", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "devden-subscription-"));
  const saved = Object.fromEntries(["PATH", "PI_CODING_AGENT_DIR", "GROK_HOME", "DEVDEN_TEST_AUTH"].map((key) => [key, process.env[key]]));
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    clearDetectionCache();
    await rm(folder, { recursive: true, force: true });
  });
  await mkdir(join(folder, "pi-state"));
  process.env.PI_CODING_AGENT_DIR = join(folder, "pi-state");
  process.env.GROK_HOME = folder;
  process.env.DEVDEN_TEST_AUTH = folder;
  process.env.PATH = `${folder}:${saved.PATH}`;
  for (const id of ["codex", "claude", "pi", "grok"]) {
    await writeFile(join(folder, id), `#!/bin/sh\nif [ "$1" = --version ]; then echo '1.0.0'; else cat "$DEVDEN_TEST_AUTH/${id}-status"; fi\n`, { mode: 0o755 });
  }
  const check = async (codex, claude, pi, grok) => {
    await writeFile(join(folder, "codex-status"), codex);
    await writeFile(join(folder, "claude-status"), JSON.stringify(claude));
    await writeFile(join(folder, "pi-state", "auth.json"), JSON.stringify(pi));
    await writeFile(join(folder, "auth.json"), JSON.stringify(grok));
    clearDetectionCache();
    return new Map((await detectBuiltins()).map((entry) => [entry.id, entry.auth]));
  };
  let result = await check("Logged in using API key", { loggedIn: true, authMethod: "api_key" }, { anthropic: { type: "api_key", key: "example" } }, { "https://api.x.ai": { key: "example" } });
  for (const id of ["codex", "claude", "pi", "grok"]) assert.equal(result.get(id), "missing");
  result = await check("Logged in using ChatGPT", { loggedIn: true, authMethod: "claude.ai" }, { anthropic: { type: "oauth", access: "example", refresh: "example" } }, { "https://accounts.x.ai/sign-in": { key: "example" } });
  for (const id of ["codex", "claude", "pi", "grok"]) assert.equal(result.get(id), "ok");
  result = await check("", {}, {}, { "https://auth.x.ai::client": { key: "example" } });
  assert.equal(result.get("grok"), "ok");
});
