// "Codex isn't available. Continue with Claude?" — shown above the composer
// when this session's agent can't run (gone, signed out, or switched off).
import { backendLabel, type AgentBackend } from "../lib/api";
import type { AgentIssue } from "./useAgentIssue";

export function AgentIssueCard({
  issue,
  onReconnect,
  onHandoff,
  onDismiss,
}: {
  issue: AgentIssue;
  onReconnect: () => void;
  onHandoff: (backend: AgentBackend) => void;
  onDismiss: () => void;
}) {
  const label = backendLabel(issue.backend);
  return (
    <div className="agent-issue" role="alert">
      <div className="agent-issue__body">
        <strong>{label} isn't available.</strong>
        <span className="agent-issue__detail" title={issue.error ?? undefined}>
          {issue.error ??
            "Its CLI is missing, signed out, or switched off in Settings."}
          {issue.handoffTo
            ? ` Continue with ${backendLabel(issue.handoffTo)}?`
            : ""}
        </span>
      </div>
      <div className="agent-issue__actions">
        {issue.reconnectable && (
          <button
            type="button"
            className="agent-issue__primary"
            onClick={onReconnect}
          >
            Reconnect {label}
          </button>
        )}
        {issue.handoffTo && (
          <button type="button" onClick={() => onHandoff(issue.handoffTo!)}>
            Continue with {backendLabel(issue.handoffTo)}
          </button>
        )}
        <button
          type="button"
          className="agent-issue__dismiss"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
    </div>
  );
}