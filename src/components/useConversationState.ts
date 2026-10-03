// All of Conversation's local state, refs and the effects that only reset or
// persist that state. Logic that acts on it lives in the use*/conversation*
// modules beside it.
import {
  useTimeline,
  useStore,
  type Attachment,
  type ConversationTab,
} from "../lib/store";
import {
  AGENT_BACKENDS,
  type SlashCommand,
  type ModelInfo,
  type AgentBackend,
  type WorkspaceMatch,
  type QueuedMessage,
  type ProviderUsage,
  api,
} from "../lib/api";
import { useState, useRef, useEffect } from "react";
import type { ToolFileView } from "../lib/toolCards";
import { CLAUDE_MODELS, CLAUDE_EFFORT_LEVELS } from "../lib/claudeModels";
import { useBackendUsage, usagePair } from "../lib/backendUsage";
import type { AccessMode, AgentMode } from "./conversationHelpers";
import { type SessionRoute, emptyRoute } from "../lib/route";
import { capabilitiesFor } from "../lib/agentCapabilities";
import type { SessionView } from "./SessionHeader";
import type { WorkspacePlacement } from "./WorkspaceExplorer";
import type { WorkspacePickerHandle } from "./WorkspacePicker";

export type UseConversationStateArgs = {
  tab: ConversationTab;
  visible: boolean;
};

export function useConversationState({
  tab,
  visible,
}: UseConversationStateArgs) {
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
  // client-side constant (instant). useModelPicker prefetches the rest so
  // browsing an agent does not sit on "Loading models…".
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

  return {
    route,
    setRoutePicking,
    awaitingRoute,
    textareaRef,
    timeline,
    state,
    resumeSessions,
    setModelMenuOpen,
    configuring,
    setDefaultBackend,
    setConversationBackend,
    reviewStarting,
    setReviewStarting,
    setReviews,
    openConversation,
    closeConversation,
    setDraft,
    conversationRef,
    setNarrow,
    providerUsage,
    setTurnOpen,
    setEditingMessageId,
    setHiddenSubagents,
    setPinnedSubagents,
    setFocusedSubagent,
    seenRunningSubagents,
    hiddenSubagents,
    pinnedSubagents,
    focusedSubagent,
    setViewer,
    forkingId,
    caps,
    editingMessageId,
    compacting,
    modelMetadataLoadedRef,
    modelMetadataRequestRef,
    metadataGenRef,
    setModels,
    setLevels,
    metadataBackendRef,
    commandsLoadedRef,
    commandRequestRef,
    setCommands,
    setWorkspaceTab,
    setWorkspaceMounted,
    setWorkspaceOpen,
    workspaceReveal,
    setWorkspacePlacement,
    workspaceOpen,
    draft,
    commandMenuOpen,
    usageRequestRef,
    setProviderUsage,
    accessMode,
    agentMode,
    usageRefreshPendingRef,
    queueFromEventRef,
    setQueued,
    setConversationLabel,
    scrollRef,
    stickToBottom,
    setAttachments,
    dragCounterRef,
    setDragActive,
    setConversationWorkspace,
    setAgentMode,
    persistRoute,
    setConfiguring,
    setAccessMode,
    setOpenRoleId,
    setConversationSessionPath,
    taskSeeds,
    clearTaskSeed,
    attachments,
    sendLockRef,
    lastSendRef,
    refreshSessions,
    setCompacting,
    setRemoteQr,
    canSteer,
    steerOnceRef,
    pendingBackendRef,
    pendingModelRef,
    setPreferredModel,
    setCommandMenuOpen,
    modeMenuOpen,
    modeMenuRef,
    setModeMenuOpen,
    modelMenuOpen,
    modelMenuRef,
    usageOpen,
    usagePopRef,
    setUsageOpen,
    commands,
    caret,
    mentionMatches,
    setMentionMatches,
    setMentionIndex,
    setCaret,
    mentionIndex,
    setSlashIndex,
    slashIndex,
    models,
    pickerBackend,
    pickerModels,
    modelQuery,
    levels,
    pickerLevels,
    modelIndex,
    setPickerModels,
    setPickerLevels,
    setModelQuery,
    setModelIndex,
    setAgentNote,
    modelSearchRef,
    backendIds,
    setPickerBackend,
    setForkingId,
    openForkedConversation,
    narrow,
    workspacePickerRef,
    dragActive,
    queued,
    fileInputRef,
    effortHover,
    setEffortHover,
    backendUsage,
    currentReset,
    workspaceMounted,
    workspacePlacement,
    workspaceTab,
    boardOpen,
    setBoardOpen,
    awaitingKeys,
    sessionDetailsOpen,
    setSessionDetailsOpen,
    setRenameDraft,
    setRenaming,
    renameDraft,
    renaming,
    conversationView,
    setConversationView,
    openRoleId,
    viewer,
    turnOpen,
    reviews,
    revealConversation,
    remoteQr,
  };
}
