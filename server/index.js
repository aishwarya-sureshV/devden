/**
 * devden server: static file serving (production build), JSON command API,
 * and a Server-Sent Events stream that fans out pi RPC events to the browser.
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/attention                 -> pending tool-approval count
 *   GET  /api/sessions?view=archived       -> persisted ~/.pi sessions
 *   POST /api/sessions/archive             { sessionPath }
 *   POST /api/sessions/restore             { sessionPath }
 *   POST /api/sessions/delete              { sessionPath }
 *   GET  /api/workspace?path=              -> files + folders in a project directory
 *   GET  /api/workspace/file?path=         -> text contents of a source file
 *   GET  /api/workspace/grep?root=&q=      -> content matches across the project
 *   GET  /api/workspace/definition?root=&symbol= -> where a symbol is defined
 *   PUT  /api/workspace/file               { path, content }
 *   POST /api/board/card-title             { text } -> short title for a board card
 *   POST /api/workspace/rename|delete|copy|move|reveal|open
 *   GET  /api/events                       -> SSE stream of all agent events
 *   POST /api/:sessionKey/start            { cwd }
 *   POST /api/:sessionKey/prompt           { message }
 *   POST /api/:sessionKey/steer            { message }
 *   POST /api/:sessionKey/abort
 *   POST /api/:sessionKey/stop
 *   GET  /api/:sessionKey/log
 *   POST /api/:sessionKey/new-session
 *   POST /api/:sessionKey/fork              { timestamp }
 *   POST /api/:sessionKey/compact          { customInstructions? }
 *   POST /api/:sessionKey/set-model        { provider, modelId }
 *   POST /api/:sessionKey/set-thinking     { level }
 *   GET  /api/:sessionKey/route            -> saved composer route (no chain)
 *   PUT  /api/:sessionKey/route            { route, sessionFile? }
 *   GET  /api/:sessionKey/git-changes?cwd=  -> branch, remote, per-file working-tree changes
 *   GET  /api/:sessionKey/git-changes?cwd=&file= -> one file's diff vs HEAD
 *   GET  /api/:sessionKey/changes?scope=turn|session&sessionPath=&turn=
 *                                          -> recorded per-turn / per-session diffs
 *   POST /api/:sessionKey/git              { cwd, op } where op is one of
 *                                          push|pull|pull-rebase|fetch|commit|
 *                                          commit-push|stash|stash-apply|
 *                                          stash-pop|stash-drop|branch-create|
 *                                          branch-switch|undo-commit|continue|
 *                                          abort|pr
 *   GET  /api/:sessionKey/worktrees?cwd=    -> this repo's worktrees
 *   POST /api/:sessionKey/worktree          { cwd, op: create|remove, name?,
 *                                             path?, force? }
 *   GET  /api/:sessionKey/commands
 *   GET  /api/:sessionKey/models
 *   GET  /api/:sessionKey/thinking-levels
 *   GET  /api/remote/status                 -> is the /remote phone tunnel up?
 *   POST /api/remote/start                  -> cloudflared quick tunnel + QR
 *   POST /api/remote/stop
 */
import "./env.js";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

import {
  mkdir,
  open as openFile,
  readdir,
  readlink,
  rename,
  rm,
  cp,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawn, execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { logFault } from "./log-fault.js";
import {
  isAllowedOrigin as allowedOrigin,
  isLoopbackRequest,
  requestHasAccess as hasAccess,
} from "./request-access.js";
import { hasAskBlock } from "./ask-block.js";
import { countPendingApprovals } from "./approval-gate.js";
import { createTerminalTabs } from "./terminal-tabs.js";
import { leaseVerdict } from "./lease-sweep.js";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import {
  PiAgentPool,
  assistantText,
  CARD_TITLE_INSTRUCTION,
  generateSessionTitle,
} from "./pi-agent.js";
import { ClaudeAgentPool, startClaudeAuthKeepalive } from "./claude-agent.js";
import { GrokAgentPool } from "./grok-agent.js";
import { CodexAgentPool } from "./codex-agent.js";
import { closeSharedCodex } from "./codex-app-server.js";
import {
  AGENT_BACKENDS,
  allBackendIds,
  backendName,
  capabilitiesFor,
  listBackends,
  sessionScope,
} from "./agent-registry.js";
import { clearDetectionCache } from "./agent-detect.js";
import { readHarnessUpdates, runHarnessUpdate } from "./harness-update.js";
import { cachedModels, clearModelCatalogs } from "./model-catalog.js";
import { devdenHome, readSetup, writeSetup } from "./setup-state.js";
import {
  agentIsAlive,
  callAgentMethod,
  claimFork,
  hasMethod,
  releaseFork,
  shouldAdoptLiveAgent,
  startOptionsFromBody,
  unsupported,
} from "./agent-methods.js";
import {
  noteTurnContext,
  noteTurnSettled,
  noteTurnStarted,
  rekeySession,
  runningSessionPaths,
  takeInterruptedTurns,
} from "./inflight.js";
import { resumePrompt } from "./co-partner-prompt.js";
import { isOneShotSseClient, SSE_ONESHOT_MS } from "./host-guard.js";
import {
  commitForFork,
  diffSinceSnapshot,
  restoreSnapshot,
  takeSnapshot,
} from "./snapshots.js";
import {
  beginTurn,
  endTurn,
  forgetSessionChanges,
  noteSessionContext,
  noteSessionActivity,
  noteToolCall,
  pruneChanges,
  readChanges,
  rekeyChanges,
} from "./changes.js";
import {
  baseOf,
  createWorktree,
  listWorktrees,
  removeWorktree,
  toplevelOf,
} from "./worktrees.js";
import {
  archiveSession,
  deleteSession,
  listSessions,
  searchSessions,
  loadSessionLog,
  readSessionMessages,
  readSessionXray,
  restoreSession,
} from "./sessions.js";
import {
  SETTINGS_PATH,
  deleteSkill,
  loadCatalog,
  readSkill,
  writeSkill,
} from "./catalog.js";
import { listOllamaModels, syncOllamaModelsJson } from "./ollama-models.js";
import {
  confinePath,
  defaultWorkspaceRoots,
  safeTranscriptName,
} from "./workspace-paths.js";
import { findDefinition, grepWorkspace } from "./workspace-search.js";
import { saveDisplayOverlay, withDisplayHistory } from "./display-history.js";
import { loadRoute, saveRoute } from "./session-route.js";
import {
  startRemoteTunnel,
  stopRemoteTunnel,
  getRemoteTunnel,
} from "./remote-tunnel.js";
import qrcode from "qrcode";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const DIST = join(ROOT, "dist");
const PORT = Number(process.env.DEVDEN_PORT || 4319);
const HOST = process.env.DEVDEN_HOST || "127.0.0.1";
const ACCESS_TOKEN = String(process.env.DEVDEN_TOKEN || "").trim();
const execFileAsync = promisify(execFile);

/**
 * Workspace roots for the file-explorer endpoints. Starts from the launch
 * directory plus DEVDEN_WORKSPACE_ROOTS; session cwds are added as agents
 * start so saved sessions from other projects stay browsable. Mutations
 * (write/rename/delete/copy/move) and external-app actions are confined to
 * these roots; read-only browsing is confined to the user's home directory.
 */
const workspaceRoots = new Set(defaultWorkspaceRoots());
/**
 * The subset that is infrastructure rather than a workspace: the launch
 * directory and any configured roots. These are never themselves deletable.
 * A session cwd is a workspace you happen to work in, so deleting it from the
 * sessions pane is legitimate and must not be blocked by its own confinement.
 */
const protectedRoots = new Set(defaultWorkspaceRoots());

function addWorkspaceRoot(path) {
  if (typeof path === "string" && path.trim())
    workspaceRoots.add(resolve(path));
}

/** Directories never worth walking for a file picker. */
const SEARCH_SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  // Git worktrees hold a second copy of the whole repo; every file would
  // otherwise show up twice in the picker.
  "worktrees",
]);
const SEARCH_MAX_MATCHES = 40;
const SEARCH_MAX_VISITS = 20000;

/**
 * Breadth-first walk of a workspace root, returning paths that match `query`.
 * Breadth-first so shallow files — the ones a person is most likely to mean —
 * are found before deep ones, and both the match count and the total number of
 * entries visited are capped so a huge tree cannot stall the request.
 */
async function searchWorkspaceFiles(root, query) {
  const matches = [];
  const queue = [root];
  let visits = 0;
  while (queue.length > 0 && matches.length < SEARCH_MAX_MATCHES) {
    const dir = queue.shift();
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory; keep going
    }
    for (const entry of entries) {
      if (++visits > SEARCH_MAX_VISITS)
        return rankSearchMatches(matches, query);
      if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SEARCH_SKIP.has(entry.name)) queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(root, full);
      if (query && !relativePath.toLowerCase().includes(query)) continue;
      matches.push({ path: full, relativePath, name: entry.name });
      if (matches.length >= SEARCH_MAX_MATCHES) break;
    }
  }
  return rankSearchMatches(matches, query);
}

/** Basename hits first, then shallower paths, then alphabetical. */
function rankSearchMatches(matches, query) {
  return matches
    .map((match) => ({
      ...match,
      score:
        (query && match.name.toLowerCase().startsWith(query) ? 0 : 2) +
        (query && match.name.toLowerCase().includes(query) ? 0 : 1),
      depth: match.relativePath.split("/").length,
    }))
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.depth - right.depth ||
        left.relativePath.localeCompare(right.relativePath),
    )
    .slice(0, SEARCH_MAX_MATCHES)
    .map(({ path, relativePath, name }) => ({ path, relativePath, name }));
}

/**
 * Split one file's unified diff into its header and its hunks. A patch that
 * applies only hunk N is the header plus that hunk and nothing else — which is
 * what makes reverting a single hunk possible without touching the others.
 */
function splitDiffHunks(diff) {
  const lines = String(diff ?? "").split("\n");
  const header = [];
  const hunks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current) hunks.push(current);
      current = { header: line, lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
    else header.push(line);
  }
  if (current) hunks.push(current);
  return { header, hunks };
}

function confineWorkspacePath(requested) {
  return confinePath(requested, [...workspaceRoots]);
}

function confineHomePath(requested) {
  return confinePath(requested, [...workspaceRoots, homedir()]);
}

/**
 * One-time auth tickets for browser transports that cannot send headers or
 * cookies (cross-origin EventSource, WebSocket). Minted by /api/auth after a
 * successful token check; consumed by the first request that presents them.
 * Short-lived and single-use, so a ticket that leaks into a log line is
 * worthless to a replay attacker.
 */
const AUTH_TICKETS = new Map();
const AUTH_TICKET_TTL_MS = 30_000;

function mintAuthTicket() {
  const ticket = randomUUID();
  AUTH_TICKETS.set(ticket, Date.now() + AUTH_TICKET_TTL_MS);
  return ticket;
}

function consumeAuthTicket(ticket) {
  if (typeof ticket !== "string" || !ticket) return false;
  const expiresAt = AUTH_TICKETS.get(ticket);
  if (!expiresAt) return false;
  AUTH_TICKETS.delete(ticket);
  return Date.now() < expiresAt;
}

function pruneAuthTickets() {
  const now = Date.now();
  for (const [ticket, expiresAt] of AUTH_TICKETS) {
    if (expiresAt < now) AUTH_TICKETS.delete(ticket);
  }
}

/**
 * Session leases: a page heartbeats the keys of its open conversations and
 * the sweep stops agents whose page went away (tab closed, browser quit).
 * This is the single owner of process lifetime across page refreshes — the
 * old pagehide beacon raced adoptLiveAgent and killed the very process a
 * refresh was supposed to rebind. With leases, a refresh never stops the
 * agent: the new page's /start adopts the live process, and only a page that
 * stops heartbeating (a real close) lets the sweep reap it. A lapsed lease
 * alone does not prove the page is gone — a background tab the browser
 * froze, or a sleeping machine, stops heartbeating while still open — so
 * the sweep spares every live agent (working or idle) for a bounded grace
 * window; the verdict itself lives in lease-sweep.js.
 */
const SESSION_LEASES = new Map();
const LEASE_SWEEP_MS = 60_000;
const LEASE_GRACE = new Map();

function renewLease(sessionKey) {
  SESSION_LEASES.set(sessionKey, Date.now());
}

function sweepExpiredLeases() {
  const now = Date.now();
  for (const [key, lastHeartbeat] of SESSION_LEASES) {
    const backend = sessionBackends.get(key);
    const agent = backend ? poolFor(backend).agents.get(key) : undefined;
    const { reap, deadline } = leaseVerdict({
      lastHeartbeat,
      status: agent?.status,
      now,
      deadline: LEASE_GRACE.get(key),
    });
    if (deadline === undefined) LEASE_GRACE.delete(key);
    else LEASE_GRACE.set(key, deadline);
    if (!reap) continue;
    SESSION_LEASES.delete(key);
    if (!backend) continue;
    poolFor(backend).stop(key);
    sessionBackends.delete(key);
    clearSessionGoal(key);
  }
  for (const key of [...SESSION_LEASES.keys()]) {
    if (!sessionBackends.has(key)) SESSION_LEASES.delete(key);
  }
}

setInterval(sweepExpiredLeases, LEASE_SWEEP_MS).unref();
setInterval(pruneAuthTickets, 60_000).unref();
// Recorded turn diffs older than 30 days, and content nothing points at.
const pruneChangeHistory = () => {
  try {
    pruneChanges();
  } catch (error) {
    logFault("prune-changes", error);
  }
};
pruneChangeHistory();
setInterval(pruneChangeHistory, 6 * 60 * 60_000).unref();

/**
 * Standing goals (/goal): the agent gets a deterministic follow-up check-in
 * when idle — after 30 minutes, then 1h, then every 2h — so a long task does
 * not silently stall. In-memory per session key; /goal off clears it.
 */
const CONVERSATION_GOALS = new Map();
const GOAL_CHECKIN_DELAYS_MS = [30, 60, 120].map((minutes) => minutes * 60_000);
/**
 * Hard stop on the check-in loop. Every check-in is a full turn on the whole
 * conversation, fired hours apart -- always past the prompt-cache TTL, so each
 * one re-bills the entire context at the full input rate. The agent is asked
 * to end the loop itself by saying GOAL DONE, but a model that never says it
 * would otherwise keep spending for as long as the tab stays open. Eight
 * covers ~13h (30m + 1h + 2h x 6) before the user has to re-park the goal.
 */
const MAX_GOAL_CHECKINS = 8;

function clearSessionGoal(sessionKey) {
  const goal = CONVERSATION_GOALS.get(sessionKey);
  if (goal?.timer) clearTimeout(goal.timer);
  CONVERSATION_GOALS.delete(sessionKey);
}

function scheduleGoalCheckIn(sessionKey) {
  const goal = CONVERSATION_GOALS.get(sessionKey);
  if (!goal) return;
  const delay =
    GOAL_CHECKIN_DELAYS_MS[
      Math.min(goal.checkIns, GOAL_CHECKIN_DELAYS_MS.length - 1)
    ];
  goal.timer = setTimeout(() => {
    if (!CONVERSATION_GOALS.has(sessionKey)) return;
    const backend = sessionBackends.get(sessionKey);
    const agent = backend ? poolFor(backend).get(sessionKey) : undefined;
    if (!agent || agent.status === "stopped" || agent.status === "error") {
      CONVERSATION_GOALS.delete(sessionKey);
      return;
    }
    // Counted whether or not the check-in could be sent: the delays are a
    // backoff over elapsed time, and incrementing only on a successful send
    // pinned a session that is busy at every check-in to the 30-minute delay
    // forever -- four times the intended rate, on the longest-running work.
    goal.checkIns += 1;
    if (goal.checkIns > MAX_GOAL_CHECKINS) {
      clearSessionGoal(sessionKey);
      publishRuntimeEvent(sessionKey, "server", {
        type: "notice",
        message: `Standing goal stopped after ${MAX_GOAL_CHECKINS} check-ins without a "GOAL DONE". Re-park it with /goal if it is still live.`,
      });
      return;
    }
    if (agent.status === "ready") {
      void agent
        .followUp(
          `Goal check-in ("${goal.text}"): report progress in one line. If the goal is fully achieved, reply with exactly "GOAL DONE" plus one line of proof; otherwise continue working on it now.`,
        )
        .catch(() => {
          /* re-armed below; the next check-in retries */
        });
    }
    scheduleGoalCheckIn(sessionKey);
  }, delay);
  goal.timer.unref?.();
}

/**
 * Restart the turns that were running when this process's predecessor
 * stopped. The user should not have to ask "did you finish that?" after a
 * deploy, a crash, or the machine being switched off.
 *
 * The agent is resumed on its own session file, so it comes back with the
 * full conversation in context; the follow-up only tells it that the last
 * turn never ended. The conversation key is synthetic because the browser
 * mints a new one on reload -- adoptLiveAgent() rebinds this running agent
 * to whatever key the page comes back with, keyed on the session file, and
 * carries the runtime log across with it, so the restored tab shows the
 * resumed run live.
 */
const MAX_CONCURRENT_RESUMES = 3;

