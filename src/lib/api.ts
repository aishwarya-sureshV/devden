/** Types shared with the devden server. */

import type { SessionRoute } from "./route";

export type RunStatus = "stopped" | "starting" | "ready" | "working" | "error";
export const AGENT_BACKENDS = ["pi", "claude", "grok", "codex"] as const;
export type BuiltinBackend = (typeof AGENT_BACKENDS)[number];
/** Backend ids arrive as plain strings from the server; built-ins are the known ones. */
export type AgentBackend = BuiltinBackend | (string & {});

export type BackendAuth = "ok" | "missing" | "unknown";

export interface BackendInfo {
  id: string;
  name: string;
  command: string;
  args: string[];
  path: string | null;
  pathLabel: string | null;
  version: string | null;
  auth: BackendAuth;
  installCommand: string | null;
  loginCommand: string | null;
  connectCommand?: string;
  capabilities: import("./agentCapabilities").AgentCapabilities;
}

let catalogIds: string[] | null = null;

/** Ids from GET /api/backends. */
export function installBackendCatalog(list: BackendInfo[]) {
  catalogIds = list.map((item) => item.id);
}

export function agentBackendIds(): readonly string[] {
  return catalogIds ?? AGENT_BACKENDS;
}

export function backendLabel(backend: AgentBackend): string {
  if (backend === "claude") return "Claude";
  if (backend === "grok") return "Grok";
  if (backend === "codex") return "Codex";
  if (backend === "pi") return "Pi";
  return backend || "Pi";
}

/** Glyph + CSS color for the 2B sidebar agent mark. */
export function backendMark(backend: AgentBackend): {
  glyph: string;
  color: string;
  blurb: string;
} {
  // Claude's signature amber ("crail"). Fixed — no theme or state overrides it.
  if (backend === "claude")
    return { glyph: "✳", color: "var(--glyph-claude, #d97757)", blurb: "acp" };
  if (backend === "grok")
    return { glyph: "✦", color: "var(--glyph-grok, #ececf1)", blurb: "cloud" };
  if (backend === "codex")
    return { glyph: "⬡", color: "var(--glyph-codex, #ececf1)", blurb: "codex" };
  if (backend === "pi")
    return {
      glyph: "π",
      color: "var(--glyph-pi, #5fd49a)",
      blurb: "local shell agent",
    };
  return { glyph: "✦", color: "var(--pw-teal)", blurb: "acp" };
}

export interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  /** Thinking levels this model supports, from the pi model catalog. */
  levels?: string[];
}

/** A prompt waiting for the running turn to finish. */
export interface QueuedMessage {
  id: string;
  message: string;
  at: number;
}

export interface PendingUserInput {
  requestId: string;
  questions: (import("./askBlock").AskQuestion & { id: string; isSecret?: boolean; link?: string })[];
}

export interface SessionState {
  model: ModelInfo | null;
  thinkingLevel: string;
  isStreaming: boolean;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  messageCount: number;
  pendingMessageCount: number;
  queuedMessages?: QueuedMessage[];
  pendingUserInputs?: PendingUserInput[];
  contextWindow?: number;
  turnDiff?: string;
  capabilities?: import("./agentCapabilities").AgentCapabilities;
}

export interface UsageWindow {
  label: string;
  usedPercent?: number;
  /** Pre-rendered value for providers that report counts ("410 req") instead of a percent. */
  usedText?: string;
  /** Epoch ms, so the client can count down rather than print a fixed string. */
  resetsAt?: number;
}

export interface ProviderUsage {
  available: boolean;
  provider?: string;
  plan?: string;
  windows: UsageWindow[];
  tokens?: {
    input: number;
    output: number;
    total: number;
  };
  updatedAt?: string;
}

export interface ResumeSession {
  path: string;
  name: string;
  cwd: string;
  createdAt: number;
  modifiedAt: number;
  messageCount: number;
  backend: AgentBackend;
  firstPrompt?: string;
  /** Tail of the final assistant message, when it is the last message in the
   *  session — the sidebar runs the awaiting-answer rule on it. */
  lastAssistantText?: string;
  lastModel?: string;
  /** Provider of `lastModel` (pi sessions), so the picker can restore it. */
  lastModelProvider?: string;
  /** Every model that produced a turn in this session, including one-off swaps. */
  models?: string[];
  lastEffort?: string;
  /** True while an agent turn is in flight for this file. */
  isStreaming?: boolean;
}

export interface GitChange {
  path: string;
  status: "added" | "modified" | "deleted" | "conflicted";
  additions: number;
  deletions: number;
}

export type ChangeScope = "turn" | "session";

/** One file in a recorded turn/session view (server/changes.js). */
export interface RecordedChange extends GitChange {
  /** "tool": an edit tool named it. "command": changed by a shell command. */
  source: "tool" | "command";
  /** Another session in this checkout touched it too; the diff may mix. */
  shared: boolean;
  /** False when the diff can't be pinned on this session alone. */
  exact: boolean;
  /** The file changed again after this view's last turn. */
  drift: boolean;
  /** Too large to keep; listed without a diff. */
  skipped: boolean;
  turns: number;
  diff: string;
}

export interface RecordedTurn {
  id: number;
  startedAt: number;
  endedAt: number;
  label: string;
  concurrent: number;
  files: number;
}

export interface ChangesResponse {
  ok: boolean;
  scope?: ChangeScope;
  running?: boolean;
  turn?: RecordedTurn | null;
  turns?: RecordedTurn[];
  files?: RecordedChange[];
  error?: string;
}

