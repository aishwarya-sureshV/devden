import {
  Activity,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  api,
  type AgentBackend,
  type RewindFilesResult,
} from "../lib/api";
import type {
  Attachment,
  ConversationTab,
  TaskSeed,
} from "../lib/store";
import type { TimelineItem } from "../lib/timeline";
import { SubagentPanel } from "./SubagentPanel";
import type {
  ToolFileView,
} from "../lib/toolCards";
import { FileViewer } from "./FileViewer";
import { RouteChainStrip } from "./RouteChainStrip";
import { RouteRolePane } from "./RouteRolePane";
import type { PaneDensity } from "../lib/sessionLayout";
import {
  FishLogo,
} from "./icons";
import type {
  AccessMode,
  AgentMode,
} from "./conversationHelpers";
import { ConversationComposer } from "./ConversationComposer";
import {
  send as sendImpl,
  resendEdited as resendEditedImpl,
  selectUserVersion as selectUserVersionImpl,
} from "./conversationSend";
import {
  switchAgentMode as switchAgentModeImpl,
  configureSession as configureSessionImpl,
} from "./conversationModel";
import {
  isolateSession as isolateSessionImpl,
  forkOutput as forkOutputImpl,
  stopTurn,
} from "./conversationSession";
import { useModelPicker } from "./useModelPicker";
import { useSessionStatus } from "./useSessionStatus";
import { useComposerMenus } from "./useComposerMenus";
import { useSessionSync } from "./useSessionSync";
import { useUsageRefresh } from "./useUsageRefresh";
import { useAgentIssue } from "./useAgentIssue";
import { AgentConnect } from "./AgentConnect";
import { composeUsageStatus } from "../lib/backendUsage.ts";
import { useWorkspacePane } from "./useWorkspacePane";
import { useModelMetadata } from "./useModelMetadata";
import { useTimelineRows } from "./useTimelineRows";
import { useSessionView } from "./useSessionView";
import { useSessionChrome } from "./useSessionChrome";
import { useConversationPanels } from "./useConversationPanels";
import { useComposerOverlays } from "./useComposerOverlays";
import { useFileDrop } from "./useFileDrop";
import { useConversationState } from "./useConversationState";
import { ConversationPane } from "./ConversationPane";
import { useEffortFloor, useProsecutorCase } from "./useProsecutorCase";
import { effortFloor as floorFor } from "../lib/prosecutorEffort";

