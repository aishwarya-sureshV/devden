import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAgentProcess } from "./pi-agent.js";

/**
 * stop() then start() (the Ollama set_model path) used to fail: the old
 * child's late exit ran failPending() and rejected the NEW child's
 * get_state, so start() threw "Pi exited (SIGTERM)".
 */
// Answers every request after 500ms; exits 300ms after SIGTERM, so the old
// child's exit lands while the new child's get_state is still pending.
const FAKE_PI = `#!/usr/bin/env node
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300));
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const { id } = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ type: "response", id, success: true, data: { isStreaming: false } }) + "\\n");
    }, 500);
  }
});
`;

test("restart survives the old child's exit landing mid-start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
  const executable = join(dir, "pi");
  writeFileSync(executable, FAKE_PI);
  chmodSync(executable, 0o755);

  const agent = new PiAgentProcess("restart-test");
  agent.executable = executable;
  try {
    assert.equal((await agent.start(dir)).ok, true);
    const old = agent.process;
    const oldExited = new Promise((resolve) => old.once("exit", resolve));
    agent.stop();
    const restarted = agent.start(dir);
    await oldExited; // the race: old exit fires before the new get_state answers
    assert.equal((await restarted).ok, true);
    assert.notEqual(agent.process, undefined);
    assert.equal(agent.status, "ready");
  } finally {
    agent.stop();
  }
});