export interface GitStash {
  /** `stash@{0}` — the only form the server accepts back. */
  ref: string;
  label: string;
  age: string;
}

export interface GitChangesResponse {
  ok: boolean;
  error?: string;
  /** False when cwd is not a git repo. */
  repo?: boolean;
  /** True when an origin remote exists (push target available). */
  connected?: boolean;
  remote?: string;
  branch?: string;
  changes?: GitChange[];
  /** False when the branch has never been pushed (no upstream to compare). */
  upstream?: boolean;
  /** Commits on this branch the upstream lacks, and vice versa. */
  ahead?: number;
  behind?: number;
  stashes?: GitStash[];
  /** Local branches, most recently committed first. */
  branches?: string[];
  /** Remote-tracking branches with no local counterpart, prefix stripped. */
  remoteBranches?: string[];
  /** Latest commits on HEAD, newest first. */
  log?: { hash: string; subject: string; age: string }[];
  /** A half-finished operation the repo is sitting in, if any. */
  state?: "clean" | "merging" | "rebasing" | "cherry-picking" | "reverting";
  /** Paths git still reports as unmerged. */
  conflicts?: string[];
}

/** Every git action the UI can trigger. Mirrors GIT_WRITE_OPS on the server. */
export type GitOp =
  | "push"
  | "pull"
  | "pull-rebase"
  | "fetch"
  | "commit"
  | "commit-push"
  | "stash"
  | "stash-apply"
  | "stash-pop"
  | "stash-drop"
  | "branch-create"
  | "branch-switch"
  | "undo-commit"
  | "continue"
  | "abort"
  /** Push the branch and open a pull request for it (needs the gh CLI). */
  | "pr";

export interface GitOpOptions {
  /** Commit message, or the stash label. */
  message?: string;
  /** Repo-relative paths to limit a commit or stash to. */
  files?: string[];
  /** Target for stash-apply/pop/drop. */
  ref?: string;
  /** Target for branch-create/branch-switch. */
  branch?: string;
}

export interface SlashCommand {
  name: string;
  description?: string;
  source?: string;
  argumentHint?: string;
}

export interface ImageAttachment {
  type: "image";
  data: string;
  mimeType: string;
}

export interface SessionHistoryMessage {
  role?: string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  errorMessage?: string;
  stopReason?: string;
  [key: string]: unknown;
}

/** One session that matched a transcript search, with the lines that matched. */
export interface SessionSearchResult {
  path: string;
  name: string;
  cwd: string;
  backend: AgentBackend;
  modifiedAt: number;
  messageCount: number;
  snippets: Array<{ role: string; text: string }>;
}

export interface SessionSnapshotResponse {
  ok: boolean;
  state?: SessionState;
  messages?: SessionHistoryMessage[];
  error?: string;
  unsupported?: boolean;
  capability?: string;
  /** True when the live conversation was preserved and `state` describes the fork. */
  restored?: boolean;
  /** Worktree/cwd for the forked session (falls back to the original cwd). */
  forkCwd?: string;
  /** Isolated checkout created for this fork, when the parent cwd is a git repo. */
  worktree?: {
    path: string;
    branch: string;
    base: string;
    seeded: string[];
  };
}

/** What a file rewind did, or — with dryRun — what it would do. */
export interface RewindFilesResult {
  canRewind?: boolean;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  skippedLinks?: number;
  dryRun?: boolean;
  error?: string;
}

/** Real context accounting, when the backend can report it. */
export interface ContextUsageReport {
  totalTokens: number;
  maxTokens: number;
  percent: number;
  model: string;
  autoCompactThreshold: number;
  isAutoCompactEnabled: boolean;
  categories: Array<{ name: string; tokens: number }>;
  /**
   * Session ledger counted once (Grok's usage.json). Per-message timeline
   * sums are a different number: they can repeat a cumulative snapshot.
   */
  session?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** Model time across completed turns, excluding tool waits. */
    durationMs: number;
  };
}

/** A hook the agent will run, flattened out of the settings tree. */
export interface HookRow {
  event: string;
  matcher: string;
  type: string;
  command: string;
}

/** Settings as resolved by the agent, plus which file each value came from. */
export interface AgentSettings {
  effective: Record<string, unknown>;
  hooks: HookRow[];
  sources: Array<{
    source: string;
    settings: Record<string, unknown>;
  }>;
  localSettings: Record<string, unknown>;
  files: {
    userSettings: string;
    projectSettings: string;
    localSettings: string;
  };
}

/** One MCP server as the agent sees it. */
export interface McpServerInfo {
  name: string;
  status: string;
  scope: string;
  error: string;
  version: string;
  toolCount: number | null;
}

