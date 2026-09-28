/**
 * Claude Code stream-json process pool.
 *
 * Each workbench session owns one long-lived `claude -p` process. The adapter
 * translates Claude's stream-json events into the event vocabulary already
 * consumed by devden's Timeline, while exposing the same public surface as
 * PiAgentProcess.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { AgentPool } from "./agent-pool.js";
import { ApprovalGate } from "./approval-gate.js";
import { attachQueue } from "./agent-queue.js";
import {
  attachSubagentFollows,
  isSubagentToolName,
  noteSubagentToolEvent,
  subagentBusy,
} from "./agent-subagent.js";
import {
  CO_PARTNER_PROMPT,
  CO_PARTNER_PROMPT_MANUAL,
  CLARIFY_PROMPT,
} from "./co-partner-prompt.js";
import { withHostGuardEnv } from "./host-guard.js";
import { forkClaudeTranscript } from "./claude-fork.js";

function formatClaudeModelName(value) {
  const stripped = String(value || "")
    .trim()
    .replace(/\[1m\]$/i, "")
    .replace(/-20\d{6}(?:-v\d+)?$/i, "")
    .replace(/^claude[\s_-]+/i, "");
  const parts = stripped.split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return stripped || String(value || "");
  const title = (part) =>
    part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  const family = title(parts[0] ?? "");
  const version = [];
  const extras = [];
  for (const part of parts.slice(1)) {
    if (/^\d/.test(part) && extras.length === 0) version.push(part);
    else extras.push(title(part));
  }
  return [family, version.join("."), ...extras].filter(Boolean).join(" ");
}

const CLAUDE_FAMILIES = ["opus", "fable", "sonnet", "haiku"];
const CLAUDE_MODEL_FALLBACK_IDS = [
  "claude-opus-5",
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "claude-haiku-4-5",
];
const toClaudeModels = (ids) =>
  ids.map((id) => ({
    provider: "anthropic",
    id,
    name: formatClaudeModelName(id),
  }));

/** Newest model id per family (list is sorted newest-first). */
function claudeAliasesFor(models) {
  const aliases = {};
  for (const family of CLAUDE_FAMILIES) {
    const newest = models.find((model) =>
      model.id.startsWith(`claude-${family}-`),
    );
    if (newest) aliases[family] = newest.id;
  }
  return aliases;
}

/**
 * Extract model ids from the installed CLI bundle so a `claude` update is
 * picked up without touching this file. The bundle's model catalog is a chain
 * of `x==="claude-..."` comparisons — preferred, because raw strings include
 * dead ids the CLI itself rejects (e.g. claude-sonnet-3-7). Loose strings are
 * only the fallback. Bare majors are kept for the family's newest major only
 * (the CLI's own convention), and `-0` / dated (`-20250514`) variants never
 * match.
 */
// ponytail: single-digit version parts and the four families only — a
// "claude-x-4-10" or a fifth family needs this widened.
export function parseClaudeModelIds(text) {
  const source = String(text);
  const candidates = new Set();
  for (const m of source.matchAll(/[A-Za-z_$][\w$]*==="(claude-[\w-]+)"/g))
    candidates.add(m[1]);
  if (candidates.size === 0)
    for (const m of source.matchAll(
      /claude-(?:opus|fable|sonnet|haiku)-[\w-]+/g,
    ))
      candidates.add(m[0]);
  const found = new Map();
  for (const id of candidates) {
    const m = id.match(
      /^claude-(opus|fable|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?$/,
    );
    if (!m) continue;
    const major = Number(m[2]);
    const minor = m[3] === undefined ? null : Number(m[3]);
    if (major > 9 || (minor !== null && (minor === 0 || minor > 9))) continue;
    found.set(m[0], { family: m[1], major, minor });
  }
  const maxMajor = new Map();
  for (const { family, major } of found.values()) {
    maxMajor.set(family, Math.max(maxMajor.get(family) ?? 0, major));
  }
  return [...found.entries()]
    .filter(([, m]) => m.minor !== null || m.major === maxMajor.get(m.family))
    .sort(
      (a, b) =>
        b[1].major - a[1].major ||
        (b[1].minor ?? 0) - (a[1].minor ?? 0) ||
        CLAUDE_FAMILIES.indexOf(a[1].family) -
          CLAUDE_FAMILIES.indexOf(b[1].family),
    )
    .map(([id]) => id);
}

let CLAUDE_MODELS = toClaudeModels(CLAUDE_MODEL_FALLBACK_IDS);
let CLAUDE_ALIASES = claudeAliasesFor(CLAUDE_MODELS);

// Rescanned only when the resolved `claude` binary's path or mtime changes,
// i.e. when the CLI updates — the models endpoint picks the new list up
// within its 5-min cache TTL, no devden restart needed. A failed or
// unfamiliar bundle keeps the previous list.
let claudeModelScan = { path: "", mtimeMs: -1 };

async function refreshClaudeModels() {
  let bin;
  try {
    bin = realpathSync(
      execFileSync("which", ["claude"], { encoding: "utf8" }).trim(),
    );
    const mtimeMs = statSync(bin).mtimeMs;
    if (claudeModelScan.path === bin && claudeModelScan.mtimeMs === mtimeMs)
      return;
    claudeModelScan = { path: bin, mtimeMs };
  } catch {
    return;
  }
  try {
    const ids = parseClaudeModelIds(await readFile(bin, "latin1"));
    if (ids.length === 0) return;
    CLAUDE_MODELS = toClaudeModels(ids);
    CLAUDE_ALIASES = claudeAliasesFor(CLAUDE_MODELS);
  } catch {
    // scan failed: keep the previous list
  }
}
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_CLAUDE_MODEL_ID = "claude-sonnet-5";
const DEFAULT_CLAUDE_EFFORT = "high";
const USAGE_TTL_MS = 5 * 60_000;
/**
 * Floor on the forced path. The composer polls usage every 30s for as long as
 * a turn streams, and `force` used to skip the cache outright -- so a ten
 * minute turn spawned twenty `claude` CLI processes. Forced still means
 * "fresher than the idle TTL", just not "respawn unconditionally": these are
 * subscription windows measured in hours, so a two-minute floor still moves
 * the composer chip several times a turn.
 */
const USAGE_FORCE_TTL_MS = 2 * 60_000;
let usageCache = { at: 0, promise: undefined, result: undefined };

function claudeModelInfo(modelId) {
  const raw = String(modelId || "").trim();
  if (!raw) return null;
  const alias = CLAUDE_ALIASES[raw.toLowerCase()];
  const stripped = raw
    .replace(/\[1m\]$/i, "")
    .replace(/-20\d{6}(?:-v\d+)?$/i, "");
  const known = CLAUDE_MODELS.find(
    (model) =>
      model.id === raw ||
      model.id === alias ||
      model.id === stripped ||
      raw === model.id ||
      stripped === model.id ||
      raw.startsWith(`${model.id}-`) ||
      stripped.startsWith(`${model.id}-`),
  );
  if (known) return { ...known };
  return {
    provider: "anthropic",
    id: alias || raw,
    name: formatClaudeModelName(alias || stripped || raw),
  };
}

/**
 * Claude ids only. The CLI takes any string for --model, so a proxied or
 * experimental id (`glm-5.3-flash`) used to be adopted as the session's model
 * and prepended to the model list — which is how a `claude` row ended up
 * advertising another provider's model.
 */
function isClaudeModelId(modelId) {
  const raw = String(modelId || "").trim();
  if (!raw) return false;
  if (raw.toLowerCase().startsWith("claude")) return true;
  return Boolean(CLAUDE_ALIASES[raw.toLowerCase()]);
}

/** The session's model: the Claude id given, or the default when it is foreign. */
function claudeModelOrDefault(modelId) {
  return isClaudeModelId(modelId)
    ? claudeModelInfo(modelId)
    : claudeModelInfo(DEFAULT_CLAUDE_MODEL_ID);
}

function parseClaudeUsageText(stdout) {
  let resultText = String(stdout || "");
  try {
    const parsed = JSON.parse(resultText);
    if (typeof parsed?.result === "string") resultText = parsed.result;
    else if (typeof parsed?.text === "string") resultText = parsed.text;
  } catch {
    for (const line of resultText.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "result" && typeof event.result === "string")
          resultText = event.result;
      } catch {
        /* ignore non-JSON output */
      }
    }
  }
  const legacy = [
    ...resultText.matchAll(
      /^(Current session|Current week[^:]*):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+))?$/gim,
    ),
  ].map((match) => {
    // The CLI prints the reset as prose ("Sep 11, 9:08 AM"); the chip wants an
    // instant so it can count down, so it is parsed here.
    const resetsAt = match[3] ? Date.parse(match[3].trim()) : Number.NaN;
    return {
      label: /^Current session$/i.test(match[1])
        ? "Current session"
        : "Current week",
      usedPercent: Number(match[2]),
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
    };
  });
  if (legacy.length > 0) return legacy;
  // Newer CLIs dropped "N% used" for request counts: "Last 24h · 410 requests".
  return [
    ...resultText.matchAll(/^Last\s+(24h|7d)\s*·\s*([\d,]+)\s+requests?/gim),
  ].map((match) => ({ label: match[1], usedText: `${match[2]} req` }));
}