async function resumeInterruptedTurns() {
  const interrupted = takeInterruptedTurns().slice(0, MAX_CONCURRENT_RESUMES);
  for (const entry of interrupted) {
    if (!existsSync(entry.cwd) || !existsSync(entry.sessionPath)) continue;
    const backend = backendName(entry.backend);
    const sessionKey = `resume-${randomUUID()}`;
    const agent = watch(sessionKey, backend);
    // Re-register before the agent starts: if this resume is itself cut
    // short, the attempt counter is what stops a crash loop.
    noteTurnStarted({
      ...entry,
      sessionKey,
      resumeAttempts: Number(entry.resumeAttempts ?? 0) + 1,
    });
    const started = await runLoggedCommand(
      sessionKey,
      "start",
      { cwd: entry.cwd, backend },
      () =>
        agent.start(entry.cwd, {
          sessionPath: entry.sessionPath,
          ...(entry.model ? { model: entry.model } : {}),
          ...(entry.thinkingLevel
            ? { thinkingLevel: entry.thinkingLevel }
            : {}),
        }),
    );
    if (!started.ok) {
      noteTurnSettled(sessionKey);
      continue;
    }
    publishRuntimeEvent(sessionKey, "server", {
      type: "notice",
      sessionKey,
      message:
        "The workbench restarted mid-turn — picking this conversation back up where it stopped.",
    });
    void agent
      .followUp(resumePrompt(entry.message))
      .then(() => {
        // Instructions the user had lined up behind the interrupted turn are
        // part of the work, so they go back into the queue rather than being
        // silently dropped.
        for (const queued of entry.queued ?? [])
          void agent.enqueue?.(queued.message);
      })
      .catch((error) => {
        noteTurnSettled(sessionKey);
        publishRuntimeEvent(sessionKey, "server", {
          type: "notice",
          sessionKey,
          message: `Could not resume the interrupted turn: ${String(error?.message ?? error)}`,
          tone: "error",
        });
      })
      .finally(() => {
        // No lease is taken for a resume key: nothing heartbeats it, and the
        // sweep would reap the agent mid-work. That means cleaning up here
        // instead -- unless a page has adopted the agent by now, in which
        // case adoptLiveAgent has already moved it to the page's own key and
        // this key is gone.
        if (sessionBackends.has(sessionKey)) poolFor(backend).stop(sessionKey);
      });
  }
}

function setSessionGoal(sessionKey, text) {
  if (!text || /^off$/i.test(text)) {
    clearSessionGoal(sessionKey);
    return { ok: true, cleared: true };
  }
  clearSessionGoal(sessionKey);
  CONVERSATION_GOALS.set(sessionKey, { text, checkIns: 0 });
  scheduleGoalCheckIn(sessionKey);
  return { ok: true, text };
}
const BUILD_ID = existsSync(join(DIST, "index.html"))
  ? createHash("sha256")
      .update(readFileSync(join(DIST, "index.html")))
      .digest("hex")
      .slice(0, 12)
  : "dev";

/**
 * One-click deploy (the Deploy button in the conversation header).
 *
 * The server never rebuilds itself: POST /api/deploy spawns scripts/deploy.mjs
 * as a detached process and answers immediately. The deployer (git pull in
 * cloud mode -> npm run build) reports progress only through this state file,
 * then SIGTERMs this process so the supervisor restarts it with fresh code.
 */
const BOOT_MS = Date.now();
const DEPLOY_MODE =
  process.env.DEVDEN_DEPLOY_MODE === "cloud" ? "cloud" : "local";

/**
 * Deploy targets the project the session is working in, not devden. Every
 * deploy fact (state file, git head, dirty count) is therefore per-project:
 * the state file lives beside the project it describes, so two projects
 * deployed from the same workbench never overwrite each other's history.
 * `cwd` is confined to the workspace roots exactly like file access is.
 */
function deployProjectRoot(requested) {
  if (!requested || typeof requested !== "string" || !requested.trim())
    return ROOT;
  // Confined the same way opening a workspace is (roots plus the user's home
  // directory) rather than to the mutation roots: a session's cwd only
  // becomes a mutation root once its agent has started, and the Deploy button
  // has to answer for a tab whose agent is still lazy.
  // A session opened in a subfolder (src/, packages/web) still deploys its
  // project: walk up to the nearest package.json, stopping at home.
  const start = resolve(confineHomePath(requested));
  for (
    let dir = start;
    dir !== homedir() && dir !== dirname(dir);
    dir = dirname(dir)
  ) {
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  return start;
}

/**
 * Does deploying `projectRoot` rebuild the code this server runs? Always for
 * ROOT; also for any devden checkout when the Mac app supervises us — it
 * reads DEVDEN_RELAUNCH_FILE to restart from the freshly built checkout
 * instead of its bundled copy.
 */
function deploysSelf(projectRoot) {
  if (projectRoot === ROOT) return true;
  if (!process.env.DEVDEN_RELAUNCH_FILE) return false;
  try {
    const pkg = JSON.parse(
      readFileSync(join(projectRoot, "package.json"), "utf8"),
    );
    return (
      pkg.name === "devden" &&
      existsSync(join(projectRoot, "server", "index.js"))
    );
  } catch {
    return false;
  }
}

function deployStatePath(projectRoot) {
  return join(projectRoot, ".devden-deploy.json");
}

function readDeployState(projectRoot = ROOT) {
  try {
    return JSON.parse(readFileSync(deployStatePath(projectRoot), "utf8"));
  } catch {
    return null;
  }
}

function writeDeployState(patch, projectRoot = ROOT) {
  const base = readDeployState(projectRoot) || {};
  try {
    writeFileSync(
      deployStatePath(projectRoot),
      JSON.stringify({ ...base, ...patch }, null, 2),
    );
  } catch {
    // Best-effort status reporting; a missing state file just means the UI
    // shows "never deployed".
  }
}

function currentGitHead(projectRoot = ROOT) {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Content signature of the whole working tree: HEAD + status + diff, hashed.
 * The deployer stores this at deploy time, so /api/deploy/status can answer
 * "does the working tree differ from what is running?" — including uncommitted
 * edits, which HEAD alone can't see.
 */
function workingTreeSignature(projectRoot = ROOT) {
  try {
    const out = execSync(
      // `git diff HEAD` skips untracked files, so hash their contents too:
      // editing a new file would otherwise leave the button on "Live".
      "git rev-parse HEAD && git status --porcelain && git diff HEAD && git ls-files -o --exclude-standard -z | xargs -0 git hash-object --",
      {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return createHash("sha256").update(out).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

function uncommittedFileCount(projectRoot = ROOT) {
  try {
    const out = execSync("git status --porcelain", {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .toString()
      .trim();
    return out ? out.split("\n").length : 0;
  } catch {
    return null;
  }
}

const piPool = new PiAgentPool();
const claudePool = new ClaudeAgentPool();
const grokPool = new GrokAgentPool();
const codexPool = new CodexAgentPool();
const POOLS = {
  pi: piPool,
  claude: claudePool,
  grok: grokPool,
  codex: codexPool,
};
/** @type {Map<string, 'pi' | 'claude'>} */
const sessionBackends = new Map();
/**
 * Old tab key → current key, after adoptLiveAgent rebinds a live agent to a
 * refreshed page's key. Events are re-broadcast under aliases so the page
 * that lost the agent keeps receiving its in-flight turn instead of sitting
 * frozen on a “running” card until it manually refreshes; watch() resolves
 * aliases so the old page's commands still reach the live process rather
 * than spawning a duplicate.
 */
const KEY_ALIASES = new Map();

function resolveSessionKey(sessionKey) {
  let resolved = sessionKey;
  for (let hops = 0; hops < 10; hops += 1) {
    const next = KEY_ALIASES.get(resolved);
    if (!next) break;
    resolved = next;
  }
  return resolved;
}
/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set();
/**
 * WebSocket twin of the SSE fan-out. Cloudflare quick tunnels do not support
 * SSE (documented limitation — the edge buffers text/event-stream bodies),
 * but they pass WebSockets cleanly, so /remote clients connect here instead.
 * @type {Set<import('ws').WebSocket>}
 */
const eventSockets = new Set();
/** @type {Map<string, Array<{ id: string, timestamp: number, source: string, type: string, payload: object }>>} */
const runtimeLogs = new Map();
const MAX_RUNTIME_LOG_ENTRIES = 25_000;
const MAX_RUNTIME_LOG_TOTAL = 100_000;
let runtimeLogTotal = 0;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function broadcast(event) {
  // Stringified once for the whole fan-out, but inside a guard: an agent's tool
  // result can carry anything (a cycle, a BigInt), and this runs on the agent's
  // event path with no handler above it -- one such event used to throw out of
  // here and take the server down mid-turn, which loses the in-flight events
  // and freezes every open page on stuck tool cards until a manual refresh.
  let line;
  let json;
  try {
    json = JSON.stringify(event);
    line = `data: ${json}\n\n`;
  } catch (error) {
    // Named, because a silently dropped event is the exact failure mode this
    // guard exists to survive -- and the only trace of it.
    logFault("unstringifiable event", event?.type, error);
    return;
  }
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      /* dropped */
    }
  }
  for (const socket of eventSockets) {
    try {
      socket.send(json);
    } catch {
      /* dropped */
    }
  }
}

// Heartbeat so a client can tell an idle stream from a half-open socket
// (sleep/wake, a proxy dropping the connection without a reset) and reconnect
// when the beats stop. Carries no sessionKey, so the UI ignores it.
setInterval(() => broadcast({ type: "__ping" }), 10_000).unref();

// Server-owned terminal tabs for agent-launched long-running commands
// (run_in_terminal / read_terminal tools). Lifecycle events go through the
// runtime log so a refreshed page can see open tabs; output chunks stream
// live but are not logged — they would evict real turn events from the log.
const terminalTabs = createTerminalTabs({
  onEvent: (event) => {
    if (event.type === "terminal_output") broadcast(event);
    else publishRuntimeEvent(event.sessionKey, "pi", event);
  },
});

function logPayload(event) {
  if (event && typeof event === "object" && !Array.isArray(event)) return event;
  return { value: event };
}

function recordRuntimeEvent(sessionKey, source, event) {
  const entry = {
    id: randomUUID(),
    timestamp: Date.now(),
    source,
    type: String(event?.type ?? "unknown"),
    payload: logPayload(event),
  };
  const entries = runtimeLogs.get(sessionKey) ?? [];
  entries.push(entry);
  if (entries.length > MAX_RUNTIME_LOG_ENTRIES)
    entries.splice(0, entries.length - MAX_RUNTIME_LOG_ENTRIES);
  runtimeLogs.set(sessionKey, entries);
  runtimeLogTotal += 1;
  // Hard global bound: many session keys must not grow memory without limit.
  while (runtimeLogTotal > MAX_RUNTIME_LOG_TOTAL) {
    let largestKey;
    let largest = 0;
    for (const [key, log] of runtimeLogs) {
      if (log.length > largest) {
        largest = log.length;
        largestKey = key;
      }
    }
    if (!largestKey) break;
    const log = runtimeLogs.get(largestKey);
    const drop = Math.max(1, Math.ceil(log.length / 2));
    log.splice(0, drop);
    runtimeLogTotal -= drop;
    if (log.length === 0) runtimeLogs.delete(largestKey);
  }
  return entry;
}

function publishRuntimeEvent(sessionKey, source, event) {
  trackTurnLifecycle(sessionKey, event);
  const entry = recordRuntimeEvent(sessionKey, source, event);
  const payload = {
    ...event,
    sessionKey,
    __logId: entry.id,
    __loggedAt: entry.timestamp,
    __logSource: source,
  };
  broadcast(payload);
  // Alias keys: pages that owned this agent before an adoption keep their
  // transcripts live under the key they know.
  for (const [alias, target] of KEY_ALIASES) {
    if (target !== sessionKey) continue;
    broadcast({ ...payload, sessionKey: alias });
  }
  // The check-in prompt asks the agent to end a standing goal by replying
  // GOAL DONE, but nothing read it, so a goal that was achieved kept billing
  // a full-context turn every two hours. Checked here because every backend's
  // events pass through this one funnel.
  if (
    // The completed assistant message lands on message_end for pi/Claude/Grok
    // and on turn_end for Codex.
    (event?.type === "message_end" || event?.type === "turn_end") &&
    event.message?.role === "assistant" &&
    CONVERSATION_GOALS.has(sessionKey) &&
    assistantText(event.message).includes("GOAL DONE")
  ) {
    clearSessionGoal(sessionKey);
    publishRuntimeEvent(sessionKey, source, {
      type: "notice",
      message: "Goal reported done — standing check-ins stopped.",
    });
  }
  return entry;
}

// Set while the process is tearing down, so the "stopped" events our own
// shutdown produces are not mistaken for abandoned turns.
let shuttingDown = false;

/**
 * Mirror a turn's lifecycle into the crash-durable record. Every backend
 * funnels its events through publishRuntimeEvent, so this is the one place
 * that sees a turn start, learn its session file, and end -- whichever
 * adapter produced it.
 */
function trackTurnLifecycle(sessionKey, event) {
  trackTurnChanges(sessionKey, event);
  switch (event.type) {
    case "state":
      noteTurnContext(sessionKey, {
        sessionPath: event.state?.sessionFile,
        cwd: event.state?.cwd,
        model: event.state?.model ?? undefined,
        thinkingLevel: event.state?.thinkingLevel,
      });
      return;
    case "queue_updated":
      // Queued prompts are part of the work in flight: dropping them on a
      // restart loses instructions the user already gave.
      noteTurnContext(sessionKey, { queued: event.queued ?? [] });
      return;
    case "agent_settled":
    case "agent_end":
      noteTurnSettled(sessionKey);
      return;
    case "__status":
      // A stopped agent normally means the user closed the tab and the lease
      // sweep reaped it -- that turn is abandoned, not interrupted. During
      // our own shutdown the same event means the opposite, so the record
      // must survive it: that is precisely the case this exists for.
      if (
        event.status === "error" ||
        (event.status === "stopped" && !shuttingDown)
      )
        noteTurnSettled(sessionKey);
      return;
    default:
  }
}

/**
 * Same funnel, for changes.js: which files each turn changed. A queued
 * prompt starts its turn without /prompt, so agent_start opens one too
 * (beginTurn ignores a turn that is already open).
 */
function trackTurnChanges(sessionKey, event) {
  try {
    switch (event.type) {
      case "state":
        noteSessionContext(sessionKey, {
          cwd: event.state?.cwd,
          sessionPath: event.state?.sessionFile,
        });
        return;
      case "agent_start":
        noteSessionActivity(sessionKey);
        beginTurn({ sessionKey, takeSnapshot });
        return;
      case "tool_execution_start":
        beginTurn({ sessionKey, takeSnapshot });
        noteToolCall(sessionKey, event.toolName, event.args);
        return;
      case "agent_settled":
      case "agent_end":
        void endTurn(sessionKey);
        return;
      case "__status":
        if (event.status === "error" || event.status === "stopped")
          void endTurn(sessionKey);
        return;
      default:
    }
  } catch (error) {
    // Change history is a convenience; it never gets to break a turn.
    logFault("track-changes", error);
  }
}

function commandMetadata(body) {
  const metadata = {};
  if (body && typeof body.cwd === "string") metadata.cwd = body.cwd;
  if (body && typeof body.backend === "string")
    metadata.backend = backendName(body.backend);
  if (body && typeof body.message === "string") metadata.message = body.message;
  if (body?.model && typeof body.model === "object") {
    metadata.model = {
      provider: body.model.provider,
      id: body.model.id,
    };
  }
  if (body && Array.isArray(body.images)) {
    metadata.images = body.images.map((image) => ({
      type: image?.type,
      mimeType: image?.mimeType,
      attached: Boolean(image?.data),
    }));
  }
  return metadata;
}

async function runLoggedCommand(sessionKey, action, body, run) {
  const requestId = randomUUID();
  publishRuntimeEvent(sessionKey, "server", {
    type: "backend_request",
    requestId,
    action,
    payload: commandMetadata(body),
  });
  let result;
  try {
    result = await run();
  } catch (error) {
    result = { ok: false, error: String(error?.message ?? error) };
  }
  publishRuntimeEvent(sessionKey, "server", {
    type: "backend_response",
    requestId,
    action,
    ok: Boolean(result?.ok),
    ...(result?.error ? { error: result.error } : {}),
    ...(result?.data === undefined ? {} : { data: result.data }),
    ...(result?.state === undefined ? {} : { state: result.state }),
    ...(Array.isArray(result?.messages)
      ? { messageCount: result.messages.length }
      : {}),
  });
  return result;
}

function sessionPathOf(agent) {
  return agent?.sessionFile ?? agent?.lastState?.sessionFile ?? "";
}

async function rawAgentMessages(agent) {
  try {
    const messages = await agent.getMessages();
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

async function clientMessages(agent, sessionPath = sessionPathOf(agent)) {
  return withDisplayHistory(sessionPath, await rawAgentMessages(agent));
}

// Fan every pool event out to all SSE clients (events carry their sessionKey).

// This was previously sent to the active model as ordinary text when it was
// entered in the composer. It is a display-only shortcut, though: forwarding
// it starts an unnecessary agent turn (and a stale client can keep doing so).
function isUsageShortcut(message, images) {
  return (
    !images?.length &&
    /^\/(?:grok-cli-usage|grok-usage)$/i.test(String(message ?? "").trim())
  );
}

function poolFor(backend) {
  return POOLS[backendName(backend)] ?? piPool;
}

/** Session files whose agent is mid-turn — inflight records plus any live
 *  process that still says it is streaming, so the sidebar can blink every
 *  running row even when that session is not an open tab. */
function streamingSessionPaths() {
  const paths = new Set(runningSessionPaths());
  for (const name of allBackendIds()) {
    const pool = poolFor(name);
    for (const agent of pool.agents.values()) {
      // A dead agent is not streaming, whatever it last believed. `status`
      // and `lastState` live on the agent object and outlive its child, so a
      // process that was killed, crashed, or got lease-swept mid-turn kept
      // painting its session amber in the sidebar until the whole server
      // restarted — sessions glowing "running" with no child process behind
      // them at all.
      if (!agentIsAlive(agent)) continue;
      const streaming =
        agent.status === "working" || agent.lastState?.isStreaming === true;
      if (!streaming) continue;
      const path = agent.sessionFile ?? agent.lastState?.sessionFile;
      if (path) paths.add(path);
    }
  }
  return paths;
}

/**
 * Claude-style session titles for Pi sessions: after the first prompt, a
 * short-lived ephemeral pi process summarizes it into a concise title, which
 * is persisted via set_session_name (a session_info entry the sidebar already
 * reads). Best-effort and fire-and-forget — failures leave the prompt-derived
 * fallback in place.
 */
const piTitleInFlight = new Set();

/**
 * Resolves when the agent's current turn ends. The listener is attached by the
 * caller *before* any await, so a turn that settles while the title is being
 * generated is never missed. `agent.status` is not a reliable idle check right
 * after a prompt is dispatched (the RPC acks before agent_start arrives), so
 * an early exit is only taken on a state read that says the agent is idle.
 */
function whenTurnSettles(agent, isSettled, waiters) {
  if (isSettled()) return Promise.resolve();
  return new Promise((resolve) => {
    // unref'd: a pending title write must never hold the server open.
    const timer = setTimeout(resolve, 20 * 60_000);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    waiters.add(done);
    void agent
      .getState()
      .then((state) => {
        if (!state?.isStreaming) {
          waiters.delete(done);
          done();
        }
      })
      .catch(() => {});
  });
}

/**
 * Two separate steps, because they have opposite timing needs:
 *
 *  - Generating the title is a bare, ephemeral pi process that never touches
 *    the live agent, so it runs immediately and the UI is relabelled the
 *    moment it lands (a couple of seconds), while the turn keeps streaming.
 *  - Persisting it is a set_session_name RPC *on the live process*. Issuing
 *    that mid-stream raced the running turn (it could stop sibling sessions
 *    or leave the new one stuck "thinking"), so the write waits for the turn
 *    to settle.
 */
function maybeGeneratePiTitle(sessionKey, agent, message) {
  if (piTitleInFlight.has(sessionKey)) return;
  piTitleInFlight.add(sessionKey);
  let settled = false;
  const waiters = new Set();
  // Attached synchronously: a turn that ends during generation still counts.
  const off = agent.onEvent((event) => {
    if (event.type !== "agent_settled") return;
    settled = true;
    for (const resolve of waiters) resolve();
    waiters.clear();
  });
  void (async () => {
    try {
      // Always read fresh state: lastState is not updated by set_session_name,
      // so a second prompt would otherwise regenerate (and overwrite) the title.
      const state = await agent.getState();
      if (state?.sessionName) return;
      const title = await generateSessionTitle(message, state?.model);
      if (!title) return;
      // Publish first: the label updates in the background, independently of
      // when (or whether) the write to the session file succeeds.
      publishRuntimeEvent(sessionKey, "pi", {
        type: "session_title_set",
        title,
      });
      await whenTurnSettles(agent, () => settled, waiters);
      await agent.setSessionName(title);
    } catch {
      /* title generation is best-effort */
    } finally {
      off();
      waiters.clear();
      piTitleInFlight.delete(sessionKey);
    }
  })();
}

/**
 * A page refresh re-opens saved sessions under fresh tab keys. If a process
 * is already live for the same session file, rebind it to the new key
 * instead of spawning a duplicate — otherwise the original run keeps
 * streaming invisibly in the background and both processes append to the
 * same session file. Returns the adopted agent, if any.
 */
function adoptLiveAgent(sessionKey, backend, sessionPath) {
  if (!sessionPath) return undefined;
  const pool = poolFor(backendName(backend));
  for (const [key, candidate] of pool.agents) {
    if (key === sessionKey) continue;
    if (!candidate.process) continue;
    const candidateFile =
      candidate.sessionFile ?? candidate.lastState?.sessionFile;
    if (candidateFile !== sessionPath) continue;
    if (candidate.status === "stopped" || candidate.status === "error")
      continue;
    pool.agents.delete(key);
    pool.agents.set(sessionKey, candidate);
    candidate.sessionKey = sessionKey;
    sessionBackends.delete(key);
    // Keep the abandoned page's key alive as an alias: its events still
    // fan out under it and its commands resolve here, so a second tab (or
    // a stray page) opening this session can't freeze the first one.
    for (const [alias, target] of KEY_ALIASES) {
      if (target === key) KEY_ALIASES.set(alias, sessionKey);
    }
    KEY_ALIASES.set(key, sessionKey);
    // The lease belongs to the conversation, not the tab: carry it to the
    // adopting key so the sweep does not reap a freshly refreshed session.
    const lease = SESSION_LEASES.get(key);
    if (lease) {
      SESSION_LEASES.delete(key);
      SESSION_LEASES.set(sessionKey, lease);
    }
    // The interrupted-turn record belongs to the conversation too. Left on
    // the abandoned key it never settles, so every restart resumed a turn
    // that had already finished -- and that resume held the turn slot, so
    // the next thing the user typed was rejected as "already in progress".
    rekeySession(key, sessionKey);
    rekeyChanges(key, sessionKey);
    // The runtime event log belongs to the conversation too — carry it over
    // so /api/<newKey>/log includes the in-flight turn's pre-reload events
    // (needed to replay the live run after a page refresh). Entry counts
    // move, they are not duplicated, so the global budget is unchanged.
    const previousLog = runtimeLogs.get(key);
    if (previousLog && previousLog.length > 0) {
      runtimeLogs.delete(key);
      const currentLog = runtimeLogs.get(sessionKey) ?? [];
      runtimeLogs.set(
        sessionKey,
        [...previousLog, ...currentLog].sort(
          (left, right) => left.timestamp - right.timestamp,
        ),
      );
    }
    // A parked goal belongs to the conversation, not the browser tab.
    const goal = CONVERSATION_GOALS.get(key);
    if (goal) {
      clearSessionGoal(key);
      CONVERSATION_GOALS.set(sessionKey, goal);
      scheduleGoalCheckIn(sessionKey);
    }
    return candidate;
  }
  return undefined;
}


function watch(sessionKey, requestedBackend, bind = true) {
  // An adopted-away key still routes here (old tab sending a command):
  // resolve to the live agent instead of spawning a duplicate process.
  sessionKey = resolveSessionKey(sessionKey) ?? sessionKey;
  const backend =
    requestedBackend === undefined
      ? (sessionBackends.get(sessionKey) ?? "pi")
      : backendName(requestedBackend);
  // Catalog reads (model list, thinking levels) must not retarget the
  // session. A picker prefetch used to land here and leave the next prompt
  // on whichever agent was listed last.
  if (bind) sessionBackends.set(sessionKey, backend);
  const agent = poolFor(backend).get(sessionKey);
  if (!bind) {
    agent.__watchedBackend ??= backend;
    return agent;
  }
  // Rebind rather than register once: adoptLiveAgent moves a running process
  // to the refreshed page's key, and a listener still closed over the old key
  // published the whole in-flight turn under a key no client is listening on
  // — the reloaded page sat frozen on its restored snapshot until the turn
  // ended. Re-registering keeps exactly one publisher, on the current key.
  if (agent.__watchedKey !== sessionKey || agent.__watchedBackend !== backend) {
    agent.__unwatch?.();
    agent.__watchedKey = sessionKey;
    agent.__watchedBackend = backend;
    agent.__unwatch = agent.onEvent((event) => {
      // A throw here escapes into the agent's own event pump, where nothing
      // catches it, and an uncaught throw ends the process. Swallow it as a
      // dropped event instead: one bad payload is not worth a dead server.
      try {
        trackAskPending(agent, event);
        publishRuntimeEvent(sessionKey, backend, event);
      } catch (error) {
        logFault("dropped event", event?.type, error);
      }
    });
  }
  return agent;
}

/**
 * Whether a settled turn ended by asking the user something (an ```ask fence
 * in its final assistant reply). While set, the queue holds typed prompts so
 * a follow-up typed before the answer cannot replace the pending question —
 * the answer goes first, and the answer turn's settle flushes the queue.
 * Cleared the moment any turn starts, so a fork/check-in/auto-resume cannot
 * strand the hold. Event shapes per backend mirror the GOAL DONE check in
 * publishRuntimeEvent: message_end (pi/Claude/Grok), turn_end (Codex).
 */
function trackAskPending(agent, event) {
  if (event?.type === "agent_start") {
    agent.askPending = false;
    return;
  }
  if (
    (event?.type === "message_end" || event?.type === "turn_end") &&
    event.message?.role === "assistant"
  ) {
    agent.askPending = hasAskBlock(assistantText(event.message));
  }
}

function isAllowedOrigin(origin) {
  return allowedOrigin(
    origin, process.env.DEVDEN_UI_ORIGIN, getRemoteTunnel()?.url,
  );
}

function corsHeaders(req) {
  const origin = String(req.headers.origin || "");
  if (!isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    // Only granted to allowlisted origins (the legit hosted UI). This is what
    // lets Chrome's Private Network Access gate public->localhost requests:
    // an attacker's page gets no CORS headers at all, so the browser blocks it.
    "Access-Control-Allow-Private-Network": "true",
    Vary: "Origin",
  };
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    ...corsHeaders(res.req || { headers: {} }),
  });
  res.end(data);
}

async function readBody(req) {
  let text = "";
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new BodyTooLargeError();
    text += chunk;
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large.");
    this.statusCode = 413;
  }
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;

function serveStatic(res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const abs = join(DIST, filePath);
  // Trailing-separator check: a sibling "dist-anything" directory must not be
  // served as if it were the build output.
  if (
    !abs.startsWith(DIST + sep) ||
    !existsSync(abs) ||
    !statSync(abs).isFile()
  ) {
    // SPA fallback
    const index = join(DIST, "index.html");
    if (existsSync(index)) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
        Pragma: "no-cache",
      });
      res.end(readFileSyncSafe(index));
      return;
    }
    res.writeHead(404);
    res.end("Not found (run npm run build)");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(abs)] ?? "application/octet-stream",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
  });
  res.end(readFileSyncSafe(abs));
}

function readFileSyncSafe(p) {
  try {
    return readFileSync(p);
  } catch {
    return "";
  }
}

// Git operations the UI is allowed to run. Anything outside this set falls
// back to `push`; anything user-typed (branch name, stash ref, file paths) is
// pattern-validated before it reaches argv.
const GIT_WRITE_OPS = new Set([
  "push",
  "pull",
  "pull-rebase",
  "fetch",
  "commit",
  "commit-push",
  "stash",
  "stash-apply",
  "stash-pop",
  "stash-drop",
  "branch-create",
  "branch-switch",
  "pr",
  "undo-commit",
  "continue",
  "abort",
]);

/**
 * Which half-finished operation the repo is sitting in. git records these as
 * marker files in the git dir; until one is concluded, an ordinary commit
 * would bake the working tree (conflict markers included) into history.
 */
function gitStateFromDir(gitDir) {
  const marker = (name) => Boolean(gitDir) && existsSync(join(gitDir, name));
  if (marker("MERGE_HEAD")) return "merging";
  if (marker("rebase-merge") || marker("rebase-apply")) return "rebasing";
  if (marker("CHERRY_PICK_HEAD")) return "cherry-picking";
  if (marker("REVERT_HEAD")) return "reverting";
  return "clean";
}

async function gitProgressState(dir) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "rev-parse", "--absolute-git-dir"],
      { timeout: 10_000 },
    );
    return gitStateFromDir(String(stdout).trim());
  } catch {
    return "clean";
  }
}

