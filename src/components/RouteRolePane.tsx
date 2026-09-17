import { backendLabel, backendMark } from "../lib/api";
import { roleAccess, stepLabel, type RouteStep } from "../lib/route";
import { BackendLogo } from "./icons";

export function RouteRolePane({
  step,
  onClose,
}: {
  step: RouteStep;
  onClose: () => void;
}) {
  const mark = backendMark(step.backend);
  return (
    <aside className="route-pane" aria-label={`${step.kind} role`}>
      <header className="route-pane__head">
        <span className="route-pane__tile" style={{ color: mark.color }}>
          <BackendLogo backend={step.backend} size={16} />
        </span>
        <div className="route-pane__identity">
          <strong>
            {backendLabel(step.backend).toLowerCase()} · {step.kind}
          </strong>
          <span>
            {stepLabel(step)} · {roleAccess(step.kind)}
          </span>
        </div>
        <button
          type="button"
          className="route-pane__close"
          aria-label="Close role pane"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="route-pane__body">
        <p>
          This role does not have its own session yet. Sending still uses this
          conversation’s backend; the chain will land in a later pass.
        </p>
      </div>
    </aside>
  );
}
