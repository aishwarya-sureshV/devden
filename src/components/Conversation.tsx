import {
  Activity,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  AGENT_BACKENDS,
  api,
  backendLabel,
  backendMark,
  subscribeEvents,
  type ModelInfo,
  type ContextUsageReport,
  type QueuedMessage,
  type WorkspaceMatch,
  type RewindFilesResult,
  type ProviderUsage,
  type SlashCommand,
  type AgentBackend,
} from "../lib/api";
import {
  useStore,
  useTimeline,
  BACKEND_DEFAULT_EFFORT,
  isUnstartedTab,
  type Attachment,
  type ConversationTab,
  type TaskSeed,
} from "../lib/store";
import { effortStops } from "../lib/effortStops";
import { LIVE_TEXT_STALL_MS, shouldShowThinkingRow } from "../lib/thinkingRow";
import {
  THINKING_QUIP_MS,
  createThinkingQuips,
  thinkingLineParts,
} from "../lib/thinkingQuips";
import {
  PaneChrome,
  SessionHeader,
  displayPath,
  type PaneTone,
  type SessionTone,
  type SessionView,
} from "./SessionHeader";
import {
  contextualSessionTitle,
  isLocalCommandText,
} from "../lib/sessionTitle";
import {
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_MODELS,
  formatClaudeModelName,
} from "../lib/claudeModels";
import {
  isModelIdentityQuestion,
  runtimeModelAnswer,
} from "../lib/modelIdentity";
import { capabilitiesFor } from "../lib/agentCapabilities";
import { useBackendUsage, usagePair } from "../lib/backendUsage";
import {
  exhaustedWindow,
  isUsageLimitError,
  limitResumePrompt,
  limitScope,
  pendingLimitTurn,
} from "../lib/usageLimit";
import { LimitBanner } from "./LimitBanner";
import {
  estimateContext,
  compactTokens,
  usageCutoff,
  usageSummaryFromCounts,
  usageStamp,
  usageSummaryOf,
  type ContextUsage,
} from "../lib/sessionMetrics";
import {
  exportFilename,
  handoffPrompt,
  timelineToMarkdown,
  transcriptFilename,
} from "../lib/exportSession";
import { DISTILL_SKILL_PROMPT } from "../lib/skilldraft";
import {
  formatReviewHunks,
  integrityPrompt,
  filterDiffToFiles,
  lastUserRequest,
  lastUserTimestamp,
  partitionUnifiedDiff,
  reviewPathsMatch,
  scanPrechecks,
  taskPrompt,
  statsForTurn,
  turnStats,
} from "../lib/turnReview";
import {
  isTurnComplete,
  isTurnLogOpen,
  splitTurns,
  turnBodyItems,
  turnEndedAt,
  turnKey,
  turnSummaryItems,
  turnUserItems,
} from "../lib/turnFold";
import type { TimelineItem } from "../lib/timeline";
import {
  collectSubagentRuns,
  isHeldMainNarration,
  isHeldMainTool,
  isSettledSpawnTool,
  isSubagentChatter,
  isSubagentCheckIn,
  isSubagentEcho,
  isSubagentTool,
  isSubagentToolEcho,
  type SubagentRun,
} from "../lib/subagents";
import { isAskMessage } from "../lib/askBlock";
import { formatWorkingClock } from "../lib/toolRow";
import { ExploredRows, ToolCard } from "./ToolCard";
import { SubagentCard } from "./SubagentCard";
import { SubagentPanel } from "./SubagentPanel";
import { RichText } from "./RichText";
import { AskCard } from "./AskCard";
import {
  getToolDiff,
  type DiffLine,
  type ToolFileView,
} from "../lib/toolCards";
import { FileViewer } from "./FileViewer";
import { Trajectory } from "./Trajectory";
import { BackendLog } from "./BackendLog";
import { WorkspacePicker, type WorkspacePickerHandle } from "./WorkspacePicker";
import {
  WorkspaceExplorer,
  type WorkspacePlacement,
} from "./WorkspaceExplorer";
import { CopyButton } from "./CopyButton";
import { TodoTracker, TodoTranscript, extractTodos } from "./TodoTracker";
import { ChangesPanel } from "./ChangesPanel";
import { BoardPanel } from "./BoardPanel";
import { SelectionTools } from "./SelectionTools";
import { TurnCompleteBar } from "./TurnCompleteBar";
import { TurnFilesCard, TurnFoldBar, turnChangedFiles } from "./TurnFoldBar";
import { ReviewCard } from "./ReviewCard";
import { RouteSetup } from "./RouteSetup";
import { RouteChainStrip } from "./RouteChainStrip";
import { RouteHandoffCard } from "./RouteHandoffCard";
import { RouteRolePane } from "./RouteRolePane";
import {
  applyTemplate,
  emptyRoute,
  type RouteTemplate,
  type SessionRoute,
} from "../lib/route";
import {
  ModeChip,
  ModelChip,
  UsageChip,
  type ModelOption,
} from "./ComposerChrome";
import { ActiveRunIndicator } from "./ToolActivity";
import { groupTranscriptRows } from "../lib/toolRow";
import type { PaneDensity } from "../lib/sessionLayout";
import {
  IconArrowUp,
  IconCode,
  IconFile,
  IconFork,
  IconPencil,
  IconHistory,
  IconPlus,
  IconStop,
  IconUpload,
  FishLogo,
} from "./icons";
import {
  type AccessMode,
  type AgentMode,
  capText,
  collectReviewDiff,
  getResponseActionIds,
  lastAnswerableAssistantId,
  promptIndexAtAssistant,
  userTextBeforeAssistant,
} from "./conversationHelpers";
import {
  SubagentWaitRow,
  ThinkingRow,
  TimelineRow,
  turnStartedAt,
} from "./ConversationRows";
import { ConversationComposer } from "./ConversationComposer";
const DESIGN_MODES: AgentMode[] = ["manual", "auto-edit", "plan", "standard"];
const apiAgentMode = (
  mode: AgentMode,
): "standard" | "plan" | "manual" | "auto-edit" =>
  mode === "plan"
    ? "plan"
    : mode === "manual"
      ? "manual"
      : mode === "auto-edit"
        ? "auto-edit"
        : "standard";

const USAGE_IDLE_REFRESH_INTERVAL_MS = 5 * 60_000 + 30_000;
const USAGE_RUNNING_REFRESH_INTERVAL_MS = 30_000;

function isUsageShortcut(value: string): boolean {
  return /^\/(?:grok-cli-usage|grok-usage)$/i.test(value.trim());
}

/** Commands handled entirely in the UI (never sent to the backend). */
const LOCAL_COMMANDS: SlashCommand[] = [
  {
    name: "clear",
    description: "Wipe the slate and start a fresh session",
    source: "local",
  },
  {
    name: "compact",
    description: "Summarize older history for the model; keep this transcript",
    source: "local",
  },
  {
    name: "context",
    description: "See what is using the context window",
    source: "local",
  },
  {
    name: "cost",
    description: "Check spend and usage for the current model",
    source: "local",
  },
  {
    name: "diff",
    description: "Review every file change in one diff viewer",
    source: "local",
  },
  {
    name: "export",
    description: "Download this conversation as a Markdown transcript",
    source: "local",
  },
  {
    name: "fork",
    description: "Fork the latest reply into a side chat with its own worktree",
    source: "local",
  },
  {
    name: "goal",
    description:
      "Park a background goal with automatic check-ins (/goal off clears)",
    source: "local",
  },
  {
    name: "remote",
    description:
      "Open this workbench on your phone via a secure tunnel + QR (/remote off stops)",
    source: "local",
  },
  {
    name: "skill",
    description:
      "Distill this session into a reusable skill draft (review before saving)",
    source: "local",
  },
  {
    name: "pull",
    description: "Pull the latest changes for this repository",
    source: "local",
  },
  {
    name: "push",
    description: "Push this repository to its remote",
    source: "local",
  },
  {
    name: "usage",
    description: "Check spend and usage for the current model",
    source: "local",
  },
];

export function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () =>
      resolve(String(reader.result ?? "").split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function useLiveTextStalled(active: boolean, text: string): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!active) {
      setStalled(false);
      return;
    }
    setStalled(false);
    const timer = window.setTimeout(() => setStalled(true), LIVE_TEXT_STALL_MS);
    return () => window.clearTimeout(timer);
  }, [active, text]);
  return active && stalled;
}

