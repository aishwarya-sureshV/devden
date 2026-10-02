/**
 * Terminal tabs: long-running commands the agent (or user) can watch live.
 *
 * Claude Code's terminal-panel MCP, ported: an agent hands a command to a
 * real shell tab instead of blocking its own bash tool on an 8-minute run,
 * then polls output. Tabs are owned by the devden server (not the agent
 * process) so they survive the agent dying and stream to the browser via the
 * same SSE event bus as every other runtime event.
 *
 * ponytail: pipes, not a PTY — the use case is "run experiment, read output",
 * not interactive programs. A real PTY (node-pty + xterm.js) is the upgrade
 * path if interactivity is ever needed.
 */
import { spawn } from "node:child_process";

const MAX_BUFFER = 200_000;

export function createTerminalTabs({ onEvent }) {
  const tabs = new Map();
  let nextId = 1;

  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      /* a dead listener must not kill the pipe pump */
    }
  };

  return {
    /** Start `command` in a new tab. Returns the tab handle. */
    run({ sessionKey, command, cwd, title }) {
      const tabId = `t${nextId++}`;
      const child = spawn(process.env.SHELL || "/bin/sh", ["-lc", command], {
        cwd: cwd || process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const tab = {
        id: tabId,
        sessionKey,
        command,
        title: title || command,
        cwd: cwd || process.cwd(),
        child,
        output: "",
        agentOffset: 0,
        status: "running",
        exitCode: undefined,
        startedAt: Date.now(),
        /** Resolvers woken by the next chunk or exit — read_terminal polling. */
        waiters: [],
      };
      tabs.set(tabId, tab);
      const append = (chunk) => {
        tab.output = (tab.output + chunk.toString("utf8")).slice(-MAX_BUFFER);
        tab.waiters.splice(0).forEach((wake) => wake());
        emit({
          type: "terminal_output",
          sessionKey,
          tabId,
          chunk: chunk.toString("utf8"),
        });
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("exit", (code) => {
        tab.status = "exited";
        tab.exitCode = code;
        tab.child = undefined;
        tab.waiters.splice(0).forEach((wake) => wake());
        emit({ type: "terminal_exit", sessionKey, tabId, exitCode: code });
      });
      child.on("error", (error) => {
        tab.output = (tab.output + `\n${String(error)}\n`).slice(-MAX_BUFFER);
        tab.status = "exited";
        tab.exitCode = -1;
        tab.child = undefined;
        tab.waiters.splice(0).forEach((wake) => wake());
        emit({ type: "terminal_exit", sessionKey, tabId, exitCode: -1 });
      });
      emit({
        type: "terminal_opened",
        sessionKey,
        tabId,
        title: tab.title,
        command,
        cwd: tab.cwd,
      });
      return { tabId };
    },

    /**
     * Agent-facing read: returns output the caller has not seen yet, waiting
     * up to `waitMs` for new output (or exit) when there is none. Mirrors
     * Claude Code's read_terminal `wait_for_output_ms` — the poll returns
     * early the moment something happens instead of burning the timeout.
     */
    async read({ sessionKey, tabId, waitMs = 0, lines = 400 }) {
      const tab = tabs.get(tabId);
      if (!tab || tab.sessionKey !== sessionKey)
        return { ok: false, error: "no such terminal tab" };
      const hasNews = () =>
        tab.output.length > tab.agentOffset || tab.status === "exited";
      if (!hasNews() && waitMs > 0) {
        await new Promise((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(
            () => {
              tab.waiters = tab.waiters.filter((w) => w !== wake);
              resolve();
            },
            Math.min(waitMs, 600_000),
          );
          tab.waiters.push(wake);
        });
      }
      const fresh = tab.output.length > tab.agentOffset;
      const text = fresh
        ? tab.output.slice(tab.agentOffset)
        : tab.output.split("\n").slice(-lines).join("\n");
      tab.agentOffset = tab.output.length;
      return {
        ok: true,
        tabId,
        status: tab.status,
        exitCode: tab.exitCode,
        running: tab.status === "running",
        text: text.slice(-8_000),
      };
    },

    /** Kill a running tab (the UI's stop button). No-op after exit. */
    stop({ sessionKey, tabId }) {
      const tab = tabs.get(tabId);
      if (!tab || tab.sessionKey !== sessionKey)
        return { ok: false, error: "no such terminal tab" };
      if (tab.child) {
        tab.child.kill("SIGTERM");
        // Escalate if the process ignores the polite signal.
        setTimeout(() => tab.child?.kill("SIGKILL"), 2_000).unref?.();
      }
      return { ok: true };
    },
  };
}
