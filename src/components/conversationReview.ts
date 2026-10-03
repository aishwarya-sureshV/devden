// Post-turn review for Conversation: diff collection, review launch in a
// fresh session, and the transcript export used alongside it.
import type * as React from "react";
import {
  type AgentBackend,
  api,
  backendLabel,
  type SessionState,
} from "../lib/api";
import {
  lastUserRequest,
  lastUserTimestamp,
  turnStats,
  partitionUnifiedDiff,
  formatReviewHunks,
  scanPrechecks,
  integrityPrompt,
  taskPrompt,
} from "../lib/turnReview";
import { collectReviewDiff, capText } from "./conversationHelpers";
import {
  BACKEND_DEFAULT_EFFORT,
  type ConversationTab,
  type OpenConversationOptions,
} from "../lib/store";
import { timelineToMarkdown, transcriptFilename } from "../lib/exportSession";
import type { TimelineItem, Timeline } from "../lib/timeline";
import type { TodoTask } from "../lib/todos";

export type StartTurnReviewCtx = {
  reviewStarting: AgentBackend | null;
  streaming: boolean;
  tab: ConversationTab;
  visibleItems: TimelineItem[];
  timeline: Timeline;
  setReviewStarting: React.Dispatch<React.SetStateAction<AgentBackend | null>>;
  launchReviewSession: (args: {
    backend: AgentBackend;
    cwd: string;
    label: string;
    prompt: string;
  }) => Promise<{ key: string } | { error: string }>;
  displayTitle: string;
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
};

export async function startTurnReview(
  ctx: StartTurnReviewCtx,
  backend: AgentBackend,
) {
  const {
    reviewStarting,
    streaming,
    tab,
    visibleItems,
    timeline,
    setReviewStarting,
    launchReviewSession,
    displayTitle,
    setReviews,
  } = ctx;
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
        integrityRun.error ?? "Integrity and task review both failed to start.",
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
}

export type LaunchReviewSessionCtx = {
  openConversation: (
    cwd: string,
    label?: string | undefined,
    backend?: AgentBackend | undefined,
    options?: OpenConversationOptions | undefined,
  ) => string;
  closeConversation: (key: string) => void;
};

export async function launchReviewSession(
  ctx: LaunchReviewSessionCtx,
  args: {
    backend: AgentBackend;
    cwd: string;
    label: string;
    prompt: string;
  },
): Promise<{ key: string } | { error: string }> {
  const { openConversation, closeConversation } = ctx;
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
        sent.error ?? `${backendLabel(args.backend)} did not take the review.`,
    };
  }
  return { key };
}

export type SaveTranscriptCtx = {
  timeline: Timeline;
  tab: ConversationTab;
  transcriptPath: string | null;
  displayTitle: string;
  state: SessionState | null;
  todos: TodoTask[];
  setTranscriptPath: React.Dispatch<React.SetStateAction<string | null>>;
};

export async function saveTranscript(
  ctx: SaveTranscriptCtx,
): Promise<string | null> {
  const {
    timeline,
    tab,
    transcriptPath,
    displayTitle,
    state,
    todos,
    setTranscriptPath,
  } = ctx;
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
          (task) => task.status === "pending" || task.status === "in_progress",
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
}
