/**
 * Update detection for the harness CLIs (pi, claude, grok, codex) and devden
 * itself. Harnesses resolve by package name against the global npm tree;
 * native (non-npm) installs of claude/codex fall back to `--version` parsing.
 * devden is a git checkout: installed version is package.json, "latest" is
 * origin HEAD. runHarnessUpdate() upgrades in place; new agent sessions pick
 * the newer binary up, and a devden update needs a server restart after.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const NPM_MS = 15_000;
const LATEST_TTL_MS = 5 * 60_000;
const DEV_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Harness CLIs: npm package names to check; `bin` enables the native
 *  (non-npm) install fallback and its built-in updater. */
const CLI_PACKAGES = [
  {
    id: "pi",
    variants: [
      "@mariozechner/pi-coding-agent",
      "@earendil-works/pi-coding-agent",
    ],
    bin: null,
  },
  { id: "claude", variants: ["@anthropic-ai/claude-code"], bin: "claude" },
  { id: "codex", variants: ["@openai/codex"], bin: "codex" },
  { id: "grok", variants: ["@xai-official/grok"], bin: null },
];

const latestCache = new Map(); // pkg -> { value: string|null, at: number }
const remoteHeadCache = { sha: null, behind: 0, at: 0 };
let devdenVersionPromise = null;
let installedPromise = null; // global npm tree: pkg -> { version }