export function Conversation({
  tab,
  showThinking = false,
  split = false,
  density = "full",
  sessionCount = 1,
  headerHost = null,
  tabHost = null,
  focused = true,
  visible = true,
  onClose,
  onFocus,
  onBack,
  sharedWorkspaceOpen = false,
  onSharedWorkspaceToggle,
  onSharedWorkspaceOpen,
  sharedBoardOpen = false,
  onSharedBoardToggle,
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
  tabHost?: HTMLElement | null;
  focused?: boolean;
  visible?: boolean;
  onClose?: () => void;
  onFocus?: () => void;
  /** Present while this session is maximized out of a split view. */
  onBack?: () => void;
  /** Split view: one workspace pane on the right serves every session. */
  sharedWorkspaceOpen?: boolean;
  onSharedWorkspaceToggle?: () => void;
  onSharedWorkspaceOpen?: (tab?: "files" | "changes") => void;
  sharedBoardOpen?: boolean;
  onSharedBoardToggle?: () => void;
  onSessionSplit?: (key: string) => void;
  terminalOpen?: boolean;
  onTerminalToggle?: () => void;
  reviewTitle?: string | null;
  dockMulti?: boolean;
  onOpenReview?: (view: ToolFileView) => void;
}) {
  const {
    route, setRoutePicking, awaitingRoute, textareaRef, timeline, state,
    resumeSessions, setModelMenuOpen, configuring, setDefaultBackend,
    setConversationBackend, reviewStarting, setReviewStarting, setReviews,
    openConversation, closeConversation, setDraft, conversationRef, setNarrow,
    providerUsage, setTurnOpen, setEditingMessageId, setHiddenSubagents,
    setPinnedSubagents, setFocusedSubagent, seenRunningSubagents,
    hiddenSubagents, pinnedSubagents, focusedSubagent, setViewer, forkingId,
    caps, editingMessageId, compacting, modelMetadataLoadedRef,
    modelMetadataRequestRef, metadataGenRef, setModels, setLevels,
    metadataBackendRef, commandsLoadedRef, commandRequestRef, setCommands,
    setWorkspaceTab, setWorkspaceMounted, setWorkspaceOpen, workspaceReveal,
    setWorkspacePlacement, workspaceOpen, draft, commandMenuOpen,
    usageRequestRef, setProviderUsage, accessMode, agentMode,
    usageRefreshPendingRef, queueFromEventRef, setQueued, setConversationLabel,
    scrollRef, stickToBottom, setAttachments, dragCounterRef, setDragActive,
    setConversationWorkspace, setAgentMode, persistRoute, setConfiguring,
    setAccessMode, setOpenRoleId, setConversationSessionPath, taskSeeds,
    clearTaskSeed, attachments, sendLockRef, lastSendRef, refreshSessions,
    setCompacting, setRemoteQr, canSteer, steerOnceRef, pendingBackendRef,
    pendingModelRef, setPreferredModel, setCommandMenuOpen, modeMenuOpen,
    modeMenuRef, setModeMenuOpen, modelMenuOpen, modelMenuRef, usageOpen,
    usagePopRef, setUsageOpen, commands, caret, mentionMatches,
    setMentionMatches, setMentionIndex, setCaret, mentionIndex, setSlashIndex,
    slashIndex, models, pickerBackend, pickerModels, modelQuery, levels,
    pickerLevels, modelIndex, setPickerModels, setPickerLevels, setModelQuery,
    setModelIndex, setAgentNote, modelSearchRef, backendIds, setPickerBackend,
    setForkingId, openForkedConversation, narrow, workspacePickerRef,
    dragActive, queued, fileInputRef, effortHover, setEffortHover,
    backendUsage, backendUsageFetchedAt, currentReset, workspaceMounted, workspacePlacement,
    workspaceTab, boardOpen, setBoardOpen, awaitingKeys, sessionDetailsOpen,
    setSessionDetailsOpen, setRenameDraft, setRenaming, renameDraft, renaming,
    conversationView, setConversationView, openRoleId, viewer, turnOpen,
    reviews, revealConversation, remoteQr, backendCatalog, defaultBackend,
    refreshBackendCatalog,
  } = useConversationState({
    tab, visible,
  });

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

  const {
    subagentRuns, visibleItems, streaming, subagentChildren, subagentBusy,
    mirrorsChildWork, subagentRunning, showingLiveText, liveTextStalled,
    status, limitTurn, limitWindow, setExactContext, displayTitle, hasItems,
    context, pendingHandoffRef, transcriptBackendRef, thin, switchBackend,
    startTurnReview, todos, limitVisible, agentBusy, usageSinceRef, reported,
    estimated, exactContext, firstUserItem, chatTurns, latestChangedTurn,
  } = useSessionView({
    timeline, state, tab, resumeSessions, split, density, setModelMenuOpen,
    configuring, setDefaultBackend, setConversationBackend,
    setConversationSessionPath, reviewStarting,
    setReviewStarting, setReviews, openConversation, closeConversation,
    setDraft, conversationRef, setNarrow, providerUsage, showThinking,
    setTurnOpen,
  });
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
  const {
    lastAssistantId, openFileView, sessionPaths, renderTimelineItem,
    runningShell, showThinkingIndicator, openSubagents, stableRowHandlers,
  } = useTimelineRows({
    rowHandlersRef, setHiddenSubagents, setPinnedSubagents,
    seenRunningSubagents, tab, subagentRuns, hiddenSubagents, pinnedSubagents,
    focusedSubagent, setFocusedSubagent, visibleItems, streaming, timeline,
    onOpenReview, setViewer, reviewTitle, dockMulti, subagentChildren,
    forkingId, caps, editingMessageId, subagentBusy, mirrorsChildWork,
    subagentRunning, compacting, showingLiveText, liveTextStalled,
  });

  const {
    loadModelMetadata,
  } = useModelMetadata({
    modelMetadataLoadedRef, modelMetadataRequestRef, status, metadataGenRef,
    tab, setModels, setLevels, state, metadataBackendRef, visible,
  });

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

  const {
    openWorkspace, workspaceShown, workspaceButton, chooseWorkspacePlacement,
    closeWorkspace,
  } = useWorkspacePane({
    setWorkspaceTab, setWorkspaceMounted, setWorkspaceOpen, workspaceReveal,
    tab, setWorkspacePlacement, split, onSharedWorkspaceToggle, onSharedWorkspaceOpen,
    sharedWorkspaceOpen, workspaceOpen, draft, commandMenuOpen, loadCommands,
  });

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

  const {
    refreshUsage, resumeFromLimit, usageMeta,
  } = useUsageRefresh({
    usageRequestRef, tab, timeline, setProviderUsage, visible, limitTurn,
    accessMode, streaming, limitWindow, state, agentMode, status,
    usageRefreshPendingRef,
  });

  // This session's agent can't run (missing, signed out, switched off): one
  // card above the composer offering Reconnect and — when another agent can
  // take over — the same transcript handoff a manual backend switch uses.
  const { issue: agentIssue, dismiss: dismissAgentIssue } = useAgentIssue({
    backend: tab.backend,
    catalog: backendCatalog,
    hasItems,
    preferred: defaultBackend,
  });
  const [reconnectBackend, setReconnectBackend] = useState<AgentBackend | null>(
    null,
  );
  // Remounts the dialog on every Reconnect click so autoOpen fires again
  // after a cancelled attempt.
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const openAgentReconnect = () => {
    setReconnectBackend(tab.backend);
    setReconnectNonce((value) => value + 1);
  };
  const handoffToAgent = (next: AgentBackend) => {
    // Dismiss only once the switch landed: a failed transcript save must
    // leave the card up so the user can retry (so must a blocked no-op).
    switchBackend(next).then((switched) => switched && dismissAgentIssue(), () => {});
  };
  const usageStatus = composeUsageStatus(
    usageMeta,
    providerUsage !== null,
    backendUsage[tab.backend],
    backendUsageFetchedAt,
  );

  useSessionSync({
    queueFromEventRef, setQueued, state, tab, visible, caps, streaming,
    setExactContext, timeline, usageRefreshPendingRef, refreshUsage,
    setConversationLabel, displayTitle, scrollRef, stickToBottom, conversationView,
  });

  const {
    uploadFilesRef, onDragEnter, onDragOver, onDragLeave, onDrop, uploadFiles,
    onPasteImage, onScroll,
  } = useFileDrop({
    scrollRef, stickToBottom, timeline, tab, setAttachments, dragCounterRef,
    setDragActive, textareaRef,
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

  const configureSession = (nextAccess: AccessMode, nextMode: AgentMode, nextCwd = tab.cwd) =>
    configureSessionImpl(
      {
        tab, hasItems, timeline, setConversationWorkspace, openWorkspace,
        setAgentMode, persistRoute, route, setRoutePicking, setConfiguring,
        state, setAccessMode,
      },
      nextAccess,
      nextMode,
      nextCwd,
    );

  // Plan/auto can be switched mid-conversation: the backend restarts the agent
  // against the same session file (plan mode = different system prompt + tool
  // allowlist, which only apply at spawn time), so the transcript is reloaded
  // from the persisted session afterwards.
  const switchAgentMode = (nextMode: AgentMode, silent = false) =>
    switchAgentModeImpl(
      {
        agentMode, hasItems, switchAgentMode, configureSession, accessMode,
        setAgentMode, persistRoute, route, setRoutePicking, setOpenRoleId,
        configuring, streaming, timeline, state, setConfiguring, tab,
        setConversationSessionPath,
      },
      nextMode,
      silent,
    );

  // Edit + resend: rewind the backend to just before the chosen message (the
  // server branches the session file there), record the edit as the newest
  // version of that message, then send the new prompt over the trimmed context.
  const resendEdited = (itemId: string, text: string) =>
    resendEditedImpl(
      {
        timeline, streaming, state, tab, setConversationSessionPath,
        stickToBottom,
      },
      itemId,
      text,
    );

  // Claude-Code-style ‹ › navigation: rebind the backend to the session file
  // that contains the chosen version, rewound to just before its prompt.
  const selectUserVersion = (item: Extract<TimelineItem, { kind: "user" }>, targetIndex: number) =>
    selectUserVersionImpl(
      {
        streaming, editingMessageId, tab, timeline, setConversationSessionPath,
      },
      item,
      targetIndex,
    );

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

  const send = (raw: string, seedAttachments?: Attachment[], opts?: { answersAsk?: boolean }) =>
    sendImpl(
      {
        accessMode, awaitingRoute, attachments, sendLockRef, lastSendRef,
        editingMessageId, timeline, setDraft, setEditingMessageId,
        resendEdited, tab, setConversationSessionPath, refreshSessions, caps,
        compacting, setCompacting, state, refreshUsage, displayTitle, context,
        setViewer, forkOutput, setRemoteQr, setAttachments, stickToBottom,
        streaming, canSteer, steerOnceRef, lastAssistantId, visibleItems,
        pendingBackendRef, pendingModelRef, pendingHandoffRef, agentMode,
        transcriptBackendRef, route,
      },
      raw,
      seedAttachments,
      opts,
    );

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
  const {
    autoGrow, mentionOpen, applyMention, slashOpen, slashMatches, onKeyDown,
  } = useComposerMenus({
    caps, commands, draft, caret, mentionMatches, setMentionMatches, tab,
    setMentionIndex, commandMenuOpen, setDraft, textareaRef, setCaret,
    agentMode, switchAgentMode, streaming, steerOnceRef, canSteer, send,
    mentionIndex, setSlashIndex, slashIndex, setCommandMenuOpen,
    editingMessageId, setEditingMessageId, thin,
  });

  const prosecutorCase = useProsecutorCase(
    tab.key,
    agentMode === "prosecutor",
    tab.sessionPath ?? tab.timeline.state?.sessionFile,
  );
  const effortFloor = floorFor(agentMode, prosecutorCase);
  const {
    browseBackend, currentModelLabel, effort, trackLevels, supportedLevels,
    visibleOptions,
    currentModel, pickListedModel, setEffort, onModelMenuKey,
    contextChoices, currentContext, defaultContext, onContext,
  } = useModelPicker({
    effortFloor, models, tab, state, timeline, setLevels, setPreferredModel, refreshUsage,
    pickerBackend, pickerModels, modelQuery, levels, pickerLevels, modelIndex,
    setModelMenuOpen, pendingModelRef, pendingBackendRef, switchBackend,
    modelMenuOpen, setPickerModels, setPickerLevels, setModelQuery,
    setModelIndex, setAgentNote, modelSearchRef, backendIds, setPickerBackend,
  });
  useEffortFloor(effortFloor, levels, effort, setEffort);

  const interrupt = useCallback(() => {
    void stopTurn(tab.key, timeline);
  }, [tab.key, timeline]);

  /**
   * Move this session into its own checkout. Snapshots, the Changes panel and
   * every git op already key off the tab's cwd, so repointing it is the whole
   * of the isolation -- no backend knows or needs to know.
   */
  const isolateSession = () =>
    isolateSessionImpl({ tab, timeline, setConversationWorkspace });

  const forkOutput = (item: Extract<TimelineItem, { kind: "assistant" }>) =>
    forkOutputImpl(
      {
        forkingId, timeline, setForkingId, tab, state, accessMode, agentMode,
        openForkedConversation, refreshSessions, onSessionSplit,
      },
      item,
    );

  const {
    tight, setupChips, pickRoute, dropZoneProps, dropOverlay,
  } = useComposerOverlays({
    thin, narrow, hasItems, workspacePickerRef, tab, configuring,
    configureSession, accessMode, agentMode, isolateSession, openWorkspace,
    split, workspaceShown, workspaceButton, onDragEnter, onDragOver,
    onDragLeave, onDrop, dragActive, route, persistRoute, setRoutePicking,
    textareaRef,
  });

  const routeOverlay = awaitingRoute ? (
    <div
      className="route-overlay"
      role="presentation"
      onClick={dismissRoutePick}
    />
  ) : null;

  const composer = (
    <ConversationComposer
      contextUsage={{ percent: hasItems ? reported?.percent ?? (caps.contextUsage ? null : estimated.percent) : 0, label: !hasItems ? "This session · no messages yet" : !reported && caps.contextUsage ? "Context usage unavailable" : `${reported ? "" : "Estimated · "}${context.estimatedTokens.toLocaleString()} / ${context.contextWindow.toLocaleString()} tokens · this session` }}
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
        backendIds, currentModelLabel, effort, trackLevels, supportedLevels,
        effortHover, effortFloor, prosecutorCase,
        visibleOptions, modelIndex, modelQuery, currentModel, setUsageOpen,
        setModeMenuOpen, setModelMenuOpen, setPickerBackend, setModelQuery,
        setModelIndex, pickListedModel, setEffort, setEffortHover,
        contextChoices, currentContext, defaultContext, onContext,
        onModelMenuKey, loadModelMetadata, modeMenuRef, modeMenuOpen,
        switchAgentMode, dismissRoutePick, usagePopRef, usageOpen,
        providerUsage, backendUsage, currentReset, agentBusy,
        agentIssue, onAgentIssueReconnect: openAgentReconnect,
        onAgentIssueHandoff: handoffToAgent, onAgentIssueDismiss: dismissAgentIssue,
        usageStatus,
      }}
    />
  );

  const {
    workspaceExplorer, boardPanel, selectionTools,
  } = useConversationPanels({
    chooseWorkspacePlacement, tab, setDraft, setAttachments, textareaRef,
    workspaceMounted: workspaceMounted && !onSharedWorkspaceToggle, workspaceOpen, workspacePlacement, workspaceTab,
    setWorkspaceTab, closeWorkspace, boardOpen: boardOpen && !onSharedBoardToggle, setBoardOpen,
  });

  const {
    statusLabel, statusTone, branchLabel, contextLabel, usageLabel, paneTone,
    running,
  } = useSessionStatus({
    awaitingKeys, tab, agentMode, status, streaming, focused, timeline,
    usageSinceRef, sessionDetailsOpen, hasItems, reported, caps, estimated,
    exactContext,
  });
  const {
    sessionChrome,
  } = useSessionChrome({
    tab, setSessionDetailsOpen, firstUserItem, setRenameDraft, state,
    setRenaming, renameDraft, displayTitle, split, sessionCount, onBack,
    renaming, sessionDetailsOpen, statusLabel, statusTone, branchLabel,
    contextLabel, usageLabel, conversationView, setConversationView,
    terminalOpen, onTerminalToggle, workspaceShown, workspaceButton, boardOpen: onSharedBoardToggle ? sharedBoardOpen : boardOpen,
    setBoardOpen, onBoardToggle: onSharedBoardToggle, focused, headerHost, status, paneTone, running, onFocus,
    onClose, currentModelLabel, effort, tabHost, contextPercent: hasItems ? reported?.percent ?? (caps.contextUsage ? null : estimated.percent) : 0,
    configuring: configuring || streaming, onPickWorkspace: path => configureSession(accessMode, agentMode, path),
  });

  if (!hasItems) {
    return (
      <>
        {sessionChrome}
      <Activity mode={visible ? "visible" : "hidden"}>
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
      </>
    );
  }

  const conversationPane = (
    <ConversationPane
      {...{
        conversationRef, dropZoneProps, routeOverlay, agentMode, route,
        openRoleId, setOpenRoleId, setRoutePicking, conversationView,
        scrollRef, onScroll, chatTurns, streaming, turnOpen,
        renderTimelineItem, setTurnOpen, tab, openFileView,
        onRewindFiles: (timestamp: number) =>
          rowHandlersRef.current.onRewindFiles(timestamp, false),
        latestChangedTurn, hasItems, reviews, setDraft, revealConversation,
        onSessionSplit, closeConversation, setReviews, todos, subagentRuns,
        runningShell, interrupt, showThinkingIndicator, visibleItems,
        timeline, composer, dropOverlay,
      }}
    />
  );

  return (
    <>
      {sessionChrome}
    <Activity mode={visible ? "visible" : "hidden"}>

      <div className="conversation-stage" data-backend={tab.backend}>
        {conversationPane}
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
      {reconnectBackend &&
        (() => {
          const row = backendCatalog.find(
            (entry) => entry.id === reconnectBackend,
          );
          if (!row) return null;
          return (
            <AgentConnect
              key={`${reconnectBackend}:${reconnectNonce}`}
              agent={row}
              autoOpen
              hideButton
              onConnected={(backends) => void refreshBackendCatalog(backends)}
            />
          );
        })()}
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
    </>
  );
}