// Rolling windows never announce their reset: a window frees up when its
// oldest in-window request ages out, so reset = oldest request + span. The
// OAuth usage endpoint (five_hour/seven_day.resets_at) is the real source but
// 429s persistently for some plans, so estimate from the same local
// transcripts the CLI's "approximate, based on local sessions" stats use.
// ponytail: reads every transcript written in the last 7d per poll; move to
// the OAuth endpoint (or cache with a longer TTL) if that scan shows up.
const CLAUDE_USAGE_WINDOW_SPANS = {
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

async function claudeWindowResets() {
  const now = Date.now();
  let entries;
  try {
    entries = readdirSync(join(homedir(), ".claude", "projects"), {
      recursive: true,
      withFileTypes: true,
    });
  } catch {
    return {};
  }
  const earliest = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(entry.parentPath, entry.name);
    try {
      if (now - statSync(path).mtimeMs > CLAUDE_USAGE_WINDOW_SPANS["7d"])
        continue;
      const contents = await readFile(path, "utf8");
      for (const match of contents.matchAll(/"timestamp":"([^"]+)"/g)) {
        const at = Date.parse(match[1]);
        if (!Number.isFinite(at)) continue;
        for (const [label, span] of Object.entries(CLAUDE_USAGE_WINDOW_SPANS))
          if (at >= now - span && at < (earliest[label] ?? Infinity))
            earliest[label] = at;
      }
    } catch {
      /* unreadable transcript, skip */
    }
  }
  const resets = {};
  for (const [label, span] of Object.entries(CLAUDE_USAGE_WINDOW_SPANS))
    if (Number.isFinite(earliest[label]))
      resets[label] = earliest[label] + span;
  return resets;
}

async function readClaudeSessionRuntime(path) {
  if (!path || !existsSync(path)) return {};
  try {
    const contents = await readFile(path, "utf8");
    let model;
    let effort;
    for (const line of contents.split("\n")) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "assistant") continue;
      const id = entry.message?.model;
      if (typeof id === "string" && id && id !== "<synthetic>") model = id;
      if (typeof entry.effort === "string" && entry.effort.trim())
        effort = entry.effort.trim();
    }
    return { model, effort };
  } catch {
    return {};
  }
}

/**
 * Exact five_hour/seven_day utilization + reset instants -- the same data the
 * CLI's own usage bars fetch (GET /api/oauth/usage, utilization as a percent,
 * resets_at RFC3339). The endpoint 429s persistently for some plans, so
 * callers fall back to the prose + transcript estimate.
 */
async function claudeOAuthToken() {
  try {
    const parsed = JSON.parse(
      await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8"),
    );
    const token = parsed?.claudeAiOauth?.accessToken;
    if (token) return token;
  } catch {
    /* Linux has no keychain but does have this file; macOS has the keychain */
  }
  let raw;
  try {
    raw = await new Promise((resolve, reject) =>
      execFile(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 5_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    );
    return JSON.parse(String(raw).trim())?.claudeAiOauth?.accessToken;
  } catch {
    return undefined; // no keychain item, or unreadable credential
  }
}

/**
 * unifiedWindows from a rate_limit_event ({five_hour, seven_day} with
 * fractional utilization and epoch-second resetsAt) -> chip windows.
 * Expired windows drop rather than counting into the past.
 */
function usageWindowsFromUnified(unifiedWindows) {
  const now = Date.now();
  return Object.entries(unifiedWindows ?? {})
    .map(([key, window]) => {
      const resetsAt = Number(window?.resetsAt) * 1000;
      const usedPercent = Number(window?.utilization) * 100;
      if (!Number.isFinite(resetsAt) || resetsAt <= now) return null;
      return {
        label: key === "five_hour" ? "Session" : "Weekly",
        ...(Number.isFinite(usedPercent) && usedPercent >= 0
          ? { usedPercent }
          : {}),
        resetsAt,
      };
    })
    .filter(Boolean);
}

async function claudeOAuthUsage() {
  const token = await claudeOAuthToken();
  if (!token) throw new Error("no claude oauth token");
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
      "User-Agent": "claude-cli/2.1.267 (external, cli)",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`claude usage ${response.status}`);
  const payload = await response.json();
  return [
    ["Session", payload?.five_hour],
    ["Weekly", payload?.seven_day],
  ]
    .map(([label, window]) => {
      const usedPercent = Number(window?.utilization);
      const resetsAt = Date.parse(window?.resets_at ?? "");
      return {
        label,
        ...(Number.isFinite(usedPercent) && usedPercent > 0
          ? { usedPercent }
          : {}),
        ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
      };
    })
    .filter(
      (window) =>
        window.usedPercent !== undefined || window.resetsAt !== undefined,
    );
}

let claudeOAuthUsageFailedAt = 0;

/**
 * Fallback probe: one tiny inference turn through the CLI. Every turn's stream
 * carries a rate_limit_event with exact five_hour/seven_day utilization, so
 * this beats both the /usage prose (no percents) and the OAuth endpoint
 * (persistent 429s -- claude-code#31021, and refreshing is not possible when
 * auth is delegated to a host like Claude Desktop, which holds the refresh
 * token itself). Cost: one haiku "ok" per cache-expired poll.
 */
function loadClaudeProbeUsage() {
  return new Promise((resolve) => {
    const child = spawn(
      resolveClaudeExecutable(),
      [
        "-p",
        "Reply with exactly: ok",
        "--model",
        "haiku",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--dangerously-skip-permissions",
      ],
      {
        cwd: homedir(),
        env: subscriptionEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      resolve(result);
    };
    const timeout = setTimeout(
      () => finish({ ok: false, error: "Claude usage probe timed out." }),
      30_000,
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", (error) => finish({ ok: false, error: error.message }));
    child.once("exit", () => {
      if (settled) return;
      let windows = [];
      for (const line of stdout.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.type === "rate_limit_event")
            windows = usageWindowsFromUnified(
              event.rate_limit_info?.unifiedWindows,
            );
          if (windows.length > 0) break;
        } catch {
          /* non-JSON line */
        }
      }
      if (windows.length > 0) {
        finish({
          ok: true,
          usage: {
            available: true,
            provider: "Claude",
            windows,
            updatedAt: new Date().toISOString(),
          },
        });
        return;
      }
      finish({
        ok: false,
        usage: { available: false, provider: "Claude", windows: [] },
        error: "no rate limit data in probe output",
      });
    });
  });
}

async function getClaudeUsage() {
  // A 429'd endpoint shouldn't be re-poked on every 30s poll; back off.
  const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
  if (
    !claudeOAuthUsageFailedAt ||
    Date.now() - claudeOAuthUsageFailedAt > RETRY_AFTER_FAILURE_MS
  ) {
    try {
      const windows = await claudeOAuthUsage();
      if (windows.length > 0)
        return {
          ok: true,
          usage: {
            available: true,
            provider: "Claude",
            windows,
            updatedAt: new Date().toISOString(),
          },
        };
    } catch {
      claudeOAuthUsageFailedAt = Date.now();
    }
  }
  // Exact data beats estimates: a probe turn carries real utilization, so try
  // it before falling back to the prose + transcript arithmetic.
  const probed = await loadClaudeProbeUsage().catch(() => null);
  if (probed?.ok) return probed;
  return loadClaudeUsage();
}

function loadClaudeUsage() {
  return new Promise((resolve) => {
    const child = spawn(
      resolveClaudeExecutable(),
      [
        "-p",
        "/usage",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--dangerously-skip-permissions",
      ],
      {
        cwd: homedir(),
        env: subscriptionEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      resolve(result);
    };
    const timeout = setTimeout(
      () => finish({ ok: false, error: "Claude usage check timed out." }),
      25_000,
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => finish({ ok: false, error: error.message }));
    child.once("exit", async (code) => {
      if (settled) return;
      const windows = parseClaudeUsageText(stdout);
      if (windows.length > 0) {
        const resets = await claudeWindowResets().catch(() => ({}));
        finish({
          ok: true,
          usage: {
            available: true,
            provider: "Claude",
            windows: windows.map((window) =>
              resets[window.label]
                ? { ...window, resetsAt: resets[window.label] }
                : window,
            ),
            updatedAt: new Date().toISOString(),
          },
        });
        return;
      }
      finish({
        ok: code === 0,
        usage: { available: false, provider: "Claude", windows: [] },
        ...(code === 0
          ? {}
          : {
              error:
                stderr.trim() || `Claude usage check exited with code ${code}`,
            }),
      });
    });
  });
}

// Claude Code refreshes its OAuth tokens only when the CLI actually runs, and
// the refresh token behind them has a hard expiry measured in weeks. A devden
// host that sits idle past it — or a freshly deployed one that nobody has
// opened yet — is logged out for real, and the only way back is an interactive
// `claude` + /login on that machine. So re-run the usage check on a timer: it
// spawns the CLI, which renews the token as a side effect, and a failure here
// is the earliest warning that the session is gone rather than a mid-turn one.
// Validated, not just coerced: a non-numeric override (DEVDEN_..._MS=6h)
// yields NaN, which setInterval silently treats as 1ms -- spawning the CLI
// a thousand times a second.
const AUTH_KEEPALIVE_MS = (() => {
  const ms = Number(process.env.DEVDEN_CLAUDE_KEEPALIVE_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 6 * 60 * 60 * 1000;
})();

export function startClaudeAuthKeepalive() {
  const ping = () =>
    loadClaudeUsage().then(
      (result) => {
        if (result?.ok) return;
        console.warn(
          `[claude] auth keepalive failed: ${result?.error || "unknown error"}`,
        );
        console.warn(
          "[claude] run `claude auth login` on this host — devden strips" +
            " ANTHROPIC_API_KEY and Claude Desktop host-auth, so there is" +
            " no fallback credential.",
        );
      },
      () => {},
    );
  void ping();
  return setInterval(ping, AUTH_KEEPALIVE_MS).unref();
}

function resolveClaudeExecutable() {
  return process.env.DEVDEN_CLAUDE_BIN || "claude";
}

export function subscriptionEnvironment() {
  const env = {
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    // Makes the CLI back up every file before it edits it, which is what the
    // rewind_files control request restores from. Without this a rewind can
    // only ever roll back the transcript, leaving the working tree ahead of
    // the conversation. (The SDK sets the same variable for its
    // enableFileCheckpointing option.)
    CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true",
  };
  // Claude Code otherwise silently prefers API/third-party billing over the
  // user's Claude.ai OAuth subscription when these are inherited by the server.
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    // If devden was started from Claude Desktop / Claude Code, these make the
    // child CLI treat this process as an SDK host that will refresh OAuth.
    // There is no such host, so you get "OAuth session expired and could not
    // be refreshed" even when a stored login exists. Refresh tokens are
    // single-use, so leaving them also lets a parent Desktop session burn
    // the token out from under us.
    "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
    "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
  ])
    delete env[name];
  // Desktop also injects session scopes. Keep them only when the operator
  // actually provisioned a long-lived env token / refresh token for headless
  // use (`claude setup-token` or CLAUDE_CODE_OAUTH_REFRESH_TOKEN).
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN)
    delete env.CLAUDE_CODE_OAUTH_SCOPES;
  return withHostGuardEnv(env);
}

