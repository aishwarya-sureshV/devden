import {
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
  type ReactNode,
} from "react";
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
  type Attachment,
  type ConversationTab,
  type TaskSeed,
} from "../lib/store";
import { LIVE_TEXT_STALL_MS, shouldShowThinkingRow } from "../lib/thinkingRow";
import { DeployButton } from "./DeployButton";
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
import { ToolCard } from "./ToolCard";
import { SubagentCard, runningSubagentSummary } from "./SubagentCard";
import { SubagentPanel } from "./SubagentPanel";
import { RichText } from "./RichText";
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
import { UsageSummary, showsUsageSummary } from "./UsageDisplay";
import { ActiveRunIndicator } from "./ToolActivity";
import type { PaneDensity } from "../lib/sessionLayout";
import {
  IconArrowUp,
  IconBranch,
  IconChat,
  IconChevronDown,
  IconCode,
  IconCube,
  IconDots,
  IconDownload,
  IconFile,
  IconFork,
  IconInfo,
  IconPencil,
  IconHistory,
  IconColumns,
  IconList,
  IconPlus,
  IconRefresh,
  IconStop,
  IconUpload,
  FishLogo,
  BackendLogo,
} from "./icons";

type ModelOption = { provider: string; id: string; label: string };
type AccessMode = "workspace-write" | "read-only";
type AgentMode = "standard" | "plan" | "routed" | "manual";
const apiAgentMode = (mode: AgentMode): "standard" | "plan" | "manual" =>
  mode === "plan" ? "plan" : mode === "manual" ? "manual" : "standard";
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
  onClose,
  onSessionSplit,
}: {
  tab: ConversationTab;
  showThinking?: boolean;
  split?: boolean;
  density?: PaneDensity;
  onClose?: () => void;
  onSessionSplit?: (key: string) => void;
}) {
  const timeline = useTimeline(tab.timeline)!;
  const {
    refreshSessions,
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
  } = useStore();
  const backendIds = backendCatalog.length
    ? backendCatalog.map((item) => item.id)
    : [...AGENT_BACKENDS];
  const [draft, setDraft] = useState("");
  // The draft survives page reloads: keyed by conversation identity (the
  // session file once it exists, else a fresh-conversation slot per backend
  // + cwd). When the identity resolves in place (fresh chat gained its
  // session file, fork, session switch) the in-progress draft is carried
  // over rather than overwritten from storage.
  const draftKey = `devden.draft:${
    tab.sessionPath ?? `new:${tab.backend}:${tab.cwd}`
  }`;
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
  const [viewer, setViewer] = useState<ToolFileView | null>(null);
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
  const [conversationView, setConversationView] = useState<
    "chat" | "trajectory" | "backend"
  >("chat");
  const [sessionDetailsOpen, setSessionDetailsOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [workspaceMounted, setWorkspaceMounted] = useState(false);
  const [workspacePlacement, setWorkspacePlacement] =
    useState<WorkspacePlacement>(() =>
      localStorage.getItem("devden.workspace-placement") === "full"
        ? "full"
        : "side",
    );
  const workspacePickerRef = useRef<WorkspacePickerHandle | null>(null);
  // Width-aware tight mode: any side pane (board, explorer, subagents, route
  // pane) or a narrow window shrinks the conversation column — apply the same
  // compact treatment split sessions get, whatever the cause.
  const conversationRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [providerUsage, setProviderUsage] = useState<ProviderUsage | null>(
    null,
  );
  const [usageRefreshing, setUsageRefreshing] = useState(false);
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

  useEffect(() => {
    if (!overflowOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!overflowRef.current?.contains(event.target as Node))
        setOverflowOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOverflowOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [overflowOpen]);

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

  // Auto-saved transcript. Written after every settled turn rather than when a
  // limit is about to be hit: exhaustion can land mid-turn with no warning, and
  // a turn killed that way produced nothing worth keeping anyway. Entirely
  // mechanical -- no model is asked to summarise, so this costs no tokens.
  const [transcriptPath, setTranscriptPath] = useState<string | null>(null);
  useEffect(() => {
    if (streaming || timeline.items.length === 0 || !tab.cwd) return;
    const handle = window.setTimeout(() => {
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
      void api
        .writeTranscript(
          transcriptFilename(tab.sessionPath ?? tab.key, displayTitle),
          markdown,
        )
        .then((result) => {
          if (result.ok && result.path) setTranscriptPath(result.path);
        });
    }, 2000);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, timeline.items, displayTitle, tab.key, tab.cwd, tab.backend]);

  /** Hand this session to another agent: same folder, transcript as the brief. */
  const continueIn = (backend: AgentBackend) => {
    if (!transcriptPath || !tab.cwd) return;
    const text = handoffPrompt(transcriptPath, backendLabel(tab.backend));
    // A tab not yet mounted picks the draft up from storage on mount; the event
    // covers a fresh tab that is already open and so will not re-read storage.
    try {
      localStorage.setItem(`devden.draft:new:${backend}:${tab.cwd}`, text);
    } catch {
      /* storage unavailable; the event path still seeds it */
    }
    const key = openConversation(tab.cwd, undefined, backend);
    onSessionSplit?.(key);
    window.dispatchEvent(
      new CustomEvent("devden:seed-draft", { detail: { key, text } }),
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
  // Claude Code can count the context for real; every other backend gets the
  // character-based estimate. Refreshed between turns, since that is when the
  // number actually moves and when the CLI is free to answer.
  const [exactContext, setExactContext] = useState<ContextUsageReport | null>(
    null,
  );
  const estimated = estimateContext(timeline.items, state);
  const context: ContextUsage = exactContext
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
    : estimated;
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
  // The handoff field shows a single backend — the first one this session is
  // not already running on — so the closed select stays as narrow as its mark
  // instead of listing every other agent at once.
  const handoffTarget =
    backendIds.find((backend) => backend !== tab.backend) ?? "claude";
  // Reasoning summaries are intentionally not rendered in the chat view. The
  // data still flows through the timeline (Trajectory tab, context estimates),
  // but the transcript stays clean; thinking activity surfaces as the
  // "is thinking" spinner while the agent streams.
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
  const renderTimelineItem = (item: TimelineItem) => (
    <TimelineRow
      key={item.id}
      item={item}
      onOpenFile={setViewer}
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
          setLevels(levelResult.levels);
        if (modelResult.ok && levelResult.ok)
          modelMetadataLoadedRef.current = true;
      })
      .finally(() => {
        modelMetadataRequestRef.current = null;
      });
    modelMetadataRequestRef.current = request;
  }, [status, tab.backend, tab.key]);

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
    if (status === "starting" || status === "stopped") return;
    loadModelMetadata();
  }, [loadModelMetadata, status]);

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

  const openWorkspace = useCallback(() => {
    setWorkspaceMounted(true);
    setWorkspaceOpen(true);
  }, []);

  useEffect(() => {
    if (workspaceReveal?.key === tab.key) openWorkspace();
  }, [openWorkspace, tab.key, workspaceReveal]);

  const chooseWorkspacePlacement = useCallback(
    (next: WorkspacePlacement) => {
      localStorage.setItem("devden.workspace-placement", next);
      setWorkspacePlacement(next);
      openWorkspace();
    },
    [openWorkspace],
  );

  const closeWorkspace = useCallback(() => setWorkspaceOpen(false), []);

  const toggleWorkspace = () => {
    setWorkspaceOpen((open) => {
      if (!open) setWorkspaceMounted(true);
      return !open;
    });
  };

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

  // The reset instants are pure arithmetic, but the percentages only move when
  // something asks: page load, a finished turn, or the poll timer. This is the
  // "ask now" button.
  const refreshUsageNow = useCallback(async () => {
    setUsageRefreshing(true);
    try {
      await refreshUsage(true);
    } finally {
      setUsageRefreshing(false);
    }
  }, [refreshUsage]);

  // The percentages lag the failure (the poll runs every 30-60s), so ask now
  // that it has landed rather than showing the banner with stale numbers.
  useEffect(() => {
    if (limitTurn?.noticeId) void refreshUsage(true);
  }, [limitTurn?.noticeId, refreshUsage]);

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
    // ponytail: each tab polls its backend independently — N open tabs mean N
    // fetches per interval. Provider-global dedupe if that ever shows.
    if (status === "starting" || (!state && !tab.sessionPath)) return;
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
    if (!caps.contextUsage || streaming) {
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
  ]);

  useEffect(
    () =>
      subscribeEvents((event) => {
        if (event.sessionKey !== tab.key || event.type !== "agent_settled")
          return;
        if (document.hidden) {
          usageRefreshPendingRef.current = true;
          return;
        }
        void refreshUsage(true);
      }),
    [refreshUsage, tab.key],
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
    if (!stickToBottom.current || !el) return;
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
    if (split) return;
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
  }, [split]);

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
          ? "Plan mode is on — read-only exploration until you run the plan."
          : nextMode === "manual"
            ? "Manual mode is on — the agent asks before running tools."
            : "Auto mode is on.",
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
        // Prefer the backend's own accounting; fall back to the estimate.
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
      const outboundMessage = [
        (message === "/skill" ? DISTILL_SKILL_PROMPT : message) ||
          "Please inspect the attached file(s).",
        attachmentLines.length
          ? `Attached files:\n${attachmentLines.join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const displayMessage = [
        message || "Attached file(s)",
        pickedAttachments.length
          ? `Attachments: ${pickedAttachments.map((attachment) => attachment.name).join(", ")}`
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
      if (!willQueue) timeline.appendUser(displayMessage);
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

      const promptOptions = {
        images,
        cwd: tab.cwd,
        backend: tab.backend,
        sessionPath: tab.sessionPath ?? state?.sessionFile ?? undefined,
        model: state?.model ?? undefined,
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
    };
    document.addEventListener("pointerdown", closeFloatingMenus);
    return () =>
      document.removeEventListener("pointerdown", closeFloatingMenus);
  }, [commandMenuOpen, modeMenuOpen]);

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

  const textareaMinHeight = 48;
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, textareaMinHeight), 196)}px`;
  }, []);
  useLayoutEffect(() => {
    autoGrow();
  });

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

  const tight = (split && density !== "full") || narrow;

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
            className={`workspace-picker__trigger${workspaceOpen ? " is-active" : ""}`}
            aria-pressed={workspaceOpen}
            title={tab.cwd}
            onClick={toggleWorkspace}
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
    <div
      className={`composer${tight ? " composer--tight" : ""}${awaitingRoute ? " is-picking-route" : ""}`}
      data-backend={tab.backend}
    >
      {!streaming && hasItems && tab.cwd && (
        <div className="composer__turn-bar">
          <ChangesPanel
            sessionKey={tab.key}
            cwd={tab.cwd}
            streaming={streaming}
            compact={tight}
            onWorkspaceClick={() => workspacePickerRef.current?.openBrowser()}
            onAskAgent={(prompt) =>
              setDraft((current) =>
                current.trim() ? `${current}\n\n${prompt}` : prompt,
              )
            }
            onLeaveWorktree={(mainPath) => {
              setConversationWorkspace(tab.key, mainPath);
              timeline.appendNotice(
                "Worktree deleted — this session is back on the main checkout.",
                "info",
              );
            }}
          />
          {lastAssistantId && (
            <TurnCompleteBar
              backend={tab.backend}
              stats={turnStats(visibleItems)}
              starting={reviewStarting}
              onReview={(backend) => void startTurnReview(backend)}
            />
          )}
        </div>
      )}
      {/* The changes card clips its overflow, so the workspace picker's modal
          has to be hosted outside it. Kept mounted (and hidden) so the folder
          card in the changes footer has something to open. Split panes host
          the picker as the header folder chip instead. */}
      {hasItems && tab.cwd && !split && (
        <WorkspacePicker
          ref={workspacePickerRef}
          cwd={tab.cwd}
          backend={tab.backend}
          disabled={configuring}
          hideTrigger
          onPick={(path) => configureSession(accessMode, agentMode, path)}
          onIsolate={isolateSession}
          onViewWorkspace={openWorkspace}
        />
      )}
      {!hasItems && setupChips}
      {agentMode === "routed" && (
        <RouteSetup
          route={route}
          sessionKey={tab.key}
          sessionBackend={tab.backend}
          picking={awaitingRoute}
          onChange={(next) => persistRoute({ ...next, enabled: true })}
          onPick={pickRoute}
          onChangeRoute={() => setRoutePicking(true)}
        />
      )}
      {editingMessageId !== null && (
        <div className="composer__editing" role="status">
          <span>Editing message — press Enter to resend, Esc to cancel</span>
          <button
            type="button"
            onClick={() => {
              setEditingMessageId(null);
              setDraft("");
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {mentionOpen && (
        <div className="slash-menu mention-menu">
          {mentionMatches.map((match, index) => (
            <button
              key={match.path}
              type="button"
              className={`slash-menu__item${index === mentionIndex ? " is-active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                applyMention(match);
              }}
            >
              <code>{match.name}</code>
              <span>{match.relativePath}</span>
            </button>
          ))}
        </div>
      )}
      {slashOpen && slashMatches.length > 0 && (
        <div className="slash-menu">
          {slashMatches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              className={`slash-menu__item${index === slashIndex ? " is-active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setDraft(`/${command.name} `);
                setCommandMenuOpen(false);
                textareaRef.current?.focus();
              }}
            >
              <code>/{command.name}</code>
              <span>{command.description ?? ""}</span>
              <em>{command.source ?? "pi"}</em>
            </button>
          ))}
        </div>
      )}
      {streaming && todos.length > 0 && <TodoTracker tasks={todos} />}
      {timeline.pendingApprovals.map((approval) => (
        <div
          className="approval-card"
          key={approval.requestId}
          role="alertdialog"
          aria-label={`Approve ${approval.toolName}`}
        >
          <div className="approval-card__head">
            <span className="approval-card__badge">Approval needed</span>
            <strong>{approval.toolName}</strong>
          </div>
          {approval.detail && (
            <pre className="approval-card__detail">{approval.detail}</pre>
          )}
          <div className="approval-card__options" role="group">
            {approval.options.map((option) => (
              <button
                key={option.id}
                type="button"
                className={
                  option.id === "deny" || option.id === "reject_once"
                    ? "is-danger"
                    : undefined
                }
                onClick={() =>
                  void api
                    .approve(
                      tab.key,
                      approval.requestId,
                      option.id,
                      tab.backend,
                    )
                    .then((result) => {
                      if (!result.ok)
                        timeline.appendNotice(
                          result.error ?? "Could not send approval",
                          "error",
                        );
                    })
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      {compacting && (
        <div className="compacting-strip" role="status" aria-live="polite">
          <p className="compacting-strip__hint">
            Compacting the conversation — summarizing older history for the
            model…
          </p>
          <div className="compacting-strip__bar" aria-hidden="true">
            <span className="compacting-strip__fill" />
          </div>
        </div>
      )}
      {queued.length > 0 && (
        <div className="queue-strip" aria-label="Queued messages">
          <p className="queue-strip__hint">
            <span>
              {/* After an interrupt the queue outlives the turn it was
                  waiting on: nothing is running, and these are held until
                  the user sends them. Saying "waiting for this turn to
                  finish" there reads as a hang. A usage-limit wall is the
                  opposite: the turn did not finish, so the queue stays. */}
              {limitVisible
                ? "Waiting for the cut-off turn to finish."
                : streaming
                  ? canSteer
                    ? "Waiting for this turn to finish."
                    : "Waiting for this turn to finish — this agent cannot take a message mid-turn."
                  : "Queued — nothing is running. These are not sent yet."}
            </span>
            {/* Mid-turn this is steering, which not every agent can do.
                Idle it is just "send it now", which all of them can — and
                without it an interrupted grok queue has no way out.
                While the limit banner is up, sending now would start a new
                prompt and Resume would follow that instead of the cut-off turn. */}
            {!limitVisible && (canSteer || !streaming) && (
              <button
                type="button"
                className="queue-strip__steer"
                title={
                  streaming
                    ? "Send this into the turn that is already running"
                    : "Send this now"
                }
                onClick={() => {
                  const item = queued[0];
                  if (!item) return;
                  void api.steerQueued(tab.key, item.id).then((result) => {
                    if (!result.ok)
                      timeline.appendNotice(
                        result.error ?? "Could not steer",
                        "error",
                      );
                  });
                }}
              >
                {streaming ? "Steer now" : "Send now"}
              </button>
            )}
            {queued.length > 1 && (
              <button
                type="button"
                className="queue-strip__clear"
                title="Drop every queued message"
                onClick={() => {
                  void api.cancelQueued(tab.key).then((result) => {
                    if (!result.ok)
                      timeline.appendNotice(
                        result.error ?? "Could not clear the queue",
                        "error",
                      );
                  });
                }}
              >
                Clear all
              </button>
            )}
          </p>
          {queued.map((item, index) => (
            <div key={item.id} className="queue-chip">
              <span className="queue-chip__index">{index + 1}</span>
              <span className="queue-chip__text">{item.message}</span>
              <button
                type="button"
                aria-label="Remove from queue"
                title="Remove from queue"
                onClick={() => {
                  void api.cancelQueued(tab.key, item.id).then((result) => {
                    if (!result.ok)
                      timeline.appendNotice(
                        result.error ?? "Could not remove that message",
                        "error",
                      );
                  });
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {limitVisible && (
        <LimitBanner
          scope={limitScope(limitWindow?.label ?? "")}
          label={limitWindow?.label}
          resetsAt={limitWindow?.resetsAt}
          busy={streaming}
          onResume={() => void resumeFromLimit()}
        />
      )}
      <form
        className={`composer__card${awaitingRoute ? " is-awaiting-route" : ""}`}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <input
          ref={fileInputRef}
          className="composer__file-input"
          type="file"
          multiple
          onChange={(event) => {
            void uploadFiles(event.target.files);
            event.target.value = "";
          }}
        />
        {attachments.length > 0 && (
          <div className="composer__attachments" aria-label="Attached files">
            {attachments.map((attachment) => {
              const removeAttachment = () =>
                setAttachments((current) =>
                  current.filter((candidate) => candidate.id !== attachment.id),
                );
              if (attachment.imageData) {
                const src = `data:${attachment.mimeType};base64,${attachment.imageData}`;
                return (
                  <span
                    className="attachment-chip attachment-chip--image"
                    key={attachment.id}
                    title={attachment.path}
                  >
                    <button
                      type="button"
                      className="attachment-chip__preview"
                      aria-label={`Preview ${attachment.name}`}
                      onClick={() =>
                        setViewer({ title: attachment.name, imageSrc: src })
                      }
                    >
                      <img src={src} alt="" />
                      <span>{attachment.name}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${attachment.name}`}
                      onClick={removeAttachment}
                    >
                      ×
                    </button>
                  </span>
                );
              }
              return (
                <span
                  className="attachment-chip"
                  key={attachment.id}
                  title={attachment.path}
                >
                  <IconFile size={14} />
                  <span>{attachment.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={removeAttachment}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}
        <div className="composer__scroll">
          <textarea
            ref={textareaRef}
            className="composer__textarea"
            rows={2}
            disabled={awaitingRoute}
            placeholder={
              awaitingRoute
                ? "Pick a route above"
                : editingMessageId === null
                  ? hasItems
                    ? streaming
                      ? tight
                        ? "Reply…"
                        : "Reply, or queue the next step…"
                      : "Describe what you want next…"
                    : "Describe what you want to build"
                  : "Edit your message…"
            }
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              if (commandMenuOpen) setCommandMenuOpen(false);
              autoGrow();
            }}
            onSelect={(e) =>
              setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)
            }
            onKeyDown={onKeyDown}
            onPaste={onPasteImage}
          />
        </div>
        <div className="composer__row">
          <div className="composer__tools">
            <button
              type="button"
              className="composer__add"
              aria-label="Attach files"
              title="Attach files (20 MB max)"
              onClick={() => fileInputRef.current?.click()}
            >
              <IconPlus />
            </button>
            <div className="composer__mode" ref={modeMenuRef}>
              <button
                type="button"
                className="composer__mode-trigger"
                aria-haspopup="menu"
                aria-expanded={modeMenuOpen}
                disabled={configuring || streaming}
                onClick={() => setModeMenuOpen((open) => !open)}
              >
                {accessMode === "read-only"
                  ? "Read-only"
                  : agentMode === "plan"
                    ? "Plan"
                    : agentMode === "routed"
                      ? "Routed"
                      : agentMode === "manual"
                        ? "Manual"
                        : "Auto"}
                {tight ? "" : " mode"}
                <IconChevronDown size={11} />
              </button>
              {modeMenuOpen && (
                <div className="composer__mode-menu" role="menu">
                  <span className="composer__mode-heading">Mode</span>
                  {(
                    [
                      ["standard", "Auto", "This agent runs the whole turn"],
                      [
                        "plan",
                        "Plan",
                        "Map the work first; nothing is written",
                      ],
                      [
                        "routed",
                        "Routed",
                        "Pass the turn through a chain of agents",
                      ],
                      ["manual", "Manual", "Ask before each tool call"],
                    ] as const
                  ).map(([id, label, sub]) => {
                    const selected =
                      accessMode !== "read-only" && agentMode === id;
                    return (
                      <button
                        type="button"
                        role="menuitem"
                        key={id}
                        className={selected ? "is-active" : undefined}
                        onClick={() => {
                          setModeMenuOpen(false);
                          // Read-only is no longer offered here, but a session
                          // already sitting in it must still be able to leave.
                          if (accessMode === "read-only") {
                            void configureSession(
                              "workspace-write",
                              id as AgentMode,
                            );
                            return;
                          }
                          void switchAgentMode(id as AgentMode);
                        }}
                      >
                        <span>
                          <strong>{label}</strong>
                          <em>{sub}</em>
                        </span>
                        {selected ? <span>✓</span> : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {agentMode === "routed" && (
              <button
                type="button"
                className={`composer__route-chip${awaitingRoute ? " is-open" : ""}`}
                aria-haspopup="menu"
                aria-expanded={awaitingRoute}
                disabled={configuring || streaming}
                onClick={() =>
                  awaitingRoute ? dismissRoutePick() : setRoutePicking(true)
                }
              >
                {awaitingRoute ? "esc" : "/ route"}
              </button>
            )}
          </div>
          <div className="composer__trailing">
            {providerUsage && showsUsageSummary(providerUsage) && (
              <>
                <UsageSummary usage={providerUsage} />
                <span className="usage-summary__rule" aria-hidden="true" />
              </>
            )}
            <div
              className="native-model-controls"
              onPointerDown={loadModelMetadata}
              onFocus={loadModelMetadata}
            >
              <span
                className="native-model-controls__field native-model-controls__field--model"
                title={`${backendLabel(tab.backend)} · ${currentModelLabel}`}
              >
                <span className="native-model-controls__value">
                  {backendLabel(tab.backend).toLowerCase()} ·{" "}
                  {currentModelLabel}
                </span>
                <span className="native-select__chev">
                  <IconChevronDown size={13} />
                </span>
                <select
                  aria-label="Model"
                  value={currentModel}
                  disabled={configuring || streaming}
                  title={
                    streaming
                      ? "Wait for the current response to finish before changing model"
                      : "Change model for the next message"
                  }
                  onChange={(event) => setModel(event.target.value)}
                >
                  {!currentModel && <option value="">model…</option>}
                  {currentModel &&
                    !modelOptions.some(
                      (option) =>
                        `${option.provider}/${option.id}` === currentModel,
                    ) && (
                      <option value={currentModel}>
                        {tab.backend === "claude"
                          ? formatClaudeModelName(
                              state?.model?.name ??
                                state?.model?.id ??
                                currentModel,
                            )
                          : (state?.model?.name ??
                            state?.model?.id ??
                            currentModel)}
                      </option>
                    )}
                  {modelOptions.map((option) => (
                    <option
                      key={`${option.provider}/${option.id}`}
                      value={`${option.provider}/${option.id}`}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
              </span>
              <span
                className="native-model-controls__field native-model-controls__field--effort"
                title={`Effort: ${effort}`}
              >
                <span className="native-model-controls__value">{effort}</span>
                <span className="native-select__chev">
                  <IconChevronDown size={13} />
                </span>
                <select
                  aria-label="Effort"
                  value={effort}
                  disabled={configuring || streaming}
                  onChange={(event) => setEffort(event.target.value)}
                >
                  {!levels.includes(effort) && (
                    <option value={effort}>{effort}</option>
                  )}
                  {levels.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </span>
            </div>
            {streaming ? (
              <button
                type="button"
                className="composer__primary is-stop"
                aria-label="Stop"
                onClick={() => void api.abort(tab.key)}
              >
                <IconStop />
              </button>
            ) : (
              <button
                type="submit"
                className="composer__primary"
                aria-label="Send"
                disabled={
                  awaitingRoute || (!draft.trim() && attachments.length === 0)
                }
              >
                <IconArrowUp />
              </button>
            )}
          </div>
        </div>
      </form>
      {hasItems && (
        <div className="composer__handoff">
          {transcriptPath ? (
            <span
              className="composer__handoff-status"
              title={`Saved automatically after every reply to ${transcriptPath}`}
            >
              Transcript saved
            </span>
          ) : (
            <span className="composer__handoff-status">Transcript idle</span>
          )}
          <span className="composer__handoff-rule" aria-hidden="true" />
          <span className="composer__handoff-continue">Continue in…</span>
          <div className="native-select composer__handoff-select">
            <span
              className="composer__handoff-mark"
              style={{ color: backendMark(handoffTarget).color }}
              aria-hidden
            >
              <BackendLogo backend={handoffTarget} size={12} />
            </span>
            <select
              aria-label="Continue this conversation in another agent"
              title="Opens a new session in the same folder, seeded with this transcript"
              value=""
              disabled={!transcriptPath}
              onChange={(event) => {
                const next = event.target.value as AgentBackend;
                event.target.value = "";
                if (next) continueIn(next);
              }}
            >
              <option value="">{backendLabel(handoffTarget)}</option>
              {backendIds
                .filter((backend) => backend !== tab.backend)
                .map((backend) => (
                  <option key={backend} value={backend}>
                    {backendLabel(backend)}
                  </option>
                ))}
            </select>
            <span className="native-select__chev">
              <IconChevronDown size={12} />
            </span>
          </div>
          {providerUsage?.available && (
            <span className="composer__handoff-reset">
              <button
                type="button"
                className={`usage-refresh${usageRefreshing ? " is-spinning" : ""}`}
                aria-label="Refresh usage"
                title="Refresh usage"
                disabled={usageRefreshing}
                onClick={() => void refreshUsageNow()}
              >
                <IconRefresh size={12} />
              </button>
            </span>
          )}
        </div>
      )}
    </div>
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

  const folderChip =
    split && tab.cwd ? (
      <WorkspacePicker
        ref={workspacePickerRef}
        cwd={tab.cwd}
        backend={tab.backend}
        disabled={configuring}
        variant="chip"
        onPick={(path) => configureSession(accessMode, agentMode, path)}
        onIsolate={isolateSession}
        // Split panes show one conversation each; the workspace is owned
        // by the wide layout, so hide its menu entry here.
        onViewWorkspace={undefined}
      />
    ) : null;

  const overflowMenu = tight ? (
    <div className="conversation-header__overflow" ref={overflowRef}>
      <button
        type="button"
        className="conversation-header__more"
        aria-haspopup="menu"
        aria-expanded={overflowOpen}
        aria-label="Session actions"
        onClick={() => setOverflowOpen((open) => !open)}
      >
        <IconDots size={14} />
      </button>
      {overflowOpen && (
        <div className="conversation-header__overflow-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOverflowOpen(false);
              setSessionDetailsOpen(true);
            }}
          >
            Session details
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOverflowOpen(false);
              toggleWorkspace();
            }}
          >
            View project source
          </button>
          {onClose && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOverflowOpen(false);
                onClose();
              }}
            >
              Close session
            </button>
          )}
        </div>
      )}
    </div>
  ) : null;

  const viewTab = (
    id: "chat" | "trajectory" | "backend",
    label: string,
    icon: ReactNode | null,
    count?: number,
  ) => {
    const active = conversationView === id;
    const showLabel =
      density === "full" ||
      (density === "compact" && id === "chat") ||
      (density === "dense" && active);
    const showIcon =
      density === "dense" || (density === "compact" && id !== "chat");
    return (
      <button
        key={id}
        type="button"
        role="tab"
        aria-selected={active}
        aria-label={label}
        title={label}
        className={active ? "is-active" : ""}
        onClick={() => setConversationView(id)}
      >
        {showIcon && icon}
        {showLabel && <span>{label}</span>}
        {count != null && count > 0 && density !== "full" && (
          <span className="conversation-header__count">{count}</span>
        )}
      </button>
    );
  };

  const trajCount = timeline.items.length;
  const viewSwitcher =
    density === "dense" ? (
      <div
        className="conversation-header__segment"
        role="tablist"
        aria-label="Conversation view"
      >
        {viewTab("chat", "Chat", <IconChat size={12} />)}
        {viewTab(
          "trajectory",
          "Trajectory",
          <IconBranch size={12} />,
          trajCount,
        )}
        {viewTab("backend", "Backend log", <IconList size={12} />)}
      </div>
    ) : (
      <div
        className={`conversation-header__track${density === "compact" ? " conversation-header__track--compact" : ""}`}
        role="tablist"
        aria-label="Conversation view"
      >
        {viewTab("chat", "Chat", <IconChat size={12} />)}
        {viewTab(
          "trajectory",
          "Trajectory",
          <IconBranch size={12} />,
          density === "compact" ? trajCount : undefined,
        )}
        {viewTab("backend", "Backend log", <IconList size={12} />)}
      </div>
    );

  if (!hasItems) {
    return (
      <>
        {split && (
          <div className="conversation-header conversation-header--empty">
            <div className="conversation-header__actions">
              {onClose && (
                <button
                  type="button"
                  className="conversation-header__close"
                  aria-label={`Close ${displayTitle}`}
                  title="Close session"
                  onClick={onClose}
                >
                  ×
                </button>
              )}
            </div>
          </div>
        )}
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
      </>
    );
  }

  const statusDot = (
    <span
      className={`conversation-header__dot${streaming ? " is-live" : ""}`}
      style={{
        background:
          status === "error"
            ? "var(--pw-red)"
            : streaming
              ? "var(--pw-accent)"
              : backendMark(tab.backend).color,
      }}
      aria-hidden
    />
  );

  // Click-to-rename: the title itself becomes the editor in place — no
  // separate dialog. Enter or blur saves; Escape cancels.
  const startRename = () => {
    const fallback = firstUserItem?.kind === "user" ? firstUserItem.text : "";
    setRenameDraft(state?.sessionName?.trim() || fallback.slice(0, 200));
    setRenaming(true);
  };
  const finishRename = () => {
    setRenaming(false);
    const title = renameDraft.trim();
    if (!title || title === displayTitle) return;
    // The session_title_set event updates the timeline, the tab label and
    // the sidebar; the API call just persists it.
    void api.rename(tab.key, title).then((result) => {
      if (!result.ok && result.error)
        window.alert(`Rename failed: ${result.error}`);
    });
  };
  const renameInput = (
    <input
      className="conversation-header__title-input"
      value={renameDraft}
      onChange={(event) => setRenameDraft(event.target.value)}
      onBlur={finishRename}
      onKeyDown={(event) => {
        if (event.key === "Escape") setRenaming(false);
        // Blur is the single save path, so Enter cannot double-commit.
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      autoFocus
      onFocus={(event) => event.target.select()}
      aria-label="Session title"
    />
  );

  return (
    <>
      <div className={`conversation-header${split ? ` is-${density}` : ""}`}>
        {/* Wide split panes leave tight mode, but the title still lives here.
            Gating this row on tight hid it whenever the sidebar collapsed. */}
        {(tight || split) && (
          <div className="conversation-header__identity">
            {statusDot}
            {split ? (
              renaming ? (
                renameInput
              ) : (
                <button
                  type="button"
                  className="conversation-header__agent"
                  aria-label="Rename session"
                  title="Rename session"
                  onClick={startRename}
                >
                  <span
                    className="conversation-header__agent-logo"
                    style={{ color: backendMark(tab.backend).color }}
                    aria-hidden
                  >
                    <BackendLogo backend={tab.backend} size={13} />
                  </span>
                  <span className="conversation-header__agent-title">
                    {displayTitle}
                  </span>
                </button>
              )
            ) : (
              <span className="conversation-header__agent">
                {backendLabel(tab.backend)}
              </span>
            )}
            {tight && (
              <>
                <span className="conversation-header__spacer" aria-hidden />
                {providerUsage && showsUsageSummary(providerUsage) && (
                  <UsageSummary usage={providerUsage} />
                )}
                {density === "dense" && folderChip}
                {overflowMenu}
              </>
            )}
          </div>
        )}
        <div className="conversation-header__row">
          <div className="conversation-header__tabs">
            {agentMode === "plan" && !tight && (
              <div className="conversation-header__mode">
                <IconCube size={13} /> Plan mode
              </div>
            )}
            {agentMode === "routed" && !tight && (
              <div className="conversation-header__mode">Routed</div>
            )}
            {viewSwitcher}
          </div>
          {!split && (
            <div className="conversation-header__workspace">
              {renaming ? (
                renameInput
              ) : (
                <button
                  type="button"
                  className="conversation-header__session-title"
                  aria-label="Rename session"
                  title="Rename session"
                  onClick={startRename}
                >
                  {displayTitle}
                </button>
              )}
            </div>
          )}
          <div className="conversation-header__tabs-actions">
            {!tight && runningSubagentSummary(subagentRuns) && (
              <span className="conversation-header__subagents">
                <span
                  className="conversation-header__subagents-dot"
                  aria-hidden
                />
                {runningSubagentSummary(subagentRuns)}
              </span>
            )}
            {density !== "dense" && folderChip}
            <DeployButton cwd={tab.cwd} compact={tight} />
            {!tight && onClose && (
              <button
                type="button"
                className="conversation-header__close"
                aria-label={`Close ${displayTitle}`}
                title="Close session"
                onClick={onClose}
              >
                ×
              </button>
            )}
            {!split && (
              <button
                type="button"
                className={`conversation-header__download conversation-header__icon-btn${workspaceOpen ? " is-active" : ""}`}
                aria-pressed={workspaceOpen}
                aria-label="View project source"
                title="View project source"
                onClick={toggleWorkspace}
              >
                <IconCode size={14} />
              </button>
            )}
            {!split && tab.cwd && (
              <button
                type="button"
                className={`conversation-header__download conversation-header__icon-btn${boardOpen ? " is-active" : ""}`}
                aria-pressed={boardOpen}
                aria-label="Board"
                title="Board"
                onClick={() => setBoardOpen((open) => !open)}
              >
                <IconColumns size={14} />
              </button>
            )}
            {!tight && (
              <button
                type="button"
                className="conversation-header__download conversation-header__icon-btn"
                aria-label="Session details"
                title="Session details"
                onClick={() => setSessionDetailsOpen(true)}
              >
                <IconInfo size={14} />
              </button>
            )}
          </div>
        </div>
        <ContextFill context={context} />
      </div>

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
                      {turnUserItems(turn).map(renderTimelineItem)}
                      {showFold && stats && (
                        <TurnFoldBar
                          durationMs={stats.durationMs}
                          endedAt={turnEndedAt(turn)}
                          toolCount={stats.toolCount}
                          fileCount={changedFiles.length || stats.fileCount}
                          open={logOpen}
                          onToggle={() =>
                            setTurnOpen((current) => ({
                              ...current,
                              [id]: !logOpen,
                            }))
                          }
                        />
                      )}
                      {bodyItems.map(renderTimelineItem)}
                      {!logOpen && (
                        <TurnFilesCard
                          files={changedFiles}
                          onOpenFile={setViewer}
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
                    backend={tab.backend}
                    resume={visibleItems.some(
                      (item) =>
                        item.kind === "notice" &&
                        /picking this conversation back up/i.test(item.text),
                    )}
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
              onOpenFile={setViewer}
              onOpenSubagent={stableRowHandlers.onOpenSubagent}
            />
          )}
        {workspaceExplorer}
        {boardPanel}
        {selectionTools}
      </div>

      {viewer && <FileViewer view={viewer} onClose={() => setViewer(null)} />}
      {sessionDetailsOpen && (
        <div className="viewer" onClick={() => setSessionDetailsOpen(false)}>
          <div
            className="viewer__panel session-details"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="viewer__head">
              <span>Session details</span>
              <button
                type="button"
                className="viewer__close"
                aria-label="Close"
                onClick={() => setSessionDetailsOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="session-details__body">
              <div className="details__row">
                <span>session id</span>
                <code>{state?.sessionId ?? "—"}</code>
              </div>
              <div className="details__row details__row--path">
                <span>session file</span>
                <code title={state?.sessionFile}>
                  {state?.sessionFile ?? "—"}
                </code>
              </div>
              <a
                className={`conversation-header__download${state?.sessionFile ? "" : " is-disabled"}`}
                href={
                  state?.sessionFile
                    ? api.sessionLogUrl(state.sessionFile)
                    : undefined
                }
                aria-disabled={!state?.sessionFile}
                download
                onClick={(event) => {
                  if (!state?.sessionFile) event.preventDefault();
                }}
              >
                Download session log <IconDownload size={14} />
              </a>
            </div>
          </div>
        </div>
      )}
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
    </>
  );
}

function ThinkingRow({
  backend,
  resume = false,
}: {
  backend: ConversationTab["backend"];
  resume?: boolean;
}) {
  const name = backendLabel(backend);
  const label = resume ? "Picking up after restart" : `${name} is thinking`;
  return (
    <div className="thinking" aria-label={label}>
      <span className="thinking__spinner" />
      <span>{label}</span>
      {resume ? null : <span className="thinking__dots" aria-hidden="true" />}
    </div>
  );
}

function ContextFill({ context }: { context: ContextUsage }) {
  const percent = context.percent ?? 0;
  const nearLimit = percent >= 80;
  const title = context.exact
    ? [
        `${context.estimatedTokens.toLocaleString()} of ${context.contextWindow.toLocaleString()} context tokens used (${percent}%)`,
        context.autoCompactAt
          ? `Auto-compacts at ${context.autoCompactAt.toLocaleString()}.`
          : "",
        ...(context.categories ?? [])
          .slice(0, 6)
          .map((entry) => `${entry.name}: ${compactTokens(entry.tokens)}`),
      ]
        .filter(Boolean)
        .join("\n")
    : `Approximately ${context.estimatedTokens.toLocaleString()} of ${context.contextWindow.toLocaleString()} context tokens used (estimated)`;
  return (
    <div
      className={`context-fill${nearLimit ? " is-near-limit" : ""}${context.exact ? " is-exact" : ""}`}
      role="progressbar"
      aria-label={`Context used: ${percent}%${context.exact ? "" : ", estimated"}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      title={title}
    >
      <span style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  );
}

/** What the transcript shows in place of the model's babysitting churn: one
 *  steady row for as long as the run is in flight. `attention` replaces it
 *  when the runner reports the child is blocked on a reply — otherwise a
 *  stalled run is indistinguishable from a slow one. */
function SubagentWaitRow({ runs }: { runs: SubagentRun[] }) {
  const running = runs.filter((run) => run.status === "running");
  if (running.length === 0) return null;
  const blocked = running.find((run) => run.attention);
  const label = blocked?.attention
    ? `Subagent needs attention — ${blocked.attention}`
    : running.length > 1
      ? `${running.length} background subagents are running — waiting for them to complete`
      : "Background subagent is running — waiting for it to complete";
  return (
    <div
      className={`thinking${blocked ? " thinking--attention" : ""}`}
      aria-label={label}
    >
      <span className="thinking__spinner" />
      <span>{label}</span>
      {blocked ? null : <span className="thinking__dots" aria-hidden="true" />}
    </div>
  );
}

/**
 * Memoized: streaming deltas tick the timeline many times a second, and a
 * long session re-parsing every RichText/diff row per tick froze the main
 * thread — the first paint after sending a prompt lagged for seconds, which
 * read as "nothing happened". Rows whose item and flags are unchanged now
 * skip re-rendering entirely.
 */
/**
 * "Undo the edits made since this message." Claude Code restores from the
 * per-file backups it takes before writing; every other backend restores from
 * the git snapshot the server takes before each turn. It asks for the preview
 * first so the click is never blind — a rewind is not itself undoable.
 */
function RewindFilesButton({
  timestamp,
  disabled,
  onRewindFiles,
}: {
  timestamp: number;
  disabled?: boolean;
  onRewindFiles?: (
    timestamp: number,
    dryRun: boolean,
  ) => Promise<RewindFilesResult>;
}) {
  const [preview, setPreview] = useState<RewindFilesResult | null>(null);
  const [busy, setBusy] = useState(false);
  if (!onRewindFiles) return null;

  const ask = async () => {
    setBusy(true);
    try {
      setPreview(await onRewindFiles(timestamp, true));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const result = await onRewindFiles(timestamp, false);
      setPreview(result.error ? result : null);
    } finally {
      setBusy(false);
    }
  };

  if (preview) {
    const count = preview.filesChanged?.length ?? 0;
    return (
      <span className="rewind">
        {preview.error ? (
          <span className="rewind__error">{preview.error}</span>
        ) : (
          <>
            <span className="rewind__summary">
              Restore {count} file{count === 1 ? "" : "s"}
              {preview.insertions === undefined
                ? ""
                : ` (+${preview.insertions}/−${preview.deletions ?? 0})`}
              ?
            </span>
            <button
              type="button"
              className="rewind__confirm"
              disabled={busy || count === 0}
              onClick={() => void confirm()}
            >
              Restore
            </button>
          </>
        )}
        <button
          type="button"
          className="rewind__cancel"
          onClick={() => setPreview(null)}
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      className="user-msg__action"
      aria-label="Restore files to this point"
      title="Restore files to this point"
      disabled={disabled || busy}
      onClick={() => void ask()}
    >
      <IconHistory size={13} />
    </button>
  );
}

/** Notice with expandable content (compaction summary) — one compact line,
 *  click to reveal what was compacted away. */
function CompactedNotice({
  text,
  tone,
  detail,
}: {
  text: string;
  tone: "info" | "warning" | "error";
  detail: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`notice notice--${tone}`}>
      <button
        type="button"
        className="notice__summary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {text}
      </button>
      {open && <pre className="notice__detail">{detail}</pre>}
    </div>
  );
}

const TimelineRow = memo(function TimelineRow({
  item,
  onOpenFile,
  onFork,
  forking,
  canFork = true,
  canTruncate = false,
  showActions,
  showModelTag,
  editingId,
  streaming,
  onEditMessage,
  onCancelEdit,
  onVersionChange,
  onRewindFiles,
  onAnswer,
  subagentChildren,
  onOpenSubagent,
  onBackgroundSubagent,
  onStopTerminal,
}: {
  item: TimelineItem;
  onOpenFile: (view: ToolFileView) => void;
  onFork: (item: Extract<TimelineItem, { kind: "assistant" }>) => void;
  forking: boolean;
  canFork?: boolean;
  canTruncate?: boolean;
  showActions: boolean;
  showModelTag: boolean;
  editingId?: string | null;
  streaming?: boolean;
  onEditMessage?: (item: Extract<TimelineItem, { kind: "user" }>) => void;
  onCancelEdit?: () => void;
  onVersionChange?: (
    item: Extract<TimelineItem, { kind: "user" }>,
    index: number,
  ) => void;
  onRewindFiles?: (
    timestamp: number,
    dryRun: boolean,
  ) => Promise<RewindFilesResult>;
  /** Present only on the newest settled reply — see AskCard. */
  onAnswer?: (text: string) => void;
  subagentChildren?: Map<string, Extract<TimelineItem, { kind: "tool" }>[]>;
  onOpenSubagent?: (id: string) => void;
  onBackgroundSubagent?: (id: string) => void;
  /** Stop a running server-owned terminal tab (its card's Stop button). */
  onStopTerminal?: (tabId: string) => void;
}) {
  if (item.kind === "tool" && isSubagentTool(item.name))
    return (
      <SubagentCard
        item={item}
        children={subagentChildren?.get(item.id) ?? []}
        onOpenFile={onOpenFile}
        onOpenSubagent={onOpenSubagent}
        onBackground={onBackgroundSubagent}
      />
    );
  if (item.kind === "tool")
    return (
      <ToolCard
        item={item}
        onOpenFile={onOpenFile}
        onOpenSubagent={onOpenSubagent}
        children={subagentChildren?.get(item.id) ?? []}
      />
    );
  if (item.kind === "notice")
    return item.detail ? (
      <CompactedNotice text={item.text} tone={item.tone} detail={item.detail} />
    ) : (
      <div className={`notice notice--${item.tone}`}>{item.text}</div>
    );
  if (item.kind === "terminal")
    return (
      <div className="terminal-card">
        <div className="terminal-card__header">
          <span
            className={`terminal-card__dot${
              item.status === "running" ? " is-running" : ""
            }`}
          />
          <span className="terminal-card__title" title={item.command}>
            {item.title}
          </span>
          <span className="terminal-card__status">
            {item.status === "exited"
              ? `exit ${item.exitCode ?? "?"}`
              : "running"}
          </span>
          {item.status === "running" && onStopTerminal && (
            <button
              type="button"
              className="terminal-card__stop"
              onClick={() => onStopTerminal(item.tabId)}
            >
              Stop
            </button>
          )}
        </div>
        <pre className="terminal-card__output">{item.output}</pre>
      </div>
    );
  if (item.kind === "user") {
    const versions = item.versions;
    const versionIndex = item.versionIndex ?? 0;
    return (
      <article className="tl tl--user">
        <span className="tl__node" />
        <div className="tl--user__stack">
          <div
            className={`user-msg${editingId === item.id ? " is-editing" : ""}`}
          >
            {item.text}
          </div>
          <div className="user-msg__actions">
            <CopyButton
              text={item.text}
              label="Copy message"
              className="user-msg__action"
            />
            {canTruncate ? (
              <button
                type="button"
                className="user-msg__action"
                aria-label="Edit and resend"
                title="Edit and resend"
                disabled={streaming}
                onClick={() => {
                  if (editingId === item.id) {
                    onCancelEdit?.();
                    return;
                  }
                  onEditMessage?.(item);
                }}
              >
                <IconPencil size={13} />
              </button>
            ) : null}
            <RewindFilesButton
              timestamp={item.timestamp}
              disabled={streaming}
              onRewindFiles={onRewindFiles}
            />
          </div>
          {canTruncate && versions && versions.length > 1 && (
            <div
              className="user-msg__versions"
              role="group"
              aria-label="Message versions"
            >
              <button
                type="button"
                aria-label="Previous version"
                disabled={versionIndex === 0}
                onClick={() => onVersionChange?.(item, versionIndex - 1)}
              >
                ‹
              </button>
              <span>
                {versionIndex + 1}/{versions.length}
              </span>
              <button
                type="button"
                aria-label="Next version"
                disabled={versionIndex >= versions.length - 1}
                onClick={() => onVersionChange?.(item, versionIndex + 1)}
              >
                ›
              </button>
            </div>
          )}
        </div>
      </article>
    );
  }
  return (
    <article
      className={`tl tl--assistant${item.kind === "rationale" ? " tl--rationale" : ""}`}
    >
      <span className={`tl__node${item.live ? " is-live" : ""}`} />
      <div>
        <RichText
          text={item.text
            .replace(/\s*\[DONE:\d+\]\s*/gi, " ")
            // Models end turns with trailing newlines and pre-wrap renders
            // them as real blank lines — the phantom gap between prose and
            // the rows below.
            .replace(/\s+$/, "")
            .replace(/^\s+/, "")}
          live={item.live}
          onAnswer={onAnswer}
        />
      </div>
      {item.kind === "assistant" &&
        !item.live &&
        showModelTag &&
        (item.provider || item.modelId) && (
          <div
            className="response-model-tag"
            title="Model that generated this reply, as tracked by the backend — not the model's own self-report."
          >
            {item.provider}
            {item.provider && item.modelId ? "/" : ""}
            {item.modelId}
          </div>
        )}
      {item.kind === "assistant" && !item.live && showActions && (
        <div
          className="response-actions"
          aria-label="Response actions"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <CopyButton
            text={item.text.replace(/\s*\[DONE:\d+\]\s*/gi, " ")}
            label="Copy response"
            iconOnly
          />
          {canFork ? (
            <button
              type="button"
              className={forking ? "is-busy" : undefined}
              aria-label="Fork response"
              title={forking ? "Forking response" : "Fork response"}
              disabled={forking}
              onClick={() => onFork(item)}
            >
              <IconFork />
            </button>
          ) : null}
        </div>
      )}
    </article>
  );
});

/** Newest settled reply, preferring an ask card so a trailing report does not lock it. */
function lastAnswerableAssistantId(items: TimelineItem[]): string | undefined {
  const tail: Extract<TimelineItem, { kind: "assistant" }>[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "user" || item.kind === "tool") break;
    if (item.kind === "assistant") tail.push(item);
  }
  return (tail.find((item) => isAskMessage(item.text)) ?? tail[0])?.id;
}

function getResponseActionIds(
  items: TimelineItem[],
  streaming: boolean,
): Set<string> {
  const ids = new Set<string>();
  let segment: TimelineItem[] = [];
  const segments: TimelineItem[][] = [];
  for (const item of items) {
    if (item.kind === "user" && segment.length) {
      segments.push(segment);
      segment = [];
    }
    segment.push(item);
  }
  if (segment.length) segments.push(segment);

  segments.forEach((turn, index) => {
    if (streaming && index === segments.length - 1) return;
    const assistantIndex = turn.reduce(
      (last, item, itemIndex) => (item.kind === "assistant" ? itemIndex : last),
      -1,
    );
    if (assistantIndex < 0) return;
    if (turn.slice(assistantIndex + 1).some((item) => item.kind === "tool"))
      return;
    const response = turn[assistantIndex];
    if (response?.kind === "assistant") ids.add(response.id);
  });
  return ids;
}

/** Harness rows the journal never counts as a user turn. */
function isCountedUserTurn(
  item: Extract<TimelineItem, { kind: "user" }>,
): boolean {
  const text = item.text.trim();
  if (!text) return false;
  return (
    !text.startsWith("<user_info>") &&
    !text.startsWith("<system-reminder>") &&
    !text.startsWith("<session_context>")
  );
}

/** 0-based user-turn index for the assistant reply being forked. */
function promptIndexAtAssistant(
  items: TimelineItem[],
  assistantId: string,
): number {
  let users = 0;
  for (const item of items) {
    if (item.kind === "user" && isCountedUserTurn(item)) users += 1;
    if (item.id === assistantId) return Math.max(0, users - 1);
  }
  return Math.max(0, users - 1);
}

function userTextBeforeAssistant(
  items: TimelineItem[],
  assistantId: string,
): string {
  let last = "";
  for (const item of items) {
    if (item.kind === "user" && isCountedUserTurn(item))
      last = item.text.trim();
    if (item.id === assistantId) return last;
  }
  return last;
}

function capText(text: string, limit = 80_000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (truncated)`;
}

async function collectReviewDiff(
  key: string,
  cwd: string,
  since: number,
  turnFiles: string[],
): Promise<
  { ok: true; diff: string; reason?: string } | { ok: false; error: string }
> {
  const bulk = await api.gitReviewDiff(key, cwd, since);
  if (bulk.ok && bulk.repo === false)
    return { ok: false, error: "This folder is not a git repository." };
  if (bulk.ok && typeof bulk.diff === "string" && bulk.diff.trim()) {
    const diff =
      bulk.scope === "turn" || turnFiles.length === 0
        ? bulk.diff
        : filterDiffToFiles(bulk.diff, turnFiles, cwd);
    if (diff.trim()) return { ok: true, diff };
  }
  const listed = await api.gitChanges(key, cwd);
  if (!listed.ok)
    return { ok: false, error: listed.error ?? "Could not list git changes." };
  if (listed.repo === false)
    return { ok: false, error: "This folder is not a git repository." };
  const changes = listed.changes ?? [];
  if (changes.length === 0) return { ok: true, diff: "" };
  const matched = turnFiles.length
    ? changes.filter((file) =>
        turnFiles.some((path) => reviewPathsMatch(file.path, path, cwd)),
      )
    : [];
  // Isolation missed (absolute tool paths, old API without snapshot diffs).
  // The working tree is dirty — review that rather than claiming no change.
  const files = matched.length ? matched : changes;
  const pieces = await Promise.all(
    files.map((file) => api.gitFileDiff(key, cwd, file.path)),
  );
  return {
    ok: true,
    diff: pieces
      .map((piece) => piece.diff ?? "")
      .filter((block) => block.trim())
      .join("\n"),
  };
}
