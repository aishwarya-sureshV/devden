/**
 * Where each built-in CLI is, what version it prints, and whether it is
 * signed in. Results are cached until Re-check clears them.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { grokAuthPath } from "./grok-usage.js";
import { subscriptionEnvironment } from "./claude-agent.js";

const execFileAsync = promisify(execFile);
const VERSION_MS = 3_000;

export const BUILTIN_DETECT = [
  {
    id: "claude",
    installCommand: "npm i -g @anthropic-ai/claude-code",
    loginCommand: "claude auth login --claudeai",
  },
  {
    id: "codex",
    installCommand: "npm i -g @openai/codex",
    loginCommand: "codex login --device-auth",
  },
  {
    id: "pi",
    installCommand: "npm i -g @earendil-works/pi-coding-agent",
    loginCommand: "pi",
  },
  {
    id: "grok",
    installCommand: "npm i -g @xai-official/grok",
    loginCommand: "grok login --device-auth",
  },
];

/** Fixed commands only; never interpolate a client-supplied package or shell command. */
export function connectionCommand(id, installedPath) {
  const spec = BUILTIN_DETECT.find((entry) => entry.id === id);
  if (!spec) throw new Error("Unknown agent");
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  const executable = installedPath ? quote(installedPath) : `"$HOME/.local/bin/${id}"`;
  const login = spec.loginCommand.replace(id, executable);
  const connect = id === "pi"
    ? `${quote(process.execPath)} ${quote(fileURLToPath(new URL("./pi-login.js", import.meta.url)))} ${executable}`
    : login;
  const install = spec.installCommand.replace("npm i -g", 'npm install --global --prefix "$HOME/.local"');
  return `export PATH="$HOME/.local/bin:$PATH"; ${installedPath ? connect : `${install} && ${connect}`}`;
}

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

async function authFor(id, executable) {
  if (id === "codex" || id === "claude") {
    try {
      const { stdout, stderr } = await execFileAsync(executable,
        id === "codex" ? ["login", "status"] : ["auth", "status", "--json"],
        { timeout: 10_000, ...(id === "claude" ? { env: subscriptionEnvironment() } : {}) });
      if (id === "codex") return /ChatGPT/i.test(`${stdout}\n${stderr}`) ? "ok" : "missing";
      const status = JSON.parse(stdout);
      // This adapter uses Claude subscription auth, not API-key billing.
      return status.loggedIn && ["claude.ai", "oauth_token"].includes(status.authMethod) ? "ok" : "missing";
    } catch (error) {
      // Older CLIs may lack a status command; a stored credential is only a hint.
      if (error?.killed || error?.code === "ENOENT") return "unknown";
      return "missing";
    }
  }
  if (id === "grok") {
    try {
      const credentials = JSON.parse(await readFile(grokAuthPath(), "utf8"));
      const token = credentials?.["https://accounts.x.ai/sign-in"]?.key;
      return typeof token === "string" && token.length > 0 ? "ok" : "missing";
    } catch (error) {
      return error.code === "ENOENT" ? "missing" : "unknown";
    }
  }
  if (id === "pi") {
    try {
      const credentials = JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "auth.json"), "utf8"));
      return Object.values(credentials).some((entry) => entry?.type === "oauth" && (entry.access || entry.refresh)) ? "ok" : "missing";
    } catch (error) {
      return error.code === "ENOENT" ? "missing" : "unknown";
    }
  }
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
    const found = await detectCommand(spec.id, spec.id);
    const auth = found.path ? await authFor(spec.id, found.path) : "missing";
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
