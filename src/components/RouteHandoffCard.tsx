import { backendLabel, backendMark } from "../lib/api";
import { roleAccess, type RouteStep } from "../lib/route";
import { BackendLogo } from "./icons";

export function RouteHandoffCard({
  step,
  onOpen,
}: {
  step: RouteStep;
  onOpen: () => void;
}) {
  const mark = backendMark(step.backend);
  return (
    <article className={`route-card is-${step.kind}`}>
      <header className="route-card__head">
        <span className="route-card__tile" style={{ color: mark.color }}>
          <BackendLogo backend={step.backend} size={16} />
        </span>
        <span className={`route-card__kind is-${step.kind}`}>{step.kind}</span>
        <strong>{backendLabel(step.backend).toLowerCase()}</strong>
        <span className="route-card__meta">
          {[step.modelName || step.modelId || "default", roleAccess(step.kind)].join(
            " · ",
          )}
        </span>
        <button type="button" className="route-card__open" onClick={onOpen}>
          Open
        </button>
      </header>
      <p className="route-card__empty">
        This step has not run. The route is saved on the session; the chain is
        not wired yet.
      </p>
    </article>
  );
}
