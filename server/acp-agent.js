/**
 * ACP (Agent Client Protocol) over a CLI's stdio. Grok launches through it
 * (`grok agent stdio`).
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
} from "@zed-industries/agent-client-protocol";
import { withHostGuardEnv } from "./host-guard.js";

export const ACP_PROTOCOL_VERSION = 1;
export const GROK_ACP_ARGS = ["agent", "stdio"];

/**
 * Spawn `command args`, speak ACP, and return the live connection.
 * `onSpawn` runs before initialize so a crash still has a child to kill.
 */
export async function openAcpClient({
  command,
  args = [],
  env = {},
  cwd,
  handlers,
  onSpawn,
  onStderr,
  onError,
  onExit,
}) {
  const child = spawn(command, args, {
    cwd,
    env: withHostGuardEnv({ ...process.env, ...env }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  onSpawn?.(child);
  if (onStderr) child.stderr.on("data", onStderr);
  if (onError) child.once("error", onError);
  if (onExit) child.once("exit", onExit);
  await new Promise((resolvePromise, reject) => {
    child.once("spawn", resolvePromise);
    child.once("error", reject);
  });
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );
  const connection = new ClientSideConnection(handlers, stream);
  try {
    const initialized = await connection.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    return { child, connection, initialized };
  } catch (error) {
    if (!child.killed) child.kill("SIGKILL");
    throw error;
  }
}
