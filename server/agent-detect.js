/**
 * Where each built-in CLI is, what version it prints, and whether it is
 * signed in. Results are cached until Re-check clears them.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readGrokToken } from "./grok-usage.js";

const execFileAsync = promisify(execFile);
const VERSION_MS = 3_000;

export const BUILTIN_DETECT = [
  {
    id: "claude",
    installCommand: "npm i -g @anthropic-ai/claude-code",
    loginCommand: "claude",
  },
  {
    id: "codex",
    installCommand: "npm i -g @openai/codex",
    loginCommand: "codex",
  },
  {
    id: "pi",
    installCommand: "npm i -g @mariozechner/pi-coding-agent",
    loginCommand: "pi",
  },
  {
    id: "grok",
    installCommand: "npm i -g @xai-official/grok",
    loginCommand: "grok login",
  },
];

let builtinCache = null;
const commandCache = new Map();

export function clearDetectionCache() {
  builtinCache = null;
  commandCache.clear();
}

export function tilde(path) {
  if (!path) return null;
  const home = homedir();
  return path.startsWith(`${home}/`) || path === home
    ? `~${path.slice(home.length)}`
    : path;
}

export async function which(command) {
  if (!command || command.includes("\0")) return null;
  try {
    const { stdout } = await execFileAsync("which", [command], {
      timeout: 2_000,
    });
    const line = String(stdout).trim().split("\n")[0];
    return line || null;
  } catch {
    return null;
  }
}

async function readVersion(bin, id) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, ["--version"], {
      timeout: VERSION_MS,
    });
    return tidyVersion(id, `${stdout}\n${stderr}`);
  } catch (error) {
    const text = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    return tidyVersion(id, text);
  }
}

function tidyVersion(id, raw) {
  const line = String(raw)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) return null;
  const clean = line.replace(/\s*\([0-9a-f]{7,}\)\s*$/i, "").slice(0, 80);
  if (clean.toLowerCase().startsWith(id)) return clean;
  const match = clean.match(/\d+\.\d+(?:\.\d+)?/);
  return match ? `${id} ${match[0]}` : clean;
}

function hasSecret(value, depth = 0) {
  if (depth > 5) return false;
  if (typeof value === "string") return value.trim().length >= 8;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((entry) => hasSecret(entry, depth + 1));
}

async function authFromFile(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return hasSecret(parsed) ? "ok" : "missing";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    return "unknown";
  }
}

async function claudeAuth() {
  const file = await authFromFile(
    join(homedir(), ".claude", ".credentials.json"),
  );
  if (file === "ok") return "ok";
  if (process.platform !== "darwin") return file;
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 1_500 },
    );
    const parsed = JSON.parse(String(stdout).trim());
    return parsed?.claudeAiOauth?.accessToken ? "ok" : "missing";
  } catch {
    return file === "unknown" ? "unknown" : "missing";
  }
}

async function authFor(id) {
  if (id === "grok") {
    try {
      const token = await readGrokToken();
      return token ? "ok" : "missing";
    } catch {
      return "unknown";
    }
  }
  if (id === "claude") return claudeAuth();
  if (id === "codex")
    return authFromFile(
      join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"),
    );
  if (id === "pi")
    return authFromFile(join(homedir(), ".pi", "agent", "auth.json"));
  return "unknown";
}

async function detectCommand(command, id) {
  const key = `${id}\0${command}`;
  if (commandCache.has(key)) return commandCache.get(key);
  const pending = (async () => {
    const path = await which(command);
    if (!path) return { path: null, pathLabel: null, version: null };
    const version = await readVersion(path, id);
    return { path, pathLabel: tilde(path), version };
  })();
  commandCache.set(key, pending);
  try {
    const result = await pending;
    commandCache.set(key, result);
    return result;
  } catch {
    commandCache.delete(key);
    return { path: null, pathLabel: null, version: null };
  }
}

async function detectBuiltin(spec) {
  try {
    const [found, auth] = await Promise.all([
      detectCommand(spec.id, spec.id),
      authFor(spec.id),
    ]);
    return {
      ...spec,
      ...found,
      auth: found.path ? auth : "missing",
    };
  } catch {
    return {
      ...spec,
      path: null,
      pathLabel: null,
      version: null,
      auth: "unknown",
    };
  }
}

export async function detectBuiltins() {
  if (!builtinCache) {
    builtinCache = Promise.all(BUILTIN_DETECT.map(detectBuiltin)).then(
      (rows) => {
        builtinCache = rows;
        return rows;
      },
    );
  }
  return builtinCache;
}
