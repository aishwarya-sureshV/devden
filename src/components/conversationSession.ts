// Session-level actions for Conversation: isolate into a worktree, fork the
// output into a new session.
import type * as React from "react";
import {
  api,
  type SessionState,
  type SessionHistoryMessage,
  type AgentBackend,
} from "../lib/api";
import type { TimelineItem, Timeline } from "../lib/timeline";
import {
  promptIndexAtAssistant,
  userTextBeforeAssistant,
  type AccessMode,
  type AgentMode,
} from "./conversationHelpers";
import type { ConversationTab } from "../lib/store";

export type IsolateSessionCtx = {
  tab: ConversationTab;
  timeline: Timeline;
  setConversationWorkspace: (key: string, cwd: string) => void;
};

/**
 * Move this session into its own checkout. Snapshots, the Changes panel and
 * every git op already key off the tab's cwd, so repointing it is the whole
 * of the isolation -- no backend knows or needs to know.
 */
export async function isolateSession(ctx: IsolateSessionCtx) {
  const { tab, timeline, setConversationWorkspace } = ctx;
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
}

export type ForkOutputCtx = {
  forkingId: string | null;
  timeline: Timeline;
  setForkingId: React.Dispatch<React.SetStateAction<string | null>>;
  tab: ConversationTab;
  state: SessionState | null;
  accessMode: AccessMode;
  agentMode: AgentMode;
  openForkedConversation: (args: {
    cwd: string;
    sessionPath: string;
    messages: SessionHistoryMessage[];
    state?: SessionState | null | undefined;
    label?: string | undefined;
    backend?: AgentBackend | undefined;
    accessMode?: "workspace-write" | "read-only" | undefined;
    agentMode?:
      | "standard"
      | "plan"
      | "routed"
      | "manual"
      | "auto-edit"
      | undefined;
  }) => string;
  refreshSessions: () => void;
  onSessionSplit: ((key: string) => void) | undefined;
};

export async function forkOutput(
  ctx: ForkOutputCtx,
  item: Extract<TimelineItem, { kind: "assistant" }>,
) {
  const {
    forkingId,
    timeline,
    setForkingId,
    tab,
    state,
    accessMode,
    agentMode,
    openForkedConversation,
    refreshSessions,
    onSessionSplit,
  } = ctx;
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
}