/** git check-ref-format's rules, tightened: no globs, no leading dash. */
function isSafeBranchName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 200 &&
    /^[A-Za-z0-9._/+-]+$/.test(name) &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//")
  );
}

const MAX_WORKSPACE_FILE_BYTES = 1_048_576;
const MAX_WORKSPACE_WRITE_BYTES = 2_097_152;
const MAX_WORKSPACE_ENTRIES = 2_000;
const HEAVY_WORKSPACE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "DerivedData",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".turbo",
  ".cache",
  "Pods",
]);
const HEAVY_WORKSPACE_ENTRIES = 80;
const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "bmp",
  "psd",
  "ai",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "tar",
  "bz2",
  "7z",
  "rar",
  "xz",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "mov",
  "webm",
  "wav",
  "ogg",
  "flac",
  "m4a",
  "avi",
  "mkv",
  "dmg",
  "pkg",
  "exe",
  "dll",
  "so",
  "dylib",
  "class",
  "jar",
  "wasm",
  "bin",
  "dat",
  "o",
  "a",
  "pyc",
  "pyo",
]);

function workspaceIoError(error, kind) {
  const code = error?.code;
  if (code === "ENOENT")
    return kind === "file"
      ? "That file does not exist."
      : "That directory does not exist.";
  if (code === "EACCES")
    return kind === "file"
      ? "Pi cannot read that file."
      : "Pi cannot read that directory.";
  if (code === "EISDIR") return "That path is a directory.";
  return String(error?.message ?? error);
}

async function listWorkspace(requested) {
  const path = resolve(requested);
  const info = await stat(path);
  if (!info.isDirectory())
    return { ok: false, error: "That path is not a directory." };
  const dirents = await readdir(path, { withFileTypes: true });
  const heavy = HEAVY_WORKSPACE_DIRS.has(basename(path));
  const limit = heavy ? HEAVY_WORKSPACE_ENTRIES : MAX_WORKSPACE_ENTRIES;
  const entries = [];
  for (const entry of dirents) {
    if (entries.length >= limit) break;
    let type = entry.isDirectory()
      ? "directory"
      : entry.isFile()
        ? "file"
        : null;
    if (!type && entry.isSymbolicLink()) {
      try {
        const target = await stat(join(path, entry.name));
        type = target.isDirectory()
          ? "directory"
          : target.isFile()
            ? "file"
            : null;
      } catch {
        continue;
      }
    }
    if (!type) continue;
    entries.push({
      name: entry.name,
      path: join(path, entry.name),
      type,
      hidden: entry.name.startsWith("."),
    });
  }
  entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
  });
  return {
    ok: true,
    path,
    parent: path === dirname(path) ? null : dirname(path),
    truncated: dirents.length > entries.length,
    entries,
  };
}

async function readWorkspaceFile(requested) {
  const path = resolve(requested);
  const info = await stat(path);
  if (info.isDirectory())
    return { ok: false, error: "That path is a directory." };
  if (!info.isFile()) return { ok: false, error: "That path is not a file." };
  const name = basename(path);
  const extension = extname(path).slice(1).toLowerCase();
  if (BINARY_EXTENSIONS.has(extension)) {
    return { ok: true, path, name, binary: true, size: info.size };
  }
  const file = await openFile(path, "r");
  try {
    const length = Math.min(info.size, MAX_WORKSPACE_FILE_BYTES);
    const buffer = Buffer.alloc(Number(length));
    const { bytesRead } = await file.read(buffer, 0, Number(length), 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0))
      return { ok: true, path, name, binary: true, size: info.size };
    return {
      ok: true,
      path,
      name,
      content: slice.toString("utf8"),
      size: info.size,
      truncated: info.size > bytesRead,
    };
  } finally {
    await file.close();
  }
}

