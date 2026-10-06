// Provider usage for Conversation: refresh on load, poll while running, recheck
// when a usage limit lands, and resume once the window resets.
import type * as React from "react";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  type ProviderUsage,
  type UsageWindow,
  type SessionState,
  type RunStatus,
} from "../lib/api";
import type { UsageStatus } from "../lib/backendUsage.ts";
import { resumeFromLimit as resumeFromLimitImpl } from "./conversationSend";
import {
  USAGE_RUNNING_REFRESH_INTERVAL_MS,
  USAGE_IDLE_REFRESH_INTERVAL_MS,
  type AccessMode,
  type AgentMode,
} from "./conversationHelpers";
import type { ConversationTab } from "../lib/store";
import type { Timeline } from "../lib/timeline";
import type { LimitTurn } from "../lib/usageLimit";

export type UseUsageRefreshArgs = {
  usageRequestRef: React.RefObject<Promise<boolean> | null>;
  tab: ConversationTab;
  timeline: Timeline;
  setProviderUsage: React.Dispatch<React.SetStateAction<ProviderUsage | null>>;
  visible: boolean;
  limitTurn: LimitTurn | undefined;
  accessMode: AccessMode;
  streaming: boolean;
  limitWindow: UsageWindow | undefined;
  state: SessionState | null;
  agentMode: AgentMode;
  status: RunStatus;
  usageRefreshPendingRef: React.RefObject<boolean>;
};

/** When the usage data was actually current — the provider's own stamp
 *  when it has one (a server-side cache can serve minutes-old numbers),
 *  else the fetch time. */
function dataTime(usage: ProviderUsage): number {
  const stamped = usage?.updatedAt ? Date.parse(usage.updatedAt) : NaN;
  return Number.isFinite(stamped) ? stamped : Date.now();
}

export function useUsageRefresh({
  usageRequestRef,
  tab,
  timeline,
  setProviderUsage,
  visible,
  limitTurn,
  accessMode,
  streaming,
  limitWindow,
  state,
  agentMode,
  status,
  usageRefreshPendingRef,
}: UseUsageRefreshArgs) {
  // Last outcome of this session's own usage fetch, so the widget can say
  // "fetch failed — updated HH:MM" instead of just going blank.
  const [usageMeta, setUsageMeta] = useState<UsageStatus>({
    at: null,
    error: null,
  });
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
          // A backend switch dropped this request: its numbers are the old agent's.
          if (usageRequestRef.current === request) {
            setProviderUsage(result.ok ? result.usage : null);
            setUsageMeta(
              result.ok
                ? { at: dataTime(result.usage), error: null }
                : (previous) => ({
                    at: previous.at,
                    error: result.error ?? "Usage is unavailable.",
                  }),
            );
          }
          return result.ok;
        })
        .catch(() => {
          if (usageRequestRef.current === request) {
            setProviderUsage(null);
            setUsageMeta((previous) => ({
              at: previous.at,
              error: "Could not reach the devden server.",
            }));
          }
          return false;
        })
        .finally(() => {
          if (usageRequestRef.current === request) usageRequestRef.current = null;
        });
      usageRequestRef.current = request;
      return request;
    },
    [tab.backend, tab.key, tab.sessionPath, timeline],
  );

  // Declared before the poll effect so it runs first: a new backend must not
  // join the old backend's in-flight request or show its quota meanwhile.
  useEffect(() => {
    usageRequestRef.current = null;
    setProviderUsage(null);
    setUsageMeta({ at: null, error: null });
  }, [tab.backend, tab.key]);

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
  const resumeFromLimit = () =>
    resumeFromLimitImpl({
      accessMode,
      limitTurn,
      streaming,
      limitWindow,
      timeline,
      tab,
      state,
      agentMode,
    });

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

  return {
    refreshUsage,
    resumeFromLimit,
    usageMeta,
  };
}