export interface SessionMutationResponse {
  ok: boolean;
  error?: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface DirectoryListingResponse {
  ok: boolean;
  path?: string;
  parent?: string | null;
  home?: string;
  entries?: DirectoryEntry[];
  error?: string;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  hidden: boolean;
}

export interface WorkspaceListingResponse {
  ok: boolean;
  path?: string;
  parent?: string | null;
  truncated?: boolean;
  entries?: WorkspaceEntry[];
  error?: string;
}

/** One hit from the composer's "@" file picker. */
export interface WorkspaceMatch {
  path: string;
  relativePath: string;
  name: string;
}

/** One line hit from project-wide search or a definition lookup. */
export interface WorkspaceGrepMatch {
  path: string;
  relativePath: string;
  line: number;
  column: number;
  preview: string;
}

export interface WorkspaceGrepResponse {
  ok: boolean;
  matches?: WorkspaceGrepMatch[];
  truncated?: boolean;
  error?: string;
}

export interface WorkspaceFileResponse {
  ok: boolean;
  path?: string;
  name?: string;
  content?: string;
  size?: number;
  binary?: boolean;
  truncated?: boolean;
  error?: string;
}

export interface PiSkillInfo {
  name: string;
  description: string;
  path: string;
}

export interface DeployStep {
  name: string;
  ok: boolean;
  exit: number | null;
  signal: string | null;
  detail: string;
}

export interface DeployRecord {
  finishedAt?: number;
  commit?: string | null;
  signature?: string | null;
}

export interface DeployState extends DeployRecord {
  status: "running" | "success" | "failed";
  mode: "local" | "cloud";
  startedAt?: number;
  steps?: DeployStep[];
  log?: string;
  error?: string | null;
}

export interface DeployStatusResponse {
  ok: boolean;
  mode: "local" | "cloud";
  /** Absolute path of the project these facts describe. */
  project?: string;
  projectName?: string;
  /** True when that project is devden itself, i.e. deploying restarts this server. */
  self?: boolean;
  head: string | null;
  signature: string | null;
  dirtyFiles: number | null;
  deploying: boolean;
  stale: boolean;
  last: DeployState | null;
  lastLocal: DeployRecord | null;
  lastCloud: DeployRecord | null;
}

export interface PiExtensionInfo {
  name: string;
  version: string;
  description: string;
  source: string;
  spec: string;
  path: string;
}

export interface PiCatalogResponse {
  ok: boolean;
  skills: PiSkillInfo[];
  extensions: PiExtensionInfo[];
  settings: {
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: string;
    theme?: string;
    quietStartup?: boolean;
    hideThinkingBlock?: boolean;
    themeCount?: number;
    path?: string;
  };
  error?: string;
}

export interface AgentEvent {
  type: string;
  sessionKey?: string;
  [key: string]: unknown;
}

export interface BackendLogEntry {
  id: string;
  timestamp: number;
  source: string;
  type: string;
  payload: Record<string, unknown>;
}

/** Hosted UI on Pages talks to the local API started by `pi`. Same-origin when served locally. */
export function apiOrigin(): string {
  if (typeof window === "undefined") return "";
  const fromQuery = new URLSearchParams(window.location.search).get("api");
  if (fromQuery) {
    // Only a local origin may override where the UI sends its API + SSE
    // traffic. A hosted-page link could otherwise redirect every request to
    // an attacker's origin; anything non-local is ignored.
    try {
      const url = new URL(fromQuery);
      const host = url.hostname;
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === "[::1]"
      ) {
        return fromQuery.replace(/\/$/, "");
      }
    } catch {
      /* malformed; fall through to the default */
    }
  }
  const { hostname } = window.location;
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".trycloudflare.com")
  ) return "";
  return "http://127.0.0.1:4319";
}

function apiUrl(path: string): string {
  const origin = apiOrigin();
  return origin ? `${origin}${path}` : path;
}

/** Thrown when the server rejects a request with 401 (token required). */
export class AuthError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "AuthError";
  }
}

let authToken: string | null = (() => {
  try {
    return localStorage.getItem("devden.token");
  } catch {
    return null;
  }
})();

/** Persist the token the user entered at the auth gate. */
export function setAuthToken(token: string | null): void {
  authToken = token;
  try {
    if (token) localStorage.setItem("devden.token", token);
    else localStorage.removeItem("devden.token");
  } catch {
    /* storage unavailable; token stays in memory */
  }
}

export function hasAuthToken(): boolean {
  return authToken !== null;
}

async function request<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
  const res = await fetch(apiUrl(url), { ...init, headers });
  if (res.status === 401) throw new AuthError();
  if (res.status === 413)
    throw new Error("That request was too large for the server.");
  return (await res.json()) as T;
}

async function post<T = unknown>(
  url: string,
  body: unknown,
  timeoutMs?: number,
): Promise<T> {
  return request<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
}

async function get<T = unknown>(url: string): Promise<T> {
  return request<T>(url);
}

async function del<T = unknown>(url: string): Promise<T> {
  return request<T>(url, { method: "DELETE" });
}

async function put<T = unknown>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const historyRequests = new Map<string, Promise<{ ok: boolean; messages?: SessionHistoryMessage[]; error?: string }>>();

