import { formatCountdown } from "../lib/time";
import {
  formatResetAt,
  limitScopeLabel,
  type LimitScope,
} from "../lib/usageLimit";

/**
 * The quota wall, pinned above the composer. A turn that dies on a usage limit
 * cannot be retried as-is, so this is where the two things the user needs live:
 * when the window comes back, and one click to pick the work back up.
 */
export function LimitBanner({
  scope,
  label,
  resetsAt,
  busy,
  onResume,
}: {
  scope: LimitScope;
  /** The provider's own window name, when it has one. */
  label?: string;
  resetsAt?: number;
  busy: boolean;
  onResume: () => void;
}) {
  const name =
    scope === "other" && label ? label : limitScopeLabel(scope).toLowerCase();
  return (
    <div className="limit-strip" role="status">
      <span className="limit-strip__icon" aria-hidden>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path
            d="M8 1.6 15 14.2H1L8 1.6Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path
            d="M8 6v3.6M8 11.7v.1"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <p className="limit-strip__text">
        <strong>You&apos;ve run out of your {name}.</strong>{" "}
        {Number.isFinite(resetsAt) ? (
          <>
            It resets at <strong>{formatResetAt(resetsAt as number)}</strong>
            <span className="limit-strip__countdown">
              {" "}
              · in {formatCountdown(resetsAt as number)}
            </span>
            .
          </>
        ) : (
          <>Reset time unknown.</>
        )}
      </p>
      <div className="limit-strip__actions">
        <button
          type="button"
          className="limit-strip__resume"
          disabled={busy}
          title="Carry on from where the turn was cut off"
          onClick={onResume}
        >
          Resume
        </button>
      </div>
    </div>
  );
}
