/**
 * Background tasks + terminal tabs for pi, loaded by devden with
 * `pi -e <this file>` on every pi session.
 *
 * Port of the two Claude Code harness features that long-running work needs:
 *
 * 1. `bash_background` — Claude's `run_in_background` bash. Spawns the command
 *    detached from the turn, streams output to a file, returns a task id
 *    immediately, and injects a <task-notification> user message (via
 *    sendUserMessage followUp, which queues while busy and triggers a turn
 *    when idle) when it exits. `task_output` is Claude's TaskOutput tool:
 *    poll or block-with-timeout. `task_stop` kills.
 *
 * 2. `run_in_terminal` / `read_terminal` — Claude's terminal-panel MCP. The
 *    command runs in a tab owned by the devden SERVER (it survives the agent
 *    and streams to the browser), reached over the local HTTP API; env vars
 *    DEVDEN_PORT / DEVDEN_SESSION_KEY are injected by pi-agent.js at spawn.
 *
 * Minimal structural pi API types — devden does not depend on the pi package,
 * and jiti strips types when the CLI loads this file.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface BackgroundTasksApi {
  registerTool(tool: Record<string, unknown>): unknown;
  sendUserMessage(content: string, options?: { deliverAs?: string }): unknown;
}

const TASK_DIR = join(tmpdir(), "devden-tasks");
const tasks = new Map<
  string,
  {
    proc: ReturnType<typeof spawn> | undefined;
    outputFile: string;
    description: string;
    command: string;
    status: "running" | "completed" | "failed" | "stopped";
    exitCode: number | undefined;
  }
>();

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function taskDir(): string {
  mkdirSync(TASK_DIR, { recursive: true });
  return TASK_DIR;
}

function tail(text: string, lines: number): string {
  const parts = text.split("\n");
  return parts.slice(-Math.max(1, lines)).join("\n");
}

/** The terminal-tab tools are a no-op without the bridge env vars. */
function terminalBase(): string | undefined {
  const port = process.env.DEVDEN_PORT;
  const key = process.env.DEVDEN_SESSION_KEY;
  if (!port || !key) return undefined;
  return `http://127.0.0.1:${port}/api/${encodeURIComponent(key)}/terminal`;
}