export const api = {
  health: () =>
    get<{
      ok: boolean;
      cwd: string;
      buildId?: string;
      bootMs?: number;
      pid?: number;
    }>("/api/health"),
  deployStatus: (cwd?: string) =>
    get<DeployStatusResponse>(
      `/api/deploy/status${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`,
    ),
  deploy: (mode: "local" | "cloud", cwd?: string) =>
    post<{ ok: boolean; mode?: string; self?: boolean; error?: string }>(
      "/api/deploy",
      { mode, cwd },
      10_000,
    ),
  catalog: (backend: "pi" | "codex" = "pi") => get<PiCatalogResponse>(`/api/catalog?backend=${backend}`),
  openPiSettings: () =>
    post<{ ok: boolean; error?: string }>("/api/catalog/open-settings", {}),
  readSkill: (name: string, backend: "pi" | "codex" = "pi") =>
    get<{ ok: boolean; name?: string; source?: string; error?: string }>(
      `/api/catalog/skill?name=${encodeURIComponent(name)}&backend=${backend}`,
    ),
  writeSkill: (skill: { name: string; description: string; body: string; backend?: "pi" | "codex" }) =>
    request<{ ok: boolean; name?: string; path?: string; error?: string }>(
      "/api/catalog/skill",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(skill),
      },
    ),
  deleteSkill: (name: string, backend: "pi" | "codex" = "pi") =>
    request<{ ok: boolean; error?: string }>(
      `/api/catalog/skill?name=${encodeURIComponent(name)}&backend=${backend}`,
      { method: "DELETE" },
    ),
  directories: (path?: string) =>
    get<DirectoryListingResponse>(
      `/api/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
  workspace: (path: string) =>
    get<WorkspaceListingResponse>(
      `/api/workspace?path=${encodeURIComponent(path)}`,
    ),
  /** Short title for a board card. Resolves to "" when the model is
   *  unavailable, so callers keep their own fallback. */
  cardTitle: (text: string) =>
    post<{ ok: boolean; title?: string }>("/api/board/card-title", { text }),

  workspaceSearch: (root: string, q: string) =>
    get<{ ok: boolean; matches?: WorkspaceMatch[]; error?: string }>(
      `/api/workspace/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`,
    ),
  workspaceFile: (path: string) =>
    get<WorkspaceFileResponse>(
      `/api/workspace/file?path=${encodeURIComponent(path)}`,
    ),
  workspaceGrep: (
    root: string,
    q: string,
    options: {
      caseSensitive?: boolean;
      wholeWord?: boolean;
      regex?: boolean;
    } = {},
  ) => {
    const params = new URLSearchParams({ root, q });
    if (options.caseSensitive) params.set("case", "1");
    if (options.wholeWord) params.set("word", "1");
    if (options.regex) params.set("regex", "1");
    return get<WorkspaceGrepResponse>(`/api/workspace/grep?${params}`);
  },
  workspaceDefinition: (root: string, symbol: string) =>
    get<WorkspaceGrepResponse>(
      `/api/workspace/definition?root=${encodeURIComponent(root)}&symbol=${encodeURIComponent(symbol)}`,
    ),
  workspaceSave: (path: string, content: string) =>
    put<WorkspaceFileResponse>("/api/workspace/file", { path, content }),
  /** Auto-saved transcript, written to ~/.devden/transcripts (not the repo). */
  writeTranscript: (name: string, content: string) =>
    put<{ ok: boolean; path?: string; error?: string }>("/api/transcript", {
      name,
      content,
    }),
  workspaceRename: (path: string, name: string) =>
    post<{
      ok: boolean;
      path?: string;
      name?: string;
      from?: string;
      error?: string;
    }>("/api/workspace/rename", { path, name }),
  workspaceDelete: (path: string) =>
    post<{ ok: boolean; path?: string; error?: string }>(
      "/api/workspace/delete",
      { path },
    ),
  workspaceCopy: (path: string, destination: string) =>
    post<{ ok: boolean; path?: string; name?: string; error?: string }>(
      "/api/workspace/copy",
      { path, destination },
    ),
  workspaceMove: (path: string, destination: string) =>
    post<{ ok: boolean; path?: string; name?: string; error?: string }>(
      "/api/workspace/move",
      { path, destination },
    ),
  workspaceReveal: (path: string) =>
    post<{ ok: boolean; error?: string }>("/api/workspace/reveal", { path }),
  workspaceOpen: (path: string, app?: string) =>
    post<{ ok: boolean; error?: string }>("/api/workspace/open", { path, app }),
  workspaceTerminal: (path: string) =>
    post<{ ok: boolean; error?: string }>("/api/workspace/terminal", { path }),
  workspaceApps: () =>
    get<{ ok: boolean; apps: { id: string; label: string }[] }>(
      "/api/workspace/apps",
    ),
  sessionLogUrl: (sessionPath: string) =>
    apiUrl(`/api/session-log?path=${encodeURIComponent(sessionPath)}`),
  sessionMessages: (sessionPath: string) => {
    let pending = historyRequests.get(sessionPath);
    if (!pending) {
      pending = get<{ ok: boolean; messages?: SessionHistoryMessage[]; error?: string }>(
        `/api/session-messages?path=${encodeURIComponent(sessionPath)}`,
      ).finally(() => historyRequests.delete(sessionPath));
      historyRequests.set(sessionPath, pending);
    }
    return pending;
  },
  sessions: (
    view: "recent" | "archived" = "recent",
    // "all" merges every agent's sessions into one list, newest first.
    backend: AgentBackend | "all" = "pi",
  ) => {
    const params = new URLSearchParams({ backend });
    if (view === "archived") params.set("view", "archived");
    return get<{ ok: boolean; sessions: ResumeSession[] }>(
      `/api/sessions?${params}`,
    );
  },
  searchSessions: (query: string, backend: AgentBackend | "all") =>
    get<{ ok: boolean; results?: SessionSearchResult[]; error?: string }>(
      `/api/sessions/search?backend=${backend}&q=${encodeURIComponent(query)}`,
    ),
  archiveSession: (sessionPath: string) =>
    post<SessionMutationResponse>("/api/sessions/archive", { sessionPath }),
  restoreSession: (sessionPath: string) =>
    post<SessionMutationResponse>("/api/sessions/restore", { sessionPath }),
  deleteSession: (sessionPath: string) =>
    post<SessionMutationResponse>("/api/sessions/delete", { sessionPath }),
  start: (
    key: string,
    cwd: string,
    backend: AgentBackend = "pi",
    model?: ModelInfo,
    sessionPath?: string,
    thinkingLevel?: string,
    adoptOnly?: boolean,
    warmOnly?: boolean,
    independent?: boolean,
    accessMode?: "workspace-write" | "read-only",
    agentMode?: "standard" | "plan" | "manual" | "routed" | "auto-edit",
  ) =>
    post<{
      ok: boolean;
      state?: SessionState;
      messages?: SessionHistoryMessage[];
      error?: string;
    }>(`/api/${key}/start`, {
      cwd,
      backend,
      ...(model ? { model } : {}),
      ...(sessionPath ? { sessionPath } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(adoptOnly ? { adoptOnly: true } : {}),
      ...(warmOnly ? { warmOnly: true } : {}),
      ...(independent ? { independent: true } : {}),
      ...(accessMode ? { accessMode } : {}),
      ...(agentMode ? { agentMode } : {}),
    }),
  prompt: (
    key: string,
    message: string,
    options?: {
      images?: ImageAttachment[];
      // Session context for lazily-resumed conversations: a session opened
      // for display has no agent process yet, so the first prompt carries
      // what the server needs to start one (grok only today).
      cwd?: string;
      backend?: AgentBackend;
      sessionPath?: string;
      model?: ModelInfo | null;
      thinkingLevel?: string | null;
      accessMode?: "workspace-write" | "read-only";
      agentMode?: "standard" | "plan" | "manual" | "auto-edit";
      /** The ask card's submit: this message answers a pending ask, so the
       * server delivers it even though an ask still holds the queue. */
      answersAsk?: boolean;
    },
  ) => {
    const body: Record<string, unknown> = {
      message,
      ...(options?.images ? { images: options.images } : null),
    };
    if (options?.cwd) body.cwd = options.cwd;
    if (options?.backend) body.backend = options.backend;
    if (options?.sessionPath) body.sessionPath = options.sessionPath;
    if (options?.model) body.model = options.model;
    if (options?.thinkingLevel) body.thinkingLevel = options.thinkingLevel;
    if (options?.accessMode) body.accessMode = options.accessMode;
    if (options?.agentMode) body.agentMode = options.agentMode;
    if (options?.answersAsk) body.answersAsk = true;
    return post<{ ok: boolean; error?: string; sessionPath?: string }>(
      `/api/${key}/prompt`,
      body,
    );
  },
  enqueue: (key: string, message: string, images?: ImageAttachment[]) =>
    post<{
      ok: boolean;
      data?: { queued: boolean; position?: number };
      error?: string;
    }>(`/api/${key}/queue`, { message, ...(images ? { images } : {}) }),
  cancelQueued: (key: string, id?: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/queue-cancel`, {
      ...(id ? { id } : {}),
    }),
  steerQueued: (key: string, id?: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/queue-steer`, {
      ...(id ? { id } : {}),
    }),
  steer: (key: string, message: string, images?: ImageAttachment[]) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/steer`, {
      message,
      images,
    }),
  abort: (key: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/abort`, {}),
  newSession: (key: string) =>
    post<SessionSnapshotResponse>(`/api/${key}/new-session`, {}),
  resume: (key: string, sessionPath: string) =>
    post<SessionSnapshotResponse>(
      `/api/${key}/resume`,
      { sessionPath },
      30_000,
    ),
  fork: (
    key: string,
    timestamp: number,
    context: {
      cwd?: string;
      sessionPath?: string;
      backend?: AgentBackend;
      /** 0-based user-turn index to cut a Grok fork at. */
      promptIndex?: number;
      /** Text of the user turn being forked, so a miscounted index can be corrected. */
      userText?: string;
      /** Label for the isolated worktree branch. */
      name?: string;
      model?: ModelInfo | null;
      thinkingLevel?: string | null;
      accessMode?: "workspace-write" | "read-only";
      agentMode?: "standard" | "plan" | "manual" | "routed" | "auto-edit";
    } = {},
  ) =>
    post<SessionSnapshotResponse>(`/api/${key}/fork`, {
      timestamp,
      ...context,
    }),
  settings: (key: string) =>
    get<{ ok: boolean; data?: AgentSettings; error?: string }>(
      `/api/${key}/settings`,
    ),
  mcpServers: (key: string) =>
    get<{ ok: boolean; data?: { servers: McpServerInfo[] }; error?: string }>(
      `/api/${key}/mcp`,
    ),
  contextUsage: (key: string) =>
    get<{ ok: boolean; data?: ContextUsageReport; error?: string }>(
      `/api/${key}/context`,
    ),
  rewindFiles: (
    key: string,
    timestamp: number,
    dryRun = false,
    context: { cwd?: string; sessionPath?: string } = {},
  ) =>
    post<{ ok: boolean; data?: RewindFilesResult; error?: string }>(
      `/api/${key}/rewind-files`,
      { timestamp, dryRun, ...context },
    ),
  truncate: (key: string, userTimestamp: number, sessionPath?: string) =>
    post<SessionSnapshotResponse>(
      `/api/${key}/truncate`,
      { userTimestamp, sessionPath },
      30_000,
    ),
  goal: (key: string, text: string) =>
    post<{ ok: boolean; text?: string; cleared?: boolean; error?: string }>(
      `/api/${key}/goal`,
      { text },
    ),
  remoteStart: () =>
    post<{
      ok: boolean;
      url?: string;
      connectUrl?: string;
      qrDataUrl?: string;
      error?: string;
    }>("/api/remote/start", {}, 300_000),
  remoteStop: () =>
    post<{ ok: boolean; error?: string }>("/api/remote/stop", {}),
  gitRun: (key: string, cwd: string, op: GitOp, options?: GitOpOptions) =>
    post<{ ok: boolean; output?: string; url?: string; error?: string }>(
      `/api/${key}/git`,
      { cwd, op, ...options },
      120_000,
    ),
  /** This repo's worktrees; `current` is which one `cwd` is in. */
  worktrees: (key: string, cwd: string) =>
    get<{
      ok: boolean;
      current?: string;
      base?: string | null;
      worktrees?: { path: string; branch: string; main: boolean }[];
      error?: string;
    }>(`/api/${key}/worktrees?cwd=${encodeURIComponent(cwd)}`),
  /** Cut an isolated checkout on its own branch; returns the cwd to open. */
  createWorktree: (key: string, cwd: string, name: string) =>
    post<{
      ok: boolean;
      data?: {
        path: string;
        branch: string;
        base: string;
        seeded: string[];
      };
      error?: string;
    }>(`/api/${key}/worktree`, { cwd, op: "create", name }, 120_000),
  /** `dirty` comes back when the refusal was uncommitted work, not a failure. */
  removeWorktree: (key: string, cwd: string, path: string, force = false) =>
    post<{
      ok: boolean;
      data?: { path: string; branch: string };
      dirty?: boolean;
      error?: string;
    }>(`/api/${key}/worktree`, { cwd, op: "remove", path, force }, 120_000),
  /** `base` widens the change list to the worktree's whole branch (race
   *  scoreboards, where committed work must still count). */
  gitChanges: (key: string, cwd: string, base = false) =>
    get<GitChangesResponse>(
      `/api/${key}/git-changes?cwd=${encodeURIComponent(cwd)}${base ? "&base=1" : ""}`,
    ),
  /**
   * This-turn diff (snapshot → now) at -U15. `since` is the user-message time.
   * `task` widens it to everything the worktree's branch did, commits included.
   */
  gitReviewDiff: (key: string, cwd: string, since?: number, task = false) => {
    const params = new URLSearchParams({
      cwd,
      review: "1",
    });
    if (task) params.set("task", "1");
    if (since && Number.isFinite(since)) params.set("since", String(since));
    return get<{
      ok: boolean;
      repo?: boolean;
      scope?: "turn" | "head" | "task";
      base?: string;
      snapshotAt?: number;
      diff?: string;
      truncated?: boolean;
      untrackedOmitted?: number;
      error?: string;
    }>(`/api/${key}/git-changes?${params}`);
  },
  /** Recorded changes: this session's latest turn (or `turn`), or the whole
   *  session. Survives commits; unlike git, it knows whose change is whose. */
  changes: (
    key: string,
    scope: ChangeScope,
    sessionPath?: string,
    turn?: number,
  ) => {
    const params = new URLSearchParams({ scope });
    if (sessionPath) params.set("sessionPath", sessionPath);
    if (turn) params.set("turn", String(turn));
    return get<ChangesResponse>(`/api/${key}/changes?${params}`);
  },
  revertHunk: (key: string, cwd: string, file: string, hunkIndex: number) =>
    post<{
      ok: boolean;
      data?: { file: string; hunkIndex: number; remaining: number };
      error?: string;
    }>(`/api/${key}/git-hunk`, { cwd, file, hunkIndex }),
  /** Per-file diff vs HEAD — or, with `base`, vs the worktree's base commit
   *  (the branch's whole change against main, commits included). */
  gitFileDiff: (key: string, cwd: string, file: string, base = false) =>
    get<{ ok: boolean; diff?: string; error?: string }>(
      `/api/${key}/git-changes?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}${base ? "&base=1" : ""}`,
    ),
  sessionState: (key: string, backend?: AgentBackend) =>
    get<{ ok: boolean; state?: SessionState | null }>(
      `/api/${key}/state${backend ? `?backend=${encodeURIComponent(backend)}` : ""}`,
    ),
  gitCommitPush: (
    key: string,
    cwd: string,
    message: string,
    files?: string[],
    push = true,
  ) =>
    post<{ ok: boolean; output?: string; error?: string }>(
      `/api/${key}/git`,
      {
        cwd,
        op: push ? "commit-push" : "commit",
        message,
        ...(files ? { files } : {}),
      },
      120_000,
    ),
  compact: (
    key: string,
    customInstructions?: string,
    start?: {
      cwd?: string;
      sessionPath?: string;
      model?: ModelInfo | null;
      thinkingLevel?: string | null;
    },
  ) =>
    post<{
      ok: boolean;
      state?: SessionState;
      messages?: SessionHistoryMessage[];
      error?: string;
    }>(
      `/api/${key}/compact`,
      {
        customInstructions,
        // Session context for the lazy-start path: a session with no agent
        // process yet gets one started here, same as the first prompt.
        ...(start?.cwd ? { cwd: start.cwd } : null),
        ...(start?.sessionPath ? { sessionPath: start.sessionPath } : null),
        ...(start?.model ? { model: start.model } : null),
        ...(start?.thinkingLevel
          ? { thinkingLevel: start.thinkingLevel }
          : null),
      },
      // Compaction re-summarizes the whole history through the model; the
      // default request timeout cut it off and reported a failure for a
      // compaction that was in fact still running.
      300_000,
    ),
  rename: (key: string, title: string) =>
    post<{ ok: boolean; error?: string; unsupported?: boolean }>(
      `/api/${key}/rename`,
      { title },
    ),
  stopTerminal: (key: string, tabId: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/terminal`, {
      op: "stop",
      tabId,
    }),
  setModel: (key: string, provider: string, modelId: string) =>
    post<{
      ok: boolean;
      data?: ModelInfo;
      state?: SessionState;
      error?: string;
    }>(`/api/${key}/set-model`, { provider, modelId }),
  setThinking: (key: string, level: string) =>
    post<{ ok: boolean; state?: SessionState; error?: string }>(`/api/${key}/set-thinking`, {
      level,
    }),
  getRoute: (key: string, sessionFile?: string) => {
    const query = sessionFile
      ? `?sessionFile=${encodeURIComponent(sessionFile)}`
      : "";
    return get<{ ok: boolean; route?: SessionRoute; error?: string }>(
      `/api/${key}/route${query}`,
    );
  },
  putRoute: (key: string, route: SessionRoute, sessionFile?: string) =>
    put<{ ok: boolean; route?: SessionRoute; error?: string }>(
      `/api/${key}/route`,
      { route, sessionFile },
    ),
  stop: (key: string) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/stop`, {}),
  answer: (key: string, requestId: string, answers: Record<string, { answers: string[] }>) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/answer`, { requestId, answers }),
  approve: (
    key: string,
    requestId: string,
    optionId: string,
    backend: AgentBackend = "pi",
  ) =>
    post<{ ok: boolean; error?: string }>(`/api/${key}/approve`, {
      requestId,
      optionId,
      backend,
    }),
  configure: (
    key: string,
    cwd: string,
    accessMode: "workspace-write" | "read-only",
    agentMode: "standard" | "plan" | "manual" | "auto-edit",
    model?: ModelInfo | null,
    thinkingLevel?: string,
    sessionPath?: string,
    backend: AgentBackend = "pi",
  ) =>
    post<SessionSnapshotResponse>(`/api/${key}/configure`, {
      cwd,
      backend,
      accessMode,
      agentMode,
      model,
      thinkingLevel,
      sessionPath,
    }),
  upload: (key: string, name: string, mimeType: string, data: string) =>
    post<{ ok: boolean; path?: string; error?: string }>(`/api/${key}/upload`, {
      name,
      mimeType,
      data,
    }),
  /** Opens the native macOS folder dialog on the server and returns the
   *  absolute path — a web file input can never provide one. */
  pickDirectory: (prompt: string) =>
    post<{
      ok: boolean;
      path?: string;
      canceled?: boolean;
      error?: string;
    }>("/api/pick-directory", { prompt }, 120_000),
  commands: (key: string, backend?: AgentBackend, cwd?: string) => {
    const params = new URLSearchParams();
    if (backend) params.set("backend", backend);
    if (cwd) params.set("cwd", cwd);
    const query = params.toString();
    return get<{ ok: boolean; commands: SlashCommand[] }>(
      `/api/${key}/commands${query ? `?${query}` : ""}`,
    );
  },
  models: (key: string, backend?: AgentBackend) =>
    get<{ ok: boolean; models: ModelInfo[] }>(
      `/api/${key}/models${backend ? `?backend=${backend}` : ""}`,
    ),
  /** Account-level quota for every backend at once (status footer, model picker). */
  backendUsage: () =>
    get<{
      ok: boolean;
      usage: Partial<Record<AgentBackend, ProviderUsage>>;
      error?: string;
    }>("/api/usage"),
  thinkingLevels: (key: string, backend?: AgentBackend) =>
    get<{ ok: boolean; levels: string[] }>(
      `/api/${key}/thinking-levels${backend ? `?backend=${backend}` : ""}`,
    ),
  usage: (
    key: string,
    backend?: AgentBackend,
    refresh = false,
    sessionPath?: string,
  ) => {
    const params = new URLSearchParams();
    if (backend) params.set("backend", backend);
    if (refresh) params.set("refresh", "1");
    if (sessionPath) params.set("sessionPath", sessionPath);
    const query = params.size > 0 ? `?${params}` : "";
    return get<{ ok: boolean; usage: ProviderUsage; error?: string }>(
      `/api/${key}/usage${query}`,
    );
  },
  backendLog: (key: string) =>
    get<{ ok: boolean; entries: BackendLogEntry[]; error?: string }>(
      `/api/${key}/log`,
    ),
  /** Exchange the token for a session cookie + one-time SSE/WS ticket. */
  auth: (token: string) =>
    post<{ ok: boolean; enabled?: boolean; ticket?: string }>("/api/auth", {
      token,
    }),
  backends: () =>
    get<{ ok: boolean; backends: BackendInfo[] }>("/api/backends"),
  recheckBackends: () =>
    post<{ ok: boolean; backends: BackendInfo[] }>("/api/backends/recheck", {}),
  harnessUpdates: () =>
    get<{
      ok: boolean;
      updates: {
        id: string;
        pkg: string;
        installed: string | null;
        latest: string | null;
        /** devden only: commits on upstream that HEAD lacks. */
        behind?: number;
      }[];
    }>("/api/harness-updates"),
  runHarnessUpdate: (id: string) =>
    post<{
      ok: boolean;
      pkg?: string;
      error?: string;
      /** stderr tail, for the details panel. */
      log?: string;
      /** What to run by hand if the in-app update fails. */
      cmd?: string;
    }>(
      "/api/harness-updates/run",
      { id },
      5 * 60_000,
    ).then((result) => {
      if (result.ok) window.dispatchEvent(new Event("devden:models-updated"));
      return result;
    }),
  onboarding: () =>
    get<{
      ok: boolean;
      done: boolean;
      defaultBackend: string | null;
      workspace: string | null;
    }>("/api/onboarding"),
  saveOnboarding: (body: {
    done: boolean;
    defaultBackend?: string | null;
    workspace?: string | null;
  }) => post<{ ok: boolean; done: boolean }>("/api/onboarding", body),
  authStatus: () => get<{ ok: boolean }>("/api/auth/status"),
  /** Renew the server-side lease for the given conversation keys. */
  heartbeat: (keys: string[]) =>
    post<{ ok: boolean }>("/api/heartbeat", { keys }),
};

