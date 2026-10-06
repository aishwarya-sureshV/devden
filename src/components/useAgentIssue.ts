// One place for "this session's agent can't run right now": a backend_auth
// event (the sign-in died mid-session or at the keepalive) or a catalog row
// that isn't usable (uninstalled, signed out, switched off). Surfaces the
// Reconnect action, and — when another agent could take over — the
// transcript handoff from switchBackend.
import { useEffect, useState } from "react";
import { subscribeEvents, type AgentBackend, type BackendInfo } from "../lib/api";
import { backendUsable, handoffTarget } from "../lib/agentAvailability.ts";

export type AgentIssue = {
  backend: AgentBackend;
  /** Raw failure text from the backend_auth event, when there was one. */
  error: string | null;
  /** Connect can bring this agent back (it isn't switched off in Settings). */
  reconnectable: boolean;
  /** Agent offered for "continue with X instead". */
  handoffTo: AgentBackend | null;
};

export function useAgentIssue({
  backend,
  catalog,
  hasItems,
  preferred,
}: {
  backend: AgentBackend;
  catalog: BackendInfo[];
  /** Fresh chats have nothing to hand off and nothing that failed yet. */
  hasItems: boolean;
  preferred?: AgentBackend;
}): { issue: AgentIssue | null; dismiss: () => void } {
  const [alert, setAlert] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(
    () =>
      subscribeEvents((event) => {
        if (
          event.type === "backend_auth" &&
          event.ok === false &&
          event.backend === backend
        ) {
          setAlert(String(event.error ?? "Sign-in expired"));
          // A new failure earns a new card, even if the last one was dismissed.
          setDismissed(false);
        }
      }),
    [backend],
  );
  // A catalog refresh that shows the agent healthy clears the alert (the
  // user re-signed-in — the refresh comes from Connect's own re-detect);
  // a refresh that shows it broken keeps the card up through the change.
  // null = no row for this backend (empty catalog, fetch failed) — cannot
  // judge, don't flag.
  const row = catalog.find((entry) => entry.id === backend);
  const usable = row ? backendUsable(row) : null;
  useEffect(() => {
    if (usable) setAlert(null);
  }, [usable, catalog]);
  // Reset both when the session itself changes backends (a handoff).
  useEffect(() => {
    setAlert(null);
    setDismissed(false);
  }, [backend]);
  if (!hasItems || dismissed) return { issue: null, dismiss: () => setDismissed(true) };
  const gone = usable === false || alert !== null;
  if (!gone) return { issue: null, dismiss: () => setDismissed(true) };
  return {
    issue: {
      backend,
      error: alert,
      reconnectable: Boolean(row && row.enabled !== false),
      handoffTo: handoffTarget(backend, catalog, preferred),
    },
    dismiss: () => setDismissed(true),
  };
}