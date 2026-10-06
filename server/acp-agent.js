/**
 * ACP (Agent Client Protocol) over a CLI's stdio. Grok launches through it
 * (`grok agent stdio`).
 */
import { trackAgentProcess } from "./agent-pids.js";
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
  trackAgentProcess(child);
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
  // SDK 0.4.5 has no session/set_config_option (its setSessionModel even
  // sends session/set_mode), and grok ignores set_mode for models. Send that
  // one request ourselves and pull its reply out before the SDK sees an
  // unknown id. ponytail: delete once the SDK grows setSessionConfigOption.
  const pending = new Map();
  let seq = 0;
  const readable = stream.readable.pipeThrough(
    new TransformStream({
      transform(message, controller) {
        const waiter = !message?.method && pending.get(message?.id);
        if (!waiter) return controller.enqueue(message);
        pending.delete(message.id);
        if (message.error) waiter.reject(message.error);
        else waiter.resolve(message.result ?? {});
      },
    }),
  );
  child.once("exit", () => {
    for (const waiter of pending.values())
      waiter.reject(new Error("ACP agent exited"));
    pending.clear();
  });
  const connection = new ClientSideConnection(handlers, {
    readable,
    writable: stream.writable,
  });
  connection.setSessionConfigOption = (params) =>
    new Promise((resolve, reject) => {
      const id = `devden-config-${++seq}`;
      pending.set(id, { resolve, reject });
      // One write per line: Node queues it whole, never interleaved with
      // the SDK's own frames.
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method: "session/set_config_option", params })}\n`,
      );
    });
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