/**
 * Subscribe to the server event fan-out.
 *
 * EventSource cannot send Authorization headers, so with a token configured
 * the connection authenticates via the HttpOnly cookie (same-origin) or a
 * one-time ticket in the URL (cross-origin). Tickets are single-use, so on a
 * connection error the stream is re-created with a freshly minted ticket
 * instead of relying on EventSource's auto-reconnect (which would replay the
 * consumed URL and 401 forever).
 */
/**
 * One shared SSE connection for the whole page.
 *
 * Every caller used to open its own EventSource, and each conversation tab
 * subscribes twice — so the third open session blew past the browser's
 * 6-connections-per-origin limit and every later request (including the
 * session history a click needs) queued behind streams that never end. The
 * symptom was "sessions stop opening" and a UI that slowly froze.
 */
const eventListeners = new Set<(event: AgentEvent) => void>();
const statusListeners = new Set<
  (status: "connected" | "reconnecting") => void
>();
let closeSharedStream: (() => void) | null = null;

export function subscribeEvents(
  onEvent: (event: AgentEvent) => void,
  onStatus?: (status: "connected" | "reconnecting") => void,
): () => void {
  eventListeners.add(onEvent);
  if (onStatus) statusListeners.add(onStatus);
  if (!closeSharedStream) {
    closeSharedStream = openEventStream(
      (event) => {
        // One failing subscriber must not starve the others. The loop used to
        // abort on the first throw and the caller swallowed it, so a single bad
        // event stopped the transcript updating with nothing in the console to
        // say why -- indistinguishable from the server freezing.
        for (const listener of [...eventListeners]) {
          try {
            listener(event);
          } catch (error) {
            console.error("[devden] event listener failed", error);
          }
        }
      },
      (status) => {
        for (const listener of [...statusListeners]) listener(status);
      },
    );
  }
  return () => {
    eventListeners.delete(onEvent);
    if (onStatus) statusListeners.delete(onStatus);
    if (eventListeners.size === 0 && statusListeners.size === 0) {
      closeSharedStream?.();
      closeSharedStream = null;
    }
  };
}

