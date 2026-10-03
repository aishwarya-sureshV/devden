// Timeline rendering for Conversation: memoized row handlers, subagent
// open/pin state, response actions, renderTimelineItem and the thinking row.
import type * as React from "react";
import { useMemo, useEffect } from "react";
import type {
  TimelineItem,
  MessageUsage,
  UserMessageVersion,
  Timeline,
} from "../lib/timeline";
import type { RewindFilesResult } from "../lib/api";
import {
  getResponseActionIds,
  lastAnswerableAssistantId,
} from "./conversationHelpers";
import { turnChangedFiles } from "./TurnFoldBar";
import type { ToolFileView } from "../lib/toolCards";
import { TimelineRow } from "./ConversationRows";
import {
  isHeldMainTool,
  isSubagentToolEcho,
  type SubagentRun,
} from "../lib/subagents";
import { shouldShowThinkingRow } from "../lib/thinkingRow";
import type { ConversationTab } from "../lib/store";
import type { AgentCapabilities } from "../lib/agentCapabilities";

export type UseTimelineRowsArgs = {
  rowHandlersRef: React.RefObject<{
    onFork: (_item: {
      id: string;
      kind: "assistant";
      text: string;
      live: boolean;
      timestamp: number;
      provider?: string | undefined;
      modelId?: string | undefined;
      usage?: MessageUsage | undefined;
      parentToolUseId?: string | undefined;
    }) => void;
    onRewindFiles: (
      _timestamp: number,
      _dryRun: boolean,
    ) => Promise<RewindFilesResult>;
    onEditMessage: (_item: {
      id: string;
      kind: "user";
      text: string;
      images?: string[] | undefined;
      timestamp: number;
      versions?: UserMessageVersion[] | undefined;
      versionIndex?: number | undefined;
    }) => void;
    onCancelEdit: () => void;
    onVersionChange: (
      _item: {
        id: string;
        kind: "user";
        text: string;
        images?: string[] | undefined;
        timestamp: number;
        versions?: UserMessageVersion[] | undefined;
        versionIndex?: number | undefined;
      },
      _index: number,
    ) => void;
    onAnswer: (_text: string) => void;
    onOpenSubagent: (_id: string) => void;
    onBackgroundSubagent: (_id: string) => void;
    onStopTerminal: (_tabId: string) => void;
  }>;
  setHiddenSubagents: React.Dispatch<React.SetStateAction<string[]>>;
  setPinnedSubagents: React.Dispatch<React.SetStateAction<string[]>>;
  seenRunningSubagents: React.RefObject<Set<string>>;
  tab: ConversationTab;
  subagentRuns: SubagentRun[];
  hiddenSubagents: string[];
  pinnedSubagents: string[];
  focusedSubagent: string | null;
  setFocusedSubagent: React.Dispatch<React.SetStateAction<string | null>>;
  visibleItems: TimelineItem[];
  streaming: boolean;
  timeline: Timeline;
  onOpenReview: ((view: ToolFileView) => void) | undefined;
  setViewer: React.Dispatch<React.SetStateAction<ToolFileView | null>>;
  reviewTitle: string | null;
  dockMulti: boolean;
  subagentChildren: Map<
    string,
    {
      id: string;
      kind: "tool";
      name: string;
      args: Record<string, unknown>;
      details: Record<string, unknown>;
      output: string;
      status: "running" | "done" | "error";
      startedAt: number;
      elapsed?: number | undefined;
      execKind?: string | undefined;
      parentToolUseId?: string | undefined;
      usage?: MessageUsage | undefined;
    }[]
  >;
  forkingId: string | null;
  caps: AgentCapabilities;
  editingMessageId: string | null;
  subagentBusy: boolean;
  mirrorsChildWork: boolean;
  subagentRunning: boolean;
  compacting: boolean;
  showingLiveText: boolean;
  liveTextStalled: boolean;
};

export function useTimelineRows({
  rowHandlersRef,
  setHiddenSubagents,
  setPinnedSubagents,
  seenRunningSubagents,
  tab,
  subagentRuns,
  hiddenSubagents,
  pinnedSubagents,
  focusedSubagent,
  setFocusedSubagent,
  visibleItems,
  streaming,
  timeline,
  onOpenReview,
  setViewer,
  reviewTitle,
  dockMulti,
  subagentChildren,
  forkingId,
  caps,
  editingMessageId,
  subagentBusy,
  mirrorsChildWork,
  subagentRunning,
  compacting,
  showingLiveText,
  liveTextStalled,
}: UseTimelineRowsArgs) {
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
    extras?: { repeat?: number; expandDiff?: boolean; beforeActions?: React.ReactNode },
  ) => (
    <TimelineRow
      key={item.id}
      item={item}
      repeat={extras?.repeat}
      expandDiff={extras?.expandDiff}
      beforeActions={extras?.beforeActions}
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

  return {
    lastAssistantId,
    openFileView,
    sessionPaths,
    renderTimelineItem,
    runningShell,
    showThinkingIndicator,
    openSubagents,
    stableRowHandlers,
  };
}
