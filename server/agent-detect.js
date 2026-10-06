/**
 * Where each built-in CLI is, what version it prints, and whether it is
 * signed in. Results are cached until Re-check clears them.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { grokAuthPath } from "./grok-usage.js";
import { subscriptionEnvironment } from "./claude-agent.js";
import { zcodeOllamaOptedIn, zcodeProviderConfigPath } from "./zcode-ollama.js";
import { ZCODE_APP_CLI, ZCODE_APP_CONFIG } from "./zcode-app-server.js";

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
  {
    // ZCode's CLI ships inside the desktop app (no standalone installer
    // yet; the brew cask installs the same app), so the install step uses
    // the cask when brew exists, else downloads the official DMG and opens it;
    // the connect step signs in with ZCode's browser OAuth. An Ollama
    // provider config (see zcode-ollama.js) also counts as connected.
    id: "zcode",
    installCommand:
      'if command -v brew >/dev/null; then brew install --cask zcode && ZCODE_LOGIN; else a=$(uname -m | sed s/x86_64/x64/); curl -fL -o "$HOME/Downloads/ZCode.dmg" "https://cdn-zcode.z.ai/zcode/electron/releases/3.14.4/macos-$a/ZCode-3.14.4-mac-$a.dmg" && open "$HOME/Downloads/ZCode.dmg"; fi',
    loginCommand: "zcode login",
  },
];

/** Fixed commands only; never interpolate a client-supplied package or shell command. */
export function connectionCommand(id, installedPath) {
  const spec = BUILTIN_DETECT.find((entry) => entry.id === id);
  if (!spec) throw new Error("Unknown agent");
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  const executable = installedPath ? quote(installedPath) : `"$HOME/.local/bin/${id}"`;
  if (id === "zcode") {
    // No npm package: install = brew cask (then login) or download + open the
    // DMG; connect = login with the app's provider-config env.
    const login = (bin) => `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=${quote(ZCODE_APP_CONFIG)} ${quote(bin)} login`;
    if (installedPath) return login(installedPath);
    return spec.installCommand.replace("ZCODE_LOGIN", login(ZCODE_APP_CLI))
      .replace(/; fi$/, " && echo 'Drag ZCode to Applications, then Retry connection.'; fi");
  }
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

// `zcode.cjs --version` loads a large bundle (2-3s, past VERSION_MS under
// load); the app's plist has the version instantly.
async function zcodeAppVersion() {
  try {
    const plist = await readFile(join(ZCODE_APP_CLI, "../../../Info.plist"), "utf8");
    const match = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    return match ? `ZCode ${match[1]}` : null;
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
      // Device auth stores "https://auth.x.ai::<client>"; older CLIs used the
      // sign-in key. Anything else (https://api.x.ai) is an API key, not a subscription.
      const signedIn = Object.entries(credentials ?? {}).some(([origin, entry]) =>
        (origin === "https://accounts.x.ai/sign-in" || origin.startsWith("https://auth.x.ai::"))
        && typeof entry?.key === "string" && entry.key.length > 0);
      return signedIn ? "ok" : "missing";
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
  if (id === "zcode") {
    // ZCode shares its credential store with the desktop app
    // (~/.zcode/v2/credentials.json, oauth:<family>:access_token keys).
    // A locally-configured provider (e.g. the Ollama sync) works without
    // any Z.ai login, so it also counts as connected.
    for (const candidate of [
      join(homedir(), ".zcode", "v2", "credentials.json"),
      join(homedir(), ".zcode", "credentials.json"),
    ]) {
      try {
        const credentials = JSON.parse(await readFile(candidate, "utf8"));
        if (Object.keys(credentials).some((key) => /access_token/.test(key) && credentials[key]))
          return "ok";
        break;
      } catch (error) {
        if (error.code !== "ENOENT") return "unknown";
      }
    }
    try {
      const providers = JSON.parse(
        await readFile(zcodeProviderConfigPath(), "utf8"),
      );
      const rules = providers?.config?.providerConfigRules?.providerRules ?? [];
      // "ollama" is devden's own rule (zcode-ollama.js); older builds wrote it
      // unasked, so it only counts once the user opted in from the dialog.
      return rules.some((rule) =>
        rule?.providerId !== "account:zai" &&
        (rule?.providerId !== "ollama" || zcodeOllamaOptedIn()) &&
        rule?.config?.access?.apiKey &&
        rule?.config?.api?.baseUrl)
        ? "ok"
        : "missing";
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
    let found = await detectCommand(spec.id, spec.id);
    if (spec.id === "zcode" && !found.path && existsSync(ZCODE_APP_CLI))
      found = { path: ZCODE_APP_CLI, pathLabel: "ZCode.app", version: await zcodeAppVersion() };
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
