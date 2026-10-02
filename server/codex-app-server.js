/**
 * Newline-delimited JSON-RPC client for `codex app-server`, the documented
 * programmatic interface to the Codex CLI. One connection carries many
 * threads, so CodexAgentProcess owns a private one per conversation while
 * read-only lookups (session listing, model catalog, rate limits) share the
 * lazily started connection behind codexRequest().
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { withHostGuardEnv } from "./host-guard.js";

const CLIENT_INFO = { name: "devden", title: "devden", version: "0.1.0" };
const REQUEST_TIMEOUT_MS = 60_000;
// The shared connection exists only to answer sidebar/catalog reads. Holding
// a codex process open forever for that is wasteful, and respawning per read
// costs ~1s, so it lingers just long enough to serve a burst of them.
const SHARED_IDLE_MS = 120_000;

export function resolveCodexExecutable() {
  return process.env.DEVDEN_CODEX_BIN || "codex";
}

function rpcErrorMessage(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    try {
      return JSON.stringify(value);
    } catch {
      /* fall through */
    }
  }
  return "Unknown Codex app-server error";
}

export class CodexAppServer {
  constructor(options = {}) {
    this.executable = options.executable;
    this.envExtra = options.envExtra;
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

  /** Idempotent: concurrent callers await the same spawn+initialize. */
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
    const child = spawn(
      this.executable || resolveCodexExecutable(),
      ["app-server", "--listen", "stdio://"],
      {
        cwd: homedir(),
        env: withHostGuardEnv({ ...process.env, ...(this.envExtra || {}) }),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    this.buffer = "";
    this.stderr = "";
    child.stdin.on("error", (error) => { if (this.child === child) this.fail(error); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      // codex logs tracing output here; keep a tail for error messages only.
      this.stderr = `${this.stderr}${chunk}`.slice(-8000);
    });
    child.once("error", (error) => { if (this.child === child) this.fail(error); });
    child.once("exit", (code, signal) =>
      this.child === child && this.fail(
        new Error(
          `codex app-server exited (${signal ?? code ?? "unknown"})${
            this.stderr.trim()
              ? `: ${this.stderr.trim().split("\n").pop()}`
              : ""
          }`,
        ),
      ),
    );
    const initialize = await this.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    return initialize;
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
          /* app-server also prints non-protocol lines; ignore them */
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  dispatch(message) {
    // A message with both an id and a method is the server calling us
    // (approvals, tool bridging); an id alone is the reply to our own call.
    if (message.method && message.id !== undefined) {
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
    if (message.error) waiter.reject(new Error(rpcErrorMessage(message.error)));
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
      throw new Error("codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ method, id, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.write({ method, params });
  }

  /** Reply to a server->client request (approvals and the like). */
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
    this.fail(new Error("codex app-server closed"));
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

/** One-shot read against the shared connection. Never starts a thread. */
export async function codexRequest(method, params = {}) {
  if (!shared?.running && !shared?.starting) shared = new CodexAppServer();
  try {
    await shared.start();
    return await shared.request(method, params);
  } catch (error) {
    // A dead connection must not be reused; the next call respawns.
    shared?.close();
    shared = undefined;
    throw error;
  } finally {
    if (shared) scheduleSharedShutdown();
  }
}

export function closeSharedCodex() {
  clearTimeout(sharedIdleTimer);
  shared?.close();
  shared = undefined;
}