function sessionIdFromPath(path) {
  const name = basename(String(path || ""));
  return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
}

function expectedSessionPath(cwd, sessionId) {
  if (!cwd || !sessionId) return undefined;
  return join(
    homedir(),
    ".claude",
    "projects",
    claudeProjectDirName(cwd),
    `${sessionId}.jsonl`,
  );
}

/** Claude Code encodes the cwd with every non-alphanumeric character as a
 *  dash, not only the separators: /Users/x/dev/.repo becomes
 *  -Users-x-dev--repo. Slash-only encoding pointed at a directory Claude
 *  never creates, so sessions inside dot-folders could not be found. */
function claudeProjectDirName(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text" && typeof part.text === "string")
        return part.text;
      if (part.type === "tool_result") {
        if (typeof part.content === "string") return part.content;
        return contentText(part.content);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stripSystemReminders(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}

function userMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  return contentText(content);
}

/** Claude injects this as a user turn when a background Agent/Task finishes.
 *  It is harness plumbing — same class of noise as isMeta / command caveats. */
export function parseTaskNotification(text) {
  const raw = String(text ?? "");
  if (!raw.includes("<task-notification>")) return null;
  const tag = (name) => {
    const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(raw);
    return match ? match[1].trim() : "";
  };
  const toolUseId = tag("tool-use-id");
  if (!toolUseId) return null;
  return {
    toolUseId,
    taskId: tag("task-id"),
    status: tag("status").toLowerCase(),
    summary: tag("summary"),
    result: tag("result"),
  };
}

/** The completion XML is written as a user turn, a queue-operation enqueue,
 *  or an attachment — stream-json often never emits the user turn, so the
 *  session jsonl is the source of truth. */
export function taskNotificationFromEvent(event) {
  if (!event || typeof event !== "object") return null;
  const attachment =
    event.attachment && typeof event.attachment === "object"
      ? event.attachment
      : {};
  return parseTaskNotification(
    userMessageText(event.message) ||
      event.content ||
      attachment.prompt ||
      attachment.content ||
      "",
  );
}

/** How long a held background Agent may stay silent before the spawn card
 *  is closed out. Matches grok/pi: without this the UI spins on "running"
 *  until a page refresh reloads the log and skips the live hold. */
let stallMs = 5 * 60_000;

/** Tests only: shrink the stall watchdog so the bail-out is observable. */
export function setStallMsForTesting(ms) {
  stallMs = ms;
}

function jsonlSize(path) {
  if (!path) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readNewJsonlLines(path, offset) {
  if (!path) return { lines: [], offset };
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { lines: [], offset };
  }
  if (text.length < offset) offset = 0;
  const chunk = text.slice(offset);
  const lastNl = chunk.lastIndexOf("\n");
  if (lastNl < 0) return { lines: [], offset };
  const complete = chunk.slice(0, lastNl + 1);
  return {
    lines: complete.split("\n").filter((line) => line.trim()),
    offset: offset + complete.length,
  };
}

export function parseClaudeAgentId(text, details = {}) {
  if (typeof details.agentId === "string" && details.agentId.trim())
    return details.agentId.trim();
  const match = /agentId:\s*([a-zA-Z0-9_-]+)/.exec(String(text ?? ""));
  return match ? match[1] : "";
}

/** Background Agent/Task returns immediately with a receipt, the way grok's
 *  spawn_subagent returns `subagent_id` and keeps working in a child session. */
export function isAsyncAgentLaunch(text, details = {}) {
  if (details.isAsync === true || details.status === "async_launched")
    return true;
  return /Async agent launched successfully/i.test(String(text ?? ""));
}

function normalizeHistoryEntry(entry) {
  const timestamp = Date.parse(entry?.timestamp ?? "") || Date.now();
  const message = entry?.message;
  if (!message || typeof message !== "object") return [];
  if (entry.type === "assistant") {
    const content = Array.isArray(message.content)
      ? message.content.map((part) => {
          if (part?.type === "tool_use") {
            return {
              type: "toolCall",
              id: part.id,
              name: part.name,
              arguments: part.input ?? {},
            };
          }
          return part;
        })
      : [];
    return [{ ...message, role: "assistant", content, timestamp }];
  }
  if (entry.type !== "user") return [];
  // isMeta marks everything the harness injected as a user turn -- hook
  // output, slash-command caveats, SessionStart banners. The user never
  // typed it, so it must not come back as their message.
  if (entry.isMeta) return [];
  const content = message.content;
  const text = typeof content === "string" ? content : contentText(content);
  if (/<local-command-caveat>|<command-name>|<command-message>/.test(text))
    return [];
  if (parseTaskNotification(text)) return [];
  if (
    Array.isArray(content) &&
    content.some((part) => part?.type === "tool_result")
  ) {
    return content
      .filter((part) => part?.type === "tool_result")
      .map((part) => ({
        role: "toolResult",
        toolCallId: String(part.tool_use_id ?? ""),
        toolName: String(entry.toolUseResult?.name ?? ""),
        content: [{ type: "text", text: contentText(part.content) }],
        isError: Boolean(part.is_error),
        timestamp,
      }));
  }
  const parts =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content)
        ? content
        : [];
  // <system-reminder> blocks ride along inside a real user turn; strip them
  // rather than dropping the turn.
  const visible = parts
    .map((part) =>
      part?.type === "text" && typeof part.text === "string"
        ? { ...part, text: stripSystemReminders(part.text) }
        : part,
    )
    .filter((part) => part?.type !== "text" || part.text);
  if (!visible.length) return [];
  return [{ role: "user", content: visible, timestamp }];
}

/** Subagent transcripts are written beside the session file, in
 *  <session>/subagents/agent-<id>.jsonl with an agent-<id>.meta.json naming
 *  the Agent/Task call that spawned them. The parent log keeps only the spawn
 *  and its result, so without splicing the children back in a page refresh
 *  emptied the subagent panel — the nested tool calls existed only for as
 *  long as the live stream did.
 *  @returns {Map<string, object[]>} child messages keyed by spawning call id */
function readSubagentTranscripts(sessionPath) {
  const dir = join(String(sessionPath).replace(/\.jsonl$/, ""), "subagents");
  const byParent = new Map();
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return byParent; // no subagents in this session
  }
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, name), "utf8"));
      const parentToolUseId = String(meta.toolUseId ?? "");
      if (!parentToolUseId) continue;
      const log = readFileSync(
        join(dir, name.replace(/\.meta\.json$/, ".jsonl")),
        "utf8",
      );
      const child = messagesFromClaudeLog(log)
        // The child's own prompt is a `user` entry, and the timeline renders
        // those as the operator's message — it must not reappear in the main
        // chat as something the user typed.
        .filter((message) => message.role !== "user")
        .map((message) => ({ ...message, parentToolUseId }));
      if (child.length) byParent.set(parentToolUseId, child);
    } catch {
      /* a child still mid-flight has no readable meta/log pair yet */
    }
  }
  return byParent;
}

export function messagesFromClaudeLog(contents, sessionPath) {
  const messages = String(contents || "")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return normalizeHistoryEntry(JSON.parse(line));
      } catch {
        return [];
      }
    });
  const children = sessionPath
    ? readSubagentTranscripts(sessionPath)
    : undefined;
  if (!children?.size) return messages;
  // Nested work lands right after the spawn's result, which is where it
  // happened and where collectSubagentRuns expects to find it.
  return messages.flatMap((message) =>
    message.role === "toolResult" && children.has(message.toolCallId)
      ? [message, ...children.get(message.toolCallId)]
      : [message],
  );
}