function openEventStream(
  onEvent: (event: AgentEvent) => void,
  onStatus?: (status: "connected" | "reconnecting") => void,
): () => void {
  let source: EventSource | null = null;
  let socket: WebSocket | null = null;
  // Cloudflare quick tunnels buffer SSE bodies (a documented limitation), so
  // pages loaded through the /remote tunnel switch to the WebSocket twin at
  // /api/events-ws — same events, same __ping watchdog, streaming transport.
  const useWebSocket = location.hostname.endsWith(".trycloudflare.com");
  let closed = false;
  let reconnecting = false;
  let retryTimer: number | undefined;
  let lastMessage = Date.now();

  const scheduleReconnect = () => {
    if (closed || reconnecting) return;
    reconnecting = true;
    onStatus?.("reconnecting");
    source?.close();
    source = null;
    socket?.close();
    socket = null;
    retryTimer = window.setTimeout(() => {
      reconnecting = false;
      void connect();
    }, 2_000);
  };

  // Staleness watchdog: EventSource.onerror never fires for a half-open
  // connection (idle proxy, sleep/wake, dropped socket without a reset),
  // which leaves the UI frozen on stale data until a manual refresh. The
  // server sends a __ping event every 10s; ~3 missed beats means it is dead.
  const watchdog = window.setInterval(() => {
    if (closed || reconnecting) return;
    if (Date.now() - lastMessage > 30_000) scheduleReconnect();
  }, 5_000);

  const connect = async () => {
    if (closed) return;
    // Hold the reconnecting flag for the whole connect body: connect() awaits
    // auth before assigning source, and if the flag dropped early the watchdog
    // could arm a second timer and open a duplicate EventSource.
    reconnecting = true;
    try {
      if (useWebSocket) {
        const scheme = location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(`${scheme}//${location.host}/api/events-ws`);
        socket.onopen = () => onStatus?.("connected");
        socket.onmessage = (message) => {
          lastMessage = Date.now();
          try {
            onEvent(JSON.parse(String(message.data)) as AgentEvent);
          } catch {
            /* ignore malformed */
          }
        };
        socket.onclose = scheduleReconnect;
        return;
      }
      let url = apiUrl("/api/events");
      if (authToken) {
        try {
          const result = await api.auth(authToken);
          if (result.ok && result.ticket) {
            url = `${url}?ticket=${encodeURIComponent(result.ticket)}`;
          }
        } catch {
          /* cookie may already authenticate; fall through */
        }
      }
      if (closed) return;
      lastMessage = Date.now();
      source = new EventSource(url);
      source.onopen = () => onStatus?.("connected");
      source.onmessage = (message) => {
        lastMessage = Date.now();
        try {
          onEvent(JSON.parse(message.data) as AgentEvent);
        } catch {
          /* ignore malformed */
        }
      };
      source.onerror = scheduleReconnect;
    } finally {
      reconnecting = false;
    }
  };

  void connect();
  return () => {
    closed = true;
    window.clearInterval(watchdog);
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    source?.close();
    socket?.close();
  };
}