export function Conversation({
  tab,
  showThinking = false,
  split = false,
  density = "full",
  sessionCount = 1,
  headerHost = null,
  focused = true,
  visible = true,
  onClose,
  onFocus,
  onBack,
  sharedWorkspaceOpen = false,
  onSharedWorkspaceToggle,
  onSessionSplit,
  terminalOpen = false,
  onTerminalToggle,
  reviewTitle = null,
  dockMulti = false,
  onOpenReview,
}: {
  tab: ConversationTab;
  showThinking?: boolean;
  split?: boolean;
  density?: PaneDensity;
  sessionCount?: number;
  headerHost?: HTMLElement | null;
  focused?: boolean;
  visible?: boolean;
  onClose?: () => void;
  onFocus?: () => void;
  /** Present while this session is maximized out of a split view. */
  onBack?: () => void;
  /** Split view: one workspace pane on the right serves every session. */
  sharedWorkspaceOpen?: boolean;
  onSharedWorkspaceToggle?: () => void;
  onSessionSplit?: (key: string) => void;
  terminalOpen?: boolean;
  onTerminalToggle?: () => void;
  reviewTitle?: string | null;
  dockMulti?: boolean;
  onOpenReview?: (view: ToolFileView) => void;
}) {
  const timeline = useTimeline(tab.timeline, visible)!;
  const {
    refreshSessions,
    awaitingKeys,
    setConversationSessionPath,
    setConversationWorkspace,
    setPreferredModel,
    setConversationLabel,
    workspaceReveal,
    taskSeeds,
    clearTaskSeed,
    openForkedConversation,
    openConversation,
    closeConversation,
    revealConversation,
    backendCatalog,
    setDefaultBackend,
    setConversationBackend,
    resumeSessions,
  } = useStore();
  const backendIds = backendCatalog.length
    ? backendCatalog.map((item) => item.id)
    : [...AGENT_BACKENDS];
  const [draft, setDraft] = useState("");
  // The draft survives page reloads: keyed by conversation identity (the
  // session file once it exists, else this fresh tab's own slot). It used
  // to be a shared per-backend+cwd slot, which leaked one tab's unsent
  // draft (and stale handoff seeds) into every later new session.
  // When the identity resolves in place (fresh chat gained its session
  // file, fork, session switch) the in-progress draft is carried over
  // rather than overwritten from storage.
  // ponytail: a fresh tab's unsent draft no longer survives a reload
  // (the tab's key changes); bring back slot-based keys if that matters.
  const draftKey = `devden.draft:${tab.sessionPath ?? `new:${tab.key}`}`;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const draftKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (draftKeyRef.current === draftKey) return;
    const isInitialLoad = draftKeyRef.current === null;
    draftKeyRef.current = draftKey;
    if (isInitialLoad) {
      setDraft(localStorage.getItem(draftKey) ?? "");
      return;
    }
    if (draftRef.current) localStorage.setItem(draftKey, draftRef.current);
    else localStorage.removeItem(draftKey);
  }, [draftKey]);
  useEffect(() => {
    if (draftKeyRef.current !== draftKey) return;
    if (draft) localStorage.setItem(draftKey, draft);
    else localStorage.removeItem(draftKey);
  }, [draft, draftKey]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  // The open file explorer / diff viewer survive navigating to settings or
  // any other page: those routes unmount this component, which used to drop
  // the open panel with it. Same per-session keys as the draft above.
  const panelKey = `devden.panel:${tab.key}`;
  const [viewer, setViewer] = useState<ToolFileView | null>(() => {
    try {
      const restored: ToolFileView | null = JSON.parse(
        localStorage.getItem(`${panelKey}:viewer`) ?? "null",
      );
      // Image previews embed the attachment bytes; not worth persisting.
      return restored && !restored.imageSrc ? restored : null;
    } catch {
      return null;
    }
  });
  const [hiddenSubagents, setHiddenSubagents] = useState<string[]>([]);
  const [pinnedSubagents, setPinnedSubagents] = useState<string[]>([]);
  const [focusedSubagent, setFocusedSubagent] = useState<string | null>(null);
  const seenRunningSubagents = useRef<Set<string>>(new Set());
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [models, setModels] = useState<ModelInfo[]>(() =>
    tab.backend === "claude" ? CLAUDE_MODELS : [],
  );
  const [levels, setLevels] = useState<string[]>(() =>
    tab.backend === "claude" ? CLAUDE_EFFORT_LEVELS : [],
  );
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [remoteQr, setRemoteQr] = useState<{
    qrDataUrl: string;
    connectUrl: string;
  } | null>(null);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  // Model menu extras from the workbench redesign: search, keyboard
  // navigation and the per-agent usage bars.
  const [modelQuery, setModelQuery] = useState("");
  const [modelIndex, setModelIndex] = useState(0);
  const [, setAgentNote] = useState<AgentBackend | null>(null);
  const modelSearchRef = useRef<HTMLInputElement | null>(null);
  const [pickerBackend, setPickerBackend] = useState<AgentBackend | null>(null);
  // Per-backend model catalogs for the picker. Claude's list is a fixed
  // client-side constant (instant); the rest are warmed eagerly so browsing
  // agents never shows the multi-second "Loading models…" spinner.
  const [pickerModels, setPickerModels] = useState<
    Partial<Record<AgentBackend, ModelInfo[]>>
  >({ claude: CLAUDE_MODELS });
  // Thinking ladders for backends browsed in the picker (not the session's
  // own backend): fetched per backend so the track reflects what you click,
  // not what the session happens to run on.
  const [pickerLevels, setPickerLevels] = useState<
    Partial<Record<AgentBackend, string[]>>
  >({ claude: CLAUDE_EFFORT_LEVELS });
  const [usageOpen, setUsageOpen] = useState(false);
  const [effortHover, setEffortHover] = useState<number | null>(null);
  const pendingModelRef = useRef<ModelInfo | null>(null);
  const pendingBackendRef = useRef<AgentBackend | null>(null);
  const usagePopRef = useRef<HTMLDivElement | null>(null);
  const backendUsage = useBackendUsage();
  // Reset countdown for the active backend's nearest limit window, shown
  // under the composer's tool row (only while that window is in flight).
  const currentReset = usagePair(backendUsage[tab.backend]).reset;
  // Compaction is a long, silent backend job: pi/claude re-summarize the whole
  // history before answering. Without a visible in-progress state the UI looked
  // idle, so /compact got sent again and again.
  const [compacting, setCompacting] = useState(false);
  const [accessMode, setAccessMode] = useState<AccessMode>(
    tab.accessMode ?? "workspace-write",
  );
  const [agentMode, setAgentMode] = useState<AgentMode>(
    tab.agentMode ?? "standard",
  );
  const [route, setRoute] = useState<SessionRoute>(emptyRoute);
  const [routePicking, setRoutePicking] = useState(true);
  const [openRoleId, setOpenRoleId] = useState<string | null>(null);
  const [forkingId, setForkingId] = useState<string | null>(null);
  const [reviews, setReviews] = useState<
    {
      id: string;
      backend: AgentBackend;
      integrityKey: string;
      taskKey: string;
    }[]
  >([]);
  // Per-turn explicit expand/collapse. Cleared when the next prompt is sent
  // so older logs fold; the newest finished turn stays open by default.
  const [turnOpen, setTurnOpen] = useState<Record<string, boolean>>({});
  const [reviewStarting, setReviewStarting] = useState<AgentBackend | null>(
    null,
  );
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  // "@" file picker: the caret position is tracked because a mention is only
  // the token immediately before the caret, unlike "/" which owns the draft.
  const [caret, setCaret] = useState(0);
  const [mentionMatches, setMentionMatches] = useState<WorkspaceMatch[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  // Prompts lined up behind the running turn. Server-owned, so a refresh or a
  // second tab sees the same queue.
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  // Live queue_updated events win over a stale getState() snapshot that
  // still listed a message after sendNextQueued had already drained it.
  const queueFromEventRef = useRef(false);
  // Set for one send by Cmd/Ctrl+Enter, then cleared.
  const steerOnceRef = useRef(false);
  const sendLockRef = useRef(false);
  const lastSendRef = useRef({ text: "", at: 0 });
  const caps = capabilitiesFor(tab.backend);
  // Offering steer on a backend that cannot take a mid-turn message only
  // produced a failed send, so those sessions queue instead.
  const canSteer = caps.steer;
  const [conversationView, setConversationView] = useState<SessionView>("chat");
  const [sessionDetailsOpen, setSessionDetailsOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(
    () => localStorage.getItem(`${panelKey}:open`) === "1",
  );
  const [workspaceTab, setWorkspaceTab] = useState<"files" | "changes">(() =>
    localStorage.getItem(`${panelKey}:tab`) === "changes" ? "changes" : "files",
  );
  const [boardOpen, setBoardOpen] = useState(false);
  useEffect(() => {
    localStorage.setItem(`${panelKey}:open`, workspaceOpen ? "1" : "0");
  }, [panelKey, workspaceOpen]);
  useEffect(() => {
    localStorage.setItem(`${panelKey}:tab`, workspaceTab);
  }, [panelKey, workspaceTab]);
  useEffect(() => {
    try {
      if (viewer && !viewer.imageSrc)
        localStorage.setItem(`${panelKey}:viewer`, JSON.stringify(viewer));
      else localStorage.removeItem(`${panelKey}:viewer`);
    } catch {
      /* oversized content — skip persisting */
    }
  }, [panelKey, viewer]);
  // Mounted with the restored open flag so a persisted explorer renders
  // after navigating back from settings.
  const [workspaceMounted, setWorkspaceMounted] = useState(workspaceOpen);
  const [workspacePlacement, setWorkspacePlacement] =
    // Always opens docked beside the chat (conversation → files → editor);
    // full screen is a per-visit expand, not a sticky preference.
    useState<WorkspacePlacement>("side");
  const workspacePickerRef = useRef<WorkspacePickerHandle | null>(null);
  // Width-aware tight mode: any side pane (board, explorer, subagents, route
  // pane) or a narrow window shrinks the conversation column — apply the same
  // compact treatment split sessions get, whatever the cause.
  const conversationRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [providerUsage, setProviderUsage] = useState<ProviderUsage | null>(
    null,
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounterRef = useRef(0);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const usageRequestRef = useRef<Promise<boolean> | null>(null);
  const usageRefreshPendingRef = useRef(false);
  const commandRequestRef = useRef<Promise<void> | null>(null);
  const modelMetadataRequestRef = useRef<Promise<void> | null>(null);
  const commandsLoadedRef = useRef(false);
  const modelMetadataLoadedRef = useRef(tab.backend === "claude");
  // Stamps each models/levels fetch; a response landing after the tab's
  // backend changed must be dropped, not shown as the new backend's models.
  const metadataGenRef = useRef(0);
  const metadataBackendRef = useRef(tab.backend);

  const state = timeline.state;

  const persistRoute = (next: SessionRoute) => {
    setRoute(next);
    void api.putRoute(tab.key, next, tab.sessionPath ?? state?.sessionFile);
  };

  useEffect(() => {
    let cancelled = false;
    void api.getRoute(tab.key, tab.sessionPath).then((result) => {
      if (cancelled || !result.ok || !result.route) return;
      setRoute(result.route);
      setRoutePicking(!result.route.template);
      if (result.route.enabled) setAgentMode("routed");
    });
    return () => {
      cancelled = true;
    };
  }, [tab.key, tab.sessionPath]);

  const awaitingRoute =
    agentMode === "routed" && (routePicking || !route.template);

  const dismissRoutePick = () => {
    if (route.template) setRoutePicking(false);
    else void switchAgentMode("standard");
  };

  useEffect(() => {
    if (!awaitingRoute) return;
    textareaRef.current?.blur();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") dismissRoutePick();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [awaitingRoute]);

  const status = timeline.status;
  // A subagent run keeps going after pi's own turn settles (its children work
  // detached, so pi's status flips back to "ready" the moment it hands the
  // job off) — count it as busy too, so the UI waits for the subagent the
  // way Claude Code's CLI blocks on a Task call instead of going idle.
  const subagentRuns = collectSubagentRuns(timeline.items);
  const subagentRunning = subagentRuns.some((run) => run.status === "running");
  const streaming =
    status === "working" || state?.isStreaming === true || subagentRunning;
  // Belt against under-reported runs: a pane opened from saved history can
  // miss agent adoption, leaving status "ready" while the session's real
  // agent still streams. The sessions list — the same signal that blinks
  // the sidebar row — is the fallback trigger for the stop button.
  const sessionFile = tab.sessionPath ?? state?.sessionFile;
  const serverRunning = Boolean(
    sessionFile &&
      resumeSessions.some(
        (session) => session.path === sessionFile && session.isStreaming,
      ),
  );
  // Three or more panes: the composer collapses to two lines total — one
  // text line plus the model row. (density != "full" ⟺ ≥3 panes; two panes
  // and narrow single panes stay on the roomier tight layout.)
  const thin = split && density !== "full";
  const agentBusy = streaming || serverRunning;
  const firstUserItem = timeline.items.find(
    (item) =>
      item.kind === "user" &&
      !isLocalCommandText(item.kind === "user" ? item.text : ""),
  );
  const firstUserText =
    firstUserItem?.kind === "user" ? firstUserItem.text : undefined;
  const displayTitle = contextualSessionTitle(
    state?.sessionName || firstUserText || tab.label,
    tab.label,
  );
  const todos = extractTodos(timeline.items, { turnComplete: !streaming });

  // Auto-saved transcript. Written the moment a turn settles -- finished,
  // aborted, or killed by limit exhaustion (all flip `streaming` off) -- so
  // a backend switch or closed tab right after never sees a stale file.
  // Entirely mechanical -- no model is asked to summarise, so no tokens.
  const [transcriptPath, setTranscriptPath] = useState<string | null>(null);
  const saveTranscript = async (): Promise<string | null> => {
    if (timeline.items.length === 0 || !tab.cwd) return transcriptPath;
    const markdown = timelineToMarkdown(
      timeline.items,
      {
        title: displayTitle,
        backend: backendLabel(tab.backend),
        model: state?.model?.name ?? state?.model?.id,
        cwd: tab.cwd,
        todos: todos
          .filter(
            (task) =>
              task.status === "pending" || task.status === "in_progress",
          )
          .map((task) => task.subject),
      },
      { full: true },
    );
    const result = await api.writeTranscript(
      transcriptFilename(tab.sessionPath ?? tab.key, displayTitle),
      markdown,
    );
    if (!result.ok || !result.path) return transcriptPath;
    setTranscriptPath(result.path);
    return result.path;
  };
  const wasStreamingRef = useRef(streaming);
  useEffect(() => {
    const turnEnded = wasStreamingRef.current && !streaming;
    wasStreamingRef.current = streaming;
    if (streaming) return;
    if (turnEnded) {
      void saveTranscript();
      return;
    }
    // Idle edits (history load, notices, rewinds): debounced, not urgent.
    const handle = window.setTimeout(() => void saveTranscript(), 2000);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, timeline.items, displayTitle, tab.key, tab.cwd, tab.backend]);

  // Set by an in-place backend switch; the next prompt to the new agent
  // carries it so the agent reads what the old one did before answering.
  // `from` is the backend that actually produced the transcript — not the
  // picker selection being switched away from — so a pi→claude→pi round trip
  // that never sends a message does not claim the transcript came from Claude.
  const pendingHandoffRef = useRef<{
    path: string;
    from: AgentBackend;
  } | null>(null);
  // Stamps from the previous backend stay on the transcript. The card only
  // counts usage that happened after the switch.
  const usageSinceRef = useRef(0);
  const transcriptBackendRef = useRef<AgentBackend>(tab.backend);
  const switchBackend = async (next: AgentBackend) => {
    setModelMenuOpen(false);
    if (next === tab.backend || streaming || configuring) return;
    if (isUnstartedTab(tab)) {
      setDefaultBackend(next);
      return;
    }
    const from = transcriptBackendRef.current;
    // Switching back before a prompt means the transcript is still `from`.
    usageSinceRef.current = next === from ? 0 : Date.now();
    // Save now rather than trust the last write: the brief must point at a
    // file that holds every turn so far.
    const path = await saveTranscript();
    // Free the old agent's process; the new one starts on the next prompt.
    await api.stop(tab.key);
    setConversationBackend(tab.key, next);
    pendingHandoffRef.current = path ? { path, from } : null;
    timeline.appendNotice(
      next === from
        ? `Switched back to ${backendLabel(from)}.`
        : `Switched from ${backendLabel(from)} to ${backendLabel(next)}. Your next message hands it this conversation's transcript.`,
      "info",
    );
  };

  const startTurnReview = async (backend: AgentBackend) => {
    if (reviewStarting || streaming || !tab.cwd) return;
    const userRequest = lastUserRequest(visibleItems);
    if (!userRequest) {
      timeline.appendNotice(
        "Nothing to review — no user request on this turn.",
        "info",
      );
      return;
    }
    setReviewStarting(backend);
    try {
      const payload = await collectReviewDiff(
        tab.key,
        tab.cwd,
        lastUserTimestamp(visibleItems),
        turnStats(visibleItems).files,
      );
      if (!payload.ok) {
        timeline.appendNotice(
          payload.error ?? "Could not collect the review diff.",
          "error",
        );
        return;
      }
      if (!payload.diff.trim()) {
        timeline.appendNotice(
          payload.reason ??
            "Nothing to review — this turn did not change the tree.",
          "info",
        );
        return;
      }
      const parts = partitionUnifiedDiff(payload.diff);
      const sourceHunks = capText(formatReviewHunks(parts.sourceDiff));
      const testHunks = capText(formatReviewHunks(parts.testDiff)) || "none";
      const prechecks = scanPrechecks(parts.sourceDiff, parts.testDiff);
      const integrity = integrityPrompt({
        userRequest,
        sourceHunks,
        testHunks,
        prechecks,
      });
      const task = taskPrompt({ userRequest, sourceHunks });
      const [integrityRun, taskRun] = await Promise.all([
        launchReviewSession({
          backend,
          cwd: tab.cwd,
          label: `${displayTitle} · integrity`,
          prompt: integrity,
        }),
        launchReviewSession({
          backend,
          cwd: tab.cwd,
          label: `${displayTitle} · task`,
          prompt: task,
        }),
      ]);
      if ("error" in integrityRun && "error" in taskRun) {
        timeline.appendNotice(
          integrityRun.error ??
            "Integrity and task review both failed to start.",
          "error",
        );
        return;
      }
      if ("error" in integrityRun)
        timeline.appendNotice(
          integrityRun.error ?? "Integrity review failed to start.",
          "warning",
        );
      if ("error" in taskRun)
        timeline.appendNotice(
          taskRun.error ?? "Task review failed to start.",
          "warning",
        );
      if ("key" in integrityRun && "key" in taskRun) {
        setReviews((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            backend,
            integrityKey: integrityRun.key,
            taskKey: taskRun.key,
          },
        ]);
      }
    } finally {
      setReviewStarting(null);
    }
  };

  const launchReviewSession = async (args: {
    backend: AgentBackend;
    cwd: string;
    label: string;
    prompt: string;
  }): Promise<{ key: string } | { error: string }> => {
    const key = openConversation(args.cwd, args.label, args.backend, {
      activate: false,
      guest: true,
    });
    const configured = await api.configure(
      key,
      args.cwd,
      "workspace-write",
      "standard",
      undefined,
      BACKEND_DEFAULT_EFFORT[args.backend],
      undefined,
      args.backend,
    );
    if (!configured.ok) {
      closeConversation(key);
      return {
        error:
          configured.error ??
          `${backendLabel(args.backend)} could not start the review.`,
      };
    }
    const sent = await api.prompt(key, args.prompt, {
      cwd: args.cwd,
      backend: args.backend,
      thinkingLevel: BACKEND_DEFAULT_EFFORT[args.backend],
      accessMode: "workspace-write",
      agentMode: "standard",
    });
    if (!sent.ok) {
      closeConversation(key);
      return {
        error:
          sent.error ??
          `${backendLabel(args.backend)} did not take the review.`,
      };
    }
    return { key };
  };

  useEffect(() => {
    const onSeed = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; text: string }>)
        .detail;
      if (detail?.key === tab.key) setDraft(detail.text);
    };
    window.addEventListener("devden:seed-draft", onSeed);
    return () => window.removeEventListener("devden:seed-draft", onSeed);
  }, [tab.key]);
  // Every built-in backend reports the window the model is actually using.
  // The character estimate is only for a backend that has no count at all.
  // Claude's count is a CLI call, so it waits until the turn is idle. Grok
  // and Codex read a number they already have, including mid-turn.
  const [exactContext, setExactContext] = useState<ContextUsageReport | null>(
    null,
  );
  const estimated = estimateContext(timeline.items, state);
  const reported: ContextUsage | null = exactContext
    ? {
        estimatedTokens: exactContext.totalTokens,
        contextWindow: exactContext.maxTokens,
        percent: exactContext.percent,
        exact: true,
        autoCompactAt: exactContext.isAutoCompactEnabled
          ? exactContext.autoCompactThreshold
          : undefined,
        categories: exactContext.categories,
      }
    : null;
  const context: ContextUsage = reported ?? estimated;
  const hasItems = timeline.items.length > 0;
  useEffect(() => {
    const el = conversationRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setNarrow(
        (entries[entries.length - 1]?.contentRect.width ?? Infinity) < 640,
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasItems]);
  // Reasoning summaries are intentionally not rendered in the chat view. The
  // data still flows through the timeline (Trajectory tab, context estimates),
  // but the transcript stays clean; thinking activity surfaces as a
  // rotating status while the agent streams.
  // Subagent calls render inside the Task card that spawned them, so they
  // must not also appear as siblings in the main transcript.
  const subagentChildren = new Map<
    string,
    Extract<TimelineItem, { kind: "tool" }>[]
  >();
  for (const item of timeline.items) {
    if (item.kind !== "tool" || !item.parentToolUseId) continue;
    const siblings = subagentChildren.get(item.parentToolUseId) ?? [];
    siblings.push(item);
    subagentChildren.set(item.parentToolUseId, siblings);
  }
  // grok mirrors a child's tools and narration back onto the parent ACP
  // stream without a parent id, so those copies have to be filtered out by
  // shape. Claude (and pi, when it grows subagents) tags every nested event,
  // and running the same filters there hid the main agent's *own* work
  // whenever a subagent happened to be busy.
  const mirrorsChildWork = tab.backend === "grok";
  const subagentBusy =
    mirrorsChildWork && subagentRuns.some((run) => run.status === "running");

  // --- The quota wall ------------------------------------------------------
  // Only a turn that actually died on an exhausted limit gets the pill. A
  // percentage readout is not an event: a window sitting at 100% on an idle
  // session has nothing to resume, and a transient 429 that clears on its own
  // is not the same failure as a quota that has run out. The provider's own
  // numbers still supply the window's name and its reset instant.
  const limitTurn = pendingLimitTurn(timeline.items, isLocalCommandText);
  const limitWindow = exhaustedWindow(providerUsage);
  const limitVisible = Boolean(limitTurn);

  const visibleItems = timeline.items
    .filter(
      (item) =>
        (showThinking || item.kind !== "rationale") &&
        !(item.kind === "tool" && item.parentToolUseId) &&
        !(
          (item.kind === "assistant" || item.kind === "rationale") &&
          item.parentToolUseId
        ) &&
        !isHeldMainTool(item, subagentBusy, timeline.items) &&
        !isHeldMainNarration(item, subagentBusy) &&
        !isSettledSpawnTool(item, subagentRuns) &&
        // The positional check below can only hide a check-in once the call
        // it introduces has arrived, so on its own it let the text flash in
        // and back out again. This holds that narration while it streams —
        // and only that narration, so the main agent's own work still
        // arrives token by token during a run.
        !isSubagentChatter(item, subagentRuns) &&
        !isSubagentCheckIn(item, timeline.items) &&
        !(mirrorsChildWork && isSubagentEcho(item, timeline.items)) &&
        !(mirrorsChildWork && isSubagentToolEcho(item, timeline.items)) &&
        !(item.kind === "user" && isLocalCommandText(item.text)) &&
        // The quota pill above the composer owns this message; a red block in
        // the transcript saying the same thing is the same wall twice.
        !(
          limitVisible &&
          item.kind === "notice" &&
          isUsageLimitError(item.text)
        ),
    )
    .filter((item, index, all) => {
      if (item.kind !== "assistant" || !isAskMessage(item.text)) return true;
      for (let i = index - 1; i >= 0; i--) {
        const prev = all[i]!;
        if (prev.kind === "user" || prev.kind === "tool") return true;
        if (prev.kind === "assistant" && isAskMessage(prev.text)) return false;
      }
      return true;
    });
  const liveNarration = visibleItems.at(-1);
  const showingLiveText = Boolean(
    liveNarration && liveNarration.kind === "assistant" && liveNarration.live,
  );
  const liveTextStalled = useLiveTextStalled(
    showingLiveText,
    showingLiveText && liveNarration?.kind === "assistant"
      ? liveNarration.text
      : "",
  );
  const chatTurns = useMemo(() => splitTurns(visibleItems), [visibleItems]);
  const latestChangedTurn = useMemo(
    () => chatTurns.findLastIndex((turn) => turnChangedFiles(turn).length > 0),
    [chatTurns],
  );
  const lastTurnKey = chatTurns.at(-1) ? turnKey(chatTurns.at(-1)!) : "";
  useEffect(() => {
    setTurnOpen({});
  }, [tab.key, lastTurnKey]);
  // TimelineRow is memoized; passing fresh inline closures here would bust the
  // memo on every tick. Route the calls through a ref so identities stay
  // stable while the closures always see the latest state.
  const rowHandlersRef = useRef({
    onFork: (_item: Extract<TimelineItem, { kind: "assistant" }>): void => {},
    onRewindFiles: async (
      _timestamp: number,
      _dryRun: boolean,
    ): Promise<RewindFilesResult> => ({}),
    onEditMessage: (_item: Extract<TimelineItem, { kind: "user" }>): void => {},
    onCancelEdit: (): void => {},
    onVersionChange: (
      _item: Extract<TimelineItem, { kind: "user" }>,
      _index: number,
    ): void => {},
    onAnswer: (_text: string): void => {},
    onOpenSubagent: (_id: string): void => {},
    onBackgroundSubagent: (_id: string): void => {},
    onStopTerminal: (_tabId: string): void => {},
  });
  rowHandlersRef.current = {
    onFork: (item) => void forkOutput(item),
    onRewindFiles: async (timestamp, dryRun) => {
      const result = await api.rewindFiles(tab.key, timestamp, dryRun, {
        cwd: tab.cwd,
        sessionPath: state?.sessionFile,
      });
      if (!result.ok)
        return { error: result.error ?? "The rewind could not be applied." };
      return result.data ?? {};
    },
    onEditMessage: (messageItem) => {
      setEditingMessageId(messageItem.id);
      setDraft(
        messageItem.versions?.[messageItem.versionIndex ?? 0]?.text ??
          messageItem.text,
      );
      window.setTimeout(() => {
        autoGrow();
        textareaRef.current?.focus();
      }, 0);
    },
    onCancelEdit: () => {
      setEditingMessageId(null);
      setDraft("");
    },
    onVersionChange: (messageItem, index) =>
      void selectUserVersion(messageItem, index),
    onAnswer: (text) => void send(text, undefined, { answersAsk: true }),
    onOpenSubagent: (id) => {
      setHiddenSubagents((current) =>
        current.filter((openId) => openId !== id),
      );
      const run = subagentRuns.find((candidate) => candidate.id === id);
      if (run && run.status !== "running") {
        setPinnedSubagents((current) =>
          current.includes(id) ? current : [...current, id],
        );
      }
      setFocusedSubagent(id);
    },
    onBackgroundSubagent: (id) => {
      setHiddenSubagents((current) =>
        current.includes(id) ? current : [...current, id],
      );
      setPinnedSubagents((current) =>
        current.filter((openId) => openId !== id),
      );
    },
    onStopTerminal: (tabId) => {
      void api.stopTerminal(tab.key, tabId);
    },
  };
  const stableRowHandlers = useMemo(
    () => ({
      onEditMessage: (
        messageItem: Extract<TimelineItem, { kind: "user" }>,
      ): void => rowHandlersRef.current.onEditMessage(messageItem),
      onCancelEdit: (): void => rowHandlersRef.current.onCancelEdit(),
      onVersionChange: (
        messageItem: Extract<TimelineItem, { kind: "user" }>,
        index: number,
      ): void => rowHandlersRef.current.onVersionChange(messageItem, index),
      onFork: (item: Extract<TimelineItem, { kind: "assistant" }>): void =>
        rowHandlersRef.current.onFork(item),
      onRewindFiles: (
        timestamp: number,
        dryRun: boolean,
      ): Promise<RewindFilesResult> =>
        rowHandlersRef.current.onRewindFiles(timestamp, dryRun),
      onAnswer: (text: string): void => rowHandlersRef.current.onAnswer(text),
      onOpenSubagent: (id: string): void =>
        rowHandlersRef.current.onOpenSubagent(id),
      onBackgroundSubagent: (id: string): void =>
        rowHandlersRef.current.onBackgroundSubagent(id),
      onStopTerminal: (tabId: string): void =>
        rowHandlersRef.current.onStopTerminal(tabId),
    }),
    [],
  );
  useEffect(() => {
    setHiddenSubagents([]);
    setPinnedSubagents([]);
    seenRunningSubagents.current = new Set();
  }, [tab.key]);
  const runningSubagentKey = subagentRuns
    .filter((run) => run.status === "running")
    .map((run) => run.id)
    .join(",");
  useEffect(() => {
    const running = runningSubagentKey ? runningSubagentKey.split(",") : [];
    const justDone = [...seenRunningSubagents.current].filter(
      (id) => !running.includes(id),
    );
    seenRunningSubagents.current = new Set(running);
    if (justDone.length === 0) return;
    // A finished run stays open as a tab until the user closes it — closing
    // on a timer hid the findings the moment they arrived, and made each new
    // subagent mint its own transient pane instead of joining this one.
    setPinnedSubagents((current) => [...new Set([...current, ...justDone])]);
  }, [runningSubagentKey]);
  const openSubagents = useMemo(() => {
    const running = subagentRuns
      .filter(
        (run) => run.status === "running" && !hiddenSubagents.includes(run.id),
      )
      .map((run) => run.id);
    const pinned = pinnedSubagents.filter(
      (id) =>
        !hiddenSubagents.includes(id) &&
        subagentRuns.some((run) => run.id === id && run.status !== "running"),
    );
    return [...running, ...pinned];
  }, [hiddenSubagents, pinnedSubagents, subagentRuns]);
  useEffect(() => {
    if (focusedSubagent && openSubagents.includes(focusedSubagent)) return;
    setFocusedSubagent(openSubagents.at(-1) ?? null);
  }, [focusedSubagent, openSubagents]);
  const responseActionIds = getResponseActionIds(visibleItems, streaming);
  // The model tag is noise when repeated under every reply — surface it only on
  // the most recent completed assistant response, and only once the whole
  // turn has settled: mid-execution the last completed block is just an
  // intermediate step, so tagging it reads like every block is tagged.
  // `streaming` already means the turn is over, so item.live must not be
  // consulted here: a final text block whose terminating chunk never arrived
  // stays live: true forever (seen on the Claude backend), and filtering on it
  // dropped the tag — and locked the reply's ask card — on a settled turn.
  const lastAssistantId = streaming
    ? undefined
    : lastAnswerableAssistantId(visibleItems);
  // Every file this session's tools wrote: the Changes dock's default scope.
  const sessionPaths = useMemo(
    () => turnChangedFiles(timeline.items).map((file) => file.path),
    [timeline.items],
  );
  const openFileView = (view: ToolFileView) => {
    if (view.imageSrc || !onOpenReview) {
      setViewer(view);
      return;
    }
    onOpenReview(view);
  };
  const renderTimelineItem = (
    item: TimelineItem,
    extras?: { repeat?: number; expandDiff?: boolean },
  ) => (
    <TimelineRow
      key={item.id}
      item={item}
      repeat={extras?.repeat}
      expandDiff={extras?.expandDiff}
      cwd={tab.cwd}
      onOpenFile={openFileView}
      dockTitle={reviewTitle}
      dockWord={dockMulti ? "In dock" : "In panel"}
      onFork={stableRowHandlers.onFork}
      onRewindFiles={stableRowHandlers.onRewindFiles}
      subagentChildren={subagentChildren}
      onOpenSubagent={stableRowHandlers.onOpenSubagent}
      onBackgroundSubagent={stableRowHandlers.onBackgroundSubagent}
      onStopTerminal={stableRowHandlers.onStopTerminal}
      forking={forkingId === item.id}
      canFork={caps.fork}
      canTruncate={caps.truncate}
      showActions={responseActionIds.has(item.id)}
      showModelTag={item.id === lastAssistantId}
      onAnswer={
        item.id === lastAssistantId ? stableRowHandlers.onAnswer : undefined
      }
      editingId={editingMessageId}
      streaming={streaming}
      onEditMessage={stableRowHandlers.onEditMessage}
      onCancelEdit={stableRowHandlers.onCancelEdit}
      onVersionChange={stableRowHandlers.onVersionChange}
    />
  );
  const runningShell = streaming
    ? [...timeline.items]
        .reverse()
        .find(
          (item): item is Extract<TimelineItem, { kind: "tool" }> =>
            item.kind === "tool" &&
            !item.parentToolUseId &&
            !isHeldMainTool(item, subagentBusy, timeline.items) &&
            !(mirrorsChildWork && isSubagentToolEcho(item, timeline.items)) &&
            (item.name.toLowerCase() === "bash" ||
              item.execKind === "execute") &&
            item.status === "running",
        )
    : undefined;
  const showThinkingIndicator = shouldShowThinkingRow({
    streaming,
    runningShell: Boolean(runningShell),
    subagentRunning,
    compacting,
    showingLiveText,
    liveTextStalled,
  });

  const loadModelMetadata = useCallback(() => {
    if (
      modelMetadataLoadedRef.current ||
      modelMetadataRequestRef.current ||
      status === "starting" ||
      status === "stopped"
    )
      return;
    const gen = metadataGenRef.current;
    const request = Promise.all([
      api.models(tab.key, tab.backend),
      api.thinkingLevels(tab.key, tab.backend),
    ])
      .then(([modelResult, levelResult]) => {
        // The tab's backend changed while this was in flight: drop the old
        // backend's catalogs instead of showing them as the new one's.
        if (gen !== metadataGenRef.current) return;
        if (
          modelResult.ok &&
          Array.isArray(modelResult.models) &&
          modelResult.models.length > 0
        )
          setModels(modelResult.models);
        if (
          levelResult.ok &&
          Array.isArray(levelResult.levels) &&
          levelResult.levels.length > 0
        )
          // The selected model's own catalog levels win (per-model, like
          // synara); the session's live answer is the fallback for models
          // without catalog metadata.
          setLevels(levelResult.levels);
        if (modelResult.ok && Array.isArray(modelResult.models)) {
          const active = modelResult.models.find(
            (candidate) =>
              candidate.provider === state?.model?.provider &&
              candidate.id === state?.model?.id,
          );
          if (Array.isArray(active?.levels) && active.levels.length > 0)
            setLevels(active.levels);
        }
        if (modelResult.ok && levelResult.ok)
          modelMetadataLoadedRef.current = true;
      })
      .finally(() => {
        modelMetadataRequestRef.current = null;
      });
    modelMetadataRequestRef.current = request;
  }, [status, tab.backend, tab.key, state?.model]);

  // Backend switched under this tab (the sidebar picker retargets unstarted
  // tabs): drop the old backend's model/effort lists and clear the guards
  // BEFORE the warm effect below runs in this same commit — it would bail on
  // the loaded-once flag otherwise and keep showing e.g. Sonnet under grok.
  useEffect(() => {
    if (metadataBackendRef.current === tab.backend) return;
    metadataBackendRef.current = tab.backend;
    metadataGenRef.current += 1;
    modelMetadataLoadedRef.current = false;
    // Free the slot: an in-flight fetch for the old backend is still
    // tracked, and its response is dropped by the generation stamp above.
    modelMetadataRequestRef.current = null;
    setModels([]);
    setLevels([]);
  }, [tab.backend]);

  // Warm the model list as soon as the session is usable. The server caches
  // catalogs per backend, so this is one cheap request that turns the model
  // dropdown from a multi-second spinner into an instant open.
  useEffect(() => {
    if (!visible || status === "starting" || status === "stopped") return;
    loadModelMetadata();
  }, [loadModelMetadata, status, visible]);

  const loadCommands = useCallback(() => {
    if (
      commandsLoadedRef.current ||
      commandRequestRef.current ||
      status === "starting" ||
      status === "stopped"
    )
      return;
    const request = api
      .commands(tab.key, tab.backend, tab.cwd)
      .then((result) => {
        if (result.ok && Array.isArray(result.commands)) {
          setCommands(result.commands);
          commandsLoadedRef.current = true;
        }
      })
      .finally(() => {
        commandRequestRef.current = null;
      });
    commandRequestRef.current = request;
  }, [status, tab.backend, tab.cwd, tab.key]);

  const openWorkspace = useCallback((nextTab?: "files" | "changes") => {
    if (nextTab) setWorkspaceTab(nextTab);
    setWorkspaceMounted(true);
    setWorkspaceOpen(true);
  }, []);

  useEffect(() => {
    if (workspaceReveal?.key === tab.key) openWorkspace();
  }, [openWorkspace, tab.key, workspaceReveal]);

  const chooseWorkspacePlacement = useCallback(
    (next: WorkspacePlacement) => {
      setWorkspacePlacement(next);
      openWorkspace();
    },
    [openWorkspace],
  );

  const closeWorkspace = useCallback(() => setWorkspaceOpen(false), []);

  // A session opening beside this one halves the pane; a docked explorer
  // would crush the chat. Close it — the toggle reopens it as usual.
  useEffect(() => {
    if (split) setWorkspaceOpen(false);
  }, [split]);

  const toggleWorkspace = () => {
    setWorkspaceOpen((open) => {
      if (!open) setWorkspaceMounted(true);
      return !open;
    });
  };
  // In a split the workspace buttons drive the grid's shared right pane.
  const workspaceShown = onSharedWorkspaceToggle
    ? sharedWorkspaceOpen
    : workspaceOpen;
  const workspaceButton = onSharedWorkspaceToggle ?? toggleWorkspace;

  useEffect(() => {
    if (draft.startsWith("/") || commandMenuOpen) loadCommands();
  }, [commandMenuOpen, draft, loadCommands]);

  useEffect(() => {
    let cancelled = false;
    void api.backendLog(tab.key).then((result) => {
      if (!cancelled && result.ok && Array.isArray(result.entries))
        timeline.hydrateBackendLog(result.entries);
    });
    return () => {
      cancelled = true;
    };
  }, [tab.key, timeline]);

  const refreshUsage = useCallback(
    (force = false): Promise<boolean> => {
      if (usageRequestRef.current) return usageRequestRef.current;
      const request = api
        .usage(
          tab.key,
          tab.backend,
          force,
          tab.sessionPath ?? timeline.state?.sessionFile,
        )
        .then((result) => {
          setProviderUsage(result.ok ? result.usage : null);
          return result.ok;
        })
        .catch(() => {
          setProviderUsage(null);
          return false;
        })
        .finally(() => {
          usageRequestRef.current = null;
        });
      usageRequestRef.current = request;
      return request;
    },
    [tab.backend, tab.key, tab.sessionPath, timeline],
  );

  // The percentages lag the failure (the poll runs every 30-60s), so ask now
  // that it has landed rather than showing the banner with stale numbers.
  useEffect(() => {
    if (visible && limitTurn?.noticeId) void refreshUsage(true);
  }, [limitTurn?.noticeId, refreshUsage, visible]);

  /**
   * Sends a harness nudge rather than the user's text again: the agent still
   * holds its session, so all it is missing is the fact that the last turn
   * never finished. Nothing is appended to the transcript — the nudge is not
   * the user talking.
   */
  const resumeFromLimit = async () => {
    if (!limitTurn || streaming) return;
    const prompt = limitResumePrompt(
      limitTurn.request,
      limitScope(limitWindow?.label ?? ""),
    );
    timeline.appendNotice("Resuming the interrupted turn…", "info");
    timeline.markPendingRun();
    const result: {
      ok: boolean;
      error?: string;
      data?: { queued?: boolean };
    } = await api.prompt(tab.key, prompt, {
      cwd: tab.cwd,
      backend: tab.backend,
      sessionPath: tab.sessionPath ?? state?.sessionFile ?? undefined,
      model: state?.model ?? undefined,
      thinkingLevel: state?.thinkingLevel ?? undefined,
      accessMode,
      agentMode: apiAgentMode(agentMode),
    });
    if (!result.ok) {
      timeline.clearPendingRun();
      timeline.appendNotice(
        result.error ?? "Could not resume the interrupted turn",
        "error",
      );
    } else if (result.data?.queued) timeline.clearPendingRun();
  };

  useEffect(() => {
    // Refresh once when the session loads. While the agent is working, poll every
    // 30s with a forced provider check so the composer usage stays current.
    // A session whose turn is done — or that was only opened for viewing —
    // still owns a usage quota, so ask as long as there is something to ask
    // about: a live state, or a session file the server can read. Only a
    // brand-new conversation (neither) stays quiet.
    if (!visible || status === "starting" || (!state && !tab.sessionPath))
      return;
    let timer: number | undefined;
    let cancelled = false;
    const running = status === "working" || state?.isStreaming === true;
    const interval = running
      ? USAGE_RUNNING_REFRESH_INTERVAL_MS
      : USAGE_IDLE_REFRESH_INTERVAL_MS;

    const schedule = () => {
      if (cancelled) return;
      if (!running && document.hidden) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void refreshUsage(running).finally(schedule);
      }, interval);
    };
    const refreshOnVisible = () => {
      if (document.hidden && !running) {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
        return;
      }
      const force = running || usageRefreshPendingRef.current;
      usageRefreshPendingRef.current = false;
      void refreshUsage(force).finally(schedule);
    };

    // Defer the first poll on an idle session: usage is a CLI round-trip that
    // competes with page-load requests for the browser's per-origin sockets,
    // and it only feeds a composer chip. A running turn still asks at once.
    if (running) void refreshUsage(true).finally(schedule);
    else
      timer = window.setTimeout(() => {
        timer = undefined;
        void refreshUsage(false).finally(schedule);
      }, 1200);
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [
    refreshUsage,
    state?.isStreaming,
    state?.model?.id,
    state?.model?.provider,
    status,
    tab.sessionPath,
    visible,
  ]);

  useEffect(() => {
    queueFromEventRef.current = false;
    setQueued(state?.queuedMessages ?? []);
  }, [tab.key]);

  useEffect(() => {
    if (queueFromEventRef.current) return;
    setQueued(state?.queuedMessages ?? []);
  }, [state?.queuedMessages]);

  useEffect(
    () =>
      subscribeEvents((event) => {
        if (event.sessionKey !== tab.key || event.type !== "queue_updated")
          return;
        queueFromEventRef.current = true;
        setQueued((event.queued as QueuedMessage[]) ?? []);
      }),
    [tab.key],
  );

  useEffect(() => {
    // Pi's count asks the live process, which is busy mid-turn. Claude's
    // count is a separate CLI call. Grok and Codex already hold the number.
    if (!visible) return;
    const waitUntilIdle = tab.backend === "claude" || tab.backend === "pi";
    if (!caps.contextUsage || (streaming && waitUntilIdle)) {
      if (!caps.contextUsage) setExactContext(null);
      return;
    }
    let cancelled = false;
    // Same reason as the usage poll: `claude` takes ~2s to count context, and
    // on a page load that request sits in front of the sidebar and transcript.
    const timer = window.setTimeout(() => {
      void api
        .contextUsage(tab.key)
        .then((result) => {
          if (!cancelled)
            setExactContext(result.ok && result.data ? result.data : null);
        })
        .catch(() => {
          if (!cancelled) setExactContext(null);
        });
    }, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    caps.contextUsage,
    tab.key,
    tab.backend,
    streaming,
    timeline.items.length,
    visible,
  ]);

  useEffect(
    () =>
      subscribeEvents((event) => {
        if (event.sessionKey !== tab.key || event.type !== "agent_settled")
          return;
        if (!visible || document.hidden) {
          usageRefreshPendingRef.current = true;
          return;
        }
        void refreshUsage(true);
      }),
    [refreshUsage, tab.key, visible],
  );

  useEffect(() => {
    setConversationLabel(tab.key, displayTitle);
  }, [displayTitle, setConversationLabel, tab.key]);

  // Runs after every render (streaming replies grow the transcript on each
  // frame). Writing scrollTop unconditionally forced a synchronous layout and
  // a scroll event per render, which is what made a typing reply judder --
  // only write when the position actually has to move.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!visible || !stickToBottom.current || !el) return;
    const bottom = el.scrollHeight - el.clientHeight;
    if (Math.abs(el.scrollTop - bottom) > 1) el.scrollTop = bottom;
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const uploadFiles = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      if (file.size > 20 * 1024 * 1024) {
        timeline.appendNotice(
          `${file.name} is larger than the 20 MB upload limit.`,
          "error",
        );
        continue;
      }
      try {
        const data = await fileAsBase64(file);
        const result = await api.upload(
          tab.key,
          file.name,
          file.type || "application/octet-stream",
          data,
        );
        if (!result.ok || !result.path) {
          timeline.appendNotice(
            result.error ?? `Could not upload ${file.name}`,
            "error",
          );
          continue;
        }
        setAttachments((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            path: result.path!,
            ...(file.type.startsWith("image/") ? { imageData: data } : {}),
          },
        ]);
      } catch (error) {
        timeline.appendNotice(
          error instanceof Error
            ? error.message
            : `Could not upload ${file.name}`,
          "error",
        );
      }
    }
  };

  const dragHasFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = (event: DragEvent) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragCounterRef.current += 1;
    setDragActive(true);
  };

  const onDragOver = (event: DragEvent) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (event: DragEvent) => {
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    // relatedTarget is null only when the drag leaves the window/DOM entirely —
    // reset fully so a cancelled drag can never leave the overlay stuck on.
    if (dragCounterRef.current === 0 || event.relatedTarget === null) {
      dragCounterRef.current = 0;
      setDragActive(false);
    }
  };

  const onDrop = (event: DragEvent) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragCounterRef.current = 0;
    setDragActive(false);
    void uploadFiles(event.dataTransfer?.files ?? null);
    textareaRef.current?.focus();
  };

  const onPasteImage = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length === 0) return;
    event.preventDefault();
    // macOS screenshots copied to the clipboard arrive unnamed; give them a
    // recognizable, sortable name before they hit the upload path.
    const stamp = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const base = `screenshot-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
    const named = files.map((file, index) => {
      const extension = file.type.split("/")[1] ?? "png";
      const suffix = files.length > 1 ? `-${index + 1}` : "";
      return file.name && file.name !== "image.png"
        ? file
        : new File([file], `${base}${suffix}.${extension}`, {
            type: file.type,
          });
    });
    void uploadFiles(named);
  };

  // Keep the document-level drop catcher pointed at the latest upload closure.
  const uploadFilesRef = useRef(uploadFiles);
  useLayoutEffect(() => {
    uploadFilesRef.current = uploadFiles;
  });

  // Whole-window drop catching: without this, files dropped outside the
  // conversation panel (header, workspace rail, page edges) fall through to
  // the browser default — the tab navigates to the image and the upload
  // silently never happens.
  useEffect(() => {
    // In split view each pane owns its own drop zone; a global listener would
    // make both panes race for the same files.
    if (!visible || split) return;
    const hasFiles = (event: globalThis.DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onDocDragOver = (event: globalThis.DragEvent) => {
      if (!hasFiles(event)) return;
      // preventDefault outside .conversation is what makes the drop
      // deliverable there at all, and stops the browser from opening the file.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDocDrop = (event: globalThis.DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      // Inside the conversation panel the React handlers already own the drop.
      if (
        event.target instanceof Element &&
        event.target.closest(".conversation")
      )
        return;
      void uploadFilesRef.current(event.dataTransfer?.files ?? null);
      textareaRef.current?.focus();
    };
    document.addEventListener("dragover", onDocDragOver);
    document.addEventListener("drop", onDocDrop);
    return () => {
      document.removeEventListener("dragover", onDocDragOver);
      document.removeEventListener("drop", onDocDrop);
    };
  }, [split, visible]);

  const configureSession = async (
    nextAccess: AccessMode,
    nextMode: AgentMode,
    nextCwd = tab.cwd,
  ) => {
    const switchingFolder = nextCwd !== tab.cwd;
    if (hasItems && !switchingFolder) {
      timeline.appendNotice(
        "Access and agent mode can only be changed before the first message.",
        "warning",
      );
      return;
    }
    if (hasItems && switchingFolder) {
      setConversationWorkspace(tab.key, nextCwd);
      openWorkspace();
      return;
    }
    if (nextMode === "routed" && !switchingFolder) {
      setAgentMode("routed");
      persistRoute({ ...route, enabled: true });
      setRoutePicking(!route.template);
      return;
    }
    setConfiguring(true);
    const result = await api.configure(
      tab.key,
      nextCwd,
      nextAccess,
      apiAgentMode(nextMode),
      state?.model,
      state?.thinkingLevel,
      undefined,
      tab.backend,
    );
    setConfiguring(false);
    if (!result.ok || !result.state) {
      timeline.appendNotice(
        result.error ??
          `Could not reconfigure the ${backendLabel(tab.backend)} session`,
        "error",
      );
      return;
    }
    setAccessMode(nextAccess);
    setAgentMode(nextMode === "routed" ? "routed" : nextMode);
    timeline.reset(result.state);
    if (nextCwd !== tab.cwd) setConversationWorkspace(tab.key, nextCwd);
  };

  // Plan/auto can be switched mid-conversation: the backend restarts the agent
  // against the same session file (plan mode = different system prompt + tool
  // allowlist, which only apply at spawn time), so the transcript is reloaded
  // from the persisted session afterwards.
  const switchAgentMode = async (nextMode: AgentMode, silent = false) => {
    if (nextMode === "routed") {
      if (agentMode === "plan") {
        if (hasItems) await switchAgentMode("standard", true);
        else await configureSession(accessMode, "standard");
      }
      setAgentMode("routed");
      persistRoute({ ...route, enabled: true });
      setRoutePicking(!route.template);
      return;
    }
    if (agentMode === "routed") {
      persistRoute({ ...route, enabled: false });
      setOpenRoleId(null);
      setRoutePicking(false);
    }
    if (configuring || nextMode === agentMode) return;
    if (!hasItems) {
      void configureSession(accessMode, nextMode);
      return;
    }
    if (streaming) {
      timeline.appendNotice(
        "Wait for the current response to finish before switching mode.",
        "warning",
      );
      return;
    }
    const sessionFile = state?.sessionFile;
    if (!sessionFile) {
      timeline.appendNotice(
        "Agent mode can only be changed before the first message.",
        "warning",
      );
      return;
    }
    setConfiguring(true);
    const result = await api.configure(
      tab.key,
      tab.cwd,
      accessMode,
      apiAgentMode(nextMode),
      state?.model,
      state?.thinkingLevel,
      sessionFile,
      tab.backend,
    );
    setConfiguring(false);
    if (!result.ok || !result.state) {
      timeline.appendNotice(
        result.error ?? "Could not switch agent mode",
        "error",
      );
      return;
    }
    if (Array.isArray(result.messages))
      timeline.hydrate(result.messages, result.state);
    else timeline.reset(result.state);
    setAgentMode(nextMode);
    setConversationSessionPath(tab.key, sessionFile);
    if (!silent) {
      timeline.appendNotice(
        nextMode === "plan"
          ? "Plan mode is on — read and plan, change nothing."
          : nextMode === "manual"
            ? "Ask mode is on — the agent asks before every edit and command."
            : nextMode === "auto-edit"
              ? "Auto-edit is on — edits apply, commands still ask."
              : "Full auto is on.",
        "info",
      );
    }
  };

  // Edit + resend: rewind the backend to just before the chosen message (the
  // server branches the session file there), record the edit as the newest
  // version of that message, then send the new prompt over the trimmed context.
  const resendEdited = async (itemId: string, text: string) => {
    const item = timeline.items.find((candidate) => candidate.id === itemId);
    if (!item || item.kind !== "user" || streaming) return;
    const versions = item.versions;
    const currentVersion = versions?.[item.versionIndex ?? 0];
    const fromSessionFile =
      currentVersion?.sessionFile ?? state?.sessionFile ?? "";
    const result = await api.truncate(
      tab.key,
      currentVersion?.timestamp ?? item.timestamp,
      fromSessionFile || undefined,
    );
    if (!result.ok || !result.state) {
      timeline.appendNotice(
        result.error ?? "Could not rewind the conversation for editing",
        "error",
      );
      return;
    }
    timeline.editUserMessage(
      itemId,
      text,
      fromSessionFile,
      result.state.sessionFile ?? fromSessionFile,
    );
    setConversationSessionPath(tab.key, result.state.sessionFile);
    stickToBottom.current = true;
    const sent = await api.prompt(tab.key, text, { images: [] });
    if (!sent.ok) {
      timeline.appendNotice(sent.error ?? "prompt failed", "error");
    }
  };

  // Claude-Code-style ‹ › navigation: rebind the backend to the session file
  // that contains the chosen version, rewound to just before its prompt.
  const selectUserVersion = async (
    item: Extract<TimelineItem, { kind: "user" }>,
    targetIndex: number,
  ) => {
    if (streaming || editingMessageId !== null) return;
    const target = item.versions?.[targetIndex];
    if (!target || targetIndex === (item.versionIndex ?? 0)) return;
    const result = await api.truncate(
      tab.key,
      target.timestamp,
      target.sessionFile || undefined,
    );
    if (!result.ok || !result.state) {
      timeline.appendNotice(
        result.error ?? "Could not switch to that version",
        "error",
      );
      return;
    }
    timeline.setUserVersion(
      item.id,
      targetIndex,
      result.state.sessionFile ?? target.sessionFile,
    );
    setConversationSessionPath(tab.key, result.state.sessionFile);
  };

  // A tab opened from a board card carries its first message with it. Fire it
  // once, after the tab is mounted -- send() configures and starts the agent
  // on its own, so there is nothing to wait for.
  const seedFired = useRef(false);
  useEffect(() => {
    const seed: TaskSeed | undefined = taskSeeds[tab.key];
    if (seedFired.current || seed === undefined) return;
    seedFired.current = true;
    clearTaskSeed(tab.key);
    void send(seed.prompt, seed.attachments);
  }, [taskSeeds, tab.key, clearTaskSeed]);

  const send = async (
    raw: string,
    seedAttachments?: Attachment[],
    opts?: { answersAsk?: boolean },
  ) => {
    if (awaitingRoute) return;
    const message = raw.trim();
    if (!message && attachments.length === 0 && !seedAttachments?.length)
      return;
    // Enter in the textarea and the form submit can fire in the same tick,
    // and a key-repeat Enter re-sends the same draft. Either path used to
    // POST /prompt then immediately /queue the same text, so the first
    // prompt appeared queued with no second message from the user.
    const now = Date.now();
    if (
      sendLockRef.current ||
      (message &&
        message === lastSendRef.current.text &&
        now - lastSendRef.current.at < 400)
    )
      return;
    sendLockRef.current = true;
    if (message) lastSendRef.current = { text: message, at: now };
    try {
      // Edited-message resend: the composer is attached to an existing user
      // message; resend it over the rewound context instead of appending a turn.
      if (editingMessageId !== null) {
        if (attachments.length > 0) {
          timeline.appendNotice(
            "Remove attachments to resend an edited message.",
            "warning",
          );
          return;
        }
        const itemId = editingMessageId;
        setDraft("");
        setEditingMessageId(null);
        if (!message) return;
        await resendEdited(itemId, message);
        return;
      }
      if (
        attachments.length === 0 &&
        (message === "/new" || message === "/clear")
      ) {
        const result = await api.newSession(tab.key);
        if (result.ok && result.state && Array.isArray(result.messages)) {
          timeline.hydrate(result.messages, result.state);
          setConversationSessionPath(tab.key, undefined);
        } else if (!result.ok) {
          timeline.appendNotice(
            result.error ??
              `Could not create a new ${backendLabel(tab.backend)} session`,
            "error",
          );
        }
        refreshSessions();
        setDraft("");
        return;
      }
      if (attachments.length === 0 && message === "/compact") {
        setDraft("");
        if (!caps.compact) {
          timeline.appendNotice(
            "This agent cannot compact a conversation.",
            "info",
          );
          return;
        }
        if (compacting) return;
        setCompacting(true);
        // No transcript notice here: the compacting strip above the composer is
        // the single live status, and a second message in the transcript read
        // as a duplicate with the Changes panel sandwiched between them.
        const result = await api.compact(tab.key, undefined, {
          cwd: tab.cwd,
          sessionPath: tab.sessionPath ?? state?.sessionFile ?? undefined,
          model: state?.model ?? undefined,
          thinkingLevel: state?.thinkingLevel ?? undefined,
        });
        setCompacting(false);
        if (result.ok) {
          // Compact rewrites the backend log the model will see. Hydrating
          // with that rewritten history is what made the original turns
          // disappear from the transcript.
          if (result.state) timeline.setState(result.state);
          // The backend's compaction event appends the single transcript
          // notice (with counts + an expandable summary) — adding one here
          // read as a duplicate pill.
        } else
          timeline.appendNotice(
            result.error ?? "Could not compact the conversation",
            "unsupported" in result && result.unsupported ? "info" : "error",
          );
        return;
      }
      if (attachments.length === 0 && isUsageShortcut(message)) {
        setDraft("");
        if (!(await refreshUsage(true)))
          timeline.appendNotice("Could not retrieve usage", "error");
        return;
      }
      if (
        attachments.length === 0 &&
        (message === "/usage" || message === "/cost")
      ) {
        setDraft("");
        const retrieved = await refreshUsage(true);
        timeline.appendNotice(
          retrieved
            ? "Usage refreshed — current windows are shown in the composer status bar."
            : "Could not retrieve usage",
          retrieved ? "info" : "error",
        );
        return;
      }
      if (message === "/export") {
        setDraft("");
        const markdown = timelineToMarkdown(timeline.items, {
          title: displayTitle,
          backend: backendLabel(tab.backend),
          model: state?.model?.name ?? state?.model?.id,
          cwd: tab.cwd,
        });
        const name = exportFilename(displayTitle);
        const url = URL.createObjectURL(
          new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Revoked on the next tick so the download has taken the handle.
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
        timeline.appendNotice(`Exported this conversation to ${name}.`, "info");
        return;
      }
      if (message === "/context") {
        setDraft("");
        const userTurns = timeline.items.filter(
          (item) => item.kind === "user",
        ).length;
        const toolCalls = timeline.items.filter(
          (item) => item.kind === "tool",
        ).length;
        // Prefer the backend's own accounting. A capable backend that has
        // not answered yet has no honest number to print.
        if (caps.contextUsage && !context.exact) {
          timeline.appendNotice(
            "Context usage isn't in yet. It shows up once the model reports the window.",
            "info",
          );
          return;
        }
        const usage = context;
        const qualifier = usage.exact ? "" : "~";
        const breakdown = (usage.categories ?? [])
          .slice(0, 5)
          .map((entry) => `${entry.name} ${compactTokens(entry.tokens)}`)
          .join(", ");
        timeline.appendNotice(
          `Context use: ${qualifier}${compactTokens(usage.estimatedTokens)} of ${compactTokens(usage.contextWindow)} tokens (${usage.percent}%) — ${userTurns} user turns, ${toolCalls} tool calls${breakdown ? `. Largest: ${breakdown}` : ", plus the system prompt and tool definitions"}.${usage.autoCompactAt ? ` Auto-compacts at ${compactTokens(usage.autoCompactAt)}.` : ""} /compact summarizes older history for the model without clearing this transcript; /clear starts fresh.`,
          "info",
        );
        return;
      }
      if (message === "/diff") {
        setDraft("");
        const changes = timeline.items.filter(
          (item): item is Extract<TimelineItem, { kind: "tool" }> =>
            item.kind === "tool" &&
            ["edit", "write"].includes(item.name.toLowerCase()),
        );
        const lines: DiffLine[] = [];
        const files = new Set<string>();
        for (const item of changes) {
          const diff = getToolDiff(item);
          if (!diff) continue;
          const path = String(
            item.args.path ?? item.args.file_path ?? "(unknown)",
          );
          if (!files.has(path)) {
            files.add(path);
            lines.push({
              kind: "meta",
              text: `── ${path}${item.name.toLowerCase() === "write" ? "  (new file)" : ""}`,
            });
          }
          lines.push(...diff.lines);
        }
        if (lines.length === 0) {
          timeline.appendNotice("No file changes in this session yet.", "info");
          return;
        }
        setViewer({
          title: `Session diff · ${files.size} file${files.size === 1 ? "" : "s"} · ${changes.length} change${changes.length === 1 ? "" : "s"}`,
          diff: {
            added: lines.filter((line) => line.kind === "add").length,
            removed: lines.filter((line) => line.kind === "remove").length,
            lines,
          },
        });
        return;
      }
      if (message === "/fork" || /^\/fork\s+\d+$/.test(message)) {
        if (!caps.fork) {
          timeline.appendNotice(
            "This agent cannot fork a conversation.",
            "info",
          );
          return;
        }
        setDraft("");
        const arg = Number(message.slice(5).trim() || "1");
        const position = Number.isFinite(arg) && arg >= 1 ? Math.floor(arg) : 1;
        const assistants = timeline.items.filter(
          (item): item is Extract<TimelineItem, { kind: "assistant" }> =>
            item.kind === "assistant" && !item.live,
        );
        if (assistants.length === 0) {
          timeline.appendNotice(
            "Nothing to fork yet — send a message first.",
            "warning",
          );
          return;
        }
        if (position > assistants.length) {
          timeline.appendNotice(
            `There are only ${assistants.length} ${assistants.length === 1 ? "reply" : "replies"} to fork.`,
            "warning",
          );
          return;
        }
        const target = assistants.at(-position);
        if (!target) return;
        await forkOutput(target);
        return;
      }
      if (message.startsWith("/goal")) {
        const arg = message.slice(5).trim();
        setDraft("");
        if (!arg) {
          timeline.appendNotice(
            "Usage: /goal <one concrete outcome> — the agent checks in automatically (after 30m, then 1h → 2h). /goal off clears it.",
            "info",
          );
          return;
        }
        const result = await api.goal(tab.key, arg);
        if (!result.ok) {
          timeline.appendNotice(
            result.error ?? "Could not set the goal",
            "error",
          );
          return;
        }
        timeline.appendNotice(
          result.cleared
            ? "Standing goal cleared."
            : `Goal parked — the agent checks in on its own (after 30m, then every 1h → 2h): ${arg}`,
          "info",
        );
        return;
      }
      if (message === "/remote" || message.startsWith("/remote ")) {
        const arg = message.slice("/remote".length).trim();
        setDraft("");
        if (arg === "off") {
          const result = await api.remoteStop();
          timeline.appendNotice(
            result.ok
              ? "Remote tunnel closed."
              : "No remote tunnel was running.",
            "info",
          );
          return;
        }
        timeline.appendNotice(
          "Opening a secure tunnel — first run downloads cloudflared (~35 MB); later runs take a few seconds…",
          "info",
        );
        const result = await api.remoteStart();
        if (!result.ok || !result.connectUrl || !result.qrDataUrl) {
          timeline.appendNotice(
            result.error ?? "Could not start the remote tunnel.",
            "error",
          );
          return;
        }
        setRemoteQr({
          qrDataUrl: result.qrDataUrl,
          connectUrl: result.connectUrl,
        });
        return;
      }
      if (message === "/push" || message === "/pull") {
        const op = message.slice(1) as "push" | "pull";
        setDraft("");
        timeline.appendNotice(`Running git ${op} in ${tab.cwd}…`, "info");
        const result = await api.gitRun(tab.key, tab.cwd, op);
        if (result.ok) {
          const output = (result.output ?? "").trim();
          timeline.appendNotice(
            output ? `git ${op}:\n${output}` : `git ${op} finished.`,
            "info",
          );
        } else {
          timeline.appendNotice(result.error ?? `git ${op} failed`, "error");
        }
        return;
      }
      const pickedAttachments = seedAttachments ?? attachments;
      // An image attachment is already inline in the `images` payload below.
      // Listing its path under "inspect the attached file(s)" made agents Read
      // it a second time, so the same picture entered context twice and was
      // re-billed as fresh input on every later turn. The path stays -- it is the only
      // way to act on the file itself -- but it says it has already been seen.
      const attachmentLines = pickedAttachments.map((attachment) =>
        attachment.imageData
          ? `- ${attachment.name} (already attached inline — open this path only to edit the file, never to view it): ${attachment.path}`
          : `- ${attachment.name}: ${attachment.path}`,
      );
      // /skill sends the distill prompt to the agent itself — its own
      // history is the input, nothing to attach or re-read. The transcript
      // keeps the short "/skill" bubble instead of the canned prompt.
      let outboundMessage = [
        (message === "/skill" ? DISTILL_SKILL_PROMPT : message) ||
          "Please inspect the attached file(s).",
        attachmentLines.length
          ? `Attached files:\n${attachmentLines.join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      // Pictures show as thumbnails in the bubble; only other files are named.
      const namedFiles = pickedAttachments.filter((a) => !a.imageData);
      const displayMessage = [
        message || (namedFiles.length ? "Attached file(s)" : ""),
        namedFiles.length
          ? `Attachments: ${namedFiles.map((attachment) => attachment.name).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const images = pickedAttachments
        .filter((attachment) => attachment.imageData)
        .map((attachment) => ({
          type: "image" as const,
          data: attachment.imageData!,
          mimeType: attachment.mimeType,
        }));
      setDraft("");
      setAttachments([]);
      stickToBottom.current = true;
      // Mid-turn, Enter always queues. Cmd/Ctrl+Enter (and Steer now on the
      // queue chip) splice into the running turn on agents that support it.
      // An unsettled ask (the newest settled reply is an unanswered ask card)
      // holds the floor the same way: a prompt typed before the answer must
      // queue behind it, not replace the pending question. The ask card's
      // own submit (answersAsk) is the answer and goes straight through.
      const willSteer = Boolean(streaming) && canSteer && steerOnceRef.current;
      steerOnceRef.current = false;
      const lastReply = lastAssistantId
        ? visibleItems.find(
            (item): item is Extract<TimelineItem, { kind: "assistant" }> =>
              item.id === lastAssistantId && item.kind === "assistant",
          )
        : undefined;
      const askPending = !streaming && isAskMessage(lastReply?.text);
      const willQueue =
        !opts?.answersAsk && (Boolean(streaming) || askPending) && !willSteer;
      // A queued follow-up must not land in the transcript yet: it used to
      // sit in the middle of the still-printing turn, then its reply arrived
      // after the handover. The queue chip is the affordance until the
      // previous turn settles; message_start then appends the bubble.
      if (!willQueue)
        timeline.appendUser(
          displayMessage,
          images.map((image) => `data:${image.mimeType};base64,${image.data}`),
        );
      // Optimistic pending-run state: the RPC prompt response only arrives when
      // the whole turn completes, and agent_start can lag (a stalled model call
      // once left the UI silent for 225s). Show "working" immediately so the
      // user always knows the request was sent — and has a stop affordance.
      // A queued follow-up is not a run yet, so it must not flip the composer.
      if (!willQueue) timeline.markPendingRun();

      // A model's natural-language self-identification is not authoritative:
      // aliases and provider prompts can make Luna claim to be Kimi. For this
      // narrow question, answer from the session state that Pi reports instead.
      if (
        pickedAttachments.length === 0 &&
        state?.model &&
        isModelIdentityQuestion(message)
      ) {
        timeline.clearPendingRun();
        timeline.appendAssistant(runtimeModelAnswer(state.model));
        return;
      }

      const promptBackend = pendingBackendRef.current ?? tab.backend;
      const promptModel = pendingModelRef.current ?? state?.model ?? undefined;
      if (!willQueue) {
        pendingModelRef.current = null;
        pendingBackendRef.current = null;
      }
      const pendingHandoff = willQueue ? null : pendingHandoffRef.current;
      // A handoff belongs on the message only when it actually lands on a
      // backend other than the one that produced the transcript. Switching
      // away and back (e.g. pi→claude→pi) must not hand the transcript off.
      const handoff =
        pendingHandoff && pendingHandoff.from !== promptBackend
          ? handoffPrompt(
              pendingHandoff.path,
              backendLabel(pendingHandoff.from),
            )
          : null;
      if (!willQueue) pendingHandoffRef.current = null;
      if (handoff) {
        outboundMessage = `${handoff}\n\n---\n\n${outboundMessage}`;
      }
      const promptOptions = {
        images,
        cwd: tab.cwd,
        backend: promptBackend,
        accessMode,
        agentMode: apiAgentMode(agentMode),
        sessionPath: tab.sessionPath ?? state?.sessionFile ?? undefined,
        model: promptModel,
        thinkingLevel: state?.thinkingLevel ?? undefined,
      };
      // Drop the same-tick lock before awaiting the turn so a follow-up can
      // queue; the 400ms same-text debounce still rejects the duplicate Enter.
      sendLockRef.current = false;
      // prompt() is the only one of the three that can hand back a session path.
      let result: {
        ok: boolean;
        error?: string;
        sessionPath?: string;
        data?: { queued?: boolean };
      } = streaming
        ? willSteer
          ? await api.steer(tab.key, outboundMessage, images)
          : await api.enqueue(tab.key, outboundMessage, images)
        : await api.prompt(tab.key, outboundMessage, {
            ...promptOptions,
            answersAsk: opts?.answersAsk,
          });
      // Laptop sleep / lease sweep can kill grok stdio while the tab still
      // thinks a turn is in flight and therefore enqueues. Restart on the
      // prompt path with the session file instead of failing closed.
      if (
        !result.ok &&
        /session is not running/i.test(String(result.error ?? ""))
      ) {
        result = await api.prompt(tab.key, outboundMessage, promptOptions);
      }
      if (result.ok) {
        // The transcript's producing backend is now whichever agent took this
        // message, so a later switch-away-and-back compares against the real
        // source rather than the picker's intermediate selections.
        transcriptBackendRef.current = promptBackend;
        if (willQueue && !result.data?.queued) {
          // enqueue sends immediately when the agent went idle between click
          // and the POST; show the bubble the queue path skipped.
          timeline.appendUser(displayMessage);
          timeline.markPendingRun();
        } else if (!willQueue && result.data?.queued) {
          // The tab thought the agent was idle and the server disagreed (a
          // desynced `streaming` flag), so /prompt queued instead of starting.
          // Drop the optimistic run or the composer spins on a turn that is
          // still sitting in the queue — the exact "it queued my first message
          // by itself" shape, seen from the other side.
          timeline.clearPendingRun();
        }
        if (result.sessionPath && !(tab.sessionPath ?? state?.sessionFile)) {
          // A lazily-started session (pi and grok both start on the first message)
          // only reveals its file through the agent's own state, and no event
          // carries it -- so this reply is where the tab finally learns it. Until
          // it does, the sidebar cannot match this session's saved row to the tab
          // and shows no open marker against it.
          setConversationSessionPath(tab.key, result.sessionPath);
        }
        if (agentMode === "routed") {
          void api.putRoute(
            tab.key,
            route,
            result.sessionPath ?? tab.sessionPath ?? state?.sessionFile,
          );
        }
      } else {
        setAttachments(pickedAttachments);
        if (pendingHandoff) pendingHandoffRef.current = pendingHandoff;
        if (!willQueue) timeline.clearPendingRun();
        timeline.appendNotice(result.error ?? "prompt failed", "error");
      }
    } finally {
      sendLockRef.current = false;
    }
  };

  useEffect(() => {
    if (state?.sessionFile)
      setConversationSessionPath(tab.key, state.sessionFile);
  }, [setConversationSessionPath, state?.sessionFile, tab.key]);

  useEffect(() => {
    if (state?.model) setPreferredModel(tab.backend, tab.cwd, state.model);
  }, [setPreferredModel, state?.model, tab.backend, tab.cwd]);

  useEffect(() => {
    const closeFloatingMenus = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (commandMenuOpen && !target.closest(".composer"))
        setCommandMenuOpen(false);
      if (
        modeMenuOpen &&
        modeMenuRef.current &&
        !modeMenuRef.current.contains(target)
      )
        setModeMenuOpen(false);
      if (modelMenuOpen && !modelMenuRef.current?.contains(target))
        setModelMenuOpen(false);
      if (
        usageOpen &&
        usagePopRef.current &&
        !usagePopRef.current.contains(target)
      )
        setUsageOpen(false);
    };
    document.addEventListener("pointerdown", closeFloatingMenus);
    return () =>
      document.removeEventListener("pointerdown", closeFloatingMenus);
  }, [commandMenuOpen, modeMenuOpen, modelMenuOpen, usageOpen]);

  // slash filtering for the command menu opened by typing "/"
  const localCommands = LOCAL_COMMANDS.filter((command) => {
    if (command.name === "fork") return caps.fork;
    if (command.name === "compact") return caps.compact;
    return true;
  });
  const localByName = new Map(
    localCommands.map((command) => [command.name, command]),
  );
  const mergedCommands = [
    ...localCommands,
    ...commands.filter((command) => !localByName.has(command.name)),
  ];
  // The "@" token under the caret, if any: an @ that starts a word, followed
  // by anything but whitespace.
  const mentionQuery = (() => {
    const before = draft.slice(0, caret);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
    return match ? match[1] : null;
  })();
  const mentionOpen = mentionQuery !== null && mentionMatches.length > 0;

  // Debounced so a fast typist does not walk the tree on every keystroke.
  // Declared here rather than with the other effects because the dependency
  // array is evaluated during render and mentionQuery is derived just above.
  useEffect(() => {
    if (mentionQuery === null) {
      setMentionMatches([]);
      return;
    }
    const root = tab.cwd;
    if (!root) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .workspaceSearch(root, mentionQuery)
        .then((result) => {
          if (cancelled) return;
          setMentionMatches(result.ok ? (result.matches ?? []) : []);
          setMentionIndex(0);
        })
        .catch(() => {
          if (!cancelled) setMentionMatches([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mentionQuery, tab.cwd]);

  const bareSlashCommand = /^\/([\w:-]*)$/.exec(draft);
  const slashFilter = bareSlashCommand
    ? bareSlashCommand[1].toLowerCase()
    : null;
  const slashMatches =
    slashFilter !== null && slashFilter.length >= 0
      ? mergedCommands
          .filter((c) => c.name.toLowerCase().startsWith(slashFilter))
          .slice(0, 8)
      : mergedCommands.slice(0, 8);
  const slashOpen =
    commandMenuOpen || (slashFilter !== null && slashMatches.length > 0);

  /** Swap the "@token" under the caret for the picked path. */
  const applyMention = (match: WorkspaceMatch) => {
    const before = draft.slice(0, caret);
    const start = before.search(/(?:^|\s)@[^\s@]*$/);
    const at = before.indexOf("@", start === -1 ? 0 : start);
    if (at === -1) return;
    const next = `${draft.slice(0, at)}@${match.relativePath} ${draft.slice(caret)}`;
    setDraft(next);
    setMentionMatches([]);
    const caretAfter = at + match.relativePath.length + 2;
    window.setTimeout(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(caretAfter, caretAfter);
      setCaret(caretAfter);
      autoGrow();
    }, 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Tab" && event.shiftKey && !mentionOpen && !slashOpen) {
      event.preventDefault();
      const index = DESIGN_MODES.indexOf(agentMode);
      const next = DESIGN_MODES[(index + 1) % DESIGN_MODES.length] ?? "manual";
      void switchAgentMode(next);
      return;
    }
    // Steer the running turn, whatever the mid-turn default is.
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      streaming &&
      draft.trim()
    ) {
      event.preventDefault();
      steerOnceRef.current = canSteer;
      void send(draft);
      return;
    }
    if (mentionOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex(
          (i) => (i - 1 + mentionMatches.length) % mentionMatches.length,
        );
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        applyMention(
          mentionMatches[Math.min(mentionIndex, mentionMatches.length - 1)],
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionMatches([]);
        return;
      }
    }
    if (slashOpen && slashMatches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex(
          (i) => (i - 1 + slashMatches.length) % slashMatches.length,
        );
        return;
      }
      if (
        event.key === "Tab" ||
        (event.key === "Enter" && slashFilter !== null && draft.length > 1)
      ) {
        event.preventDefault();
        const picked =
          slashMatches[Math.min(slashIndex, slashMatches.length - 1)];
        setCommandMenuOpen(false);
        if (!picked) return;
        // Enter and Tab both insert the command into the draft, same as
        // clicking it: the trailing space closes the menu and keeps the
        // composer open so arguments can follow. The next Enter sends.
        setDraft(`/${picked.name} `);
        return;
      }
      if (event.key === "Escape") {
        setCommandMenuOpen(false);
        return;
      }
    }
    if (event.key === "Escape" && editingMessageId !== null) {
      event.preventDefault();
      setEditingMessageId(null);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send(draft);
    }
  };

  // The inline height overrides any CSS, so the thin cap has to live here —
  // a stylesheet rule alone can never shrink the textarea below 48px.
  const textareaMinHeight = 26;
  const textareaMaxHeight = thin ? 26 : 196;
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, textareaMinHeight), textareaMaxHeight)}px`;
  }, [textareaMinHeight, textareaMaxHeight]);
  useLayoutEffect(() => {
    autoGrow();
    // deps: [draft] only — this used to run on every render (no deps array),
    // so any unrelated re-render (a selection change from onSelect, an idle
    // polling tick) re-zeroed the textarea's height and reset its internal
    // scroll to the top, which looked like the caret jumping or the box
    // scrolling up while typing. Content changes always go through setDraft.
  }, [draft, autoGrow]);

  const modelOptions: ModelOption[] = models.map((m) => ({
    provider: m.provider,
    id: m.id,
    label:
      tab.backend === "claude" || m.provider === "anthropic"
        ? formatClaudeModelName(m.name ?? m.id)
        : (m.name ?? m.id),
  }));
  const activeModel =
    state?.model ??
    (tab.backend === "claude" && tab.isFresh ? CLAUDE_DEFAULT_MODEL : null);
  const currentModel = activeModel
    ? `${activeModel.provider}/${activeModel.id}`
    : "";
  const currentModelLabel =
    modelOptions.find(
      (option) => `${option.provider}/${option.id}` === currentModel,
    )?.label ??
    (tab.backend === "claude" && activeModel
      ? formatClaudeModelName(activeModel.name ?? activeModel.id)
      : activeModel?.name) ??
    activeModel?.id ??
    "model…";
  const effort =
    state?.thinkingLevel ??
    (tab.isFresh ? BACKEND_DEFAULT_EFFORT[tab.backend] : "off");

  const setModel = (value: string) => {
    const option = modelOptions.find(
      (candidate) => `${candidate.provider}/${candidate.id}` === value,
    );
    if (!option) return;
    void api.setModel(tab.key, option.provider, option.id).then((result) => {
      if (!result.ok) {
        timeline.appendNotice(result.error ?? "Could not set model", "error");
        return;
      }
      // Adopt the new model's catalog levels immediately so the effort
      // slider matches the selected model before the (slower) live
      // thinking-levels refresh below answers.
      const catalog = models.find(
        (candidate) =>
          candidate.provider === option.provider && candidate.id === option.id,
      );
      if (Array.isArray(catalog?.levels) && catalog.levels.length > 0)
        setLevels(catalog.levels);
      if (result.state) {
        timeline.setState(result.state);
        setPreferredModel(tab.backend, tab.cwd, result.state.model);
      } else {
        const model =
          result.data ??
          models.find(
            (candidate) =>
              candidate.provider === option.provider &&
              candidate.id === option.id,
          ) ??
          option;
        if (timeline.state) {
          timeline.setState({ ...timeline.state, model });
          setPreferredModel(tab.backend, tab.cwd, model);
        }
      }
      void api.thinkingLevels(tab.key, tab.backend).then((levelResult) => {
        if (levelResult.ok && Array.isArray(levelResult.levels))
          setLevels(levelResult.levels);
      });
      void refreshUsage(true);
    });
  };

  const browseBackend = pickerBackend ?? tab.backend;
  const visibleOptions = useMemo(() => {
    const source =
      browseBackend === tab.backend
        ? models
        : (pickerModels[browseBackend] ?? []);
    const options: ModelOption[] = source.map((model) => ({
      provider: model.provider,
      id: model.id,
      label:
        browseBackend === "claude" || model.provider === "anthropic"
          ? formatClaudeModelName(model.name ?? model.id)
          : (model.name ?? model.id),
      context: model.contextWindow,
      levels: model.levels,
    }));
    const query = modelQuery.trim().toLowerCase();
    if (!query) return options;
    return options.filter((option) =>
      `${option.label} ${option.provider}/${option.id}`
        .toLowerCase()
        .includes(query),
    );
  }, [browseBackend, modelQuery, models, pickerModels, tab.backend]);

  // The effort track follows what the picker browses: the highlighted model's
  // own ladder when the catalog knows it, else the browsed backend's (fetched
  // cold) — so clicking backends/models no longer shows the session's ladder
  // everywhere. effortStops keeps the session's current level visible in it.
  const backendLevels =
    browseBackend === tab.backend
      ? levels
      : (pickerLevels[browseBackend] ?? []);
  const hoveredLevels = visibleOptions[modelIndex]?.levels;
  const trackLevels = effortStops(
    hoveredLevels?.length ? hoveredLevels : backendLevels,
    effort,
  );

  const pickListedModel = (option: ModelOption) => {
    setModelMenuOpen(false);
    const model: ModelInfo = {
      provider: option.provider,
      id: option.id,
      name: option.label,
    };
    if (browseBackend === tab.backend) {
      pendingModelRef.current = null;
      pendingBackendRef.current = null;
      setModel(`${option.provider}/${option.id}`);
      return;
    }
    pendingModelRef.current = model;
    pendingBackendRef.current = browseBackend;
    setPreferredModel(browseBackend, tab.cwd, model);
    void switchBackend(browseBackend);
  };

  useEffect(() => {
    if (!modelMenuOpen || !pickerBackend || pickerBackend === tab.backend)
      return;
    let cancelled = false;
    // Already warmed (or fetched on an earlier browse): read from cache.
    if (!pickerModels[pickerBackend]?.length)
      void api.models(tab.key, pickerBackend).then((result) => {
        if (cancelled || !result.ok || !Array.isArray(result.models)) return;
        setPickerModels((prev) => ({
          ...prev,
          [pickerBackend]: result.models,
        }));
      });
    if (!pickerLevels[pickerBackend]?.length)
      void api.thinkingLevels(tab.key, pickerBackend).then((result) => {
        if (
          cancelled ||
          !result.ok ||
          !Array.isArray(result.levels) ||
          result.levels.length === 0
        )
          return;
        setPickerLevels((prev) => ({
          ...prev,
          [pickerBackend]: result.levels,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [
    modelMenuOpen,
    pickerBackend,
    tab.backend,
    tab.key,
    pickerLevels,
    pickerModels,
  ]);

  // Fresh menu state on every open; keyboard focus lands in the search box.
  useEffect(() => {
    if (!modelMenuOpen) return;
    setModelQuery("");
    // Start the keyboard highlight on the session's model (mock parity), so
    // the effort track opens on its ladder and arrows walk from it.
    const start = modelOptions.findIndex(
      (option) => `${option.provider}/${option.id}` === currentModel,
    );
    setModelIndex(start >= 0 ? start : 0);
    setAgentNote(null);
    const input = modelSearchRef.current;
    if (input) input.focus();
    // deps: [modelMenuOpen, tab.backend] only — re-running on catalog
    // arrivals would reset a query the user is typing mid-menu.
  }, [modelMenuOpen, tab.backend]);

  const onModelMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.altKey &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      if (browseBackend !== tab.backend) return;
      const track = effortStops(levels, effort);
      const index = Math.max(0, track.indexOf(effort));
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next =
        track[Math.max(0, Math.min(track.length - 1, index + delta))];
      if (next && next !== effort) setEffort(next);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const count = visibleOptions.length;
      if (count === 0) return;
      setModelIndex((index) =>
        event.key === "ArrowDown"
          ? (index + 1) % count
          : (index - 1 + count) % count,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = visibleOptions[modelIndex];
      if (option) pickListedModel(option);
    } else if (event.key === "Escape") {
      setModelMenuOpen(false);
    } else if (event.key === "Tab") {
      event.preventDefault();
      const index = backendIds.indexOf(browseBackend);
      const next =
        backendIds[
          (index + (event.shiftKey ? -1 : 1) + backendIds.length) %
            backendIds.length
        ];
      if (next) {
        setPickerBackend(next);
        setModelQuery("");
        setModelIndex(0);
      }
    }
  };

  const setEffort = (level: string) => {
    void api.setThinking(tab.key, level).then((result) => {
      if (!result.ok) {
        timeline.appendNotice(
          result.error ?? "Could not set thinking level",
          "error",
        );
        return;
      }
      if (timeline.state)
        timeline.setState({ ...timeline.state, thinkingLevel: level });
    });
  };

  const interrupt = useCallback(() => {
    void api.abort(tab.key);
  }, [tab.key]);

  /**
   * Move this session into its own checkout. Snapshots, the Changes panel and
   * every git op already key off the tab's cwd, so repointing it is the whole
   * of the isolation -- no backend knows or needs to know.
   */
  const isolateSession = async () => {
    const made = await api.createWorktree(tab.key, tab.cwd, tab.label);
    if (!made.ok || !made.data) {
      timeline.appendNotice(
        made.error ?? "Could not create a worktree here.",
        "error",
      );
      return;
    }
    setConversationWorkspace(tab.key, made.data.path);
    timeline.appendNotice(
      `Now working in an isolated checkout on ${made.data.branch}.${
        made.data.seeded.length
          ? ` Carried over: ${made.data.seeded.join(", ")}.`
          : ""
      }`,
      "info",
    );
  };

  const forkOutput = async (
    item: Extract<TimelineItem, { kind: "assistant" }>,
  ) => {
    if (forkingId) return;
    if (item.live || timeline.state?.isStreaming) {
      timeline.appendNotice(
        "Wait for this reply to finish before forking.",
        "info",
      );
      return;
    }
    setForkingId(item.id);
    try {
      const result = await api.fork(tab.key, item.timestamp, {
        cwd: tab.cwd,
        sessionPath: state?.sessionFile ?? tab.sessionPath,
        backend: tab.backend,
        promptIndex: promptIndexAtAssistant(timeline.items, item.id),
        userText: userTextBeforeAssistant(timeline.items, item.id),
        name: `${tab.label}-fork`,
        model: state?.model,
        thinkingLevel: state?.thinkingLevel,
        accessMode,
        agentMode,
      });
      if (!result.ok || !result.state?.sessionFile) {
        timeline.appendNotice(
          result.error ?? "Could not fork this response",
          "unsupported" in result && result.unsupported ? "info" : "error",
        );
        return;
      }
      const messages = Array.isArray(result.messages) ? result.messages : [];
      // Every backend returns the branch as its own session file and leaves
      // this conversation where it was. Open that file as a side chat.
      const forkCwd = result.forkCwd ?? tab.cwd;
      const forkKey = openForkedConversation({
        cwd: forkCwd,
        sessionPath: result.state.sessionFile,
        messages,
        state: result.state,
        label: `${tab.label} · fork`,
        backend: tab.backend,
        accessMode,
        agentMode,
      });
      refreshSessions();
      onSessionSplit?.(forkKey);
      const branch = result.worktree?.branch;
      timeline.appendNotice(
        branch
          ? `Forked into a side conversation on ${branch}.`
          : "Forked into a side conversation.",
        "info",
      );
      return;
    } catch (error) {
      timeline.appendNotice(
        error instanceof Error ? error.message : "Could not fork this response",
        "error",
      );
    } finally {
      setForkingId(null);
    }
  };

  const tight = thin || narrow;

  const setupChips = (
    <div className="composer__setup">
      <div className="hero__chips">
        <WorkspacePicker
          ref={hasItems ? undefined : workspacePickerRef}
          cwd={tab.cwd}
          backend={tab.backend}
          disabled={configuring}
          onPick={(path) => configureSession(accessMode, agentMode, path)}
          onIsolate={isolateSession}
          onViewWorkspace={openWorkspace}
        />
        {!split && (
          <button
            type="button"
            className={`workspace-picker__trigger${workspaceShown ? " is-active" : ""}`}
            aria-pressed={workspaceShown}
            title={tab.cwd}
            onClick={workspaceButton}
          >
            <IconCode size={15} />
            <span>View workspace</span>
          </button>
        )}
      </div>
    </div>
  );

  const dropZoneProps = {
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  };
  const dropOverlay = dragActive ? (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-overlay__card">
        <IconUpload />
        <span>Drop to attach — 20 MB max</span>
      </div>
    </div>
  ) : null;

  const pickRoute = (template: RouteTemplate) => {
    if (template !== route.template)
      persistRoute(applyTemplate(template, tab.backend));
    setRoutePicking(false);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const routeOverlay = awaitingRoute ? (
    <div
      className="route-overlay"
      role="presentation"
      onClick={dismissRoutePick}
    />
  ) : null;

  const composer = (
    <ConversationComposer
      {...{
        tight, thin, awaitingRoute, tab, streaming, hasItems,
        workspacePickerRef, setDraft, setConversationWorkspace, timeline,
        openWorkspace, openFileView, sessionPaths, lastAssistantId,
        visibleItems, reviewStarting, startTurnReview, split, configuring,
        configureSession, accessMode, agentMode, isolateSession,
        setupChips, route, persistRoute, pickRoute, setRoutePicking,
        editingMessageId, setEditingMessageId, mentionOpen, mentionMatches,
        mentionIndex, applyMention, slashOpen, slashMatches, slashIndex,
        setCommandMenuOpen, textareaRef, todos, compacting, queued,
        limitVisible, canSteer, limitWindow, resumeFromLimit, send, draft,
        fileInputRef, uploadFiles, attachments, setAttachments, setViewer,
        setCaret, commandMenuOpen, autoGrow, onKeyDown, onPasteImage,
        modelMenuRef, modelSearchRef, modelMenuOpen, browseBackend,
        backendIds, currentModelLabel, effort, trackLevels, effortHover,
        visibleOptions, modelIndex, modelQuery, currentModel, setUsageOpen,
        setModeMenuOpen, setModelMenuOpen, setPickerBackend, setModelQuery,
        setModelIndex, pickListedModel, setEffort, setEffortHover,
        onModelMenuKey, loadModelMetadata, modeMenuRef, modeMenuOpen,
        switchAgentMode, dismissRoutePick, usagePopRef, usageOpen,
        providerUsage, backendUsage, currentReset, agentBusy,
      }}
    />
  );

  const addWorkspacePathToChat = useCallback(
    (path: string) => {
      chooseWorkspacePlacement("side");
      const insertion = path.startsWith(`${tab.cwd}/`)
        ? path.slice(tab.cwd.length + 1)
        : path;
      setDraft((current) => {
        if (!current.trim()) return insertion;
        return current.endsWith("\n")
          ? `${current}${insertion}`
          : `${current}\n${insertion}`;
      });
      const name = path.split("/").filter(Boolean).at(-1) ?? path;
      setAttachments((current) =>
        current.some((item) => item.path === path)
          ? current
          : [
              ...current,
              {
                id: crypto.randomUUID(),
                name,
                mimeType: "text/plain",
                size: 0,
                path,
              },
            ],
      );
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    },
    [tab.cwd],
  );

  const workspaceExplorer = workspaceMounted ? (
    <WorkspaceExplorer
      key={tab.cwd}
      sessionKey={tab.key}
      root={tab.cwd}
      visible={workspaceOpen}
      placement={workspacePlacement}
      tab={workspaceTab}
      onTabChange={setWorkspaceTab}
      onPlacementChange={chooseWorkspacePlacement}
      onClose={closeWorkspace}
      onAddToChat={addWorkspacePathToChat}
    />
  ) : null;

  // Remounts per workspace: the board seeds from localStorage on mount only.
  const boardPanel =
    boardOpen && tab.cwd ? (
      <BoardPanel
        key={tab.cwd}
        cwd={tab.cwd}
        sessionPath={tab.sessionPath}
        onClose={() => setBoardOpen(false)}
      />
    ) : null;

  const selectionTools = tab.cwd ? (
    <SelectionTools cwd={tab.cwd} sessionPath={tab.sessionPath} />
  ) : null;

  const awaiting = awaitingKeys.has(tab.key);
  const modeLabel =
    agentMode === "plan"
      ? "Plan"
      : agentMode === "routed"
        ? "Routed"
        : agentMode === "manual"
          ? "Manual"
          : agentMode === "auto-edit"
            ? "Auto-edit"
            : "";
  const phaseLabel =
    status === "error"
      ? "Error"
      : streaming || status === "starting"
        ? "Running"
        : awaiting
          ? "Needs input"
          : "Idle";
  const statusLabel = modeLabel ? `${modeLabel} · ${phaseLabel}` : phaseLabel;
  const statusTone: SessionTone =
    status === "error"
      ? "error"
      : streaming || status === "starting"
        ? "running"
        : awaiting
          ? "waiting"
          : "idle";
  // A run that finished while the user was looking elsewhere keeps a ✓ on
  // its pane until they focus it or start the next run.
  const running = streaming || status === "starting";
  const [finishedUnseen, setFinishedUnseen] = useState(false);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (running) setFinishedUnseen(false);
    else if (wasRunning.current && !focused) setFinishedUnseen(true);
    wasRunning.current = running;
  }, [running, focused]);
  useEffect(() => {
    if (focused) setFinishedUnseen(false);
  }, [focused]);
  const paneTone: PaneTone =
    statusTone === "idle" && finishedUnseen ? "done" : statusTone;
  const usageSince = usageCutoff(timeline.items, usageSinceRef.current);
  const billedItems =
    usageSince > 0
      ? timeline.items.filter((item) => usageStamp(item) >= usageSince)
      : timeline.items;
  const spend = billedItems.reduce((sum, item) => {
    if ("usage" in item && item.usage?.cost?.total)
      return sum + item.usage.cost.total;
    return sum;
  }, 0);
  // Session usage, the number Claude CLI's /usage prints: the cumulative
  // token total across the session's assistant turns. Backends that report
  // per-message usage (Claude, Codex, Grok, pi) are summed off the live
  // timeline; backends that don't fall back to the session-file summary
  // (the same sum read off disk by readResumeSession), fetched once when
  // the details popover opens.
  const liveTokens = billedItems.reduce((sum, item) => {
    if ("usage" in item && item.usage) return sum + item.usage.totalTokens;
    return sum;
  }, 0);
  const [sessionUsageTotal, setSessionUsageTotal] = useState<number | null>(
    null,
  );
  const [branchLabel, setBranchLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!sessionDetailsOpen) return;
    let cancelled = false;
    if (tab.cwd) {
      api
        .gitChanges(tab.key, tab.cwd)
        .then((result) => {
          if (!cancelled)
            setBranchLabel(
              result.ok && result.repo ? (result.branch ?? null) : null,
            );
        })
        .catch(() => {
          if (!cancelled) setBranchLabel(null);
        });
    } else {
      setBranchLabel(null);
    }
    if (liveTokens === 0) {
      api
        .usage(tab.key, tab.backend, true, tab.sessionPath)
        .then((result) => {
          if (!cancelled)
            setSessionUsageTotal(result.usage?.tokens?.total ?? null);
        })
        .catch(() => {
          if (!cancelled) setSessionUsageTotal(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [
    sessionDetailsOpen,
    tab.key,
    tab.cwd,
    tab.backend,
    tab.sessionPath,
    liveTokens,
  ]);
  // Context window, not the cumulative total: what the model carries right
  // now. Built-in backends report that count. The character estimate is only
  // for a backend that never reports one, and it stays labeled as a guess.
  const contextLabel = hasItems
    ? reported
      ? `${compactTokens(reported.estimatedTokens)} of ${compactTokens(reported.contextWindow)} tokens (${reported.percent ?? "?"}%)`
      : caps.contextUsage
        ? "—"
        : `${compactTokens(estimated.estimatedTokens)} of ${compactTokens(estimated.contextWindow)} tokens (${estimated.percent ?? "?"}%) · estimated`
    : "—";
  const usageTotal = liveTokens > 0 ? liveTokens : sessionUsageTotal;
  // Monocode's turn-metrics readout, aggregated over the session: fresh
  // input, output, cached, cache-hit percent and tok/s. Backends that report
  // no cache fields (or no per-message usage at all) fall back to the old
  // cumulative-total label.
  const spendLabel =
    spend > 0 ? (spend < 0.01 ? "<$0.01" : `$${spend.toFixed(2)}`) : "";
  // Grok's ledger is the session file, counted once. Summing timeline stamps
  // repeats a turn that was already a sum of its model calls.
  const usageSum =
    (exactContext?.session && usageSummaryFromCounts(exactContext.session)) ||
    usageSummaryOf(billedItems);
  const usageLabel =
    usageSum && (usageSum.input || usageSum.output || usageSum.cached)
      ? [
          usageSum.cacheHitPercent == null
            ? null
            : `${Math.round(usageSum.cacheHitPercent)}% cache hit`,
          usageSum.tokensPerSec == null
            ? null
            : `${Math.round(usageSum.tokensPerSec)} tok/s`,
          `${compactTokens(usageSum.input)} input`,
          `${compactTokens(usageSum.output)} output`,
          usageSum.cached ? `${compactTokens(usageSum.cached)} cached` : "",
          spendLabel,
        ]
          .filter(Boolean)
          .join(" · ")
      : usageTotal
        ? [`${compactTokens(usageTotal)} tokens`, spendLabel]
            .filter(Boolean)
            .join(" · ")
        : "—";
  const markInfo = backendMark(tab.backend);
  const startRename = () => {
    setSessionDetailsOpen(false);
    const fallback = firstUserItem?.kind === "user" ? firstUserItem.text : "";
    setRenameDraft(state?.sessionName?.trim() || fallback.slice(0, 200));
    setRenaming(true);
  };
  const finishRename = () => {
    setRenaming(false);
    const title = renameDraft.trim();
    if (!title || title === displayTitle) return;
    void api.rename(tab.key, title).then((result) => {
      if (!result.ok && result.error)
        window.alert(`Rename failed: ${result.error}`);
    });
  };
  const sessionHeader = (
    <SessionHeader
      multi={split && sessionCount > 1}
      onBack={onBack}
      title={displayTitle}
      renaming={renaming}
      renameDraft={renameDraft}
      onRenameDraft={setRenameDraft}
      onStartRename={startRename}
      onFinishRename={finishRename}
      onCancelRename={() => setRenaming(false)}
      // Split panes own the dropdown; the toolbar copy must not also listen
      // for outside clicks or it would shut the pane's popover.
      detailsOpen={!(split && sessionCount > 1) && sessionDetailsOpen}
      onDetailsOpen={setSessionDetailsOpen}
      statusLabel={statusLabel}
      statusTone={statusTone}
      pathLabel={displayPath(tab.cwd)}
      branchLabel={branchLabel}
      contextLabel={contextLabel}
      usageLabel={usageLabel}
      sessionId={state?.sessionId}
      onCopyId={() =>
        navigator.clipboard.writeText(state?.sessionId || tab.key)
      }
      logUrl={
        state?.sessionFile ? api.sessionLogUrl(state.sessionFile) : undefined
      }
      view={conversationView}
      onView={setConversationView}
      terminalOpen={terminalOpen}
      onTerminalToggle={onTerminalToggle}
      workspaceOpen={workspaceShown}
      onWorkspaceToggle={tab.cwd ? workspaceButton : undefined}
      boardOpen={boardOpen}
      onBoardToggle={tab.cwd ? () => setBoardOpen((open) => !open) : undefined}
      deployCwd={tab.cwd || undefined}
    />
  );
  const sessionChrome = (
    <>
      {split && focused && headerHost
        ? createPortal(sessionHeader, headerHost)
        : null}
      {split ? (
        <PaneChrome
          active={focused}
          title={displayTitle}
          markGlyph={markInfo.glyph}
          markColor={status === "error" ? "var(--pw-red)" : markInfo.color}
          tone={paneTone}
          live={running}
          details={{
            title: displayTitle,
            statusLabel,
            statusTone,
            pathLabel: displayPath(tab.cwd),
            branchLabel,
            contextLabel,
            usageLabel,
            sessionId: state?.sessionId,
            onCopyId: () =>
              navigator.clipboard.writeText(state?.sessionId || tab.key),
            logUrl: state?.sessionFile
              ? api.sessionLogUrl(state.sessionFile)
              : undefined,
          }}
          detailsOpen={sessionDetailsOpen}
          onDetailsOpen={setSessionDetailsOpen}
          onMaximize={onFocus}
          onClose={onClose}
        />
      ) : (
        sessionHeader
      )}
    </>
  );

  if (!hasItems) {
    return (
      <Activity mode={visible ? "visible" : "hidden"}>
        {sessionChrome}
        <div className="conversation-stage">
          <div
            className="conversation conversation--empty"
            ref={conversationRef}
            {...dropZoneProps}
          >
            {routeOverlay}
            {agentMode === "routed" && route.steps.length > 0 && (
              <RouteChainStrip
                steps={route.steps}
                activeId={openRoleId}
                onSelect={setOpenRoleId}
                onEdit={() => setRoutePicking(true)}
              />
            )}
            {/* Standalone hero with flex: 1 — it centers the headline in the
                free space and pushes the composer down, exactly like the
                pre-grok layout. Nesting it inside the (top-aligned, flex:
                none) composer killed the centering. */}
            <div className="hero">
              <div className="hero__glow" />
              <div className="hero__stack">
                <div className="hero__headline">
                  <span className="hero__fish">
                    <FishLogo size={34} />
                  </span>
                  <span className="hero__title">Onwards &amp; Upwards</span>
                  <span className="hero__badge">Preview</span>
                </div>
              </div>
            </div>
            {composer}
            {dropOverlay}
          </div>
          {agentMode === "routed" &&
            !tight &&
            openRoleId &&
            route.steps.some((step) => step.id === openRoleId) && (
              <RouteRolePane
                step={
                  route.steps.find((step) => step.id === openRoleId) ??
                  route.steps[0]!
                }
                onClose={() => setOpenRoleId(null)}
              />
            )}
          {workspaceExplorer}
          {boardPanel}
          {selectionTools}
        </div>
        {viewer && <FileViewer view={viewer} onClose={() => setViewer(null)} />}
      </Activity>
    );
  }

  return (
    <Activity mode={visible ? "visible" : "hidden"}>
      {sessionChrome}

      <div className="conversation-stage">
        <div className="conversation" ref={conversationRef} {...dropZoneProps}>
          {routeOverlay}
          {agentMode === "routed" && route.steps.length > 0 && (
            <RouteChainStrip
              steps={route.steps}
              activeId={openRoleId}
              onSelect={setOpenRoleId}
              onEdit={() => setRoutePicking(true)}
            />
          )}
          {conversationView === "chat" ? (
            <div
              className="conversation__scroll"
              ref={scrollRef}
              onScroll={onScroll}
              role="tabpanel"
              aria-label="Chat"
              tabIndex={0}
            >
              <div className="conversation__column">
                {chatTurns.map((turn, turnIndex) => {
                  const id = turnKey(turn);
                  const live = streaming && turnIndex === chatTurns.length - 1;
                  const complete = isTurnComplete(turn);
                  const logOpen = isTurnLogOpen({
                    live,
                    isLast: turnIndex === chatTurns.length - 1,
                    complete,
                    explicit: id in turnOpen ? turnOpen[id] : undefined,
                  });
                  const showFold = !live && complete;
                  const bodyItems = logOpen
                    ? turnBodyItems(turn)
                    : turnSummaryItems(turn);
                  const changedFiles = turnChangedFiles(turn);
                  const stats = showFold ? statsForTurn(turn) : null;
                  return (
                    <div className="chat-turn" key={id || turnIndex}>
                      {turnUserItems(turn).map((item) =>
                        renderTimelineItem(item),
                      )}
                      {showFold && stats && (
                        <TurnFoldBar
                          durationMs={stats.durationMs}
                          endedAt={turnEndedAt(turn)}
                          toolCount={stats.toolCount}
                          fileCount={changedFiles.length || stats.fileCount}
                          failedCount={
                            turn.filter(
                              (entry) =>
                                entry.kind === "tool" &&
                                entry.status === "error",
                            ).length
                          }
                          open={logOpen}
                          onToggle={() =>
                            setTurnOpen((current) => ({
                              ...current,
                              [id]: !logOpen,
                            }))
                          }
                        />
                      )}
                      {groupTranscriptRows(bodyItems).map((block) =>
                        block.type === "explored" ? (
                          <ExploredRows
                            key={block.id}
                            entries={block.entries}
                            calls={block.calls}
                            failed={block.failed}
                            durationMs={block.durationMs}
                            cwd={tab.cwd}
                            expandDiff={turnIndex === chatTurns.length - 1}
                            onOpenFile={openFileView}
                          />
                        ) : (
                          renderTimelineItem(block.item, {
                            repeat: block.repeat,
                            expandDiff: turnIndex === chatTurns.length - 1,
                          })
                        ),
                      )}
                      {!live && complete && (
                        <TurnFilesCard
                          files={changedFiles}
                          onOpenFile={openFileView}
                          latest={turnIndex === latestChangedTurn}
                        />
                      )}
                    </div>
                  );
                })}
                {agentMode === "routed" &&
                  hasItems &&
                  route.steps
                    .filter((step) => step.enabled)
                    .map((step) => (
                      <RouteHandoffCard
                        key={step.id}
                        step={step}
                        onOpen={() => setOpenRoleId(step.id)}
                      />
                    ))}
                {reviews.map((review) => (
                  <ReviewCard
                    key={review.id}
                    backend={review.backend}
                    integrityKey={review.integrityKey}
                    taskKey={review.taskKey}
                    onQueue={(text) => setDraft(text)}
                    onOpen={() => {
                      revealConversation(review.integrityKey);
                      onSessionSplit?.(review.integrityKey);
                    }}
                    onDismiss={() => {
                      closeConversation(review.integrityKey);
                      closeConversation(review.taskKey);
                      setReviews((current) =>
                        current.filter((item) => item.id !== review.id),
                      );
                    }}
                  />
                ))}
                {!streaming && <TodoTranscript tasks={todos} />}
                {subagentRuns.some(
                  (run) => run.status === "running" && run.attention,
                ) ? (
                  <SubagentWaitRow runs={subagentRuns} />
                ) : null}
                {streaming && runningShell ? (
                  <ActiveRunIndicator
                    item={runningShell}
                    onInterrupt={interrupt}
                  />
                ) : showThinkingIndicator ? (
                  <ThinkingRow
                    resume={visibleItems.some(
                      (item) =>
                        item.kind === "notice" &&
                        /picking this conversation back up/i.test(item.text),
                    )}
                    startedAt={turnStartedAt(chatTurns.at(-1))}
                    tools={
                      chatTurns.at(-1)?.filter((entry) => entry.kind === "tool")
                        .length ?? 0
                    }
                    parallel={
                      chatTurns
                        .at(-1)
                        ?.filter(
                          (entry) =>
                            entry.kind === "tool" && entry.status === "running",
                        ).length ?? 0
                    }
                  />
                ) : null}
              </div>
            </div>
          ) : conversationView === "trajectory" ? (
            <div
              className="conversation__scroll conversation__scroll--trajectory"
              role="tabpanel"
              aria-label="Trajectory"
              tabIndex={0}
            >
              <Trajectory items={timeline.items} />
            </div>
          ) : (
            <div
              className="conversation__scroll conversation__scroll--backend"
              role="tabpanel"
              aria-label="Backend log"
              tabIndex={0}
            >
              <BackendLog entries={timeline.backendLog} live={streaming} />
            </div>
          )}
          {conversationView === "chat" && composer}
          {dropOverlay}
        </div>
        {agentMode === "routed" &&
          !tight &&
          openRoleId &&
          route.steps.some((step) => step.id === openRoleId) && (
            <RouteRolePane
              step={
                route.steps.find((step) => step.id === openRoleId) ??
                route.steps[0]!
              }
              onClose={() => setOpenRoleId(null)}
            />
          )}
        {openSubagents.length > 0 &&
          subagentRuns.some((run) => openSubagents.includes(run.id)) && (
            <SubagentPanel
              runs={subagentRuns.filter((run) =>
                openSubagents.includes(run.id),
              )}
              activeId={
                focusedSubagent && openSubagents.includes(focusedSubagent)
                  ? focusedSubagent
                  : (openSubagents.at(-1) ?? "")
              }
              onSelect={setFocusedSubagent}
              onClose={() => {
                const closing =
                  focusedSubagent && openSubagents.includes(focusedSubagent)
                    ? focusedSubagent
                    : (openSubagents.at(-1) ?? "");
                if (!closing) return;
                setHiddenSubagents((current) =>
                  current.includes(closing) ? current : [...current, closing],
                );
                setPinnedSubagents((current) =>
                  current.filter((id) => id !== closing),
                );
              }}
              onOpenFile={openFileView}
              onOpenSubagent={stableRowHandlers.onOpenSubagent}
            />
          )}
        {workspaceExplorer}
        {boardPanel}
        {selectionTools}
      </div>

      {viewer && <FileViewer view={viewer} onClose={() => setViewer(null)} />}
      {remoteQr && (
        <div className="viewer" onClick={() => setRemoteQr(null)}>
          <div
            className="viewer__panel remote-qr"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="viewer__head">
              <span>Open on your phone</span>
              <button
                type="button"
                className="viewer__close"
                aria-label="Close"
                onClick={() => setRemoteQr(null)}
              >
                ×
              </button>
            </div>
            <div className="remote-qr__body">
              <img
                className="remote-qr__image"
                src={remoteQr.qrDataUrl}
                alt="QR code to open devden on your phone"
              />
              <p>
                Scan with your phone camera — the link logs in automatically for
                7 days. Add to Home Screen for the full-screen app experience.
                The tunnel stays up while the server runs;{" "}
                <code>/remote off</code> closes it.
              </p>
              <a href={remoteQr.connectUrl} target="_blank" rel="noreferrer">
                {remoteQr.connectUrl}
              </a>
            </div>
          </div>
        </div>
      )}
    </Activity>
  );
}
