import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { join } from "node:path";
import {
  blockedCommandReason,
  isOneShotSseClient,
  withHostGuardEnv,
} from "./host-guard.js";

const ctx = { port: 4319, pids: [4242, 4243] };

describe("blockedCommandReason", () => {
  it("allows scratch-server cleanup, health checks, and other ports", () => {
    assert.equal(blockedCommandReason("trap 'kill $PID' EXIT", ctx), null);
    assert.equal(blockedCommandReason("kill $PID", ctx), null);
    assert.equal(
      blockedCommandReason("curl -sf http://127.0.0.1:4319/api/health", ctx),
      null,
    );
    assert.equal(
      blockedCommandReason("kill $(lsof -t -i:9999)", ctx),
      null,
    );
    assert.equal(blockedCommandReason("lsof -ti :4319", ctx), null);
  });

  it("blocks kill of the workbench pid, port, and supervisor", () => {
    assert.match(blockedCommandReason("kill 4242", ctx), /Blocked/);
    assert.match(blockedCommandReason("kill -9 4242", ctx), /Blocked/);
    assert.match(
      blockedCommandReason("kill $(lsof -t -i:4319)", ctx),
      /Blocked/,
    );
    assert.match(
      blockedCommandReason("lsof -ti :4319 | xargs kill", ctx),
      /Blocked/,
    );
    assert.match(blockedCommandReason("npx kill-port 4319", ctx), /Blocked/);
    assert.match(
      blockedCommandReason("pkill -f scripts/supervise.mjs", ctx),
      /Blocked/,
    );
  });

  it("blocks SSE curls without a timeout and allows --max-time", () => {
    assert.match(
      blockedCommandReason("curl -sN http://127.0.0.1:4319/api/events", ctx),
      /Blocked/,
    );
    assert.match(
      blockedCommandReason("curl http://127.0.0.1:5319/api/events", ctx),
      /Blocked/,
    );
    assert.equal(
      blockedCommandReason(
        "curl -sN --max-time 2 http://127.0.0.1:4319/api/events",
        ctx,
      ),
      null,
    );
    assert.equal(
      blockedCommandReason("echo http://127.0.0.1:4319/api/events", ctx),
      null,
    );
  });
});

describe("isOneShotSseClient", () => {
  it("caps curl/wget/httpie and leaves EventSource alone", () => {
    assert.equal(
      isOneShotSseClient({ headers: { "user-agent": "curl/8.4.0" } }),
      true,
    );
    assert.equal(
      isOneShotSseClient({ headers: { "user-agent": "Wget/1.21" } }),
      true,
    );
    assert.equal(
      isOneShotSseClient({
        headers: { "user-agent": "Mozilla/5.0 EventSource" },
      }),
      false,
    );
    assert.equal(isOneShotSseClient({ headers: {} }), false);
  });
});

describe("shell wrapper", () => {
  it("lets echo through and refuses kill of the guarded pid", async () => {
    const env = withHostGuardEnv({
      ...process.env,
      DEVDEN_HOST_GUARD_PIDS: "4242",
      DEVDEN_HOST_GUARD_PORT: "4319",
    });
    const bash = join(env.PATH.split(":")[0], "bash");
    const ok = await run(bash, ["-c", "echo hi"], env);
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /hi/);
    const blocked = await run(bash, ["-c", "kill 4242"], env);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /Blocked/);
  });
});

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}