function uniqueDestination(directory, name) {
  const dest = join(directory, name);
  if (!existsSync(dest)) return dest;
  const extension = extname(name);
  const stem = basename(name, extension);
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = join(directory, `${stem} ${index}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(directory, `${stem}-${Date.now()}${extension}`);
}

async function writeWorkspaceFile(requested, content) {
  const path = resolve(requested);
  if (typeof content !== "string")
    return { ok: false, error: "Missing file contents." };
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_WORKSPACE_WRITE_BYTES)
    return { ok: false, error: "That file is too large to save here." };
  if (existsSync(path)) {
    const info = await stat(path);
    if (info.isDirectory())
      return { ok: false, error: "That path is a directory." };
  } else {
    await mkdir(dirname(path), { recursive: true });
  }
  await writeFile(path, content, "utf8");
  return { ok: true, path, name: basename(path), size: bytes };
}

async function renameWorkspacePath(requested, nextName) {
  const path = resolve(requested);
  const name = String(nextName ?? "").trim();
  if (
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".."
  ) {
    return { ok: false, error: "Enter a valid name." };
  }
  const to = join(dirname(path), name);
  if (to === path) return { ok: true, path, name };
  if (existsSync(to))
    return { ok: false, error: "Something already has that name." };
  await rename(path, to);
  return { ok: true, path: to, name, from: path };
}

async function deleteWorkspacePath(requested) {
  const path = resolve(requested);
  if (path === "/" || path === homedir() || protectedRoots.has(path))
    return { ok: false, error: "That path cannot be deleted." };
  await rm(path, { recursive: true, force: true });
  return { ok: true, path };
}

async function transferWorkspacePath(requested, destinationDir, mode) {
  const path = resolve(requested);
  const directory = resolve(destinationDir);
  const info = await stat(directory);
  if (!info.isDirectory())
    return { ok: false, error: "That destination is not a folder." };
  if (directory === path || directory.startsWith(`${path}/`)) {
    return { ok: false, error: "Cannot move a folder into itself." };
  }
  const to = uniqueDestination(directory, basename(path));
  if (mode === "move") await rename(path, to);
  else await cp(path, to, { recursive: true });
  return { ok: true, path: to, name: basename(to), from: path };
}

const MAC_APPS = [
  { id: "Visual Studio Code", label: "Visual Studio Code" },
  { id: "Cursor", label: "Cursor" },
  { id: "Zed", label: "Zed" },
  { id: "TextEdit", label: "TextEdit" },
  { id: "Sublime Text", label: "Sublime Text" },
  { id: "iTerm", label: "iTerm" },
];

function listWorkspaceApps() {
  if (process.platform !== "darwin")
    return [{ id: "default", label: "Default App" }];
  return [
    { id: "default", label: "Default App" },
    ...MAC_APPS.filter((app) => existsSync(`/Applications/${app.id}.app`)),
  ];
}

async function revealWorkspacePath(requested) {
  const path = resolve(requested);
  if (process.platform === "darwin") await execFileAsync("open", ["-R", path]);
  else if (process.platform === "linux")
    await execFileAsync("xdg-open", [dirname(path)]);
  else await execFileAsync("explorer", ["/select,", path.replace(/\//g, "\\")]);
  return { ok: true, path };
}

async function openWorkspacePath(requested, app) {
  const path = resolve(requested);
  if (process.platform === "darwin") {
    // Only apps the server itself advertises may be launched; a client-supplied
    // app name would otherwise let any caller launch arbitrary applications.
    const knownApp =
      app && MAC_APPS.some((candidate) => candidate.id === app)
        ? app
        : undefined;
    if (knownApp) await execFileAsync("open", ["-a", knownApp, path]);
    else await execFileAsync("open", [path]);
  } else if (process.platform === "linux") {
    await execFileAsync("xdg-open", [path]);
  } else {
    await execFileAsync("cmd", ["/c", "start", "", path]);
  }
  return { ok: true, path };
}

async function openWorkspaceTerminal(requested) {
  const path = resolve(requested);
  const info = await stat(path);
  const folder = info.isDirectory() ? path : dirname(path);
  if (process.platform === "darwin")
    await execFileAsync("open", ["-a", "Terminal", folder]);
  else if (process.platform === "linux")
    await execFileAsync("xdg-open", [folder]);
  else await execFileAsync("cmd", ["/c", "start", "", folder]);
  return { ok: true, path: folder };
}

/**
 * Every token that currently grants access: the static env token plus the
 * rotating one minted by `/remote` while a tunnel is up. The tunnel token is
 * revoked the moment the tunnel stops.
 */
function accessTokens() {
  const tunnel = getRemoteTunnel();
  return [ACCESS_TOKEN, tunnel?.token].filter(Boolean);
}

function requestHasAccess(req, url) {
  return hasAccess(
    req, url, ACCESS_TOKEN, getRemoteTunnel()?.token, consumeAuthTicket,
  );
}

function denyAccess(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="devden"',
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(res.req || { headers: {} }),
  });
  res.end("Unauthorized");
}

/**
 * `npm run build` for the /remote tunnel's first run — the phone needs dist/.
 * Only ever triggered by /api/remote/start when dist/index.html is missing,
 * so a user who has never built still gets a working phone UI.
 */
function buildDist() {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", "build"], {
      cwd: ROOT,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        ok: false,
        error: "npm run build timed out after 10 minutes.",
      });
    }, 600_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(
        code === 0
          ? { ok: true }
          : {
              ok: false,
              error: `npm run build failed (exit ${code}):
${output.split("\n").slice(-8).join("\n")}`,
            },
      );
    });
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { ok: false, error: "Malformed URL." });
  }

  // A first load from the /remote QR carries the tunnel token in the query.
  // Swap it for the 7-day cookie and redirect to the clean URL so the token
  // never lingers in the phone's address bar or history.
  const qrTunnel = getRemoteTunnel();
  if (qrTunnel && url.searchParams.get("token") === qrTunnel.token) {
    res.writeHead(302, {
      "Set-Cookie": `devden-token=${qrTunnel.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`,
      Location: pathname,
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  if (pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      version: "0.1.0",
      buildId: BUILD_ID,
      bootMs: BOOT_MS,
      pid: process.pid,
      cwd: process.cwd(),
    });
  }

  if (pathname === "/api/auth" && req.method === "POST") {
    if (!accessTokens().length)
      return sendJson(res, 200, { ok: true, enabled: false });
    const body = await readBody(req);
    const header = String(req.headers.authorization || "");
    const headerToken = header.startsWith("Bearer ") ? header.slice(7) : "";
    const candidate = typeof body.token === "string" ? body.token : headerToken;
    const matched = accessTokens().find((token) => token === candidate);
    if (!candidate || !matched) return denyAccess(res);
    const ticket = mintAuthTicket();
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
      ...corsHeaders(req),
    };
    // HttpOnly cookie so same-origin EventSource/WebSocket authenticate without
    // exposing the token to script. Only set when the token is a safe cookie
    // value; otherwise the client relies on the ticket + Authorization header.
    if (/^[A-Za-z0-9._-]+$/.test(matched)) {
      headers["Set-Cookie"] =
        `devden-token=${matched}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, ticket }));
    return;
  }

  // Serve the local login page, but protect every API action when a token is set.
  if (
    (pathname.startsWith("/api/") || !isLoopbackRequest(req)) &&
    !requestHasAccess(req, url)
  )
    return denyAccess(res);

  if (pathname === "/api/backends" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, backends: await listBackends() });
  }

  if (pathname === "/api/backends/recheck" && req.method === "POST") {
    clearDetectionCache();
    return sendJson(res, 200, { ok: true, backends: await listBackends() });
  }

  if (pathname === "/api/harness-updates" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, updates: await readHarnessUpdates() });
  }

  if (pathname === "/api/harness-updates/run" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const result = await runHarnessUpdate(String(body.id));
      clearModelCatalogs();
      for (const pool of Object.values(POOLS))
        for (const agent of pool.agents.values()) agent.modelCatalog = undefined;
      return sendJson(res, 200, {
        ok: true,
        ...result,
      });
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        error: String(error?.message || error),
        log: error?.log,
        cmd: error?.cmd,
      });
    }
  }

  if (pathname === "/api/onboarding" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, ...readSetup() });
  }

  if (pathname === "/api/onboarding" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, { ok: true, ...writeSetup(body) });
  }

  /** The mac-native folder picker. A browser file input can never return an
   *  absolute path, so the local server opens osascript's `choose folder`
   *  and hands back the POSIX path. ponytail: darwin-only; add a zenity
   *  branch when somebody races from a Linux host. */
  if (pathname === "/api/pick-directory" && req.method === "POST") {
    const body = await readBody(req);
    const prompt = String(body.prompt || "Choose a folder").slice(0, 200);
    if (process.platform !== "darwin")
      return sendJson(res, 200, {
        ok: false,
        canceled: true,
        error: "Native folder dialogs need macOS.",
      });
    try {
      const { stdout } = await execFileAsync(
        "osascript",
        [
          "-e",
          `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`,
        ],
        { timeout: 120_000 },
      );
      // POSIX path of a folder ends in a slash; cwd-style paths want it off.
      const path = String(stdout).trim().replace(/\/+$/, "") || "/";
      return sendJson(res, 200, { ok: true, path });
    } catch (error) {
      const message = String(error?.stderr || error?.message || error);
      if (/cancel/i.test(message))
        return sendJson(res, 200, { ok: false, canceled: true });
      return sendJson(res, 200, { ok: false, error: message });
    }
  }

  if (pathname === "/api/attention" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      pendingApprovals: countPendingApprovals(POOLS),
    });
  }

  if (pathname === "/api/usage" && req.method === "GET") {
    // Account-level quota for every backend at once — the status footer and
    // the model picker's agent bars. pi has no account of its own: its quota
    // is whichever provider backs a live session, so answer from a live
    // agent when one exists; the cold probe just reports "unavailable".
    const usage = {};
    await Promise.all(
      AGENT_BACKENDS.map(async (backend) => {
        const pool = poolFor(backend);
        let agent = null;
        if (backend === "pi") {
          for (const candidate of pool.agents.values())
            if (candidate.lastState) {
              agent = candidate;
              break;
            }
        }
        agent ??= pool.get("__usage__");
        const result = await agent.getUsage().catch((error) => ({
          ok: false,
          error: String(error?.message ?? error),
        }));
        usage[backend] = result?.ok ? result.usage : { available: false };
        return usage[backend];
      }),
    );
    return sendJson(res, 200, { ok: true, usage });
  }

  if (pathname === "/api/remote/status" && req.method === "GET") {
    const tunnel = getRemoteTunnel();
    return sendJson(res, 200, {
      ok: true,
      active: Boolean(tunnel),
      url: tunnel?.url ?? null,
    });
  }

  if (pathname === "/api/remote/start" && req.method === "POST") {
    // The tunnel serves the built UI from dist/; build it first if missing.
    if (!existsSync(join(DIST, "index.html"))) {
      const built = await buildDist();
      if (!built.ok)
        return sendJson(res, 500, { ok: false, error: built.error });
    }
    const started = await startRemoteTunnel(PORT);
    const connectUrl = `${started.url}/?token=${started.token}`;
    // PNG data URL rather than SVG markup: the client renders a plain <img>,
    // so no raw HTML ever crosses the wire into the DOM.
    const qrDataUrl = await qrcode.toDataURL(connectUrl, {
      margin: 1,
      width: 260,
    });
    return sendJson(res, 200, {
      ok: true,
      url: started.url,
      connectUrl,
      qrDataUrl,
    });
  }

  if (pathname === "/api/remote/stop" && req.method === "POST") {
    stopRemoteTunnel();
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/auth/status" && req.method === "GET") {
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/deploy/status" && req.method === "GET") {
    let projectRoot;
    try {
      projectRoot = deployProjectRoot(url.searchParams.get("cwd"));
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: String(error?.message ?? error),
      });
    }
    const state = readDeployState(projectRoot);
    const stale = Boolean(
      state?.status === "running" &&
        Date.now() - (state.startedAt || 0) > 15 * 60_000,
    );
    return sendJson(res, 200, {
      ok: true,
      mode: DEPLOY_MODE,
      project: projectRoot,
      projectName: basename(projectRoot),
      // Only a deploy of devden itself restarts this server and reloads the
      // page; any other project is just built in place.
      self: deploysSelf(projectRoot),
      head: currentGitHead(projectRoot),
      signature: workingTreeSignature(projectRoot),
      dirtyFiles: uncommittedFileCount(projectRoot),
      deploying: state?.status === "running" && !stale,
      stale,
      last: state,
      lastLocal: state?.lastLocal ?? null,
      lastCloud: state?.lastCloud ?? null,
    });
  }

  if (pathname === "/api/deploy" && req.method === "POST") {
    // Requested mode comes from the button clicked; the env default only
    // applies to callers that don't specify one.
    const body = await readBody(req);
    const requestedMode =
      body?.mode === "cloud" || body?.mode === "local"
        ? body.mode
        : DEPLOY_MODE;
    let projectRoot;
    try {
      projectRoot = deployProjectRoot(body?.cwd);
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: String(error?.message ?? error),
      });
    }
    const state = readDeployState(projectRoot);
    if (
      state?.status === "running" &&
      Date.now() - (state.startedAt || 0) < 15 * 60_000
    ) {
      return sendJson(res, 409, {
        ok: false,
        error: "A deploy is already running.",
      });
    }
    writeDeployState(
      {
        status: "running",
        mode: requestedMode,
        startedAt: Date.now(),
        finishedAt: null,
        commit: currentGitHead(projectRoot),
        steps: [],
        log: "",
        error: null,
      },
      projectRoot,
    );
    try {
      const child = spawn(
        process.execPath,
        [join(ROOT, "scripts", "deploy.mjs")],
        {
          cwd: projectRoot,
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            DEVDEN_DEPLOY_MODE: requestedMode,
            DEVDEN_DEPLOY_CWD: projectRoot,
            DEVDEN_DEPLOY_STATE: deployStatePath(projectRoot),
            // Restarting this server only makes sense when the project being
            // deployed IS this server.
            ...(deploysSelf(projectRoot)
              ? { DEVDEN_SERVER_PID: String(process.pid) }
              : { DEVDEN_SERVER_PID: "" }),
          },
        },
      );
      // A deployer that dies before reporting (missing script, bad node)
      // would otherwise leave the button spinning on "running" for 15 min.
      child.on("exit", (code) => {
        if (code && readDeployState(projectRoot)?.status === "running") {
          writeDeployState(
            {
              status: "failed",
              finishedAt: Date.now(),
              error: `Deployer exited with code ${code} before reporting.`,
            },
            projectRoot,
          );
        }
      });
      child.unref();
    } catch (error) {
      writeDeployState(
        {
          status: "failed",
          finishedAt: Date.now(),
          error: `Failed to start deployer: ${error?.message || error}`,
        },
        projectRoot,
      );
      return sendJson(res, 500, {
        ok: false,
        error: "Failed to start deploy.",
      });
    }
    return sendJson(res, 200, {
      ok: true,
      mode: requestedMode,
      project: projectRoot,
      self: deploysSelf(projectRoot),
    });
  }

  if (pathname === "/api/directories" && req.method === "GET") {
    const requested = url.searchParams.get("path")?.trim() || homedir();
    try {
      // Confined like every other browsing endpoint. Without this the folder
      // picker enumerated any directory on the machine.
      const path = confineHomePath(requested);
      const info = await stat(path);
      if (!info.isDirectory())
        return sendJson(res, 400, {
          ok: false,
          error: "That path is not a directory.",
        });
      const entries = (await readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: join(path, entry.name),
          hidden: entry.name.startsWith("."),
        }))
        .sort((left, right) =>
          left.name.localeCompare(right.name, undefined, {
            sensitivity: "base",
          }),
        );
      return sendJson(res, 200, {
        ok: true,
        path,
        parent: path === dirname(path) ? null : dirname(path),
        home: homedir(),
        entries,
      });
    } catch (error) {
      const message =
        error?.code === "ENOENT"
          ? "That directory does not exist."
          : error?.code === "EACCES"
            ? "Pi cannot read that directory."
            : String(error?.message ?? error);
      return sendJson(res, 400, { ok: false, error: message });
    }
  }

  if (pathname === "/api/workspace" && req.method === "GET") {
    const requested = url.searchParams.get("path")?.trim();
    if (!requested)
      return sendJson(res, 400, {
        ok: false,
        error: "Missing workspace path.",
      });
    try {
      confineHomePath(requested);
      const result = await listWorkspace(requested);
      return sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: workspaceIoError(error, "directory"),
      });
    }
  }

  // Backs the composer's "@" file picker. Deliberately not Claude Code's
  // file_suggestions control request: this works for every backend, and the
  // CLI's matcher is inconsistent for partial path fragments.
  if (pathname === "/api/workspace/search" && req.method === "GET") {
    const root = url.searchParams.get("root")?.trim();
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    if (!root)
      return sendJson(res, 400, { ok: false, error: "Missing search root." });
    try {
      confineHomePath(root);
      const matches = await searchWorkspaceFiles(root, query);
      return sendJson(res, 200, { ok: true, matches });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: workspaceIoError(error, "directory"),
      });
    }
  }

  // Content search across the project, and the grep-backed definition lookup
  // the editor's Cmd-click uses. Both confine to a workspace root first: the
  // root is a caller-supplied path and `git grep -C <root>` would happily walk
  // anywhere on disk.
  if (pathname === "/api/workspace/grep" && req.method === "GET") {
    const root = url.searchParams.get("root")?.trim();
    if (!root)
      return sendJson(res, 400, { ok: false, error: "Missing search root." });
    try {
      confineHomePath(root);
      const result = await grepWorkspace(root, url.searchParams.get("q"), {
        caseSensitive: url.searchParams.get("case") === "1",
        wholeWord: url.searchParams.get("word") === "1",
        regex: url.searchParams.get("regex") === "1",
      });
      return sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: workspaceIoError(error, "directory"),
      });
    }
  }

  if (pathname === "/api/workspace/definition" && req.method === "GET") {
    const root = url.searchParams.get("root")?.trim();
    if (!root)
      return sendJson(res, 400, { ok: false, error: "Missing search root." });
    try {
      confineHomePath(root);
      const result = await findDefinition(root, url.searchParams.get("symbol"));
      return sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: workspaceIoError(error, "directory"),
      });
    }
  }

  if (pathname === "/api/workspace/file" && req.method === "GET") {
    const requested = url.searchParams.get("path")?.trim();
    if (!requested)
      return sendJson(res, 400, { ok: false, error: "Missing file path." });
    try {
      confineHomePath(requested);
      const result = await readWorkspaceFile(requested);
      return sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: workspaceIoError(error, "file"),
      });
    }
  }

  if (pathname === "/api/workspace/file" && req.method === "PUT") {
    const body = await readBody(req);
    try {
      confineWorkspacePath(String(body.path ?? ""));
      const result = await writeWorkspaceFile(
        String(body.path ?? ""),
        body.content,
      );
      return sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: workspaceIoError(error, "file"),
      });
    }
  }

  // A board card made from a selection: the excerpt is the card's description,
  // and this names it. Same ephemeral pi process the session titles use, so
  // there is no new model plumbing — and it degrades to "" (the client keeps
  // its truncated fallback) when pi is not installed or the call fails.
  if (pathname === "/api/board/card-title" && req.method === "POST") {
    const body = await readBody(req);
    const title = await generateSessionTitle(
      String(body.text ?? ""),
      undefined,
      CARD_TITLE_INSTRUCTION,
    );
    return sendJson(res, 200, { ok: true, title });
  }

  // Auto-saved conversation transcripts. Kept in ~/.devden/transcripts rather
  // than the workspace on purpose: this writes after every turn, and a file
  // that reappears in `git status` on every reply is worse than no feature.
  if (pathname === "/api/transcript" && req.method === "PUT") {
    const body = await readBody(req);
    const name = safeTranscriptName(body.name);
    if (!name)
      return sendJson(res, 400, { ok: false, error: "Bad transcript name." });
    const dir = join(devdenHome(), "transcripts");
    const path = join(dir, name);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(path, String(body.content ?? ""), "utf8");
      // The name carries the session title, which changes once the agent
      // renames the session -- without this, one session leaves a stale
      // 100KB copy behind under every title it ever had. The trailing id is
      // the session's identity, so same-id siblings are earlier names.
      const id = name.match(/-([a-zA-Z0-9]+)\.md$/)?.[1];
      if (id) {
        for (const other of await readdir(dir)) {
          if (other !== name && other.endsWith(`-${id}.md`))
            await rm(join(dir, other), { force: true });
        }
      }
      return sendJson(res, 200, { ok: true, path });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: String(error?.message ?? error),
      });
    }
  }

  if (pathname === "/api/workspace/apps" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, apps: listWorkspaceApps() });
  }

  if (pathname.startsWith("/api/workspace/") && req.method === "POST") {
    const action = pathname.slice("/api/workspace/".length);
    const body = await readBody(req);
    const path = String(body.path ?? "");
    try {
      confineWorkspacePath(path);
      if (action === "copy" || action === "move")
        confineWorkspacePath(String(body.destination ?? ""));
      const result =
        action === "rename"
          ? await renameWorkspacePath(path, body.name)
          : action === "delete"
            ? await deleteWorkspacePath(path)
            : action === "copy"
              ? await transferWorkspacePath(
                  path,
                  String(body.destination ?? ""),
                  "copy",
                )
              : action === "move"
                ? await transferWorkspacePath(
                    path,
                    String(body.destination ?? ""),
                    "move",
                  )
                : action === "reveal"
                  ? await revealWorkspacePath(path)
                  : action === "open"
                    ? await openWorkspacePath(
                        path,
                        typeof body.app === "string" ? body.app : undefined,
                      )
                    : action === "terminal"
                      ? await openWorkspaceTerminal(path)
                      : { ok: false, error: "unknown workspace action" };
      return sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: workspaceIoError(error, "file"),
      });
    }
  }

  if (pathname === "/api/catalog/open-settings" && req.method === "POST") {
    await readBody(req);
    try {
      await openWorkspacePath(SETTINGS_PATH);
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: String(error?.message ?? error),
      });
    }
  }

  if (pathname === "/api/catalog" && req.method === "GET") {
    return sendJson(res, 200, await loadCatalog(url.searchParams.get("backend") ?? "pi"));
  }

  // Skill authoring. Confinement to the skills root lives in catalog.js, next
  // to the writes it protects.
  if (pathname === "/api/catalog/skill" && req.method === "GET") {
    const name = url.searchParams.get("name") ?? "";
    const result = await readSkill(name, url.searchParams.get("backend") ?? "pi");
    return sendJson(res, result.ok ? 200 : 400, result);
  }
  if (pathname === "/api/catalog/skill" && req.method === "PUT") {
    const body = await readBody(req);
    const result = await writeSkill({
      backend: body.backend ?? "pi",
      name: String(body.name ?? ""),
      description: String(body.description ?? ""),
      body: String(body.body ?? ""),
    });
    return sendJson(res, result.ok ? 200 : 400, result);
  }
  if (pathname === "/api/catalog/skill" && req.method === "DELETE") {
    const name = url.searchParams.get("name") ?? "";
    const result = await deleteSkill(name, url.searchParams.get("backend") ?? "pi");
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (pathname === "/api/session-log" && req.method === "GET") {
    const result = await loadSessionLog(url.searchParams.get("path") ?? "");
    if (!result.ok) return sendJson(res, 400, result);
    const filename = basename(result.path).replace(/[^a-zA-Z0-9._-]/g, "_");
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, max-age=0",
      ...corsHeaders(req),
    });
    res.end(result.contents);
    return;
  }

  if (pathname === "/api/session-messages" && req.method === "GET") {
    const path = url.searchParams.get("path") || "";
    const result = await readSessionMessages(path);
    if (result.ok && Array.isArray(result.messages))
      result.messages = await withDisplayHistory(path, result.messages);
    return sendJson(res, 200, result);
  }

  if (pathname === "/api/xray" && req.method === "GET") {
    // Context X-ray: compaction markers, dead zone, and dropped standing
    // instructions, read straight from the session file (no agent needed).
    return sendJson(
      res,
      200,
      await readSessionXray(url.searchParams.get("path") ?? ""),
    );
  }

  if (pathname === "/api/sessions/search" && req.method === "GET") {
    return sendJson(
      res,
      200,
      await searchSessions({
        query: url.searchParams.get("q") ?? "",
        backend: sessionScope(url.searchParams.get("backend")),
      }),
    );
  }

  if (pathname === "/api/sessions" && req.method === "GET") {
    const result = await listSessions({
      archived: url.searchParams.get("view") === "archived",
      backend: sessionScope(url.searchParams.get("backend")),
    });
    // The sessions pane lists every saved session's cwd as a workspace and
    // offers to delete that folder, but a cwd only becomes a root when an
    // agent starts in it -- so a workspace you have not opened this run was
    // refused by the mutation confinement. Register what the server itself
    // just listed: derived from the local session store, never from the
    // request, which is strictly narrower than the client-supplied cwd
    // /start and /prompt already trust.
    const running = streamingSessionPaths();
    // The sidebar derives a <=68-char title from the first sentence of
    // firstPrompt, but full prompts (pasted logs, whole files) were ~1MB of
    // the ~1.6MB listing fetched on every refresh. Copies, not mutations:
    // the summaries are the server's mtime cache. `name` falls back to the
    // prompt, and the client compares the two, so cap both alike.
    const cap = (text) =>
      typeof text === "string" && text.length > 2000 ? text.slice(0, 2000) : text;
    result.sessions = (result.sessions ?? []).map((session) => {
      addWorkspaceRoot(session.cwd);
      return {
        ...session,
        name: cap(session.name),
        firstPrompt: cap(session.firstPrompt),
        isStreaming: running.has(session.path),
      };
    });
    return sendJson(res, 200, result);
  }

  if (pathname.startsWith("/api/sessions/") && req.method === "POST") {
    const action = pathname.slice("/api/sessions/".length);
    const body = await readBody(req);
    const sessionPath = String(body.sessionPath ?? "");
    const result =
      action === "archive"
        ? await archiveSession(sessionPath)
        : action === "restore"
          ? await restoreSession(sessionPath)
          : action === "delete"
            ? await deleteSession(sessionPath)
            : { ok: false, error: "unknown session action" };
    if (action === "delete" && result.ok) {
      try {
        forgetSessionChanges(sessionPath);
      } catch (error) {
        logFault("forget-changes", error);
      }
    }
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(req),
    });
    res.write(`data: ${JSON.stringify({ type: "__hello" })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    // curl/wget hang here forever (SSE never closes). EventSource is uncapped.
    if (isOneShotSseClient(req)) {
      setTimeout(() => {
        if (res.writableEnded) return;
        res.write(
          `data: ${JSON.stringify({ type: "__timeout", message: "/api/events is SSE and never closes" })}\n\n`,
        );
        res.end();
        sseClients.delete(res);
      }, SSE_ONESHOT_MS).unref();
    }
    return;
  }

  if (pathname === "/api/heartbeat" && req.method === "POST") {
    const body = await readBody(req);
    const keys = Array.isArray(body.keys)
      ? body.keys.filter((key) => typeof key === "string" && key)
      : [];
    for (const key of keys) renewLease(key);
    return sendJson(res, 200, { ok: true });
  }

  const m = pathname.match(/^\/api\/([^/]+)(?:\/([^/]+))?$/);
  if (!m) {
    if (pathname.startsWith("/api/"))
      return sendJson(res, 404, { ok: false, error: "unknown route" });
    return serveStatic(res, pathname);
  }
  const [, sessionKey, action] = m;
  renewLease(sessionKey);

  if (req.method === "GET" && action === "log") {
    return sendJson(res, 200, {
      ok: true,
      entries: runtimeLogs.get(sessionKey) ?? [],
    });
  }

  if (req.method === "POST" && action === "start") {
    const body = await readBody(req);
    addWorkspaceRoot(body.cwd);
    // Reuse a process that is already running this session file (e.g. the
    // page was refreshed and the tab key changed) instead of spawning a
    // duplicate — its live state, including isStreaming, carries over.
    // A fork tab must not steal the parent's process. independent covers
    // every backend's fork start.
    if (shouldAdoptLiveAgent(body))
      adoptLiveAgent(sessionKey, body.backend, body.sessionPath);
    const agent = watch(sessionKey, body.backend);
    // adoptOnly: attach to a live process but never spawn one. Grok stays
    // lazy for mere viewing (starting it wrote ghost session files); this
    // lets a refreshed tab re-adopt a mid-run grok turn without that cost.
    if (body.adoptOnly && !agent.process) {
      // A lazy agent that never spawns still needs to know where it would
      // start -- grok's ensureRunning() self-heal (queue/steer/compact/goal
      // check-in all funnel through it) refuses to revive a cwd-less agent,
      // and this was the only cwd this session ever offered it. Without this,
      // any of those callers on a merely-viewed session permanently fails
      // with "Grok session is not running" instead of reviving.
      if (!agent.cwd && body.cwd) agent.cwd = body.cwd;
      return sendJson(res, 200, { ok: false, error: "no live agent to adopt" });
    }
    const result = await runLoggedCommand(sessionKey, "start", body, () =>
      agent.start(body.cwd || process.cwd(), {
        ...startOptionsFromBody(body),
        warmOnly: Boolean(body.warmOnly),
      }),
    );
    if (result.ok && Array.isArray(result.messages)) {
      const path =
        (typeof body.sessionPath === "string" && body.sessionPath) ||
        sessionPathOf(agent);
      result.messages = await withDisplayHistory(path, result.messages);
    }
    return sendJson(res, result.ok ? 200 : 500, result);
  }
  if (req.method === "POST" && action === "prompt") {
    const body = await readBody(req);
    addWorkspaceRoot(body.cwd);
    const message = String(body.message ?? "");
    const images = Array.isArray(body.images) ? body.images : undefined;
    if (isUsageShortcut(message, images)) {
      const result = await runLoggedCommand(sessionKey, "usage", {}, () =>
        watch(sessionKey).getUsage(true),
      );
      return sendJson(res, result.ok ? 200 : 500, result);
    }
    // Lazy (re)start: opening a session only reads its history; the agent
    // process starts here, on the first message, using the session context
    // the client attaches to the prompt. This also self-heals dead
    // processes — a pi/claude RPC child that exited (idle exit, server
    // restart, page refresh) comes back with its session file on the next
    // message instead of failing with "process is not running".
    const promptBackend = backendName(
      body.backend ?? sessionBackends.get(sessionKey),
    );
    // Adopt before starting: the same session may already be running under
    // another key -- a refreshed tab, or a turn this server resumed at boot
    // under a key of its own. Without this the prompt spawns a second agent
    // on one session file and the two fight over it.
    adoptLiveAgent(sessionKey, promptBackend, body.sessionPath);
    const promptAgent = watch(sessionKey, promptBackend);
    const agentAlive = agentIsAlive(promptAgent);
    if (!agentAlive) {
      const started = await runLoggedCommand(sessionKey, "start", body, () =>
        promptAgent.start(
          String(body.cwd || process.cwd()),
          startOptionsFromBody(body),
        ),
      );
      if (!started.ok) return sendJson(res, 500, started);
    }
    // Snapshot the tree before the agent touches it, so "restore files to
    // this point" works on every backend and not just the one CLI that
    // checkpoints for itself. Never let it block or fail a turn — awaiting
    // `git add -A` sat on the first-token path.
    const turnCwd = String(body.cwd || promptAgent.cwd || process.cwd());
    const snapshot = takeSnapshot(turnCwd, message).catch(() => ({
      ok: false,
    }));
    // The same snapshot is this turn's "before" for the Changes views.
    beginTurn({ sessionKey, cwd: turnCwd, label: message, snapshot });
    // A tab whose `streaming` flag lost sync (laptop wake, SSE reconnect, an
    // auto-resume that started under another key) used to POST /prompt into a
    // busy agent and have the message rejected outright. enqueue sends
    // immediately when the agent is idle and queues it when it is not, so the
    // message is never dropped on the floor.
    const promptTarget = watch(sessionKey);
    // /prompt starts a turn. It used to route through enqueue() with a
    // broken isBusy (pi: "a process exists", grok: an idle reminder turn from
    // newSession counted as busy), so the user's first message was parked in
    // the queue and never sent. isBusy now means "a turn is actually
    // running", so ask it directly: idle -> start the turn, genuinely busy ->
    // queue rather than firing a second concurrent prompt down the same stdio
    // (pi's prompt() has no re-entrancy guard of its own). The client decides
    // between /prompt and /queue from its `streaming` flag, which this file
    // already documents as desyncing on laptop wake, SSE reconnect and
    // cross-key auto-resume — so the server keeps the net.
    // The reply carries `queued` so the tab can drop its optimistic run
    // instead of spinning on a turn that has not started.
    noteTurnStarted({
      sessionKey,
      backend: promptBackend,
      cwd: String(body.cwd || promptAgent.cwd || process.cwd()),
      sessionPath:
        promptAgent.sessionFile ?? promptAgent.lastState?.sessionFile,
      message,
      model: promptAgent.lastState?.model ?? promptAgent.model ?? undefined,
      thinkingLevel: promptAgent.lastState?.thinkingLevel,
    });
    const promptIsBusy =
      hasMethod(promptTarget, "isBusy") && promptTarget.isBusy();
    // A settled turn that ended by asking the user something holds the floor:
    // a prompt typed while the question waits is queued behind the answer
    // instead of replacing it. The ask card's submit flags itself as the
    // answer (answersAsk) and goes straight through; the queue chip's
    // "Send now" is the manual override. Steering is untouched — it always
    // interrupts.
    const askHoldsFloor =
      Boolean(promptTarget.askPending) && body.answersAsk !== true;
    const result = await runLoggedCommand(sessionKey, "prompt", body, () =>
      (promptIsBusy || askHoldsFloor) && hasMethod(promptTarget, "enqueue")
        ? promptTarget.enqueue(message, images)
        : promptTarget.prompt(message, images),
    );
    // Without this the record outlives a turn that never ran, and the next
    // restart "resumes" a prompt the agent never accepted. A queued prompt is
    // the same case: it is waiting, not running.
    if (!result.ok || result.data?.queued) noteTurnSettled(sessionKey);
    if (promptBackend === "pi")
      maybeGeneratePiTitle(sessionKey, promptAgent, message);
    // The agent only ever reveals its session file through getState(), and
    // neither pi nor grok puts it on an event, so a lazily-started tab had no
    // path at all. The sidebar matches saved rows by path, so such a tab's own
    // row showed no open marker -- hand the path back with the prompt reply.
    return sendJson(res, result.ok ? 200 : 500, {
      ...result,
      sessionPath:
        promptAgent.sessionFile ?? promptAgent.lastState?.sessionFile,
    });
  }
  if (req.method === "POST" && action === "steer") {
    const body = await readBody(req);
    const steerBackend = sessionBackends.get(sessionKey) ?? "pi";
    if (!capabilitiesFor(steerBackend).steer) {
      return sendJson(
        res,
        200,
        unsupported(
          "steer",
          "This agent cannot take a message mid-turn. The message was not sent.",
        ),
      );
    }
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "steer", body, () =>
        callAgentMethod(
          watch(sessionKey),
          "steer",
          [
            String(body.message ?? ""),
            Array.isArray(body.images) ? body.images : undefined,
          ],
          "steer",
        ),
      ),
    );
  }
  if (req.method === "POST" && action === "queue") {
    const body = await readBody(req);
    const agent = watch(sessionKey);
    if (
      !capabilitiesFor(sessionBackends.get(sessionKey) ?? "pi").queue ||
      !hasMethod(agent, "enqueue")
    )
      return sendJson(
        res,
        200,
        unsupported("queue", "This agent does not queue messages"),
      );
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "queue", body, () =>
        agent.enqueue(
          String(body.message ?? ""),
          Array.isArray(body.images) ? body.images : undefined,
        ),
      ),
    );
  }
  if (req.method === "POST" && action === "queue-steer") {
    const body = await readBody(req);
    const agent = watch(sessionKey);
    const steerBackend = sessionBackends.get(sessionKey) ?? "pi";
    // `steer` is about splicing into a *running* turn. Once the agent is idle
    // — after an interrupt, say — delivering a queued message is an ordinary
    // send, which every backend can do; gating that on the capability left
    // grok's queue strip with no way to send what was in it.
    if (!capabilitiesFor(steerBackend).steer && agent.isBusy?.())
      return sendJson(
        res,
        200,
        unsupported(
          "steer",
          "This agent cannot take a message mid-turn. The message was not sent.",
        ),
      );
    if (
      !capabilitiesFor(steerBackend).queue ||
      !hasMethod(agent, "steerQueued")
    )
      return sendJson(
        res,
        200,
        unsupported("queue", "This agent does not queue messages"),
      );
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "queue-steer", body, () =>
        agent.steerQueued(
          typeof body.id === "string" && body.id ? body.id : undefined,
        ),
      ),
    );
  }
  if (req.method === "POST" && action === "queue-cancel") {
    const body = await readBody(req);
    const agent = watch(sessionKey);
    if (
      !capabilitiesFor(sessionBackends.get(sessionKey) ?? "pi").queue ||
      !hasMethod(agent, "cancelQueued")
    )
      return sendJson(
        res,
        200,
        unsupported("queue", "This agent does not queue messages"),
      );
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "queue-cancel", body, () =>
        agent.cancelQueued(
          typeof body.id === "string" && body.id ? body.id : undefined,
        ),
      ),
    );
  }
  if (req.method === "POST" && action === "abort") {
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "abort", {}, () =>
        watch(sessionKey).abort(),
      ),
    );
  }
  if (req.method === "POST" && action === "answer") {
    const body = await readBody(req);
    const agent = watch(sessionKey);
    if (typeof agent.resolveUserInput !== "function") return sendJson(res, 400, { ok: false, error: "This backend has no native questions" });
    const result = agent.resolveUserInput(body.requestId, body.answers);
    return sendJson(res, result.ok ? 200 : 400, result);
  }
  if (req.method === "POST" && action === "approve") {
    // Manual-mode tool approval answer from the UI.
    const body = await readBody(req);
    const agent = watch(sessionKey);
    if (typeof agent.resolveApproval !== "function")
      return sendJson(res, 400, {
        ok: false,
        error: "this backend has no approval flow",
      });
    return sendJson(
      res,
      200,
      agent.resolveApproval(body.requestId, String(body.optionId ?? "deny")),
    );
  }
  if (req.method === "POST" && action === "stop") {
    const backend = sessionBackends.get(sessionKey) ?? "pi";
    const result = await runLoggedCommand(sessionKey, "stop", {}, () => {
      poolFor(backend).stop(sessionKey);
      sessionBackends.delete(sessionKey);
      // Free the runtime log and aliases pinned to this session; a stopped
      // conversation no longer needs reload replay or alias fan-out.
      runtimeLogs.delete(sessionKey);
      for (const [alias, target] of KEY_ALIASES) {
        if (target === sessionKey) KEY_ALIASES.delete(alias);
      }
      return { ok: true };
    });
    return sendJson(res, 200, result);
  }
  if (action === "route") {
    const sessionFile =
      req.method === "GET" ? url.searchParams.get("sessionFile") || "" : "";
    if (req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        route: (await loadRoute(sessionKey, sessionFile)) ?? undefined,
      });
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      const file =
        typeof body.sessionFile === "string" ? body.sessionFile : sessionFile;
      const result = await saveRoute(sessionKey, file, body.route);
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    return sendJson(res, 405, { ok: false, error: "method not allowed" });
  }
  if (req.method === "POST" && action === "configure") {
    const body = await readBody(req);
    addWorkspaceRoot(body.cwd);
    const currentBackend = sessionBackends.get(sessionKey) ?? "pi";
    poolFor(currentBackend).stop(sessionKey);
    sessionBackends.delete(sessionKey);
    const agent = watch(sessionKey, body.backend);
    // A not-yet-started lazy backend (fresh or lazily resumed) has nothing
    // to reconfigure server-side: just record the requested backend and
    // return placeholder state instead of spawning an agent that writes an
    // empty session file. The first prompt starts it with the new cwd.
    if (
      capabilitiesFor(body.backend).lazyStart &&
      !agentIsAlive(agent) &&
      !body.sessionPath
    ) {
      return sendJson(res, 200, {
        ok: true,
        state: {
          model:
            body.model && typeof body.model === "object" ? body.model : null,
          thinkingLevel:
            typeof body.thinkingLevel === "string" ? body.thinkingLevel : "off",
          isStreaming: false,
          sessionId: "",
          messageCount: 0,
          pendingMessageCount: 0,
        },
      });
    }
    const result = await runLoggedCommand(sessionKey, "configure", body, () =>
      agent.start(String(body.cwd || process.cwd()), {
        accessMode:
          body.accessMode === "read-only" ? "read-only" : "workspace-write",
        agentMode:
          body.agentMode === "plan" ||
          body.agentMode === "manual" ||
          body.agentMode === "auto-edit"
            ? body.agentMode
            : "standard",
        sessionPath:
          typeof body.sessionPath === "string" && body.sessionPath
            ? body.sessionPath
            : undefined,
        model:
          body.model && typeof body.model === "object"
            ? {
                provider: String(body.model.provider || ""),
                id: String(body.model.id || ""),
              }
            : undefined,
        thinkingLevel:
          typeof body.thinkingLevel === "string"
            ? body.thinkingLevel
            : undefined,
      }),
    );
    if (result.ok && body.sessionPath) {
      try {
        result.messages = await clientMessages(agent, String(body.sessionPath));
      } catch (error) {
        return sendJson(res, 500, {
          ok: false,
          error: String(error?.message ?? error),
        });
      }
    }
    return sendJson(res, result.ok ? 200 : 500, result);
  }
  if (req.method === "POST" && action === "upload") {
    const body = await readBody(req);
    const data = typeof body.data === "string" ? body.data : "";
    const bytes = Buffer.from(data, "base64");
    if (!data || bytes.length === 0)
      return sendJson(res, 400, {
        ok: false,
        error: "The uploaded file was empty.",
      });
    if (bytes.length > 20 * 1024 * 1024)
      return sendJson(res, 413, {
        ok: false,
        error: "Files must be 20 MB or smaller.",
      });
    const safeSession = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeName = basename(String(body.name || "attachment")).replace(
      /[^a-zA-Z0-9._ -]/g,
      "_",
    );
    const directory = join(tmpdir(), "devden-uploads", safeSession);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${Date.now()}-${safeName}`);
    await writeFile(path, bytes);
    return sendJson(res, 200, { ok: true, path });
  }
  if (req.method === "POST" && action === "new-session") {
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "new-session", {}, () =>
        watch(sessionKey).newSession(),
      ),
    );
  }
  if (req.method === "POST" && action === "resume") {
    const body = await readBody(req);
    const sessionPath = String(body.sessionPath ?? "");
    const resumeAgent = watch(sessionKey);
    // switch_session aborts a running turn on purpose: a *persisted* session
    // can carry a stale isStreaming flag from another pi process. But when
    // this agent is already live on the requested file (a page refresh
    // adopted it mid-run), that abort kills the very turn the reload is
    // supposed to preserve — the "request was aborted" a refresh produced.
    // Hand back the live transcript instead of switching into it.
    const liveFile =
      resumeAgent.sessionFile ?? resumeAgent.lastState?.sessionFile;
    if (sessionPath && liveFile === sessionPath) {
      const liveState = await resumeAgent.getState().catch(() => undefined);
      if (liveState?.isStreaming) {
        const messages = await clientMessages(resumeAgent, sessionPath);
        return sendJson(res, 200, { ok: true, state: liveState, messages });
      }
    }
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "resume", body, async () => {
        const result = await resumeAgent.switchSession(sessionPath);
        if (result?.ok && Array.isArray(result.messages))
          result.messages = await withDisplayHistory(
            sessionPath,
            result.messages,
          );
        return result;
      }),
    );
  }
  if (req.method === "POST" && action === "fork") {
    const body = await readBody(req);
    const forkBackend = backendName(
      body.backend ?? sessionBackends.get(sessionKey) ?? "pi",
    );
    if (!capabilitiesFor(forkBackend).fork) {
      return sendJson(
        res,
        200,
        unsupported("fork", "This agent cannot fork a conversation."),
      );
    }
    const forkAgent = watch(sessionKey, forkBackend);
    const claim = claimFork(forkAgent);
    if (!claim.ok) return sendJson(res, 200, claim);
    const forkOptions = startOptionsFromBody(body);
    try {
      // Pi and Codex fork through the live process. Claude forks the JSONL
      // on disk, and Grok's forkAt starts itself against the source file's
      // cwd — reviving either here dropped model/mode and, for Claude, held
      // a CLI the fork never uses.
      const forkNeedsProcess = forkBackend === "pi" || forkBackend === "codex";
      if (forkNeedsProcess && !agentIsAlive(forkAgent)) {
        const cwd = String(body.cwd || forkAgent.cwd || "");
        if (!cwd) {
          return sendJson(res, 200, {
            ok: false,
            error:
              "This session is not running yet. Send a message once, then fork.",
          });
        }
        const started = await runLoggedCommand(sessionKey, "start", body, () =>
          forkAgent.start(cwd, forkOptions),
        );
        if (!started.ok)
          return sendJson(res, started.unsupported ? 200 : 500, started);
      }
      // Isolate the tree first so Grok's ACP fork can receive newCwd, and so
      // every backend's child tab starts in a checkout that matches the fork
      // point (snapshot commit) rather than sharing the parent's dirty files.
      let forkCwd = String(body.cwd || forkAgent.cwd || "");
      let worktree;
      let isolatedFrom = "";
      try {
        if (forkCwd) isolatedFrom = confineWorkspacePath(forkCwd);
      } catch {
        isolatedFrom = "";
      }
      if (isolatedFrom) {
        try {
          const snap = await commitForFork(
            isolatedFrom,
            Number(body.timestamp),
          );
          const isolated = await createWorktree(
            isolatedFrom,
            String(body.name || "fork"),
            snap.ok ? { commit: snap.commit } : undefined,
          );
          if (isolated.ok) {
            addWorkspaceRoot(isolated.data.path);
            forkCwd = isolated.data.path;
            worktree = isolated.data;
          }
        } catch {
          /* not a git repo, or git failed: the fork still copies the chat */
        }
      }
      const result = await runLoggedCommand(sessionKey, "fork", body, () =>
        callAgentMethod(
          watch(sessionKey),
          "forkAt",
          [
            Number(body.timestamp),
            {
              cwd: body.cwd,
              sessionPath: forkOptions.sessionPath,
              promptIndex: body.promptIndex,
              userText:
                typeof body.userText === "string" ? body.userText : undefined,
              forkCwd,
              model: forkOptions.model,
              thinkingLevel: forkOptions.thinkingLevel,
              accessMode: forkOptions.accessMode,
              agentMode: forkOptions.agentMode,
            },
          ],
          "fork",
        ),
      );
      if (result.ok) {
        // The agent names the cwd the fork session actually lives in. When
        // that isn't the worktree (ACP ignored newCwd), drop the empty
        // checkout instead of pointing the tab at a tree the session isn't in.
        if (
          worktree?.path &&
          result.forkCwd &&
          result.forkCwd !== worktree.path
        ) {
          await removeWorktree(
            isolatedFrom || worktree.path,
            worktree.path,
            true,
          ).catch(() => {});
          worktree = undefined;
        }
        if (!result.forkCwd && forkCwd) result.forkCwd = forkCwd;
        if (worktree) result.worktree = worktree;
      } else if (worktree?.path && !result.keepWorktree) {
        await removeWorktree(
          String(body.cwd || forkAgent.cwd || worktree.path),
          worktree.path,
          true,
        ).catch(() => {});
      }
      return sendJson(
        res,
        result.ok ? 200 : result.unsupported ? 200 : 500,
        result,
      );
    } finally {
      releaseFork(forkAgent);
    }
  }
  if (req.method === "GET" && action === "settings") {
    const agent = watch(sessionKey);
    if (
      !capabilitiesFor(sessionBackends.get(sessionKey) ?? "pi").settings ||
      !hasMethod(agent, "getSettings")
    )
      return sendJson(
        res,
        200,
        unsupported("settings", "This agent does not expose settings"),
      );
    return sendJson(res, 200, await agent.getSettings());
  }
  if (req.method === "GET" && action === "mcp") {
    const agent = watch(sessionKey);
    if (
      !capabilitiesFor(sessionBackends.get(sessionKey) ?? "pi").mcp ||
      !hasMethod(agent, "getMcpServers")
    )
      return sendJson(
        res,
        200,
        unsupported("mcp", "This agent does not expose MCP servers"),
      );
    return sendJson(res, 200, await agent.getMcpServers());
  }
  if (req.method === "GET" && action === "context") {
    const agent = watch(sessionKey);
    if (
      !capabilitiesFor(sessionBackends.get(sessionKey) ?? "pi").contextUsage ||
      !hasMethod(agent, "getContextUsage")
    )
      return sendJson(
        res,
        200,
        unsupported("contextUsage", "This agent does not report context usage"),
      );
    return sendJson(res, 200, await agent.getContextUsage());
  }
  if (req.method === "POST" && action === "rewind-files") {
    const body = await readBody(req);
    const agent = watch(sessionKey);
    // Restoring happens after the turn, so the agent may have been reaped
    // since. Resume it first — the control request needs a live CLI.
    const rewindCwd = typeof body.cwd === "string" ? body.cwd : "";
    const rewindSessionPath =
      typeof body.sessionPath === "string" ? body.sessionPath : "";
    // Backends that keep their own per-file checkpoints (claude) restore
    // from those; everything else rewinds to the git snapshot taken before
    // the turn. The snapshot also covers a claude CLI that is gone or has
    // lost the checkpoint for that message.
    const fromSnapshot = () => {
      // Never fall back to the server's own cwd: restoring the wrong repo is
      // the one mistake here that costs somebody real work.
      const snapshotCwd = rewindCwd || agent.cwd || "";
      if (!snapshotCwd)
        return { ok: false, error: "No workspace directory for this session." };
      return runLoggedCommand(sessionKey, "rewind-snapshot", body, () =>
        restoreSnapshot(
          snapshotCwd,
          Number(body.timestamp),
          body.dryRun === true,
        ),
      );
    };
    if (
      !capabilitiesFor(sessionBackends.get(sessionKey) ?? "pi").rewindFiles ||
      !hasMethod(agent, "rewindFiles")
    ) {
      const snapshot = await fromSnapshot();
      return sendJson(res, snapshot.ok ? 200 : 500, snapshot);
    }
    if (agent.status !== "ready" && agent.status !== "working" && rewindCwd) {
      await runLoggedCommand(sessionKey, "start", { cwd: rewindCwd }, () =>
        agent.start(
          rewindCwd,
          rewindSessionPath ? { sessionPath: rewindSessionPath } : {},
        ),
      );
    }
    const result = await runLoggedCommand(
      sessionKey,
      "rewind-files",
      body,
      () =>
        agent.rewindFiles(
          Number(body.timestamp),
          body.dryRun === true,
          rewindSessionPath || undefined,
        ),
    );
    if (result.ok) return sendJson(res, 200, result);
    const snapshot = await fromSnapshot();
    return sendJson(
      res,
      snapshot.ok ? 200 : 500,
      snapshot.ok ? snapshot : result,
    );
  }
  if (req.method === "POST" && action === "truncate") {
    const body = await readBody(req);
    const agent = watch(sessionKey);
    if (
      !capabilitiesFor(sessionBackends.get(sessionKey) ?? "pi").truncate ||
      !hasMethod(agent, "truncateAt")
    )
      return sendJson(
        res,
        200,
        unsupported(
          "truncate",
          "This agent cannot rewind a conversation yet. Use \u201cRestore files to this point\u201d to undo the edits instead.",
        ),
      );
    const result = await runLoggedCommand(sessionKey, "truncate", body, () =>
      agent.truncateAt(
        Number(body.userTimestamp),
        typeof body.sessionPath === "string" && body.sessionPath
          ? body.sessionPath
          : undefined,
      ),
    );
    return sendJson(res, result.ok ? 200 : 500, result);
  }
  if (req.method === "POST" && action === "goal") {
    const body = await readBody(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    return sendJson(res, 200, setSessionGoal(sessionKey, text));
  }
  // Recorded changes (changes.js): this session's latest turn, a given
  // `turn`, or the whole session. Reads only DevDen's own database.
  if (req.method === "GET" && action === "changes") {
    const scope = url.searchParams.get("scope") === "turn" ? "turn" : "session";
    try {
      return sendJson(
        res,
        200,
        await readChanges({
          sessionKey,
          sessionPath: url.searchParams.get("sessionPath") || "",
          scope,
          turnId: url.searchParams.get("turn"),
        }),
      );
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        error: String(error?.message ?? error),
      });
    }
  }
  // Working-tree changes for the post-turn "Changes" card: branch, GitHub
  // connectivity (an `origin` remote must exist — push errors surface on push),
  // and per-file status plus line counts. `?file=` returns that file's diff.
  // Read-only git, but the target dir still gets confined because the output
  // discloses repo contents.
  if (req.method === "GET" && action === "git-changes") {
    const cwdParam = url.searchParams.get("cwd") || "";
    let dir;
    try {
      dir = cwdParam ? confineWorkspacePath(cwdParam) : process.cwd();
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: String(error?.message ?? error),
      });
    }
    const git = async (args) => {
      try {
        const { stdout, stderr } = await execFileAsync(
          "git",
          ["-C", dir, ...args],
          { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
        );
        return { ok: true, stdout: String(stdout), stderr: String(stderr) };
      } catch (error) {
        return {
          ok: false,
          stdout: String(error?.stdout ?? ""),
          stderr: String(error?.stderr || error?.message || error),
        };
      }
    };
    const inside = await git(["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true")
      return sendJson(res, 200, {
        ok: true,
        repo: false,
        connected: false,
        changes: [],
      });
    // Review payload. Prefer the per-turn snapshot so leftover dirty files
    // from earlier turns are not in the evidence. Fall back to HEAD.
    if (url.searchParams.get("review") === "1") {
      // A task worktree's review unit is the whole branch -- its commits and
      // its uncommitted work -- not one turn. `diff <base>` spans both.
      if (url.searchParams.get("task") === "1") {
        const base = await baseOf(dir);
        if (base) {
          const whole = await git(["diff", "-U15", "--no-renames", base]);
          const diff = String(whole.stdout ?? "");
          return sendJson(res, 200, {
            ok: true,
            repo: true,
            scope: "task",
            base,
            diff: diff.slice(0, 400_000),
            truncated: diff.length > 400_000,
          });
        }
      }
      const since = Number(url.searchParams.get("since"));
      if (Number.isFinite(since) && since > 0) {
        const isolated = await diffSinceSnapshot(dir, since, 15);
        if (isolated.ok) {
          const diff = String(isolated.diff ?? "");
          return sendJson(res, 200, {
            ok: true,
            repo: true,
            scope: "turn",
            snapshotAt: isolated.snapshotAt,
            diff: diff.slice(0, 400_000),
            truncated: diff.length > 400_000,
          });
        }
      }
      const tracked = await git(["diff", "-U15", "HEAD"]);
      const others = await git(["ls-files", "--others", "--exclude-standard"]);
      const untracked = others.stdout
        .split("\n")
        .map((row) => row.trim())
        .filter(Boolean)
        .slice(0, 40);
      const extra = [];
      for (const file of untracked) {
        if (file.split(/[\\/]/).includes("..")) continue;
        const piece = await git([
          "diff",
          "-U15",
          "--no-index",
          "--",
          "/dev/null",
          file,
        ]);
        extra.push(piece.stdout);
      }
      const diff = [tracked.stdout, ...extra]
        .filter((block) => block && block.trim())
        .join("\n");
      return sendJson(res, 200, {
        ok: true,
        repo: true,
        scope: "head",
        diff: diff.slice(0, 400_000),
        truncated: diff.length > 400_000,
        untrackedOmitted: Math.max(
          0,
          others.stdout.split("\n").filter(Boolean).length - untracked.length,
        ),
      });
    }
    if (url.searchParams.has("file")) {
      const file = String(url.searchParams.get("file"));
      if (
        isAbsolute(file) ||
        file.split(/[\\/]/).includes("..") ||
        file.startsWith(":")
      )
        return sendJson(res, 400, { ok: false, error: "Invalid file path." });
      // Untracked files never appear in `git diff HEAD`; probe first. Base
      // mode (the explorer's Changes tab) asks for the branch's whole change
      // against its base commit, so the diff target widens with it.
      const base =
        url.searchParams.get("base") === "1" ? await baseOf(dir) : null;
      const probed = await git([
        "status",
        "--porcelain=v1",
        "--no-renames",
        "--",
        file,
      ]);
      const line = probed.stdout.split("\n").find((row) => row.length > 3);
      const diff = line?.startsWith("??")
        ? await git(["diff", "--no-index", "--", "/dev/null", file])
        : await git(["diff", base ?? "HEAD", "--", file]);
      const text = `${diff.stdout}${diff.stderr}`.trim();
      return sendJson(res, 200, {
        ok: true,
        diff: text.slice(0, 200_000),
      });
    }
    // Race scoreboards pass base=1: numstat against the worktree's recorded
    // base spans the branch's commits, not just the dirty tree.
    const taskBase =
      url.searchParams.get("base") === "1" ? await baseOf(dir) : null;
    const [
      remoteProbe,
      branchProbe,
      statusProbe,
      numstatProbe,
      trackingProbe,
      gitDirProbe,
      stashProbe,
      branchListProbe,
      remoteListProbe,
      logProbe,
    ] = await Promise.all([
      git(["remote", "get-url", "origin"]),
      git(["branch", "--show-current"]),
      git(["status", "--porcelain=v1", "--no-renames"]),
      git(["diff", "--numstat", taskBase ?? "HEAD"]),
      // Fails (not ok) when the branch has no upstream — that is the signal
      // for "never pushed", not an error worth surfacing.
      git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
      git(["rev-parse", "--absolute-git-dir"]),
      git(["stash", "list", "--format=%gd%x09%gs%x09%cr"]),
      git([
        "for-each-ref",
        "--sort=-committerdate",
        "--count=30",
        "--format=%(refname:short)",
        "refs/heads",
      ]),
      // Remote-tracking refs so a branch someone else pushed is reachable
      // after a fetch; `git switch <name>` turns one into a local branch.
      git([
        "for-each-ref",
        "--sort=-committerdate",
        "--count=30",
        "--format=%(refname:short)",
        "refs/remotes",
      ]),
      // Recent commits for the explorer's mini git panel.
      git(["log", "-8", "--format=%h%x09%s%x09%cr"]),
    ]);
    const remote = remoteProbe.ok ? remoteProbe.stdout.trim() : "";
    const branch = branchProbe.stdout.trim() || "(detached)";
    const counts = new Map();
    for (const row of numstatProbe.stdout.split("\n")) {
      const match = row.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (match)
        counts.set(match[3].replace(/^"|"$/g, ""), {
          additions: Number(match[1]) || 0,
          deletions: Number(match[2]) || 0,
        });
    }
    // `git status --porcelain` collapses a fully untracked directory into a
    // single "dir/" row, which is not a file: its per-file diff is a git
    // error and the pill would list a path instead of code. Expand it into
    // the files it contains so the pill rows and their diffs are real.
    let statusRows = statusProbe.stdout.split("\n");
    if (statusProbe.ok) {
      const expanded = [];
      await Promise.all(
        statusRows.map(async (row) => {
          const path = row.slice(3).replace(/^"|"$/g, "");
          if (!row.startsWith("??") || !path.endsWith("/")) {
            expanded.push(row);
            return;
          }
          const inside = await git([
            "ls-files",
            "-o",
            "--exclude-standard",
            "--",
            path.replace(/\/$/, ""),
          ]);
          const files = inside.ok
            ? inside.stdout.split("\n").filter(Boolean)
            : [];
          if (files.length === 0) return; // nothing trackable in there
          for (const file of files) expanded.push(`?? ${file}`);
        }),
      );
      statusRows = expanded;
    }
    // Untracked files have no numstat row; count them all at once. Probing
    // them one by one serialized a git spawn per file (dozens of them),
    // which is what kept the Changes pill blank for seconds.
    const untrackedPaths = statusRows
      .filter((row) => row.startsWith("??"))
      .map((row) => row.slice(3).replace(/^"|"$/g, ""));
    await Promise.all(
      untrackedPaths.map(async (path) => {
        const probe = await git([
          "diff",
          "--no-index",
          "--numstat",
          "--",
          "/dev/null",
          path,
        ]);
        const match = probe.stdout.match(/^(\d+|-)\t(\d+|-)\t/);
        counts.set(path, {
          additions: match ? Number(match[1]) || 0 : 0,
          deletions: match ? Number(match[2]) || 0 : 0,
        });
      }),
    );
    const changes = [];
    for (const row of statusRows) {
      if (row.length < 4) continue;
      const code = row.slice(0, 2);
      const path = row.slice(3).replace(/^"|"$/g, "");
      const untracked = code.startsWith("??");
      // Unmerged index states: both/either side added, deleted or modified.
      // They are NOT "modified" — committing one writes conflict markers.
      const conflicted = code === "AA" || code === "DD" || code.includes("U");
      const letter = untracked ? "A" : code[1] === "." ? code[0] : code[1];
      const stat = counts.get(path) ?? { additions: 0, deletions: 0 };
      changes.push({
        path,
        status: conflicted
          ? "conflicted"
          : letter === "A"
            ? "added"
            : letter === "D"
              ? "deleted"
              : "modified",
        additions: stat.additions,
        deletions: stat.deletions,
      });
      // One row per file: a path can appear staged AND worktree-modified;
      // skip duplicates (deeper status merge would double-count).
      counts.delete(path);
    }
    // Base mode only: the leftover numstat rows are commit-clean paths, i.e.
    // the branch's committed work, which status never lists.
    if (taskBase) {
      for (const [path, stat] of counts) {
        changes.push({
          path,
          status: "modified",
          additions: stat.additions,
          deletions: stat.deletions,
        });
      }
    }
    const tracking = trackingProbe.stdout.trim().match(/^(\d+)\s+(\d+)$/);
    const state = gitStateFromDir(gitDirProbe.stdout.trim());
    const stashes = [];
    for (const row of stashProbe.stdout.split("\n")) {
      const [ref, label, age] = row.split("\t");
      if (!/^stash@\{\d+\}$/.test(ref ?? "")) continue;
      stashes.push({ ref, label: label ?? "", age: age ?? "" });
    }
    const branches = branchListProbe.stdout
      .split("\n")
      .map((row) => row.trim())
      .filter(Boolean);
    const local = new Set(branches);
    // Strip the remote prefix and drop anything already checked out locally or
    // pointing at HEAD — what is left is "branches you could switch to".
    const remoteBranches = [];
    for (const row of remoteListProbe.stdout.split("\n")) {
      const ref = row.trim();
      const slash = ref.indexOf("/");
      if (slash < 0 || ref.endsWith("/HEAD")) continue;
      const name = ref.slice(slash + 1);
      if (local.has(name) || remoteBranches.includes(name)) continue;
      remoteBranches.push(name);
    }
    return sendJson(res, 200, {
      ok: true,
      repo: true,
      connected: Boolean(remote),
      remote,
      branch,
      changes,
      upstream: trackingProbe.ok,
      ahead: tracking ? Number(tracking[1]) : 0,
      behind: tracking ? Number(tracking[2]) : 0,
      stashes,
      branches,
      remoteBranches,
      log: logProbe.stdout
        .split("\n")
        .map((row) => row.split("\t"))
        .filter((row) => row.length === 3)
        .map(([hash, subject, age]) => ({ hash, subject, age })),
      state,
      conflicts: changes
        .filter((change) => change.status === "conflicted")
        .map((change) => change.path),
    });
  }
  // Revert a single hunk of a file's working-tree changes: rebuild a patch
  // containing just that hunk and apply it in reverse.
  if (req.method === "POST" && action === "git-hunk") {
    const body = await readBody(req);
    const dir =
      typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd();
    const file = String(body.file ?? "");
    const hunkIndex = Number(body.hunkIndex);
    try {
      confineWorkspacePath(dir);
      if (
        !file ||
        isAbsolute(file) ||
        file.split(/[\\/]/).includes("..") ||
        file.startsWith(":")
      )
        throw new Error(`Invalid file path: ${file}`);
      if (!Number.isInteger(hunkIndex) || hunkIndex < 0)
        throw new Error("Invalid hunk index.");
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: String(error?.message ?? error),
      });
    }
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "git-hunk", body, async () => {
        let diff = "";
        try {
          const { stdout } = await execFileAsync(
            "git",
            ["-C", dir, "diff", "--unified=3", "--", file],
            { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
          );
          diff = String(stdout);
        } catch (error) {
          return {
            ok: false,
            error: String(error?.stderr || error?.message || error),
          };
        }
        if (!diff.trim())
          return {
            ok: false,
            error:
              "No tracked changes for that file — an untracked file has no hunks to revert.",
          };
        const { header, hunks } = splitDiffHunks(diff);
        const hunk = hunks[hunkIndex];
        if (!hunk)
          return { ok: false, error: "That hunk is no longer in the diff." };
        const patch = `${[...header, ...hunk.lines].join("\n").replace(/\n*$/, "")}\n`;
        const applied = await new Promise((resolve) => {
          const child = spawn(
            "git",
            ["-C", dir, "apply", "--reverse", "--recount", "-"],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("error", (error) =>
            resolve({ ok: false, error: String(error?.message ?? error) }),
          );
          child.on("close", (code) =>
            resolve(
              code === 0
                ? { ok: true }
                : {
                    ok: false,
                    error: stderr.trim() || `git apply exited ${code}`,
                  },
            ),
          );
          child.stdin.end(patch);
        });
        if (!applied.ok) return applied;
        return {
          ok: true,
          data: { file, hunkIndex, remaining: hunks.length - 1 },
        };
      }),
    );
  }

  // Worktrees: file isolation per session or per board card. A tab's cwd is
  // all that changes -- every backend already takes its cwd from the client,
  // so nothing in the agent adapters needs to know these exist.
  if (req.method === "GET" && action === "worktrees") {
    let dir;
    try {
      dir = confineWorkspacePath(String(url.searchParams.get("cwd") ?? ""));
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: String(error?.message ?? error),
      });
    }
    const trees = await listWorktrees(dir);
    return sendJson(res, 200, {
      ok: true,
      current: await toplevelOf(dir),
      base: trees.length > 1 ? await baseOf(dir) : null,
      worktrees: trees,
    });
  }
  if (req.method === "POST" && action === "worktree") {
    const body = await readBody(req);
    let dir;
    try {
      dir = confineWorkspacePath(
        typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd(),
      );
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: String(error?.message ?? error),
      });
    }
    const op = body.op === "remove" ? "remove" : "create";
    const result = await runLoggedCommand(
      sessionKey,
      `worktree-${op}`,
      body,
      async () => {
        if (op === "remove") {
          // The path to delete comes from the browser: confine it before a
          // `worktree remove --force` can be pointed anywhere.
          let target;
          try {
            target = confineWorkspacePath(String(body.path ?? ""));
          } catch (error) {
            return { ok: false, error: String(error?.message ?? error) };
          }
          return removeWorktree(dir, target, body.force === true);
        }
        const made = await createWorktree(dir, String(body.name ?? "task"));
        // The new checkout becomes a session cwd, so it has to be reachable
        // by the workspace endpoints the file explorer and git ops use.
        if (made.ok) addWorkspaceRoot(made.data.path);
        return made;
      },
    );
    return sendJson(res, result.ok ? 200 : 500, result);
  }
  if (req.method === "POST" && action === "git") {
    const body = await readBody(req);
    const op = GIT_WRITE_OPS.has(body.op) ? body.op : "push";
    const dir =
      typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd();
    // git pull/push run repo hooks (post-merge, pre-push) as this user, so the
    // target must be a repo inside the workspace roots — never an arbitrary dir.
    try {
      confineWorkspacePath(dir);
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: String(error?.message ?? error),
      });
    }
    const result = await runLoggedCommand(
      sessionKey,
      `git-${op}`,
      body,
      async () => {
        const run = (args) =>
          execFileAsync("git", ["-C", dir, ...args], {
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
          });
        const text = (done) => `${done.stdout}${done.stderr}`.trim();
        // Optional file selection: when the client sends `files`, act on only
        // those (paths are repo-relative and validated); otherwise act on the
        // whole tree. Returns undefined when the client sent no selection.
        const pickFiles = () => {
          if (!Array.isArray(body.files)) return undefined;
          const files = body.files.filter((f) => typeof f === "string" && f);
          if (files.length === 0) throw new Error("No files selected.");
          for (const file of files) {
            if (
              isAbsolute(file) ||
              file.split(/[\\/]/).includes("..") ||
              file.startsWith(":")
            )
              throw new Error(`Invalid file path: ${file}`);
          }
          return files;
        };
        // Paths git still considers unmerged. `git add` + `git commit` on one
        // of these silently records the conflict markers as the resolution,
        // so every op that commits has to refuse while any exist.
        const unmergedPaths = async () => {
          try {
            const done = await run(["diff", "--name-only", "--diff-filter=U"]);
            return done.stdout.split("\n").filter(Boolean);
          } catch {
            return [];
          }
        };
        try {
          if (op === "continue" || op === "abort") {
            const state = await gitProgressState(dir);
            if (state === "clean")
              return {
                ok: false,
                error: "No merge, rebase, cherry-pick or revert in progress.",
              };
            const command =
              state === "merging"
                ? "merge"
                : state === "rebasing"
                  ? "rebase"
                  : state === "cherry-picking"
                    ? "cherry-pick"
                    : "revert";
            if (op === "abort") {
              const done = await run([command, "--abort"]);
              return {
                ok: true,
                output:
                  text(done) ||
                  `Aborted the ${command}; the repo is back where it started.`,
              };
            }
            // An unmerged index entry is not itself a blocker — git keeps one
            // until the resolution is staged, which is what Continue does
            // next. What must not pass is a file still holding markers.
            const unresolved = [];
            for (const path of await unmergedPaths()) {
              try {
                const content = readFileSync(join(dir, path), "utf8");
                if (/^<{7}/m.test(content) || /^>{7}/m.test(content))
                  unresolved.push(path);
              } catch {
                /* deleted or binary: let git judge it at --continue */
              }
            }
            if (unresolved.length)
              return {
                ok: false,
                error: `Conflict markers are still in:\n${unresolved.join("\n")}`,
              };
            // Stage the resolutions, then let git write the merge/rebase commit
            // with its own prepared message (GIT_EDITOR=true accepts it).
            await run(["add", "-A"]);
            const done = await execFileAsync(
              "git",
              ["-C", dir, command, "--continue"],
              {
                timeout: 120_000,
                maxBuffer: 4 * 1024 * 1024,
                env: { ...process.env, GIT_EDITOR: "true" },
              },
            );
            return {
              ok: true,
              output: text(done) || `Finished the ${command}.`,
            };
          }
          if (op === "commit" || op === "commit-push") {
            const message =
              typeof body.message === "string" ? body.message.trim() : "";
            if (!message)
              return { ok: false, error: "Commit message required." };
            const blocked = await unmergedPaths();
            if (blocked.length)
              return {
                ok: false,
                error: `Cannot commit with an unresolved conflict in:\n${blocked.join("\n")}\nResolve them, then use Continue.`,
              };
            const out = [];
            const files = pickFiles();
            // A selective commit takes a pathspec rather than the bare index,
            // so files staged outside this request (a manual git add, an old
            // client) can never ride along.
            try {
              await run(files ? ["add", "--", ...files] : ["add", "-A"]);
              const commit = await run(
                files
                  ? ["commit", "-m", message, "--", ...files]
                  : ["commit", "-m", message],
              );
              out.push(text(commit));
            } catch (error) {
              const failure = String(error?.stderr || error?.message || error);
              if (!/nothing to commit|no changes added/i.test(failure))
                return { ok: false, error: failure };
              out.push("Nothing new to commit.");
            }
            if (op === "commit")
              return { ok: true, output: out.filter(Boolean).join("\n") };
            try {
              const push = await run(["push"]);
              out.push(text(push));
            } catch (error) {
              const failure = String(error?.stderr || error?.message || error);
              if (!/no upstream|has no upstream/i.test(failure))
                return { ok: false, error: failure };
              // First push of a fresh branch: bind it to origin.
              try {
                const retry = await run(["push", "-u", "origin", "HEAD"]);
                out.push(text(retry));
              } catch (error2) {
                return {
                  ok: false,
                  error: String(error2?.stderr || error2?.message || error2),
                };
              }
            }
            return { ok: true, output: out.filter(Boolean).join("\n") };
          }
          if (op === "pr") {
            // gh reads the branch and its upstream, so the branch has to be
            // pushed before there is anything to open a PR against.
            const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
            const head = branch.stdout.trim();
            if (!head || head === "HEAD")
              return { ok: false, error: "Not on a branch." };
            try {
              await run(["push", "-u", "origin", head]);
            } catch (error) {
              const failure = String(error?.stderr || error?.message || error);
              if (!/everything up-to-date/i.test(failure))
                return { ok: false, error: failure };
            }
            const title =
              typeof body.message === "string" ? body.message.trim() : "";
            try {
              const done = await execFileAsync(
                "gh",
                [
                  "pr",
                  "create",
                  "--head",
                  head,
                  ...(title ? ["--title", title, "--body", ""] : ["--fill"]),
                ],
                { cwd: dir, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
              );
              const output = `${done.stdout}${done.stderr}`.trim();
              return {
                ok: true,
                output,
                url: output.match(/https:\/\/\S+/)?.[0],
              };
            } catch (error) {
              const failure = String(error?.stderr || error?.message || error);
              // An existing PR is a success from the user's point of view:
              // hand back its URL instead of an error they cannot act on.
              if (/already exists/i.test(failure))
                return {
                  ok: true,
                  output: failure,
                  url: failure.match(/https:\/\/\S+/)?.[0],
                };
              if (/not found|command not found|ENOENT/i.test(failure))
                return {
                  ok: false,
                  error:
                    "The GitHub CLI (gh) is not installed, so a pull request cannot be opened from here. The branch has been pushed.",
                };
              return { ok: false, error: failure };
            }
          }
          if (op === "stash") {
            const label =
              typeof body.message === "string" ? body.message.trim() : "";
            // -u so a stash actually empties the tree the Changes list shows;
            // untracked files are the common case for a fresh agent turn.
            const args = ["stash", "push", "--include-untracked"];
            if (label) args.push("-m", label.slice(0, 200));
            const files = pickFiles();
            if (files) args.push("--", ...files);
            const done = await run(args);
            return { ok: true, output: text(done) || "Nothing to stash." };
          }
          if (
            op === "stash-apply" ||
            op === "stash-pop" ||
            op === "stash-drop"
          ) {
            const ref = typeof body.ref === "string" ? body.ref : "stash@{0}";
            if (!/^stash@\{\d{1,3}\}$/.test(ref))
              return { ok: false, error: "Invalid stash reference." };
            const sub = op.slice("stash-".length);
            const done = await run(["stash", sub, ref]);
            return { ok: true, output: text(done) || `Stash ${sub} done.` };
          }
          if (op === "branch-create" || op === "branch-switch") {
            const branch =
              typeof body.branch === "string" ? body.branch.trim() : "";
            if (!isSafeBranchName(branch))
              return { ok: false, error: `Invalid branch name: ${branch}` };
            // `switch` refuses to clobber a dirty tree on its own, which is the
            // safe default here: no silent carry-over of the agent's edits.
            const done = await run(
              op === "branch-create"
                ? ["switch", "--create", branch]
                : ["switch", branch],
            );
            return { ok: true, output: text(done) || `On ${branch}.` };
          }
          if (op === "undo-commit") {
            // --soft: the commit disappears, its content lands back in the
            // working tree. The UI only offers this for unpushed commits, so
            // it can never leave the branch needing a force-push.
            const done = await run(["reset", "--soft", "HEAD~1"]);
            return {
              ok: true,
              output:
                text(done) ||
                "Last commit undone; its changes are back in the working tree.",
            };
          }
          if (op === "fetch") {
            // --prune so branches deleted on the remote stop showing as
            // upstream candidates; no working-tree side effects.
            const done = await run(["fetch", "--prune"]);
            return { ok: true, output: text(done) || "Already up to date." };
          }
          // --no-rebase merges divergent history instead of failing on git's
          // pull.rebase prompt; --rebase replays local commits on top instead.
          // --autostash lets either run with the agent's uncommitted work in
          // the tree and puts it back afterwards.
          const args =
            op === "pull"
              ? ["pull", "--no-rebase", "--autostash"]
              : op === "pull-rebase"
                ? ["pull", "--rebase", "--autostash"]
                : ["push"];
          const done = await run(args);
          return { ok: true, output: text(done) };
        } catch (error) {
          return {
            ok: false,
            error: String(error?.stderr || error?.message || error),
          };
        }
      },
    );
    return sendJson(res, 200, result);
  }
  if (req.method === "POST" && action === "compact") {
    const body = await readBody(req);
    const compactBackend = sessionBackends.get(sessionKey) ?? "pi";
    if (!capabilitiesFor(compactBackend).compact) {
      return sendJson(
        res,
        200,
        unsupported("compact", "This agent cannot compact a conversation."),
      );
    }
    const instructions = capabilitiesFor(compactBackend).compactInstructions
      ? body.customInstructions
      : undefined;
    // Lazy (re)start, same as the prompt route: a session opened for
    // display has no agent process yet (pi spawns on the first message),
    // and compact re-summarizes through the model, so it needs a live
    // process. Start one instead of failing with "process is not running".
    adoptLiveAgent(sessionKey, compactBackend, body.sessionPath);
    const agent = watch(sessionKey, compactBackend);
    if (!agentIsAlive(agent)) {
      const started = await runLoggedCommand(sessionKey, "start", body, () =>
        agent.start(String(body.cwd || process.cwd()), {
          sessionPath:
            typeof body.sessionPath === "string" && body.sessionPath
              ? body.sessionPath
              : undefined,
          model:
            body.model && typeof body.model === "object"
              ? {
                  provider: String(body.model.provider || ""),
                  id: String(body.model.id || ""),
                }
              : undefined,
          thinkingLevel:
            typeof body.thinkingLevel === "string"
              ? body.thinkingLevel
              : undefined,
        }),
      );
      if (!started.ok) return sendJson(res, 500, started);
    }
    const sessionPath = sessionPathOf(agent);
    let before = await clientMessages(agent, sessionPath);
    // Lazy-start tabs hydrate from disk and may have an empty in-memory
    // log; compact still has to snapshot that transcript for reload.
    if (before.length === 0 && sessionPath) {
      const disk = await readSessionMessages(sessionPath);
      if (disk.ok && Array.isArray(disk.messages) && disk.messages.length > 0)
        before = await withDisplayHistory(sessionPath, disk.messages);
    }
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "compact", body, async () => {
        const result = await callAgentMethod(
          agent,
          "compact",
          [instructions],
          "compact",
        );
        if (result?.ok && sessionPath && before.length > 0) {
          const after = Array.isArray(result.messages)
            ? result.messages
            : await rawAgentMessages(agent);
          await saveDisplayOverlay(sessionPath, { before, after });
        }
        // Do not send the rewritten history to the client — the on-screen
        // transcript stays as it was; only the model context is compacted.
        if (result && Array.isArray(result.messages)) {
          const rest = { ...result };
          delete rest.messages;
          return rest;
        }
        return result;
      }),
    );
  }
  if (req.method === "POST" && action === "set-model") {
    const body = await readBody(req);
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "set-model", body, () =>
        watch(sessionKey).setModel(String(body.provider), String(body.modelId)),
      ),
    );
  }
  if (req.method === "POST" && action === "set-thinking") {
    const body = await readBody(req);
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "set-thinking", body, () =>
        watch(sessionKey).setThinkingLevel(String(body.level)),
      ),
    );
  }
  if (req.method === "POST" && action === "rename") {
    const body = await readBody(req);
    const title =
      typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
    if (!title)
      return sendJson(res, 200, { ok: false, error: "title required" });
    return sendJson(
      res,
      200,
      await runLoggedCommand(sessionKey, "rename", body, async () => {
        const result = await callAgentMethod(
          watch(sessionKey),
          "setSessionName",
          [title],
          "rename",
        );
        if (result?.ok ?? result?.success) {
          publishRuntimeEvent(sessionKey, "pi", {
            type: "session_title_set",
            title,
          });
        }
        return result?.ok
          ? result
          : { ...result, ok: Boolean(result?.success) };
      }),
    );
  }
  if (req.method === "POST" && action === "terminal") {
    const body = await readBody(req);
    const op = String(body.op ?? "");
    // Tabs are owned by the server, not the agent process: they outlive the
    // agent and stream to the browser on the same SSE bus. Chunks bypass
    // the runtime log (they would evict real turn events); the tab's
    // open/exit lifecycle is logged so a refreshed page can show the tab.
    if (op === "run") {
      const command = typeof body.command === "string" ? body.command : "";
      if (!command.trim())
        return sendJson(res, 200, { ok: false, error: "command required" });
      const tab = terminalTabs.run({
        sessionKey,
        command,
        cwd: typeof body.cwd === "string" && body.cwd ? body.cwd : undefined,
        title: typeof body.title === "string" ? body.title : undefined,
      });
      return sendJson(res, 200, { ok: true, tabId: tab.tabId });
    }
    if (op === "read")
      return sendJson(
        res,
        200,
        await terminalTabs.read({
          sessionKey,
          tabId: String(body.tabId ?? ""),
          waitMs: Number(body.waitMs) || 0,
          lines: Number(body.lines) || 400,
        }),
      );
    if (op === "stop")
      return sendJson(
        res,
        200,
        terminalTabs.stop({ sessionKey, tabId: String(body.tabId ?? "") }),
      );
    return sendJson(res, 200, { ok: false, error: "unknown terminal op" });
  }
  if (req.method === "GET" && action === "state") {
    // Live state snapshot for the stream-reconnect self-heal: after the SSE
    // connection drops, the UI asks whether a mid-turn "working" flag is
    // still true instead of trusting its stale local copy.
    try {
      const requested = url.searchParams.get("backend") || undefined;
      const state = await watch(sessionKey, requested).getState();
      const backend = backendName(
        requested || sessionBackends.get(sessionKey) || "pi",
      );
      return sendJson(res, 200, {
        ok: true,
        state: state
          ? { ...state, capabilities: capabilitiesFor(backend) }
          : null,
      });
    } catch {
      return sendJson(res, 200, { ok: true, state: null });
    }
  }
  if (req.method === "GET" && action === "commands") {
    const agent = watch(
      sessionKey,
      url.searchParams.get("backend") || undefined,
    );
    if (!hasMethod(agent, "getCommands"))
      return sendJson(res, 200, { ok: true, commands: [] });
    // cwd lets a cold pi session (no process yet) list commands from the
    // right project instead of 500ing — see PiAgentProcess.getCommands.
    return sendJson(
      res,
      200,
      await agent.getCommands(url.searchParams.get("cwd") || undefined),
    );
  }
  if (req.method === "GET" && action === "models")
    return sendJson(
      res,
      200,
      await cachedModels(
        watch(sessionKey, url.searchParams.get("backend") || undefined, false),
      ),
    );
  if (req.method === "GET" && action === "thinking-levels") {
    const agent = watch(
      sessionKey,
      url.searchParams.get("backend") || undefined,
      false,
    );
    if (!hasMethod(agent, "getThinkingLevels"))
      return sendJson(res, 200, { ok: true, levels: [] });
    return sendJson(res, 200, await agent.getThinkingLevels());
  }
  if (req.method === "GET" && action === "usage") {
    const refresh = url.searchParams.get("refresh") === "1";
    // Session path lets a lazily-viewed session (no live process) answer
    // usage from its session file instead of "nothing to report".
    const sessionPath = url.searchParams.get("sessionPath") || undefined;
    const result = await watch(
      sessionKey,
      url.searchParams.get("backend") || undefined,
    ).getUsage(refresh, sessionPath);
    return sendJson(res, result.ok ? 200 : 500, result);
  }

  return sendJson(res, 404, { ok: false, error: "unknown route" });
}