export function newer(latest, installed) {
  if (!latest || !installed) return false;
  // ponytail: tuple compare only — `npm view pkg version` returns the latest
  // stable tag, so prerelease ordering never matters here.
  const toTuple = (value) =>
    String(value)
      .trim()
      .match(/\d+(?:\.\d+){1,3}/)?.[0]
      .split(".")
      .map(Number) ?? [];
  const [l, i] = [toTuple(latest), toTuple(installed)];
  // A dev/placeholder build reports 0.0.0 (e.g. `codex-cli 0.0.0`). No npm
  // update replaces it, so nagging would repeat forever.
  if (!i.some(Boolean)) return false;
  for (let k = 0; k < Math.max(l.length, i.length); k++) {
    const d = (l[k] ?? 0) - (i[k] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

function readInstalledVersions() {
  if (!installedPromise) {
    installedPromise = execFileAsync(
      "npm",
      ["ls", "-g", "--json", "--depth=0"],
      { timeout: NPM_MS },
    )
      .then(({ stdout }) => JSON.parse(String(stdout || "{}")).dependencies ?? {})
      .catch(() => ({}));
  }
  return installedPromise;
}

async function binInstalledVersion(bin) {
  try {
    const { stdout } = await execFileAsync("which", [bin], { timeout: 2_000 });
    const path = String(stdout).trim().split("\n")[0];
    if (!path) return null;
    const { stdout: out } = await execFileAsync(path, ["--version"], {
      timeout: NPM_MS,
    });
    // "codex-cli 0.98.2 (…)" / "2.1.287 (Claude Code)" → "0.98.2" / "2.1.287"
    return String(out).trim().match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Where a harness lives: npm package (name + tree version) or native bin. */
async function resolveHarness(entry, npmTree) {
  for (const pkg of entry.variants) {
    if (npmTree[pkg]?.version) return { pkg, installed: npmTree[pkg].version, npm: true };
  }
  if (entry.bin) {
    const installed = await binInstalledVersion(entry.bin);
    if (installed) return { pkg: entry.variants[0], installed, npm: false };
  }
  return null;
}

export function latestVersion(pkg) {
  const row = latestCache.get(pkg);
  if (row?.promise) return row.promise;
  if (row && Date.now() - row.at < LATEST_TTL_MS) return Promise.resolve(row.value);
  const pending = execFileAsync("npm", ["view", pkg, "version"], {
    timeout: NPM_MS,
  })
    .then(({ stdout }) => String(stdout).trim() || null)
    .catch(() => row?.value ?? null) // registry unreachable: keep stale value
    .then((value) => {
      latestCache.set(pkg, { value, at: Date.now() });
      return value;
    });
  latestCache.set(pkg, { value: row?.value ?? null, at: Date.now(), promise: pending });
  // The promise above overwrites the placeholder once it settles.
  return pending;
}

function devdenVersion() {
  if (!devdenVersionPromise) {
    devdenVersionPromise = readFile(`${DEV_ROOT}package.json`, "utf8")
      .then((text) => JSON.parse(text).version ?? null)
      .catch(() => null);
  }
  return devdenVersionPromise;
}

/** Commits on the upstream branch that HEAD lacks. Local commits ahead of
 *  origin are not an update (a SHA compare flagged them forever). */
async function devdenBehind() {
  if (Date.now() - remoteHeadCache.at < LATEST_TTL_MS) return remoteHeadCache;
  const git = (args) =>
    execFileAsync("git", args, { cwd: DEV_ROOT, timeout: NPM_MS }).then(
      ({ stdout }) => String(stdout).trim(),
    );
  try {
    await git(["fetch", "--quiet", "origin"]);
    remoteHeadCache.behind = Number(await git(["rev-list", "--count", "HEAD..@{u}"])) || 0;
    remoteHeadCache.sha = await git(["rev-parse", "--short", "@{u}"]);
  } catch {
    remoteHeadCache.behind = 0; // offline, no upstream, or not a git checkout
    remoteHeadCache.sha = null;
  }
  remoteHeadCache.at = Date.now();
  return remoteHeadCache;
}

/** Installed vs latest for every known package; only outdated ones returned. */
export async function readHarnessUpdates() {
  const [npmTree, devdenInstalled] = await Promise.all([
    readInstalledVersions(),
    devdenVersion(),
  ]);
  const rows = await Promise.all(
    CLI_PACKAGES.map(async (entry) => {
      const found = await resolveHarness(entry, npmTree);
      if (!found) return null;
      const latest = await latestVersion(found.pkg);
      return newer(latest, found.installed)
        ? {
            id: entry.id,
            pkg: found.pkg,
            installed: found.installed,
            latest,
            npm: found.npm,
          }
        : null;
    }),
  );
  const upstream = await devdenBehind();
  if (upstream.behind > 0)
    rows.push({
      id: "devden",
      pkg: "devden",
      installed: devdenInstalled,
      latest: upstream.sha,
      behind: upstream.behind,
      npm: false,
    });
  return rows.filter(Boolean);
}

/** One-line, human reason for a failed update (raw output goes in `log`). */
export function explainUpdateError(error) {
  const text = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  if (/EACCES|EPERM|permission denied/i.test(text))
    return "Permission denied. npm can't write to the global folder.";
  if (error?.killed) return "Timed out before it finished.";
  if (/Not possible to fast-forward|diverg/i.test(text))
    return "Your local commits diverge from main. Merge or rebase by hand.";
  if (/conflict/i.test(text))
    return "Your local edits conflict with the update. Commit or stash them first.";
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network/i.test(text))
    return "Couldn't reach the registry. Check your connection.";
  const line = text.split("\n").map((row) => row.trim()).find(Boolean);
  return (line || "Update failed.").slice(0, 140);
}

/** Run the upgrade for one package id. Slow (~30s+); routes handle response.
 *  Failures throw an Error whose message is concise, plus `log` (stderr tail)
 *  and `cmd` (what to run by hand) for the UI's details panel. */
export async function runHarnessUpdate(id) {
  let cmd = null;
  try {
    return await upgrade(id, (value) => (cmd = value));
  } catch (error) {
    const raw = String(error?.stderr || error?.message || "").trim();
    throw Object.assign(new Error(explainUpdateError(error)), {
      cmd,
      log: raw.split("\n").slice(-12).join("\n"),
    });
  }
}

async function upgrade(id, setCmd) {
  const entry = CLI_PACKAGES.find((row) => row.id === id);
  if (id === "devden") {
    setCmd("git pull --ff-only --autostash && npm install && npm run build");
    await updateDevden();
    return { ok: true, pkg: "devden" };
  }
  if (!entry) throw new Error(`Unknown package: ${id}`);
  const found = await resolveHarness(entry, await readInstalledVersions());
  if (!found) throw new Error(`${id} is not installed`);
  if (found.npm) {
    const target = `${entry.variants.find((name) => name === found.pkg) ?? found.pkg}@latest`;
    setCmd(`npm install -g ${target}`);
    await execFileAsync("npm", ["install", "-g", target], {
      timeout: 5 * 60_000,
    });
  } else {
    setCmd(`${entry.bin} update`);
    // Native install: let the CLI's own updater do it.
    await execFileAsync("which", [entry.bin], { timeout: 2_000 });
    const { stdout } = await execFileAsync("which", [entry.bin]);
    await execFileAsync(String(stdout).trim().split("\n")[0], ["update"], {
      timeout: 5 * 60_000,
    });
  }
  installedPromise = null; // re-read versions on the next check
  const { clearDetectionCache } = await import("./agent-detect.js");
  clearDetectionCache();
  return { ok: true, pkg: found.pkg };
}

async function updateDevden() {
  await execFileAsync("git", ["pull", "--ff-only", "--autostash"], {
    cwd: DEV_ROOT,
    timeout: 5 * 60_000,
  });
  await execFileAsync("npm", ["install"], {
    cwd: DEV_ROOT,
    timeout: 10 * 60_000,
  });
  await execFileAsync("npm", ["run", "build"], {
    cwd: DEV_ROOT,
    timeout: 10 * 60_000,
  });
  // The running server keeps old code until restarted; the UI says so.
  remoteHeadCache.at = 0;
  await devdenBehind();
}
