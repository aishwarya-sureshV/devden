/**
 * NDJSON client for `zcode agent-server`, the ZCode harness's stdio programmatic
 * interface (mirrors codex-app-server.js). One connection carries many
 * sessions; ZcodeAgentProcess owns a private one per conversation.
 *
 * Frames are JSON-RPC-shaped without the `jsonrpc` field:
 *   request      {id, method, params}
 *   notification {method, params}
 *   response     {id, result} | {id, error: {code, message, data}}
 * The agent also calls *us* (interaction/requestPermission,
 * interaction/requestUserInput) with the same request shape.
 *
 * Events: `session/subscribe` returns the backlog; from then on the agent
 * pushes `state.updated` notifications and we pull `session/events` after the
 * last seen seq. (Verified against zai-org/ZCode v3.14.3
 * apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts.)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { withHostGuardEnv } from "./host-guard.js";

const REQUEST_TIMEOUT_MS = 60_000;
// The shared connection exists only for sidebar catalog reads; it lingers
// long enough to serve a burst and then shuts down (same as codex).
const SHARED_IDLE_MS = 120_000;

// The CLI ships inside the desktop app (the brew cask links nothing onto
// PATH), and it only finds the app's bundled provider config through this env.
const ZCODE_APP = "/Applications/ZCode.app/Contents/Resources";
export const ZCODE_APP_CLI = `${ZCODE_APP}/glm/zcode.cjs`;
export const ZCODE_APP_CONFIG = `${ZCODE_APP}/config/provider/zcode-builtin.json`;

export function zcodeAppEnv() {
  return existsSync(ZCODE_APP_CONFIG) ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: ZCODE_APP_CONFIG } : {};
}

export function resolveZcodeExecutable() {
  return process.env.DEVDEN_ZCODE_BIN || (existsSync(ZCODE_APP_CLI) ? ZCODE_APP_CLI : "zcode");
}

export const ZCODE_AGENT_SERVER_ARGS = ["agent-server"];

function protocolErrorMessage(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    try {
      return JSON.stringify(value);
    } catch {
      /* fall through */
    }
  }
  return "Unknown ZCode agent-server error";
}

export class ZcodeAgentServer {
  constructor(options = {}) {
    this.executable = options.executable;
    this.envExtra = options.envExtra;
    this.args = options.args ?? ZCODE_AGENT_SERVER_ARGS;
    this.child = undefined;
    this.buffer = "";
    this.nextId = 0;
    this.pending = new Map();
    this.notificationListeners = new Set();
    this.requestListeners = new Set();
    this.failureListeners = new Set();
    this.starting = undefined;
    this.stderr = "";
  }

  get running() {
    return Boolean(this.child);
  }

  /** Idempotent: concurrent callers await the same spawn. */
  start() {
    if (this.starting) return this.starting;
    this.starting = this.spawnAndInitialize().catch((error) => {
      this.starting = undefined;
      this.close();
      throw error;
    });
    return this.starting;
  }

  async spawnAndInitialize() {
    const child = spawn(this.executable || resolveZcodeExecutable(), this.args, {
      cwd: homedir(),
      env: withHostGuardEnv({ ...process.env, ...zcodeAppEnv(), ...(this.envExtra || {}) }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.buffer = "";
    this.stderr = "";
    child.stdin.on("error", (error) => { if (this.child === child) this.fail(error); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      // The protocol boundary forbids stray stdout, so stderr carries logs.
      this.stderr = `${this.stderr}${chunk}`.slice(-8000);
    });
    child.once("error", (error) => { if (this.child === child) this.fail(error); });
    child.once("exit", (code, signal) =>
      this.child === child && this.fail(
        new Error(
          `zcode agent-server exited (${signal ?? code ?? "unknown"})${
            this.stderr.trim()
              ? `: ${this.stderr.trim().split("\n").pop()}`
              : ""
          }`,
        ),
      ),
    );
    // No initialize handshake: legacy methods dispatch immediately.
    return true;
  }

  consume(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          this.dispatch(JSON.parse(line));
        } catch {
          /* guard against a partial non-protocol line */
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  dispatch(message) {
    if (!message || typeof message !== "object") return;
    if (message.method && message.id !== undefined) {
      // The agent calling us (permission / user-input requests).
      for (const listener of this.requestListeners) listener(message);
      return;
    }
    if (message.method) {
      for (const listener of this.notificationListeners) listener(message);
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(protocolErrorMessage(message.error)));
    else waiter.resolve(message.result);
  }

  fail(error) {
    const wasRunning = Boolean(this.child);
    this.child = undefined;
    this.starting = undefined;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    if (wasRunning)
      for (const listener of this.failureListeners) listener(error);
  }

  write(message) {
    if (!this.child?.stdin || this.child.stdin.destroyed)
      throw new Error("zcode agent-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = `devden-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`zcode ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** Reply to an agent->client request (permission decisions and the like). */
  respond(id, result) {
    this.write({ id, result });
  }

  respondError(id, message) {
    this.write({ id, error: { code: -32601, message } });
  }

  onFailure(listener) {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  onNotification(listener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener) {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  close() {
    const child = this.child;
    this.failureListeners.clear();
    this.fail(new Error("zcode agent-server closed"));
    this.notificationListeners.clear();
    this.requestListeners.clear();
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      child.kill();
    } catch {
      /* already exited */
    }
  }
}

let shared;
let sharedIdleTimer;

function scheduleSharedShutdown() {
  clearTimeout(sharedIdleTimer);
  sharedIdleTimer = setTimeout(() => {
    shared?.close();
    shared = undefined;
  }, SHARED_IDLE_MS);
  sharedIdleTimer.unref?.();
}

/** One-shot read against the shared connection (session listing); mirrors
 * codexRequest. Never starts a session, and a dead connection respawns. */
export async function zcodeRequest(method, params = {}) {
  if (!shared?.running && !shared?.starting) shared = new ZcodeAgentServer({});
  try {
    await shared.start();
    return await shared.request(method, params);
  } catch (error) {
    shared?.close();
    shared = undefined;
    throw error;
  } finally {
    if (shared) scheduleSharedShutdown();
  }
}

export function closeSharedZcode() {
  clearTimeout(sharedIdleTimer);
  shared?.close();
  shared = undefined;
}