// A crash mid-turn is invisible, and its consequences read as a UI bug: the
// in-flight events die with the process, every open page freezes on stuck tool
// cards, and only a manual refresh recovers it. The supervisor restarts on
// exit, so leave the stack in the inherited output instead of losing it.
for (const signal of ["uncaughtException", "unhandledRejection"]) {
  process.on(signal, (error) => {
    logFault(`${signal} -- restarting`, error);
    process.exit(1);
  });
}

const server = createServer((req, res) => {
  const origin = String(req.headers.origin || "");
  if (origin && !isAllowedOrigin(origin))
    return sendJson(res, 403, { ok: false, error: "Origin not allowed." });
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }
  route(req, res).catch((error) =>
    sendJson(res, error?.statusCode ?? 500, {
      ok: false,
      error: String(error?.message ?? error),
    }),
  );
});

const terminalSockets = new WebSocketServer({ noServer: true });
// Upgrades for /api/events-ws share the same auth gate as terminals below;
// the connections themselves live in the eventSockets fan-out set.
const eventSocketsServer = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || `${HOST}:${PORT}`}`,
  );
  // WebSockets are not subject to CORS — the server must validate Origin
  // itself. Browsers always send it; a missing Origin (non-browser client) is
  // allowed, a non-allowlisted one is destroyed before any bytes are exchanged.
  const origin = String(req.headers.origin || "");
  if (origin && !isAllowedOrigin(origin)) {
    socket.destroy();
    return;
  }
  if (
    (url.pathname !== "/api/terminal" && url.pathname !== "/api/events-ws") ||
    !requestHasAccess(req, url)
  ) {
    socket.destroy();
    return;
  }
  if (url.pathname === "/api/events-ws") {
    eventSocketsServer.handleUpgrade(req, socket, head, (webSocket) => {
      // Same contract as /api/events: __hello on connect, the shared
      // broadcast() fan-out, and the 10s __ping keeping it distinguishable
      // from a half-open proxy connection.
      try {
        webSocket.send(JSON.stringify({ type: "__hello" }));
      } catch {
        /* dropped */
      }
      eventSockets.add(webSocket);
      webSocket.on("close", () => eventSockets.delete(webSocket));
      webSocket.on("error", () => eventSockets.delete(webSocket));
    });
    return;
  }
  terminalSockets.handleUpgrade(req, socket, head, (webSocket) =>
    terminalSockets.emit("connection", webSocket, req, url),
  );
});

terminalSockets.on("connection", (socket, _request, url) => {
  const requestedCwd = url.searchParams.get("cwd") || homedir();
  const cwd =
    existsSync(requestedCwd) && statSync(requestedCwd).isDirectory()
      ? requestedCwd
      : homedir();
  const shell = process.env.SHELL || "/bin/sh";
  let terminal;
  try {
    terminal = pty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
  } catch (error) {
    socket.send(
      `\r\n\x1b[31mCould not start the shell: ${String(error?.message ?? error)}\x1b[0m\r\n`,
    );
    socket.close();
    return;
  }
  terminal.onData((data) => {
    if (socket.readyState === socket.OPEN) socket.send(data);
  });
  terminal.onExit(() => {
    clearInterval(cwdTimer);
    socket.close();
  });

  // Track the shell's live working directory (cd inside the terminal moves
  // the SHELL process, not the spawned cwd) and push it to the UI. Control
  // messages are prefixed with NUL — real terminal output never starts a
  // chunk with NUL + '{'. Polling: /proc on Linux, lsof on macOS.
  let lastCwd = cwd;
  const pushCwd = async () => {
    try {
      let cwdNow;
      if (process.platform === "darwin") {
        const { stdout } = await execFileAsync(
          "lsof",
          ["-a", "-p", String(terminal.pid), "-d", "cwd", "-Fn"],
          { timeout: 5_000 },
        );
        const line = String(stdout)
          .split("\n")
          .find((row) => row.startsWith("n/"));
        cwdNow = line ? line.slice(1) : undefined;
      } else {
        cwdNow = await readlink(join("/proc", String(terminal.pid), "cwd"));
      }
      if (cwdNow && cwdNow !== lastCwd && socket.readyState === socket.OPEN) {
        lastCwd = cwdNow;
        socket.send(`\u0000${JSON.stringify({ type: "cwd", cwd: cwdNow })}`);
      }
    } catch {
      /* shell exited or lsof unavailable; the interval just no-ops */
    }
  };
  const cwdTimer = setInterval(() => void pushCwd(), 3_000);
  setTimeout(() => void pushCwd(), 500);
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.type === "input" && typeof message.data === "string")
      terminal.write(message.data);
    if (message.type === "resize") {
      const cols = Math.max(2, Math.min(500, Number(message.cols) || 80));
      const rows = Math.max(1, Math.min(200, Number(message.rows) || 24));
      terminal.resize(cols, rows);
    }
  });
  socket.on("close", () => {
    clearInterval(cwdTimer);
    terminal.kill();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`devden ready: http://${HOST}:${PORT}`);
  // Warm the session-summary cache so the first sidebar load (and the first
  // backend switch after a restart) reads stats, not 175MB of JSONL.
  for (const backend of AGENT_BACKENDS)
    void listSessions({ backend }).catch(() => {});
  void resumeInterruptedTurns();
  startClaudeAuthKeepalive();
  listOllamaModels()
    .then((models) => syncOllamaModelsJson(models))
    .catch(() => {});
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    piPool.stop();
    claudePool.stop();
    grokPool.stop();
    codexPool.stop();
    closeSharedCodex();
    sessionBackends.clear();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
