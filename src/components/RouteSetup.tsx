import { useEffect, useState } from "react";
import {
  AGENT_BACKENDS,
  api,
  backendLabel,
  backendMark,
  type AgentBackend,
  type ModelInfo,
} from "../lib/api";
import {
  firstEnabled,
  newRouteStep,
  roleAccess,
  ROUTE_KINDS,
  ROUTE_TEMPLATES,
  routeTitle,
  type RouteKind,
  type RouteStep,
  type RouteTemplate,
  type SessionRoute,
} from "../lib/route";
import { BackendLogo, IconChevronDown, IconPlus } from "./icons";

export function RouteSetup({
  route,
  sessionKey,
  sessionBackend,
  picking,
  onChange,
  onPick,
  onChangeRoute,
}: {
  route: SessionRoute;
  sessionKey: string;
  sessionBackend: AgentBackend;
  picking: boolean;
  onChange: (route: SessionRoute) => void;
  onPick: (template: RouteTemplate) => void;
  onChangeRoute: () => void;
}) {
  const [models, setModels] = useState<Partial<Record<AgentBackend, ModelInfo[]>>>(
    {},
  );
  const [adding, setAdding] = useState(false);
  const selectedIndex = Math.max(
    0,
    ROUTE_TEMPLATES.findIndex((item) => item.id === route.template),
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const lead = firstEnabled(route);

  useEffect(() => {
    if (picking) setActiveIndex(selectedIndex);
  }, [picking, selectedIndex]);

  useEffect(() => {
    if (!picking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % ROUTE_TEMPLATES.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex(
          (index) =>
            (index - 1 + ROUTE_TEMPLATES.length) % ROUTE_TEMPLATES.length,
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const item = ROUTE_TEMPLATES[activeIndex];
        if (item) onPick(item.id);
        return;
      }
      const fromDigit = ROUTE_TEMPLATES.find((item) => item.key === event.key);
      if (fromDigit) {
        event.preventDefault();
        onPick(fromDigit.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking, activeIndex, onPick]);

  const loadModels = (backend: AgentBackend) => {
    if (models[backend]) return;
    void api.models(sessionKey, backend).then((result) => {
      if (!result.ok) return;
      setModels((current) => ({ ...current, [backend]: result.models ?? [] }));
    });
  };

  const backendsKey = route.steps.map((step) => step.backend).join(",");
  useEffect(() => {
    for (const backend of backendsKey.split(",")) {
      if (backend) loadModels(backend as AgentBackend);
    }
  }, [backendsKey]);

  const patchStep = (id: string, patch: Partial<RouteStep>) => {
    onChange({
      ...route,
      template: route.template === "custom" ? "custom" : route.template,
      steps: route.steps.map((step) =>
        step.id === id ? { ...step, ...patch } : step,
      ),
    });
  };

  const addKind = (kind: RouteKind) => {
    setAdding(false);
    onChange({
      ...route,
      enabled: true,
      template: "custom",
      steps: [...route.steps, newRouteStep(kind, sessionBackend)],
    });
  };

  if (picking) {
    return (
      <div className="route-setup route-setup--pick">
        <div className="route-picker" role="menu" aria-label="Choose a route">
          <div className="route-picker__head">
            <span>route</span>
            <span>↑↓ move · ⏎ pick · esc close</span>
          </div>
          {ROUTE_TEMPLATES.map((item, index) => {
            const selected = route.template === item.id;
            const active = index === activeIndex;
            return (
              <span key={item.id} className="route-picker__block">
                {item.id === "custom" ? (
                  <span className="route-picker__rule" />
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className={`route-picker__row${selected ? " is-selected" : ""}${active ? " is-active" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => onPick(item.id)}
                >
                  <span className="route-picker__mark" aria-hidden>
                    {selected ? "❯" : ""}
                  </span>
                  <strong>{item.title}</strong>
                  <em>{item.sub}</em>
                  <kbd>{item.key}</kbd>
                </button>
              </span>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="route-setup">
      <div className="route-setup__bar">
        <strong>{routeTitle(route)}</strong>
        <button type="button" onClick={onChangeRoute}>
          Change route
          <IconChevronDown size={11} />
        </button>
      </div>
      <ul className="route-setup__rows">
        {route.steps.map((step) => {
          const options = models[step.backend] ?? [];
          const modelValue = step.modelId
            ? `${step.backend}/${step.modelId}`
            : "";
          return (
            <li
              key={step.id}
              className={`route-setup__row${step.enabled ? "" : " is-off"}`}
            >
              <span className={`route-setup__kind is-${step.kind}`}>
                {step.kind}
              </span>
              <span
                className="route-setup__mark"
                style={{ color: backendMark(step.backend).color }}
              >
                <BackendLogo backend={step.backend} size={14} />
              </span>
              <label className="route-setup__select">
                <select
                  aria-label={`Backend for ${step.kind}`}
                  value={step.backend}
                  disabled={!step.enabled}
                  onChange={(event) => {
                    const backend = event.target.value as AgentBackend;
                    loadModels(backend);
                    patchStep(step.id, {
                      backend,
                      modelId: "",
                      modelName: "",
                    });
                  }}
                >
                  {AGENT_BACKENDS.map((backend) => (
                    <option key={backend} value={backend}>
                      {backendLabel(backend).toLowerCase()}
                    </option>
                  ))}
                </select>
              </label>
              <label className="route-setup__select route-setup__select--model">
                <select
                  aria-label={`Model for ${step.kind}`}
                  value={modelValue}
                  disabled={!step.enabled}
                  onPointerDown={() => loadModels(step.backend)}
                  onFocus={() => loadModels(step.backend)}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!value) {
                      patchStep(step.id, { modelId: "", modelName: "" });
                      return;
                    }
                    const option = options.find(
                      (item) => `${step.backend}/${item.id}` === value,
                    );
                    patchStep(step.id, {
                      modelId: option?.id ?? "",
                      modelName: option?.name ?? option?.id ?? "",
                    });
                  }}
                >
                  <option value="">default</option>
                  {step.modelId &&
                    !options.some((item) => item.id === step.modelId) && (
                      <option value={modelValue}>
                        {step.modelName || step.modelId}
                      </option>
                    )}
                  {options.map((item) => (
                    <option
                      key={`${step.backend}/${item.id}`}
                      value={`${step.backend}/${item.id}`}
                    >
                      {item.name || item.id}
                    </option>
                  ))}
                </select>
              </label>
              <em>{roleAccess(step.kind)}</em>
              <button
                type="button"
                className={step.enabled ? "is-on" : undefined}
                onClick={() => patchStep(step.id, { enabled: !step.enabled })}
              >
                {step.enabled ? "on" : "off"}
              </button>
              {route.template === "custom" && route.steps.length > 1 ? (
                <button
                  type="button"
                  className="route-setup__remove"
                  aria-label={`Remove ${step.kind}`}
                  onClick={() =>
                    onChange({
                      ...route,
                      steps: route.steps.filter((item) => item.id !== step.id),
                    })
                  }
                >
                  ×
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="route-setup__foot">
        <div className="route-setup__add">
          <button type="button" onClick={() => setAdding((open) => !open)}>
            <IconPlus size={12} /> Add a role
          </button>
          {adding && (
            <div className="route-setup__add-menu" role="menu">
              {ROUTE_KINDS.map((kind) => (
                <button
                  type="button"
                  role="menuitem"
                  key={kind}
                  onClick={() => addKind(kind)}
                >
                  {kind}
                </button>
              ))}
            </div>
          )}
        </div>
        {lead ? (
          <span className="route-setup__hint">
            starts with {lead.kind} · {backendLabel(lead.backend).toLowerCase()}
          </span>
        ) : (
          <span className="route-setup__hint">
            all roles off — this is an ordinary send
          </span>
        )}
      </div>
    </div>
  );
}


