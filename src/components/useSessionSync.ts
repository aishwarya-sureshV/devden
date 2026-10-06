// Session sync effects for Conversation: queued-message mirror, exact context
// count, settle events, tab label, and following the newest conversation turn.
import type * as React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { syncConversationScroll } from "../lib/conversationScroll";
import type { SessionView } from "./SessionHeader";
import {
  subscribeEvents,
  type QueuedMessage,
  api,
  type SessionState,
  type ContextUsageReport,
} from "../lib/api";
import type { ConversationTab } from "../lib/store";
import type { AgentCapabilities } from "../lib/agentCapabilities";
import type { Timeline } from "../lib/timeline";

export type UseSessionSyncArgs = {
  queueFromEventRef: React.RefObject<boolean>;
  setQueued: React.Dispatch<React.SetStateAction<QueuedMessage[]>>;
  state: SessionState | null;
  tab: ConversationTab;
  visible: boolean;
  caps: AgentCapabilities;
  streaming: boolean;
  setExactContext: React.Dispatch<
    React.SetStateAction<ContextUsageReport | null>
  >;
  timeline: Timeline;
  usageRefreshPendingRef: React.RefObject<boolean>;
  refreshUsage: (force?: boolean) => Promise<boolean>;
  setConversationLabel: (key: string, label: string) => void;
  displayTitle: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  stickToBottom: React.RefObject<boolean>;
  conversationView: SessionView;
};

export function useSessionSync({
  queueFromEventRef,
  setQueued,
  state,
  tab,
  visible,
  caps,
  streaming,
  setExactContext,
  timeline,
  usageRefreshPendingRef,
  refreshUsage,
  setConversationLabel,
  displayTitle,
  scrollRef,
  stickToBottom,
  conversationView,
}: UseSessionSyncArgs) {
  const lastPrompt = useRef("");
  const [contextRevision, setContextRevision] = useState(0);
  useEffect(() => { setExactContext(null); }, [tab.key, tab.backend, tab.sessionPath]);
  useEffect(() => subscribeEvents(event => {
    if (event.sessionKey !== tab.key) return;
    if (event.type === "agent_start" || event.type === "compaction_end") setExactContext(null);
    if (event.type === "agent_settled" || event.type === "compaction_end")
      setContextRevision(value => value + 1);
  }), [tab.key]);
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
    const refreshContext = () => {
      void api
        .contextUsage(tab.key)
        .then((result) => {
          if (!cancelled)
            setExactContext(result.ok && result.data ? result.data : null);
        })
        .catch(() => {
          if (!cancelled) setExactContext(null);
        });
    };
    const timer = window.setTimeout(refreshContext, 1200);
    const interval = streaming ? window.setInterval(refreshContext, 3000) : undefined;
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [
    caps.contextUsage,
    tab.key,
    tab.backend,
    tab.sessionPath,
    streaming,
    timeline.items.length,
    visible,
    contextRevision,
    timeline.state?.model?.contextWindow,
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

  // New prompts start at the top. Replies follow the tail only while the
  // reader stays there; scrolling up leaves the retained history in place.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (visible && el) syncConversationScroll(el, stickToBottom, lastPrompt);
  });

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const column = el?.querySelector(".conversation__column");
    if (!visible || !el || !column) return;
    // Also covers composer/window resizing and images loading after render.
    const observer = new ResizeObserver(() =>
      syncConversationScroll(el, stickToBottom, lastPrompt),
    );
    observer.observe(el);
    observer.observe(column);
    return () => observer.disconnect();
  }, [visible, conversationView, timeline.items.length > 0]);

  return {};
}
