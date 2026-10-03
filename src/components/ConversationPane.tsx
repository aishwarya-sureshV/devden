// The scrolling conversation column: route chain, timeline rows, thinking
// row, subagent waits and the docked composer. Pure view over Conversation's state.
import type * as React from "react";
import type { RewindFilesResult } from "../lib/api";
import { RouteChainStrip } from "./RouteChainStrip";
import {
  turnKey,
  isTurnComplete,
  isTurnLogOpen,
  turnBodyItems,
  turnSummaryItems,
  turnUserItems,
  turnEndedAt,
} from "../lib/turnFold";
import { turnChangedFiles, TurnFoldBar, TurnFilesCard } from "./TurnFoldBar";
import { statsForTurn } from "../lib/turnReview";
import { groupTranscriptRows } from "../lib/toolRow";
import { ExploredRows } from "./ToolCard";
import { RouteHandoffCard } from "./RouteHandoffCard";
import { ReviewCard } from "./ReviewCard";
import { TodoTranscript } from "./TodoTracker";
import {
  SubagentWaitRow,
  ThinkingRow,
  turnStartedAt,
} from "./ConversationRows";
import { ActiveRunIndicator } from "./ToolActivity";
import { Trajectory } from "./Trajectory";
import { BackendLog } from "./BackendLog";
import type { AgentMode } from "./conversationHelpers";
import type { SessionRoute } from "../lib/route";
import type { SessionView } from "./SessionHeader";
import type {
  TimelineItem,
  MessageUsage,
  Timeline,
} from "../lib/timeline";
import type { ConversationTab } from "../lib/store";
import type { ToolFileView } from "../lib/toolCards";
import type { AgentBackend } from "../lib/api";
import type { TodoTask } from "../lib/todos";
import type { SubagentRun } from "../lib/subagents";

export type ConversationPaneProps = {
  conversationRef: React.RefObject<HTMLDivElement | null>;
  dropZoneProps: {
    onDragEnter: (event: React.DragEvent<Element>) => void;
    onDragOver: (event: React.DragEvent<Element>) => void;
    onDragLeave: (event: React.DragEvent<Element>) => void;
    onDrop: (event: React.DragEvent<Element>) => void;
  };
  routeOverlay: React.JSX.Element | null;
  agentMode: AgentMode;
  route: SessionRoute;
  openRoleId: string | null;
  setOpenRoleId: React.Dispatch<React.SetStateAction<string | null>>;
  setRoutePicking: React.Dispatch<React.SetStateAction<boolean>>;
  conversationView: SessionView;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  chatTurns: TimelineItem[][];
  streaming: boolean;
  turnOpen: Record<string, boolean>;
  renderTimelineItem: (
    item: TimelineItem,
    extras?:
      | {
          repeat?: number | undefined;
          expandDiff?: boolean | undefined;
          beforeActions?: React.ReactNode;
        }
      | undefined,
  ) => React.JSX.Element;
  setTurnOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  tab: ConversationTab;
  openFileView: (view: ToolFileView) => void;
  onRewindFiles: (timestamp: number) => Promise<RewindFilesResult>;
  latestChangedTurn: number;
  hasItems: true;
  reviews: {
    id: string;
    backend: AgentBackend;
    integrityKey: string;
    taskKey: string;
  }[];
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  revealConversation: (key: string) => void;
  onSessionSplit: ((key: string) => void) | undefined;
  closeConversation: (key: string) => void;
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
  todos: TodoTask[];
  subagentRuns: SubagentRun[];
  runningShell:
    | {
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
      }
    | undefined;
  interrupt: () => void;
  showThinkingIndicator: boolean;
  visibleItems: TimelineItem[];
  timeline: Timeline;
  composer: React.JSX.Element;
  dropOverlay: React.JSX.Element | null;
};

export function ConversationPane({
  conversationRef,
  dropZoneProps,
  routeOverlay,
  agentMode,
  route,
  openRoleId,
  setOpenRoleId,
  setRoutePicking,
  conversationView,
  scrollRef,
  onScroll,
  chatTurns,
  streaming,
  turnOpen,
  renderTimelineItem,
  setTurnOpen,
  tab,
  openFileView,
  onRewindFiles,
  latestChangedTurn,
  hasItems,
  reviews,
  setDraft,
  revealConversation,
  onSessionSplit,
  closeConversation,
  setReviews,
  todos,
  subagentRuns,
  runningShell,
  interrupt,
  showThinkingIndicator,
  visibleItems,
  timeline,
  composer,
  dropOverlay,
}: ConversationPaneProps) {
  return (
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
              const user = turn.find((item) => item.kind === "user");
              const filesCard = !live && complete && changedFiles.length > 0 && (
                <TurnFilesCard
                  files={changedFiles}
                  onOpenFile={openFileView}
                  latest={turnIndex === latestChangedTurn}
                  onUndo={
                    user && turnIndex === chatTurns.length - 1 && !streaming
                      ? () => onRewindFiles(user.timestamp)
                      : undefined
                  }
                />
              );
              // The card sits inside the final reply, above its copy/fork row.
              const cardHost = filesCard
                ? bodyItems.findLast((item) => item.kind === "assistant")
                : undefined;
              return (
                <div
                  className="chat-turn"
                  key={id || turnIndex}
                  data-current-prompt={
                    turnIndex === chatTurns.length - 1 && user
                      ? `${id}:${user.versionIndex ?? 0}`
                      : undefined
                  }
                >
                  {turnUserItems(turn).map((item) => renderTimelineItem(item))}
                  {showFold && stats && (
                    <TurnFoldBar
                      durationMs={stats.durationMs}
                      endedAt={turnEndedAt(turn)}
                      toolCount={stats.toolCount}
                      fileCount={changedFiles.length || stats.fileCount}
                      failedCount={
                        turn.filter(
                          (entry) =>
                            entry.kind === "tool" && entry.status === "error",
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
                        beforeActions:
                          block.item === cardHost ? filesCard : undefined,
                      })
                    ),
                  )}
                  {filesCard && !cardHost && filesCard}
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
              <ActiveRunIndicator item={runningShell} onInterrupt={interrupt} />
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
            <div className="conversation__spacer" aria-hidden="true" />
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
  );
}
