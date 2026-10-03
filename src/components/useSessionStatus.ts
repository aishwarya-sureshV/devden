// Session status for Conversation's header and pane chrome: run phase and
// tone, unseen-finish flag, spend and token usage, branch and context labels.
import type * as React from "react";
import type { SessionTone, PaneTone } from "./SessionHeader";
import { useState, useRef, useEffect } from "react";
import {
  usageCutoff,
  usageStamp,
  compactTokens,
  usageSummaryFromCounts,
  usageSummaryOf,
  type ContextUsage,
} from "../lib/sessionMetrics";
import { api, type RunStatus, type ContextUsageReport } from "../lib/api";
import type { ConversationTab } from "../lib/store";
import type { AgentMode } from "./conversationHelpers";
import type { Timeline } from "../lib/timeline";
import type { AgentCapabilities } from "../lib/agentCapabilities";

export type UseSessionStatusArgs = {
  awaitingKeys: ReadonlySet<string>;
  tab: ConversationTab;
  agentMode: AgentMode;
  status: RunStatus;
  streaming: boolean;
  focused: boolean;
  timeline: Timeline;
  usageSinceRef: React.RefObject<number>;
  sessionDetailsOpen: boolean;
  hasItems: boolean;
  reported: ContextUsage | null;
  caps: AgentCapabilities;
  estimated: ContextUsage;
  exactContext: ContextUsageReport | null;
};

export function useSessionStatus({
  awaitingKeys,
  tab,
  agentMode,
  status,
  streaming,
  focused,
  timeline,
  usageSinceRef,
  sessionDetailsOpen,
  hasItems,
  reported,
  caps,
  estimated,
  exactContext,
}: UseSessionStatusArgs) {
  const awaiting = awaitingKeys.has(tab.key);
  const modeLabel =
    agentMode === "plan"
      ? "Plan"
      : agentMode === "routed"
        ? "Routed"
        : agentMode === "manual"
          ? "Manual"
          : agentMode === "auto-edit"
            ? "Auto-edit"
            : "";
  const phaseLabel =
    status === "error"
      ? "Error"
      : streaming || status === "starting"
        ? "Running"
        : awaiting
          ? "Needs input"
          : "Idle";
  const statusLabel = modeLabel ? `${modeLabel} · ${phaseLabel}` : phaseLabel;
  const statusTone: SessionTone =
    status === "error"
      ? "error"
      : streaming || status === "starting"
        ? "running"
        : awaiting
          ? "waiting"
          : "idle";
  // A run that finished while the user was looking elsewhere keeps a ✓ on
  // its pane until they focus it or start the next run.
  const running = streaming || status === "starting";
  const [finishedUnseen, setFinishedUnseen] = useState(false);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (running) setFinishedUnseen(false);
    else if (wasRunning.current && !focused) setFinishedUnseen(true);
    wasRunning.current = running;
  }, [running, focused]);
  useEffect(() => {
    if (focused) setFinishedUnseen(false);
  }, [focused]);
  const paneTone: PaneTone =
    statusTone === "idle" && finishedUnseen ? "done" : statusTone;
  const usageSince = usageCutoff(timeline.items, usageSinceRef.current);
  const billedItems =
    usageSince > 0
      ? timeline.items.filter((item) => usageStamp(item) >= usageSince)
      : timeline.items;
  const spend = billedItems.reduce((sum, item) => {
    if ("usage" in item && item.usage?.cost?.total)
      return sum + item.usage.cost.total;
    return sum;
  }, 0);
  // Session usage, the number Claude CLI's /usage prints: the cumulative
  // token total across the session's assistant turns. Backends that report
  // per-message usage (Claude, Codex, Grok, pi) are summed off the live
  // timeline; backends that don't fall back to the session-file summary
  // (the same sum read off disk by readResumeSession), fetched once when
  // the details popover opens.
  const liveTokens = billedItems.reduce((sum, item) => {
    if ("usage" in item && item.usage) return sum + item.usage.totalTokens;
    return sum;
  }, 0);
  const [sessionUsageTotal, setSessionUsageTotal] = useState<number | null>(
    null,
  );
  const [branchLabel, setBranchLabel] = useState<string | null>(null);
  useEffect(() => {

    let cancelled = false;
    if (tab.cwd) {
      api
        .gitChanges(tab.key, tab.cwd)
        .then((result) => {
          if (!cancelled)
            setBranchLabel(
              result.ok && result.repo ? (result.branch ?? null) : null,
            );
        })
        .catch(() => {
          if (!cancelled) setBranchLabel(null);
        });
    } else {
      setBranchLabel(null);
    }
    if (sessionDetailsOpen && liveTokens === 0) {
      api
        .usage(tab.key, tab.backend, true, tab.sessionPath)
        .then((result) => {
          if (!cancelled)
            setSessionUsageTotal(result.usage?.tokens?.total ?? null);
        })
        .catch(() => {
          if (!cancelled) setSessionUsageTotal(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [
    sessionDetailsOpen,
    tab.key,
    tab.cwd,
    tab.backend,
    tab.sessionPath,
    liveTokens === 0,
    running,
  ]);
  // Context window, not the cumulative total: what the model carries right
  // now. Built-in backends report that count. The character estimate is only
  // for a backend that never reports one, and it stays labeled as a guess.
  const contextLabel = hasItems
    ? reported
      ? `${compactTokens(reported.estimatedTokens)} of ${compactTokens(reported.contextWindow)} tokens (${reported.percent ?? "?"}%)`
      : caps.contextUsage
        ? "—"
        : `${compactTokens(estimated.estimatedTokens)} of ${compactTokens(estimated.contextWindow)} tokens (${estimated.percent ?? "?"}%) · estimated`
    : "—";
  const usageTotal = liveTokens > 0 ? liveTokens : sessionUsageTotal;
  // Monocode's turn-metrics readout, aggregated over the session: fresh
  // input, output, cached, cache-hit percent and tok/s. Backends that report
  // no cache fields (or no per-message usage at all) fall back to the old
  // cumulative-total label.
  const spendLabel =
    spend > 0 ? (spend < 0.01 ? "<$0.01" : `$${spend.toFixed(2)}`) : "";
  // Grok's ledger is the session file, counted once. Summing timeline stamps
  // repeats a turn that was already a sum of its model calls.
  const usageSum =
    (exactContext?.session && usageSummaryFromCounts(exactContext.session)) ||
    usageSummaryOf(billedItems);
  const usageLabel =
    usageSum && (usageSum.input || usageSum.output || usageSum.cached)
      ? [
          usageSum.cacheHitPercent == null
            ? null
            : `${Math.round(usageSum.cacheHitPercent)}% cache hit`,
          usageSum.tokensPerSec == null
            ? null
            : `${Math.round(usageSum.tokensPerSec)} tok/s`,
          `${compactTokens(usageSum.input)} input`,
          `${compactTokens(usageSum.output)} output`,
          usageSum.cached ? `${compactTokens(usageSum.cached)} cached` : "",
          spendLabel,
        ]
          .filter(Boolean)
          .join(" · ")
      : usageTotal
        ? [`${compactTokens(usageTotal)} tokens`, spendLabel]
            .filter(Boolean)
            .join(" · ")
        : "—";

  return {
    statusLabel,
    statusTone,
    branchLabel,
    contextLabel,
    usageLabel,
    paneTone,
    running,
  };
}
