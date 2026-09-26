/**
 * Stop agent bash from killing the workbench (drops SSE, hangs the turn) or
 * curling /api/events with no timeout (the stream never closes).
 *
 * Enforcement is the agent child's PATH/SHELL: bash/zsh/curl wrappers classify
 * the command and refuse before the real binary runs. kill is a shell builtin,
 * so wrapping `kill` itself is not enough.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAP = join(HERE, "host-guard-wrap.js");
export const GUARD_TOOLS = ["bash", "sh", "zsh", "dash", "ksh", "curl", "wget"];
export const SSE_ONESHOT_MS = 5_000;

export function defaultGuardContext(env = process.env) {
  const port = Number(env.DEVDEN_HOST_GUARD_PORT || env.DEVDEN_PORT || 4319);
  const pids = String(env.DEVDEN_HOST_GUARD_PIDS || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
  return { port, pids };
}

/** True for curl/wget/httpie — they hang on SSE. EventSource stays open. */
export function isOneShotSseClient(req) {
  const ua = String(req?.headers?.["user-agent"] || "");
  return /\b(curl|wget|httpie)\//i.test(ua);
}

export function blockedCommandReason(command, ctx = defaultGuardContext()) {
  const text = String(command ?? "");
  if (!text.trim()) return null;
  const port = Number(ctx.port || 4319);
  const pids = [
    ...new Set((ctx.pids ?? []).map(Number).filter((pid) => pid > 0)),
  ];

  for (const pid of pids) {
    const pidHit = new RegExp(
      `(?:^|[\\s;|&])(?:/usr/bin/|/bin/)?kill(?:\\s+-[A-Za-z0-9]+)*\\s+${pid}(?:\\s|[;|&]|$)`,
    );
    if (pidHit.test(text)) {
      return `Blocked: PID ${pid} is the workbench API (port ${port}). Killing it drops this conversation.`;
    }
  }

  const mentionsHostPort =
    new RegExp(
      `lsof\\b[\\s\\S]*-(?:[a-z]*i[a-z]*)\\s*:?\\s*(?:tcp:)?${port}\\b|fuser\\b[\\s\\S]*${port}\\b/tcp`,
      "i",
    ).test(text) ||
    new RegExp(`(?:npx\\s+)?kill-port\\s+${port}\\b`, "i").test(text);
  const hasKill =
    /(?:^|[\s;|&])(?:\/usr\/bin\/|\/bin\/)?(?:kill|pkill|killall)\b|\bxargs\s+kill\b/i.test(
      text,
    );
  if (mentionsHostPort && hasKill) {
    return `Blocked: port ${port} is the workbench API. Killing it drops this conversation.`;
  }
  if (new RegExp(`(?:npx\\s+)?kill-port\\s+${port}\\b`, "i").test(text)) {
    return `Blocked: port ${port} is the workbench API. Killing it drops this conversation.`;
  }

  if (
    /(?:pkill|killall)\b[\s\S]*(supervise\.mjs|server\/index\.js|\bdevden\b)/i.test(
      text,
    )
  ) {
    return "Blocked: that process is the workbench. Killing it drops this conversation.";
  }

  if (isStreamingFetchWithoutTimeout(text)) {
    return "Blocked: /api/events is an SSE stream and never closes. Pass --max-time.";
  }

  return null;
}

function isStreamingFetchWithoutTimeout(text) {
  if (!/\/api\/events(?:-ws)?(?:\b|$|[?'"#])/i.test(text)) return false;
  const fetcher =
    /(?:^|[\s;|&])curl\b/i.test(text) ||
    /(?:^|[\s;|&])wget\b/i.test(text) ||
    /(?:^|[\s;|&])httpie\b/i.test(text) ||
    /(?:^|[\s;|&])http\s+(GET|POST|PUT|HEAD|DELETE)\b/i.test(text);
  if (!fetcher) return false;
  if (/(?:--max-time|--connect-timeout|--timeout|-m)\s*=?\s*[1-9]\d*/.test(text))
    return false;
  return true;
}

export function ensureGuardBin() {
  const bin = join(tmpdir(), `devden-host-guard-${process.pid}`);
  mkdirSync(bin, { recursive: true });
  const stub = `#!/bin/sh\nexec "${process.execPath}" "${WRAP}" "$(basename "$0")" "$@"\n`;
  for (const name of GUARD_TOOLS) {
    writeFileSync(join(bin, name), stub);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

export function withHostGuardEnv(base = process.env) {
  const bin = ensureGuardBin();
  const incomingPath = String(base.PATH || process.env.PATH || "");
  const originalPath = String(
    base.DEVDEN_HOST_GUARD_PATH ||
      incomingPath
        .split(":")
        .filter((dir) => dir && dir !== bin)
        .join(":"),
  );
  const path = incomingPath.split(":").includes(bin)
    ? incomingPath
    : `${bin}:${incomingPath}`;
  const shellName = basename(base.SHELL || process.env.SHELL || "bash");
  const wrappedShell = join(
    bin,
    GUARD_TOOLS.includes(shellName) ? shellName : "bash",
  );
  const pids =
    base.DEVDEN_HOST_GUARD_PIDS ||
    [process.pid, process.ppid].filter(Boolean).join(",");
  return {
    ...base,
    PATH: path,
    SHELL: wrappedShell,
    DEVDEN_HOST_GUARD_PATH: originalPath,
    DEVDEN_HOST_GUARD_PID: String(base.DEVDEN_HOST_GUARD_PID || process.pid),
    DEVDEN_HOST_GUARD_PIDS: String(pids),
    DEVDEN_HOST_GUARD_PORT: String(
      Number(
        base.DEVDEN_HOST_GUARD_PORT ||
          base.DEVDEN_PORT ||
          process.env.DEVDEN_PORT ||
          4319,
      ),
    ),
  };
}

export function realBinary(name, pathEnv) {
  for (const dir of String(pathEnv || "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  if (name === "bash" || name === "sh") return `/bin/${name}`;
  if (name === "zsh") return "/bin/zsh";
  if (name === "curl") return "/usr/bin/curl";
  if (name === "wget") return "/usr/bin/wget";
  return name;
}

export function commandLineFor(tool, args) {
  const list = Array.isArray(args) ? args : [];
  if (tool === "curl" || tool === "wget") return [tool, ...list].join(" ");
  const c = list.findIndex((arg) => arg === "-c");
  if (c >= 0) return String(list[c + 1] ?? "");
  return [tool, ...list].join(" ");
}