async function postJson(
  url: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

export default function backgroundTasks(pi: BackgroundTasksApi) {
  pi.registerTool({
    name: "bash_background",
    label: "Background command",
    description:
      "Run a long-running shell command in the background without blocking the " +
      "conversation. Returns a task id and output file immediately. You will " +
      "receive a <task-notification> message when it finishes. Use for " +
      "builds, test suites, experiments, dev servers — anything over ~30s. " +
      "Use task_output to check on it early, task_stop to kill it.",
    promptSnippet:
      "bash_background: run a long shell command detached, get notified on completion",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        description: {
          type: "string",
          description: "5-10 word summary shown in the notification",
        },
      },
      required: ["command"],
    },
    async execute(
      _toolCallId: string,
      params: { command: string; description?: string },
    ) {
      const id = newId();
      const outputFile = join(taskDir(), `${id}.output`);
      const description = params.description?.trim() || tail(params.command, 1);
      const child = spawn(
        "/bin/zsh",
        ["-lc", `${params.command} >> ${JSON.stringify(outputFile)} 2>&1`],
        {
          stdio: "ignore",
        },
      );
      child.unref();
      tasks.set(id, {
        proc: child,
        outputFile,
        description,
        command: params.command,
        status: "running",
        exitCode: undefined,
      });
      child.on("exit", (code: number | undefined) => {
        const task = tasks.get(id);
        if (!task || task.status !== "running") return;
        task.status = code === 0 ? "completed" : "failed";
        task.exitCode = code;
        task.proc = undefined;
        const notification =
          `<task-notification>\n` +
          `<task-id>${id}</task-id>\n` +
          `<status>${task.status}</status>\n` +
          `<summary>Background command "${description}" ${task.status} (exit code ${code ?? "unknown"})</summary>\n` +
          `<output-file>${outputFile}</output-file>\n` +
          `Read the output file for the full results, then continue.\n` +
          `</task-notification>`;
        // followUp: queued if the agent is mid-turn, triggers a new turn if
        // idle — exactly Claude Code's notification semantics.
        try {
          pi.sendUserMessage(notification, { deliverAs: "followUp" });
        } catch {
          try {
            pi.sendUserMessage(notification);
          } catch {
            /* agent gone; nothing to notify */
          }
        }
      });
      return {
        content: [
          {
            type: "text",
            text:
              `Background task started.\ntask_id: ${id}\nstatus: running\n` +
              `output_file: ${outputFile}\nA <task-notification> will arrive when it finishes.`,
          },
        ],
        details: { task_id: id, output_file: outputFile },
      };
    },
  });

  pi.registerTool({
    name: "task_output",
    label: "Task output",
    description:
      "Read the output of a background task started with bash_background. " +
      "With block=true, waits up to timeout_ms for the task to finish first. " +
      "Returns status, exit code and the last `lines` lines of output.",
    promptSnippet: "task_output: poll or block on a background task's output",
    parameters: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "Task id from bash_background",
        },
        block: {
          type: "boolean",
          description: "Wait for completion (default false)",
        },
        timeout_ms: {
          type: "number",
          description: "Max wait when blocking (default 30000, max 600000)",
        },
        lines: {
          type: "number",
          description: "Recent lines to return (default 100)",
        },
      },
      required: ["task_id"],
    },
    async execute(
      _toolCallId: string,
      params: {
        task_id: string;
        block?: boolean;
        timeout_ms?: number;
        lines?: number;
      },
    ) {
      const task = tasks.get(params.task_id);
      if (!task)
        return {
          content: [{ type: "text", text: `No such task: ${params.task_id}` }],
          details: {},
        };
      const timeout = Math.min(
        Math.max(params.timeout_ms ?? 30_000, 0),
        600_000,
      );
      if (params.block && task.status === "running") {
        const deadline = Date.now() + timeout;
        while (task.status === "running" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      let text = "";
      try {
        text = readFileSync(task.outputFile, "utf8");
      } catch {
        /* no output yet */
      }
      const recent = tail(text, params.lines ?? 100);
      return {
        content: [
          {
            type: "text",
            text:
              `task ${task.status} (exit code ${task.exitCode ?? "unknown"})` +
              (task.status === "running"
                ? ` — still running after ${timeout}ms wait`
                : "") +
              (recent ? `\n${recent}` : "\n(no output yet)"),
          },
        ],
        details: { status: task.status, exit_code: task.exitCode },
      };
    },
  });

  pi.registerTool({
    name: "task_stop",
    label: "Stop task",
    description: "Stop a background task started with bash_background.",
    promptSnippet: "task_stop: kill a background task",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
    async execute(_toolCallId: string, params: { task_id: string }) {
      const task = tasks.get(params.task_id);
      if (!task)
        return {
          content: [{ type: "text", text: `No such task: ${params.task_id}` }],
          details: {},
        };
      if (task.proc) {
        task.proc.kill("SIGTERM");
        setTimeout(() => task.proc?.kill("SIGKILL"), 2_000).unref?.();
      }
      task.status = "stopped";
      return {
        content: [{ type: "text", text: `Task ${params.task_id} stopped.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "run_in_terminal",
    label: "Run in terminal tab",
    description:
      "Run a command in a real terminal tab in the user's devden session and " +
      "return immediately with a tab id. The tab is visible to the user in " +
      "their browser and SURVIVES this agent process. Use when the command " +
      "is interactive, needs the user watching it (dev servers, watch modes, " +
      "experiments), or outlives the turn. Poll with read_terminal.",
    promptSnippet:
      "run_in_terminal: run a command in a user-visible terminal tab, returns tab id",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        title: { type: "string", description: "Short tab title" },
        cwd: {
          type: "string",
          description: "Working directory (default: session cwd)",
        },
      },
      required: ["command"],
    },
    async execute(
      _toolCallId: string,
      params: { command: string; title?: string; cwd?: string },
    ) {
      const base = terminalBase();
      if (!base) {
        return {
          content: [
            {
              type: "text",
              text: "Terminal tabs are unavailable in this session (no devden bridge).",
            },
          ],
          details: {},
        };
      }
      const result = await postJson(`${base}/run`, {
        command: params.command,
        title: params.title,
        cwd: params.cwd,
      });
      if (!result.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Terminal tab failed: ${String(result.error)}`,
            },
          ],
          details: {},
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Terminal tab ${String(result.tabId)} is running "${params.command}". It is visible to the user. Poll with read_terminal.`,
          },
        ],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "read_terminal",
    label: "Read terminal tab",
    description:
      "Read output from a terminal tab opened with run_in_terminal. Waits up " +
      "to wait_ms for NEW output before returning (returns early the moment " +
      "output arrives or the command exits).",
    promptSnippet: "read_terminal: read new output from a terminal tab",
    parameters: {
      type: "object",
      properties: {
        tab_id: { type: "string" },
        wait_ms: {
          type: "number",
          description: "Max wait for new output (default 15000)",
        },
        lines: {
          type: "number",
          description: "Recent lines to return (default 100)",
        },
      },
      required: ["tab_id"],
    },
    async execute(
      _toolCallId: string,
      params: { tab_id: string; wait_ms?: number; lines?: number },
    ) {
      const base = terminalBase();
      if (!base) {
        return {
          content: [
            {
              type: "text",
              text: "Terminal tabs are unavailable in this session.",
            },
          ],
          details: {},
        };
      }
      const result = await postJson(`${base}/read`, {
        tabId: params.tab_id,
        waitMs: params.wait_ms ?? 15_000,
        lines: params.lines ?? 100,
      });
      if (!result.ok) {
        return {
          content: [
            { type: "text", text: `Read failed: ${String(result.error)}` },
          ],
          details: {},
        };
      }
      const status = result.running
        ? "running"
        : `exited (code ${String(result.exitCode)})`;
      return {
        content: [
          {
            type: "text",
            text: `[${params.tab_id} ${status}]\n${String(result.text || "(no new output)")}`,
          },
        ],
        details: result,
      };
    },
  });
}
