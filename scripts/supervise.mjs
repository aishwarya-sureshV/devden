#!/usr/bin/env node
/**
 * devden server supervisor: runs server/index.js in a restart loop.
 *
 * Why: `npm run dev` uses `concurrently -k`, which kills vite if the API
 * server exits. The one-click Deploy button restarts the API server after a
 * rebuild (and the server can also crash on its own) — this supervisor keeps
 * the node process alive across those restarts without touching vite.
 *
 * - SIGINT/SIGTERM forwarded to the child, then the supervisor exits (Ctrl+C
 *   during `npm run dev` behaves exactly as before).
 * - Any other child exit (deploy restart, crash) restarts the server, with a
 *   short backoff if it keeps dying.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENTRY = join(ROOT, "server", "index.js");
const PASS_THROUGH_ARGS = process.argv.slice(2);

let stopping = false;
let child = null;

const forwardSignal = (signal) => () => {
  stopping = true;
  if (child) child.kill(signal);
  else process.exit(0);
};
process.on("SIGINT", forwardSignal("SIGINT"));
process.on("SIGTERM", forwardSignal("SIGTERM"));

let consecutiveCrashes = 0;

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [ENTRY, ...PASS_THROUGH_ARGS], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    child = null;
    // `stopping` is the only signal that WE are shutting down. A SIGTERM
    // the child received on its own is someone asking for a restart --
    // which is exactly what scripts/deploy.mjs does (it SIGTERMs this pid
    // and expects to be restarted with fresh code). Treating that as a
    // stop took the API server down for good after every one-click deploy.
    // SIGINT stays a stop: Ctrl+C reaches the whole process group, and the
    // child's exit can beat this process's own handler.
    if (stopping || signal === "SIGINT") {
      process.exit(code ?? 0);
    }
    // A deploy restart or a fresh crash. Only back off when the process
    // died quickly (a real crash loop); a deploy restart survives >30s.
    const uptimeMs = Date.now() - startedAt;
    consecutiveCrashes = uptimeMs > 30_000 ? 0 : consecutiveCrashes + 1;
    const delayMs = Math.min(consecutiveCrashes, 5) * 1000;
    console.log(
      `[supervise] server exited (code ${code}, signal ${signal}) — restarting in ${delayMs / 1000}s`,
    );
    setTimeout(start, delayMs);
  });
}

start();
