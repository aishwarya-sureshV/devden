// Derived view state for Conversation: run status, title, todos, context
// fill, subagent activity, limit window and the visible timeline items.
import type * as React from "react";
import {
  collectSubagentRuns,
  isHeldMainTool,
  isHeldMainNarration,
  isSettledSpawnTool,
  isSubagentChatter,
  isSubagentCheckIn,
  isSubagentEcho,
  isSubagentToolEcho,
} from "../lib/subagents";
import {
  isLocalCommandText,
  contextualSessionTitle,
} from "../lib/sessionTitle";
import { extractTodos } from "./TodoTracker";
import { useState, useRef, useEffect, useMemo } from "react";
import {
  saveTranscript as saveTranscriptImpl,
  startTurnReview as startTurnReviewImpl,
  launchReviewSession as launchReviewSessionImpl,
} from "./conversationReview";
import type {
  AgentBackend,
  ContextUsageReport,
  SessionState,
  ResumeSession,
  ProviderUsage,
} from "../lib/api";
import { switchBackend as switchBackendImpl } from "./conversationModel";
import type { PendingHandoff } from "../lib/exportSession";
import { estimateContext, type ContextUsage } from "../lib/sessionMetrics";
import type { TimelineItem, Timeline } from "../lib/timeline";
import {
  pendingLimitTurn,
  exhaustedWindow,
  isUsageLimitError,
} from "../lib/usageLimit";
import { isAskMessage } from "../lib/askBlock";
import { useLiveTextStalled } from "./conversationHelpers";
import { splitTurns, turnKey } from "../lib/turnFold";
import { turnChangedFiles } from "./TurnFoldBar";
import type { ConversationTab, OpenConversationOptions } from "../lib/store";
import type { PaneDensity } from "../lib/sessionLayout";

export type UseSessionViewArgs = {
  timeline: Timeline;
  state: SessionState | null;
  tab: ConversationTab;
  resumeSessions: ResumeSession[];
  split: boolean;
  density: PaneDensity;
  setModelMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  configuring: boolean;
  setDefaultBackend: (backend: AgentBackend) => void;
  setConversationBackend: (key: string, backend: AgentBackend) => void;
  setConversationSessionPath: (key: string, path?: string) => void;
  reviewStarting: AgentBackend | null;
  setReviewStarting: React.Dispatch<React.SetStateAction<AgentBackend | null>>;
  setReviews: React.Dispatch<
    React.SetStateAction<
      {
        id: string;
        backend: AgentBackend;
        integrityKey: string;
        taskKey: string;
      }[]
    >
  >;
  openConversation: (
    cwd: string,
    label?: string | undefined,
    backend?: AgentBackend | undefined,
    options?: OpenConversationOptions | undefined,
  ) => string;
  closeConversation: (key: string) => void;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  conversationRef: React.RefObject<HTMLDivElement | null>;
  setNarrow: React.Dispatch<React.SetStateAction<boolean>>;
  providerUsage: ProviderUsage | null;
  showThinking: boolean;
  setTurnOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
};

export function useSessionView({
  timeline,
  state,
  tab,
  resumeSessions,
  split,
  density,
  setModelMenuOpen,
  configuring,
  setDefaultBackend,
  setConversationBackend,
  setConversationSessionPath,
  reviewStarting,
  setReviewStarting,
  setReviews,
  openConversation,
  closeConversation,
  setDraft,
  conversationRef,
  setNarrow,
  providerUsage,
  showThinking,
  setTurnOpen,
}: UseSessionViewArgs) {
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
  const saveTranscript = () =>
    saveTranscriptImpl({
      timeline,
      tab,
      transcriptPath,
      displayTitle,
      state,
      todos,
      setTranscriptPath,
    });
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
  const pendingHandoffRef = useRef<PendingHandoff | null>(null);
  // Stamps from the previous backend stay on the transcript. The card only
  // counts usage that happened after the switch.
  const usageSinceRef = useRef(0);
  const transcriptBackendRef = useRef<AgentBackend>(tab.backend);
  const switchBackend = (next: AgentBackend) =>
    switchBackendImpl(
      {
        setModelMenuOpen,
        tab,
        streaming,
        configuring,
        setDefaultBackend,
        transcriptBackendRef,
        usageSinceRef,
        saveTranscript,
        setConversationBackend,
        pendingHandoffRef,
        setConversationSessionPath,
        timeline,
      },
      next,
    );

  const startTurnReview = (backend: AgentBackend) =>
    startTurnReviewImpl(
      {
        reviewStarting,
        streaming,
        tab,
        visibleItems,
        timeline,
        setReviewStarting,
        launchReviewSession,
        displayTitle,
        setReviews,
      },
      backend,
    );

  const launchReviewSession = (args: {
    backend: AgentBackend;
    cwd: string;
    label: string;
    prompt: string;
  }) => launchReviewSessionImpl({ openConversation, closeConversation }, args);

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

  return {
    subagentRuns,
    visibleItems,
    streaming,
    subagentChildren,
    subagentBusy,
    mirrorsChildWork,
    subagentRunning,
    showingLiveText,
    liveTextStalled,
    status,
    limitTurn,
    limitWindow,
    setExactContext,
    displayTitle,
    hasItems,
    context,
    pendingHandoffRef,
    transcriptBackendRef,
    thin,
    switchBackend,
    startTurnReview,
    todos,
    limitVisible,
    agentBusy,
    usageSinceRef,
    reported,
    estimated,
    exactContext,
    firstUserItem,
    chatTurns,
    latestChangedTurn,
  };
}
