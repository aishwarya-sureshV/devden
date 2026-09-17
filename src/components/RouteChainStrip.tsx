import { backendLabel, backendMark } from "../lib/api";
import { stepLabel, type RouteStep } from "../lib/route";
import { BackendLogo } from "./icons";

export function RouteChainStrip({
  steps,
  activeId,
  onSelect,
  onEdit,
}: {
  steps: RouteStep[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onEdit: () => void;
}) {
  if (steps.length === 0) return null;
  return (
    <div className="route-strip" aria-label="Route chain">
      {steps.map((step, index) => (
        <span key={step.id} className="route-strip__item">
          {index > 0 ? (
            <span className="route-strip__arrow" aria-hidden>
              →
            </span>
          ) : null}
          <button
            type="button"
            className={`route-strip__step${activeId === step.id ? " is-active" : ""}${step.enabled ? "" : " is-off"}`}
            onClick={() => onSelect(step.id)}
          >
            <span
              className="route-strip__mark"
              style={{ color: backendMark(step.backend).color }}
            >
              <BackendLogo backend={step.backend} size={12} />
            </span>
            <span className={`route-strip__kind is-${step.kind}`}>
              {step.kind}
            </span>
            <span className="route-strip__name">
              {step.enabled
                ? stepLabel(step)
                : `${backendLabel(step.backend).toLowerCase()} off`}
            </span>
          </button>
        </span>
      ))}
      <button type="button" className="route-strip__edit" onClick={onEdit}>
        Edit chain
      </button>
    </div>
  );
}