export class ClaudeAgentProcess {
  constructor(sessionKey) {
    this.sessionKey = sessionKey;
    this.process = undefined;
    this.decoder = new StringDecoder("utf8");
    this.stdoutBuffer = "";
    this.status = "stopped";
    this.cwd = homedir();
    this.options = {};
    this.approvalGate = new ApprovalGate(this);
    this.sessionId = "";
    this.sessionFile = undefined;
    this.model = claudeModelInfo(DEFAULT_CLAUDE_MODEL_ID);
    this.thinkingLevel = DEFAULT_CLAUDE_EFFORT;
    this.messageCount = 0;
    this.pendingTurns = [];
    this.activeStreams = new Map();
    this.streamGenerations = new Map();
    this.intentionalExit = false;
    this.initialized = false;
    this.availableTools = [];
    this.slashCommands = [];
    this.skills = new Set();
    this.seenSubagents = new Set();
    /** Root-level Task/Agent spawns whose tool_result has not come back yet.
     *  The CLI never emits a tool_result for a tool that was in flight when
     *  the user interrupted — it writes a plain "[Request interrupted by
     *  user for tool use]" message — so an interrupt has to close these out
     *  itself or the spawn card spins until the stall timer fires. */
    this.openSubagents = new Set();
    /** Background Agent/Task calls whose tool_execution_end is held until the
     *  child actually finishes (task-notification), keyed by the spawn id. */
    this.pendingBackgroundAgents = new Map();
    this.backgroundWatch = undefined;
    this.backgroundLogOffset = 0;
    /**
     * Control requests this host sent to the CLI, awaiting their responses.
     * @type {Map<string, { resolve: (value: object) => void, timer: NodeJS.Timeout }>}
     */
    this.pendingControlRequests = new Map();
    this.controlRequestSeq = 0;
    /**
     * Prompts submitted while a turn was running, waiting their turn. Held
     * here rather than written straight to the CLI so they stay cancellable —
     * once a message is on stdin it is the model's, not the user's.
     * @type {Array<{ id: string, message: string, images: object[], at: number }>}
     */
    this.queuedMessages = [];
    this.queueSeq = 0;
    attachQueue(this, {
      isBusy() {
        return this.pendingTurns.length > 0 || subagentBusy(this);
      },
      sendNow(message, images) {
        return this.prompt(message, images);
      },
      steerNow(message, images) {
        return this.steer(message, images);
      },
      requeueOnFailure: false,
    });
    attachSubagentFollows(this);
    /** @type {Set<(event: object) => void>} */
    this.listeners = new Set();
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* listener errors must not kill the pump */
      }
    }
  }

  setStatus(status, error) {
    this.status = status;
    this.emit({
      type: "__status",
      sessionKey: this.sessionKey,
      status,
      ...(error ? { error } : {}),
    });
  }

  getState() {
    return Promise.resolve({
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.status === "working",
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      messageCount: this.messageCount,
      pendingMessageCount: this.pendingTurns.length,
      queuedMessages: this.queueSnapshot(),
    });
  }

  async start(cwd, options = {}) {
    if (cwd && !existsSync(cwd)) {
      cwd = homedir();
      queueMicrotask(() =>
        this.emit({
          type: "stderr",
          sessionKey: this.sessionKey,
          message: `cwd not found; opened in ${cwd} instead`,
        }),
      );
    }
    if (options.sessionPath && !existsSync(options.sessionPath)) {
      // A saved session can vanish while the workbench still lists it (scratch
      // cwd cleaned up, session deleted elsewhere). Resuming it made claude
      // exit 1 with "No conversation found" and every getEntries() read throw
      // ENOENT; open a fresh session instead and say so once.
      queueMicrotask(() =>
        this.emit({
          type: "stderr",
          sessionKey: this.sessionKey,
          message: "that saved session no longer exists; started a fresh one",
        }),
      );
      options = { ...options, sessionPath: undefined };
    }
    if (this.process) return { ok: true, state: await this.getState() };
    this.cwd = cwd || homedir();
    this.options = { ...options };
    this.thinkingLevel =
      options.thinkingLevel || this.thinkingLevel || DEFAULT_CLAUDE_EFFORT;
    if (options.sessionPath) {
      this.sessionFile = options.sessionPath;
      this.sessionId = sessionIdFromPath(options.sessionPath);
      const runtime = await readClaudeSessionRuntime(options.sessionPath);
      this.model = options.model?.id
        ? claudeModelOrDefault(options.model.id)
        : runtime.model
          ? claudeModelOrDefault(runtime.model)
          : null;
      if (!options.thinkingLevel && runtime.effort)
        this.thinkingLevel = runtime.effort;
    } else {
      this.model = options.model?.id
        ? claudeModelOrDefault(options.model.id)
        : claudeModelInfo(DEFAULT_CLAUDE_MODEL_ID);
    }
    try {
      await this.spawnProcess();
      const state = await this.getState();
      if (!this.sessionFile) return { ok: true, state };
      const messages = await this.getMessages();
      this.messageCount = messages.length;
      return { ok: true, state, messages };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async spawnProcess(extraArgs = []) {
    this.setStatus("starting");
    this.stdoutBuffer = "";
    this.activeStreams.clear();
    this.initialized = false;
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--forward-subagent-text",
      "--include-hook-events",
      "--verbose",
      "--append-system-prompt",
      // Manual mode drops the pre-tool narration: the approval card shows
      // what is about to run.
      `${this.options.agentMode === "manual" ? CO_PARTNER_PROMPT_MANUAL : CO_PARTNER_PROMPT}\n\n${CLARIFY_PROMPT}`,
    ];
    if (this.options.agentMode === "plan") {
      args.push("--permission-mode", "plan");
    } else if (this.options.accessMode === "read-only") {
      args.push("--disallowedTools", "Bash Write Edit");
    } else if (this.options.agentMode === "manual") {
      // No bypass flag: the CLI then asks permission per tool via a
      // can_use_tool control request, which the gate routes to the UI.
    } else {
      // Verified in Claude Code 2.1.239 help as the explicit bypass-all-
      // permission-checks mode; avoids an unanswerable prompt in headless mode.
      args.push("--dangerously-skip-permissions");
    }
    if (this.sessionId) args.push("--resume", this.sessionId);
    this.resumedSessionId = this.sessionId || undefined;
    if (this.model?.id) args.push("--model", this.model.id);
    if (this.thinkingLevel) args.push("--effort", this.thinkingLevel);
    args.push(...extraArgs);

    const child = spawn(this.executable || resolveClaudeExecutable(), args, {
      cwd: this.cwd,
      env: { ...subscriptionEnvironment(), ...(this.envExtra || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.process = child;
    this.intentionalExit = false;
    child.stdout.on("data", (chunk) => this.readStdout(chunk));
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message)
        this.emit({ type: "stderr", sessionKey: this.sessionKey, message });
    });
    child.once("error", (error) => {
      this.failPending(error);
      this.process = undefined;
      this.setStatus("error", error.message);
    });
    child.once("exit", (code, signal) => {
      this.flushStdout();
      this.process = undefined;
      if (this.intentionalExit) return;
      const error = new Error(`Claude exited (${signal ?? code ?? "unknown"})`);
      this.failPending(error);
      if (this.status !== "stopped") {
        const message =
          code && code !== 0 ? `Claude exited with code ${code}` : undefined;
        this.setStatus(message ? "error" : "stopped", message);
      }
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    this.setStatus("ready");
  }

  prompt(message, images) {
    return this.sendTurn(message, images, "prompt");
  }
  steer(message, images) {
    return this.sendTurn(message, images, "steer");
  }
  followUp(message, images) {
    return this.sendTurn(message, images, "follow_up");
  }

  sendTurn(message, images, kind = "prompt") {
    if (!this.process)
      return Promise.resolve({
        ok: false,
        error: "Claude process is not running",
      });
    const content = [{ type: "text", text: String(message ?? "") }];
    for (const image of images ?? []) {
      if (!image?.data || !image?.mimeType) continue;
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: image.mimeType,
          data: image.data,
        },
      });
    }
    const payload = { type: "user", message: { role: "user", content } };
    this.messageCount += 1;
    const joinsActiveRun = kind === "steer" && this.pendingTurns.length > 0;
    if (joinsActiveRun) {
      return new Promise((resolve) => {
        this.process.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
          resolve(
            error
              ? { ok: false, error: error.message }
              : { ok: true, data: { accepted: true, mode: "steer" } },
          );
        });
      });
    }
    const startsRun = this.pendingTurns.length === 0;
    if (startsRun) {
      this.setStatus("working");
      this.emit({ type: "agent_start", sessionKey: this.sessionKey });
    }
    return new Promise((resolve) => {
      const pending = { resolve, kind };
      this.pendingTurns.push(pending);
      this.process.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        const index = this.pendingTurns.indexOf(pending);
        if (index !== -1) this.pendingTurns.splice(index, 1);
        resolve({ ok: false, error: error.message });
      });
    });
  }

  /**
   * Interrupt the way the CLI's own esc does: a control request, not a kill.
   *
   * Killing the process took the session's queue down with it (failPending
   * clears it), so a message the user had lined up while a turn — or a
   * subagent — was running vanished on interrupt. In the CLI and the desktop
   * app that message is exactly what Claude answers next. Interrupting in
   * place keeps the process, the queue and the transcript: the CLI ends the
   * turn with a `result`, and the existing flushQueue on that result sends
   * the queued message, which is the CLI's behaviour reproduced rather than
   * imitated. Restarting stays as the fallback for a CLI that cannot
   * interrupt.
   */
  async abort() {
    if (!this.process) return { ok: true };
    // A tool waiting on manual approval would otherwise keep its promise
    // parked (and the card visible) until the 10-minute timeout fired.
    this.approvalGate.denyAll();
    const turn = this.pendingTurns[0];
    // Before the request, not after: the CLI can emit the interrupted turn's
    // `result` — and with it the settle that flushes the queue — before the
    // control response is settled here.
    this.holdQueue();
    this.endRunningSubagents();
    // Nothing on the wire: the only thing still rendering as running was
    // subagent work, and the CLI does not restart itself to end a Task.
    if (!turn) return { ok: true };
    const interrupted = await this.sendControlRequest(
      { subtype: "interrupt" },
      10000,
    );
    if (interrupted.ok) {
      // The CLI answers the control request before it emits the turn's
      // `result`. If that result never lands, this turn never resolves and
      // the composer spins with the stop button already spent — so fall back
      // to the restart if the turn is still pending a few seconds later.
      const guard = setTimeout(() => {
        if (this.pendingTurns.includes(turn)) void this.restartAfterAbort();
      }, 5000);
      guard.unref?.();
      return { ok: true };
    }
    return this.restartAfterAbort();
  }

  /** Manual-mode answer from POST /api/<key>/approve. */
  resolveApproval(requestId, optionId) {
    return this.approvalGate.resolve(requestId, optionId);
  }

  /**
   * Close out everything the UI is still drawing as a live subagent. The CLI
   * emits no tool_result for a tool it interrupted, so without this the spawn
   * card runs until the stall timer, and the composer — which counts a
   * running subagent as streaming — spins with it.
   */
  endRunningSubagents() {
    for (const toolCallId of this.openSubagents) {
      this.emit({
        type: "tool_execution_end",
        sessionKey: this.sessionKey,
        toolCallId,
        result: {
          content: [
            {
              type: "text",
              text: "[Request interrupted by user for tool use]",
            },
          ],
        },
        isError: true,
      });
    }
    this.openSubagents.clear();
    this.endPendingBackgroundAgents();
    this.subagents?.stopAll();
    this.emit({
      type: "notice",
      sessionKey: this.sessionKey,
      message: "[Request interrupted by user]",
      tone: "info",
    });
  }

  /** Hard restart, preserving the queue an interrupt must not eat. */
  async restartAfterAbort() {
    const resumeId = this.sessionId;
    const queued = this.queuedMessages.slice();
    await this.terminateProcess(new Error("Claude run aborted"));
    if (resumeId) this.sessionId = resumeId;
    try {
      await this.spawnProcess();
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
    if (queued.length > 0) {
      this.queuedMessages = queued;
      this.emitQueue();
    }
    return { ok: true };
  }

  async newSession() {
    await this.terminateProcess(new Error("Claude session replaced"));
    this.sessionId = "";
    this.sessionFile = undefined;
    this.messageCount = 0;
    this.model = claudeModelInfo(DEFAULT_CLAUDE_MODEL_ID);
    this.thinkingLevel = DEFAULT_CLAUDE_EFFORT;
    try {
      await this.spawnProcess();
      return { ok: true, state: await this.getState(), messages: [] };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async switchSession(sessionPath) {
    const sessionId = sessionIdFromPath(sessionPath);
    if (!sessionId) return { ok: false, error: "Invalid Claude session path." };
    if (!existsSync(sessionPath))
      return { ok: false, error: "That saved session no longer exists." };
    await this.terminateProcess(new Error("Claude session switched"));
    this.sessionId = sessionId;
    this.sessionFile = sessionPath;
    const runtime = await readClaudeSessionRuntime(sessionPath);
    this.model = runtime.model ? claudeModelOrDefault(runtime.model) : null;
    if (runtime.effort) this.thinkingLevel = runtime.effort;
    try {
      await this.spawnProcess();
      const messages = await this.getMessages();
      this.messageCount = messages.length;
      return { ok: true, state: await this.getState(), messages };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  compact(customInstructions) {
    const suffix = customInstructions ? ` ${customInstructions}` : "";
    return this.sendTurn(`/compact${suffix}`);
  }

  async setModel(_provider, modelId) {
    this.model = claudeModelOrDefault(modelId);
    const result = await this.restart();
    return result.ok
      ? { ok: true, data: this.model, state: await this.getState() }
      : result;
  }

  async setThinkingLevel(level) {
    this.thinkingLevel = level;
    return this.restart();
  }

  async restart(extraArgs = []) {
    await this.terminateProcess(new Error("Claude process reconfigured"));
    try {
      await this.spawnProcess(extraArgs);
      return { ok: true, state: await this.getState() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async getEntries() {
    if (!this.sessionFile || !existsSync(this.sessionFile)) return [];
    const contents = await readFile(this.sessionFile, "utf8");
    return contents
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }

  async getMessages() {
    const entries = await this.getEntries();
    return entries.flatMap(normalizeHistoryEntry);
  }

  async forkAt(timestamp, context = {}) {
    const named =
      typeof context.sessionPath === "string" ? context.sessionPath : "";
    const source =
      named && existsSync(named)
        ? named
        : this.sessionFile && existsSync(this.sessionFile)
          ? this.sessionFile
          : expectedSessionPath(this.cwd || context.cwd, this.sessionId);
    if (!source || !existsSync(source))
      return { ok: false, error: "No Claude session is available to fork." };
    try {
      // Copy the JSONL through the clicked assistant, remap ids, write a new
      // session file. The original transcript is untouched.
      const destDir = context.forkCwd
        ? join(
            homedir(),
            ".claude",
            "projects",
            claudeProjectDirName(context.forkCwd),
          )
        : undefined;
      const forked = await forkClaudeTranscript(
        source,
        timestamp,
        destDir,
        context.forkCwd,
      );
      const messages = forked.entries.flatMap(normalizeHistoryEntry);
      const state = await this.getState();
      return {
        ok: true,
        restored: true,
        forkCwd: context.forkCwd || this.cwd,
        state: {
          ...state,
          sessionId: forked.sessionId,
          sessionFile: forked.sessionFile,
          isStreaming: false,
        },
        messages,
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  getCommands() {
    return Promise.resolve({
      ok: true,
      commands: this.slashCommands.map((name) => ({
        name,
        source: this.skills.has(name) ? "skill" : "claude",
      })),
    });
  }
  async getAvailableModels() {
    await refreshClaudeModels();
    return { ok: true, models: [...CLAUDE_MODELS] };
  }
  getThinkingLevels() {
    return Promise.resolve({ ok: true, levels: CLAUDE_EFFORT_LEVELS });
  }

  /**
   * Windows captured from the last turn's rate_limit_event: exact utilization
   * and absolute reset instants straight from the API. Reset instants stay
   * valid while idle, so staleness only matters per window: an expired one is
   * dropped rather than shown counting into the past.
   */
  liveUsageWindows() {
    return usageWindowsFromUnified(this.rateLimits?.windows);
  }

  getUsage(force = false) {
    const live = this.liveUsageWindows();
    if (live.length > 0)
      return Promise.resolve({
        ok: true,
        usage: {
          available: true,
          provider: "Claude",
          windows: live,
          updatedAt: new Date().toISOString(),
        },
      });
    const now = Date.now();
    const ttl = force ? USAGE_FORCE_TTL_MS : USAGE_TTL_MS;
    if (usageCache.result && now - usageCache.at < ttl)
      return Promise.resolve(usageCache.result);
    if (usageCache.promise) return usageCache.promise;
    usageCache.promise = getClaudeUsage()
      .then((result) => {
        if (result?.ok) {
          usageCache = { at: Date.now(), promise: undefined, result };
        } else {
          usageCache.promise = undefined;
        }
        return result;
      })
      .catch((error) => {
        usageCache.promise = undefined;
        return {
          ok: false,
          error: String(error?.message ?? error),
          usage: { available: false, provider: "Claude", windows: [] },
        };
      });
    return usageCache.promise;
  }

  /**
   * Send a control request and wait for its matching response. The CLI keys
   * replies by request_id, so anything in flight is tracked here rather than
   * assumed to arrive in order.
   */
  sendControlRequest(request, timeoutMs = 30000) {
    if (!this.process)
      return Promise.resolve({
        ok: false,
        error: "Claude process is not running",
      });
    this.controlRequestSeq += 1;
    const requestId = `devden-${Date.now()}-${this.controlRequestSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingControlRequests.delete(requestId);
        resolve({
          ok: false,
          error: `Claude did not answer "${request.subtype}" in time`,
        });
      }, timeoutMs);
      this.pendingControlRequests.set(requestId, { resolve, timer });
      const written = this.writeControl({
        type: "control_request",
        request_id: requestId,
        request,
      });
      if (!written) {
        clearTimeout(timer);
        this.pendingControlRequests.delete(requestId);
        resolve({ ok: false, error: "Could not write to the Claude process" });
      }
    });
  }

  /** Resolve whichever sendControlRequest is waiting on this response. */
  settleControlResponse(event) {
    const response = event?.response ?? {};
    const requestId = response.request_id;
    const pending = requestId
      ? this.pendingControlRequests.get(requestId)
      : undefined;
    if (!pending) return;
    this.pendingControlRequests.delete(requestId);
    clearTimeout(pending.timer);
    if (response.subtype === "success")
      pending.resolve({ ok: true, data: response.response ?? {} });
    else
      pending.resolve({
        ok: false,
        error: String(response.error ?? "Claude rejected the request"),
      });
  }

  /**
   * Map a transcript timestamp onto the CLI's own message id. The UI knows
   * turns by when they happened; rewind_files only speaks uuid.
   */
  async userMessageIdAt(timestamp, sessionPath) {
    // Prefer the transcript named by the live session id: sessionFile can lag
    // behind a /new or a fork, and reading the previous one yields uuids the
    // CLI has never heard of.
    const candidates = [];
    // The caller's transcript wins: a rewind happens after the turn, by which
    // point this process may have been reaped and replaced by an empty one
    // that knows neither the session id nor the file.
    if (sessionPath) candidates.push(sessionPath);
    // A session started fresh in the UI has a sessionId long before
    // sessionFile is populated, so derive the path rather than requiring it.
    const expected = expectedSessionPath(this.cwd, this.sessionId);
    if (expected) candidates.push(expected);
    if (this.sessionId && this.sessionFile)
      candidates.push(
        join(dirname(this.sessionFile), `${this.sessionId}.jsonl`),
      );
    if (this.sessionFile) candidates.push(this.sessionFile);
    let contents = "";
    for (const candidate of candidates) {
      try {
        contents = await readFile(candidate, "utf8");
        break;
      } catch {
        /* try the next candidate */
      }
    }
    if (!contents) return "";
    const target = Number(timestamp);
    let best = "";
    let bestDelta = Infinity;
    for (const line of contents.split("\n")) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== "user" || typeof entry.uuid !== "string") continue;
      // Only this session's own messages. sessionFile can still name the
      // transcript a tab was previously on, and a uuid from a different
      // session is one the CLI will reject as having no checkpoint.
      if (
        !sessionPath &&
        this.sessionId &&
        typeof entry.sessionId === "string" &&
        entry.sessionId !== this.sessionId
      )
        continue;
      // Tool results are logged as user entries too, and land milliseconds
      // after the prompt they answer — near enough to win a nearest-match.
      // Only real prompts are rewind targets.
      const content = entry.message?.content;
      if (
        Array.isArray(content) &&
        content.some((block) => block?.type === "tool_result")
      )
        continue;
      const at = Date.parse(entry.timestamp ?? "");
      if (!Number.isFinite(at)) continue;
      const delta = Math.abs(at - target);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = entry.uuid;
      }
    }
    // A match more than a minute away is a different turn, not this one.
    return bestDelta <= 60000 ? best : "";
  }

  /**
   * Restore the working tree to the checkpoint taken before a given user
   * message. `dryRun` reports what would change without touching anything.
   */
  async rewindFiles(timestamp, dryRun = false, sessionPath) {
    const userMessageId = await this.userMessageIdAt(timestamp, sessionPath);
    if (!userMessageId)
      return {
        ok: false,
        error: "No checkpoint matches that message in this session's log",
      };
    const result = await this.sendControlRequest({
      subtype: "rewind_files",
      user_message_id: userMessageId,
      dry_run: dryRun === true,
    });
    if (!result.ok) return result;
    const data = result.data ?? {};
    if (data.canRewind === false)
      return { ok: false, error: String(data.error || "Nothing to restore.") };
    return { ok: true, data: { ...data, dryRun: dryRun === true } };
  }

  /**
   * Real context accounting from the CLI, replacing the character-count
   * estimate. "summary" answers from the last response's usage instead of
   * re-counting every category, which is what makes it cheap enough to ask
   * for after every turn.
   */
  async getContextUsage() {
    const result = await this.sendControlRequest(
      { subtype: "get_context_usage", detail: "summary" },
      15000,
    );
    if (!result.ok) return result;
    // The wire format is camelCase and the payload is the usage object itself
    // on current builds; older ones nest it under context_usage.
    const usage = result.data?.context_usage ?? result.data ?? {};
    const total = Number(usage.totalTokens ?? usage.total_tokens);
    const max = Number(
      usage.rawMaxTokens ?? usage.raw_max_tokens ?? usage.maxTokens,
    );
    if (!Number.isFinite(total) || !Number.isFinite(max) || max <= 0)
      return { ok: false, error: "Claude returned no usable context usage" };
    return {
      ok: true,
      data: {
        totalTokens: total,
        maxTokens: max,
        percent: Number(usage.percentage ?? Math.round((total / max) * 100)),
        model: String(usage.model ?? ""),
        autoCompactThreshold: Number(usage.autoCompactThreshold) || 0,
        isAutoCompactEnabled: usage.isAutoCompactEnabled === true,
        categories: Array.isArray(usage.categories)
          ? usage.categories
              .map((entry) => ({
                name: String(entry?.name ?? ""),
                tokens: Number(entry?.tokens) || 0,
              }))
              .filter((entry) => entry.name && entry.tokens > 0)
          : [],
      },
    };
  }

  /**
   * Settings as the agent resolved them: the merged view, each file that
   * contributed, and the hooks in force.
   *
   * Read-only on purpose. The CLI's update_settings control request accepts
   * only `outputStyle`, so it cannot back a real editor; the files themselves
   * are editable through the workspace explorer, and their paths are returned
   * here so the UI can point at them.
   */
  async getSettings() {
    const result = await this.sendControlRequest(
      { subtype: "get_settings" },
      15000,
    );
    if (!result.ok) return result;
    const data = result.data ?? {};
    const sources = Array.isArray(data.sources) ? data.sources : [];
    const effective = data.effective ?? {};
    // Flatten hooks into rows the UI can list without re-deriving the shape.
    const hooks = [];
    for (const [event, matchers] of Object.entries(effective.hooks ?? {})) {
      if (!Array.isArray(matchers)) continue;
      for (const entry of matchers) {
        for (const hook of entry?.hooks ?? []) {
          hooks.push({
            event,
            matcher: String(entry?.matcher ?? "*"),
            type: String(hook?.type ?? "command"),
            command: String(hook?.command ?? ""),
          });
        }
      }
    }
    return {
      ok: true,
      data: {
        effective,
        hooks,
        sources: sources.map((entry) => ({
          source: String(entry?.source ?? "unknown"),
          settings: entry?.settings ?? {},
        })),
        localSettings:
          sources.find((entry) => entry?.source === "localSettings")
            ?.settings ?? {},
        // Where each scope lives on disk, so the UI can open the real file.
        files: {
          userSettings: join(homedir(), ".claude", "settings.json"),
          projectSettings: join(this.cwd, ".claude", "settings.json"),
          localSettings: join(this.cwd, ".claude", "settings.local.json"),
        },
      },
    };
  }

  /** Configured MCP servers and whether each one actually connected. */
  async getMcpServers() {
    const result = await this.sendControlRequest(
      { subtype: "mcp_status" },
      15000,
    );
    if (!result.ok) return result;
    const servers = Array.isArray(result.data?.mcpServers)
      ? result.data.mcpServers
      : [];
    return {
      ok: true,
      data: {
        servers: servers.map((server) => ({
          name: String(server?.name ?? "unknown"),
          status: String(server?.status ?? "pending"),
          scope: String(server?.scope ?? ""),
          error: String(server?.error ?? ""),
          version: String(server?.serverInfo?.version ?? ""),
          toolCount: Array.isArray(server?.tools) ? server.tools.length : null,
        })),
      },
    };
  }

  /** Write one control frame to the CLI. Returns false when the pipe is gone. */
  writeControl(payload) {
    if (!this.process?.stdin?.writable) return false;
    try {
      this.process.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  readStdout(chunk) {
    this.stdoutBuffer += this.decoder.write(chunk);
    this.drainStdout();
  }

  flushStdout() {
    this.stdoutBuffer += this.decoder.end();
    this.drainStdout();
    this.stdoutBuffer = "";
  }

  drainStdout() {
    let index = this.stdoutBuffer.indexOf("\n");
    while (index !== -1) {
      let line = this.stdoutBuffer.slice(0, index);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.stdoutBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.emit({
        type: "claude_raw_line",
        sessionKey: this.sessionKey,
        raw: line,
      });
      return;
    }

    // Keep the provider's original stream event alongside the normalized
    // events used by the conversation UI. This makes the backend log useful
    // when Claude introduces a new event shape or a translation loses detail.
    this.emit({
      type: "claude_raw_event",
      sessionKey: this.sessionKey,
      rawType: event.type,
      event,
    });

    if (event.parent_tool_use_id)
      this.noteBackgroundProgress(event.parent_tool_use_id);

    const notification = taskNotificationFromEvent(event);
    if (notification) {
      this.finishBackgroundAgent(notification);
      return;
    }

    if (event.type === "control_request") {
      const request = event.request ?? {};
      if (request.subtype === "can_use_tool") {
        // Manual mode: the CLI asks before running a tool. Forward the ask
        // to the UI and answer with the user's pick; "always allow" is
        // remembered per tool name inside the gate.
        void this.approvalGate
          .request({
            toolName: String(request.tool_name ?? "tool"),
            title: String(request.tool_name ?? "tool"),
            detail: request.input,
          })
          .then(({ allow, choice }) => {
            this.writeControl({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: event.request_id,
                response: allow
                  ? {
                      behavior: "allow",
                      updatedInput: request.input ?? {},
                    }
                  : {
                      behavior: "deny",
                      message: `Denied by user (${choice ?? "deny"}).`,
                    },
              },
            });
          })
          .catch(() => {
            // The gate itself failing must not wedge the CLI: deny.
            this.writeControl({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: event.request_id,
                response: {
                  behavior: "deny",
                  message: "Approval flow failed.",
                },
              },
            });
          });
        return;
      }
      // This host implements no other inbound control requests. Refuse
      // explicitly: a silent non-answer would leave the CLI waiting forever.
      this.writeControl({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: event.request_id,
          error: `devden does not implement control request "${request.subtype}"`,
        },
      });
      return;
    }
    if (event.type === "control_cancel_request") return;
    if (event.type === "control_response") {
      this.settleControlResponse(event);
      return;
    }

    if (event.type === "system" && event.subtype === "compact_boundary") {
      // Claude auto-compacts near the context limit with no chat message of
      // its own; without this the transcript just goes silent about it.
      // Reuse pi's "compaction_end" shape so the client's existing notice
      // rendering (Timeline, src/lib/timeline.ts) picks it up unchanged.
      const meta = event.compactMetadata ?? {};
      this.emit({
        type: "compaction_end",
        sessionKey: this.sessionKey,
        reason: typeof meta.trigger === "string" ? meta.trigger : "auto",
        aborted: false,
        result: {
          tokensBefore:
            typeof meta.preTokens === "number" ? meta.preTokens : undefined,
          estimatedTokensAfter:
            typeof meta.postTokens === "number" ? meta.postTokens : undefined,
        },
      });
      return;
    }

    if (event.type === "system" && event.subtype === "init") {
      this.initialized = true;
      const authSource = event.apiKeySource ?? event.api_key_source;
      if (authSource && authSource !== "none") {
        const error = new Error(
          `Claude subscription auth required; received ${authSource}.`,
        );
        this.emit({
          type: "stderr",
          sessionKey: this.sessionKey,
          message: error.message,
        });
        void this.terminateProcess(error);
        this.setStatus("error", error.message);
        return;
      }
      if (typeof event.session_id === "string")
        this.sessionId = event.session_id;
      // The CLI reports the realpath'd cwd (this.cwd may be a /tmp symlink
      // while session files live under /private/tmp), so it must land before
      // any path is derived from it.
      if (typeof event.cwd === "string") this.cwd = event.cwd;
      // --fork-session: the fork's first prompt rebase this process onto a
      // new session id (reported by a later init). Rebind the file so a
      // refresh resumes the fork, not the conversation it branched from.
      if (
        typeof event.session_id === "string" &&
        this.resumedSessionId &&
        event.session_id !== this.resumedSessionId
      ) {
        this.resumedSessionId = event.session_id;
        this.sessionFile = expectedSessionPath(this.cwd, event.session_id);
      }
      if (typeof event.model === "string" && isClaudeModelId(event.model))
        this.model = claudeModelInfo(event.model);
      if (Array.isArray(event.tools))
        this.availableTools = event.tools.filter(
          (tool) => typeof tool === "string",
        );
      this.skills = new Set(
        Array.isArray(event.skills)
          ? event.skills.filter((skill) => typeof skill === "string")
          : [],
      );
      this.slashCommands = [
        ...new Set(
          [
            ...(Array.isArray(event.slash_commands)
              ? event.slash_commands
              : []),
            ...(Array.isArray(event.terminal_slash_commands)
              ? event.terminal_slash_commands
              : []),
          ].filter((command) => typeof command === "string"),
        ),
      ].sort((left, right) => left.localeCompare(right));
      this.sessionFile =
        this.sessionFile ?? expectedSessionPath(this.cwd, this.sessionId);
      this.emit({
        type: "claude_init",
        sessionKey: this.sessionKey,
        apiKeySource: authSource ?? "unknown",
        sessionId: this.sessionId,
        tools: this.availableTools,
        slashCommands: this.slashCommands,
      });
      void this.getState().then((state) =>
        this.emit({ type: "state", sessionKey: this.sessionKey, state }),
      );
      return;
    }

    if (event.type === "stream_event") {
      this.handleStreamEvent(event.event, event.parent_tool_use_id);
      return;
    }

    if (event.type === "assistant" && event.message) {
      const source = event.parent_tool_use_id || "root";
      if (
        event.parent_tool_use_id &&
        !this.seenSubagents.has(event.parent_tool_use_id)
      ) {
        this.seenSubagents.add(event.parent_tool_use_id);
        this.emit({
          type: "subagent_start",
          sessionKey: this.sessionKey,
          parentToolUseId: event.parent_tool_use_id,
        });
      }
      const activeStream =
        this.activeStreams.get(source) ?? this.beginMessageStream(source);
      const content = Array.isArray(event.message.content)
        ? event.message.content
        : [];
      content.forEach((part) => {
        if (part?.type !== "tool_use") return;
        this.emit({
          type: "tool_execution_start",
          sessionKey: this.sessionKey,
          toolCallId: part.id,
          toolName: part.name,
          args: part.input ?? {},
          // Set when this call was made by a subagent rather than the main
          // loop: it is the id of the Task tool call that spawned it, which
          // is what lets the UI nest the work under its parent.
          ...(event.parent_tool_use_id
            ? { parentToolUseId: event.parent_tool_use_id }
            : {}),
        });
        if (isSubagentToolName(part.name) && !event.parent_tool_use_id) {
          this.openSubagents.add(part.id);
          this.emit({
            type: "subagent_start",
            sessionKey: this.sessionKey,
            parentToolUseId: part.id,
          });
        }
        noteSubagentToolEvent(this, {
          type: "tool_execution_start",
          toolCallId: part.id,
          toolName: part.name,
          args: part.input ?? {},
        });
      });
      const message = {
        ...event.message,
        content: content.map((part) =>
          part?.type === "tool_use"
            ? {
                type: "toolCall",
                id: part.id,
                name: part.name,
                arguments: part.input ?? {},
              }
            : part,
        ),
        timestamp: Date.now(),
      };
      this.emit({
        type: "message_end",
        sessionKey: this.sessionKey,
        streamKey: activeStream.key,
        message,
        ...(event.parent_tool_use_id
          ? { parentToolUseId: event.parent_tool_use_id }
          : {}),
      });
      this.messageCount += 1;
      this.activeStreams.delete(source);
      return;
    }

    if (event.type === "user" && event.message) {
      const content = Array.isArray(event.message.content)
        ? event.message.content
        : [];
      for (const part of content) {
        if (part?.type !== "tool_result") continue;
        // Background launches come back here too, with their receipt; from
        // that point holdBackgroundAgentEnd owns the call, not this set.
        this.openSubagents.delete(part.tool_use_id);
        const endEvent = {
          type: "tool_execution_end",
          sessionKey: this.sessionKey,
          toolCallId: part.tool_use_id,
          result: {
            content: [{ type: "text", text: contentText(part.content) }],
            details: event.toolUseResult ?? {},
          },
          isError: Boolean(part.is_error),
          ...(event.parent_tool_use_id
            ? { parentToolUseId: event.parent_tool_use_id }
            : {}),
        };
        if (this.holdBackgroundAgentEnd(endEvent)) continue;
        if (noteSubagentToolEvent(this, endEvent).holdEnd) continue;
        this.emit(endEvent);
      }
      return;
    }

    if (event.type === "result") {
      const pending = this.pendingTurns.shift();
      const ok = event.is_error !== true && event.subtype !== "error";
      pending?.resolve(
        ok
          ? { ok: true, data: event }
          : {
              ok: false,
              error: String(event.result ?? "Claude request failed"),
            },
      );
      this.emit({
        type: "turn_result",
        sessionKey: this.sessionKey,
        requestKind: pending?.kind ?? "unknown",
        ok,
        result: event.result,
      });
      if (this.pendingTurns.length === 0) {
        this.setStatus("ready");
        this.emit({ type: "agent_settled", sessionKey: this.sessionKey });
        // Whatever the user lined up while this turn ran goes next —
        // unless holdQueue() marked this settle as an interrupt's own.
        this.flushQueue();
      } else {
        this.setStatus("working");
      }
      void this.getState().then((state) =>
        this.emit({ type: "state", sessionKey: this.sessionKey, state }),
      );
      return;
    }

    if (event.type === "rate_limit_event") {
      // Exact five_hour/seven_day utilization + reset instants ride every
      // turn (epoch-second resetsAt here) -- the freshest usage source there
      // is, so getUsage serves it before any endpoint or CLI fallback.
      this.rateLimits = {
        windows: event.rate_limit_info?.unifiedWindows ?? {},
        at: Date.now(),
      };
      this.emit({
        type: "rate_limit_event",
        sessionKey: this.sessionKey,
        rate_limit_info: event.rate_limit_info,
      });
      return;
    }

    // Claude adds event types frequently. Preserve unknown system/hook events
    // on the shared SSE stream so the UI can surface supported lifecycle data
    // without making the adapter brittle to new fields.
    this.emit({ ...event, sessionKey: this.sessionKey });
  }

  handleStreamEvent(streamEvent, parentToolUseId) {
    if (!streamEvent || typeof streamEvent !== "object") return;
    const source = parentToolUseId || "root";
    if (streamEvent.type === "message_start") {
      if (parentToolUseId && !this.seenSubagents.has(parentToolUseId)) {
        this.seenSubagents.add(parentToolUseId);
        this.emit({
          type: "subagent_start",
          sessionKey: this.sessionKey,
          parentToolUseId,
        });
      }
      this.beginMessageStream(source);
      return;
    }
    const index = typeof streamEvent.index === "number" ? streamEvent.index : 0;
    if (streamEvent.type === "content_block_start") {
      const activeStream =
        this.activeStreams.get(source) ?? this.beginMessageStream(source);
      const block = streamEvent.content_block ?? {};
      activeStream.blocks.set(index, {
        type: block.type,
        text: block.text ?? block.thinking ?? "",
        id: block.id,
        name: block.name,
      });
      if (block.type === "tool_use" && block.id) {
        this.emit({
          type: "tool_execution_start",
          sessionKey: this.sessionKey,
          toolCallId: block.id,
          toolName: block.name ?? "tool",
          args:
            block.input && typeof block.input === "object" ? block.input : {},
          ...(parentToolUseId ? { parentToolUseId } : {}),
        });
        if (isSubagentToolName(block.name) && !parentToolUseId) {
          this.emit({
            type: "subagent_start",
            sessionKey: this.sessionKey,
            parentToolUseId: block.id,
          });
        }
      }
      return;
    }
    if (streamEvent.type === "content_block_delta") {
      const activeStream =
        this.activeStreams.get(source) ?? this.beginMessageStream(source);
      const delta = streamEvent.delta ?? {};
      if (delta.type === "input_json_delta") {
        const partial =
          typeof delta.partial_json === "string" ? delta.partial_json : "";
        if (!partial) return;
        const block = activeStream.blocks.get(index) ?? {
          type: "tool_use",
          text: "",
        };
        block.text += partial;
        activeStream.blocks.set(index, block);
        return;
      }
      const block = activeStream.blocks.get(index) ?? {
        type: delta.type === "thinking_delta" ? "thinking" : "text",
        text: "",
      };
      const text =
        delta.type === "thinking_delta"
          ? delta.thinking
          : delta.type === "text_delta"
            ? delta.text
            : "";
      if (typeof text !== "string" || !text) return;
      block.text += text;
      activeStream.blocks.set(index, block);
      this.emit({
        type: "message_update",
        sessionKey: this.sessionKey,
        streamKey: activeStream.key,
        ...(parentToolUseId ? { parentToolUseId } : {}),
        assistantMessageEvent: {
          type:
            delta.type === "thinking_delta" ? "thinking_delta" : "text_delta",
          contentIndex: index,
          delta: text,
        },
      });
      return;
    }
    if (streamEvent.type === "content_block_stop") {
      const activeStream = this.activeStreams.get(source);
      if (!activeStream) return;
      const block = activeStream.blocks.get(index);
      if (!block) return;
      if (block.type === "tool_use" && block.id) {
        let args = {};
        try {
          args = block.text ? JSON.parse(block.text) : {};
        } catch {
          args = {};
        }
        if (args && typeof args === "object" && Object.keys(args).length) {
          this.emit({
            type: "tool_execution_start",
            sessionKey: this.sessionKey,
            toolCallId: block.id,
            toolName: block.name ?? "tool",
            args,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        }
        return;
      }
      if (!["text", "thinking"].includes(block.type)) return;
      this.emit({
        type: "message_update",
        sessionKey: this.sessionKey,
        streamKey: activeStream.key,
        ...(parentToolUseId ? { parentToolUseId } : {}),
        assistantMessageEvent: {
          type: block.type === "thinking" ? "thinking_end" : "text_end",
          contentIndex: index,
          content: block.text,
        },
      });
    }
  }

  holdBackgroundAgentEnd(endEvent) {
    const text = contentText(endEvent.result?.content);
    const details = endEvent.result?.details ?? {};
    if (!isAsyncAgentLaunch(text, details)) return false;
    this.pendingBackgroundAgents.set(endEvent.toolCallId, {
      agentId: parseClaudeAgentId(text, details),
      receipt: text,
      lastAdvance: Date.now(),
    });
    this.ensureBackgroundWatch();
    return true;
  }

  noteBackgroundProgress(parentToolUseId) {
    const pending = this.pendingBackgroundAgents.get(parentToolUseId);
    if (pending) pending.lastAdvance = Date.now();
  }

  ensureBackgroundWatch() {
    if (this.backgroundWatch) return;
    this.backgroundLogOffset = jsonlSize(this.sessionFile);
    this.backgroundWatch = setInterval(() => this.pollBackgroundAgents(), 200);
    this.backgroundWatch.unref?.();
  }

  clearBackgroundWatch() {
    if (!this.backgroundWatch) return;
    clearInterval(this.backgroundWatch);
    this.backgroundWatch = undefined;
  }

  pollBackgroundAgents() {
    if (this.pendingBackgroundAgents.size === 0) {
      this.clearBackgroundWatch();
      return;
    }
    this.consumeSessionNotifications();
    if (this.pendingBackgroundAgents.size === 0) return;
    const now = Date.now();
    for (const [toolCallId, pending] of [...this.pendingBackgroundAgents]) {
      if (now - pending.lastAdvance < stallMs) continue;
      this.finishBackgroundAgent({
        toolUseId: toolCallId,
        status: "error",
        result: pending.receipt || "Subagent stalled.",
      });
    }
  }

  consumeSessionNotifications() {
    if (!this.sessionFile) return;
    const { lines, offset } = readNewJsonlLines(
      this.sessionFile,
      this.backgroundLogOffset ?? 0,
    );
    this.backgroundLogOffset = offset;
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const notification = taskNotificationFromEvent(event);
      if (notification) this.finishBackgroundAgent(notification);
    }
  }

  finishBackgroundAgent(notification) {
    const pending = this.pendingBackgroundAgents.get(notification.toolUseId);
    if (!pending) return;
    this.pendingBackgroundAgents.delete(notification.toolUseId);
    const failed =
      notification.status === "failed" || notification.status === "error";
    const text =
      notification.result ||
      notification.summary ||
      pending.receipt ||
      "Subagent finished.";
    this.emit({
      type: "tool_execution_end",
      sessionKey: this.sessionKey,
      toolCallId: notification.toolUseId,
      result: { content: [{ type: "text", text }] },
      isError: failed,
    });
    if (this.pendingBackgroundAgents.size === 0) this.clearBackgroundWatch();
    // Same as the follower's drain: nothing else will come along to notice
    // that the agent is finally idle.
    if (!this.isBusy()) this.sendNextQueued();
  }

  endPendingBackgroundAgents() {
    for (const [toolCallId, pending] of this.pendingBackgroundAgents) {
      this.emit({
        type: "tool_execution_end",
        sessionKey: this.sessionKey,
        toolCallId,
        result: {
          content: [
            {
              type: "text",
              text: pending.receipt || "Subagent interrupted.",
            },
          ],
        },
        isError: true,
      });
    }
    this.pendingBackgroundAgents.clear();
    this.clearBackgroundWatch();
  }

  beginMessageStream(source) {
    const generation = (this.streamGenerations.get(source) ?? 0) + 1;
    this.streamGenerations.set(source, generation);
    const stream = { key: `claude-${source}-${generation}`, blocks: new Map() };
    this.activeStreams.set(source, stream);
    this.emit({
      type: "turn_start",
      sessionKey: this.sessionKey,
      streamKey: stream.key,
    });
    return stream;
  }

  failPending(error) {
    for (const pending of this.pendingTurns.splice(0)) {
      pending.resolve({ ok: false, error: String(error?.message ?? error) });
    }
    if (this.queuedMessages.length > 0) {
      this.queuedMessages = [];
      this.emitQueue();
    }
    for (const [requestId, pending] of [...this.pendingControlRequests]) {
      this.pendingControlRequests.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: String(error?.message ?? error) });
    }
  }

  async terminateProcess(error) {
    const child = this.process;
    this.process = undefined;
    this.intentionalExit = true;
    this.endPendingBackgroundAgents();
    this.failPending(error);
    if (!child) return;
    this.signalProcess(child, "SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return resolve();
      const timeout = setTimeout(() => {
        this.signalProcess(child, "SIGKILL");
        resolve();
      }, 1200);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  signalProcess(child, signal) {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        /* process group already exited */
      }
    }
    try {
      child.kill(signal);
    } catch {
      /* process already exited */
    }
  }

  stop() {
    this.status = "stopped";
    this.subagents?.stopAll();
    void this.terminateProcess(new Error("Claude process stopped"));
    this.emit({
      type: "__status",
      sessionKey: this.sessionKey,
      status: "stopped",
    });
  }
}

export class ClaudeAgentPool extends AgentPool {
  constructor() {
    super((sessionKey) => new ClaudeAgentProcess(sessionKey));
  }
}
