import type { AgentBackend } from "./api";

export const ROUTE_KINDS = ["plan", "diagnose", "execute", "review"] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];
export const ROUTE_TEMPLATES = [
  {
    id: "diagnose",
    title: "Diagnose → Execute → Review",
    sub: "Hunt the cause, land the fix, then a second agent reads the diff",
    key: "1",
  },
  {
    id: "fix",
    title: "Diagnose → Execute",
    sub: "Hunt the cause and land the fix — no review pass",
    key: "2",
  },
  {
    id: "plan",
    title: "Plan → Execute → Review",
    sub: "You know the work: plan it, implement, then review the result",
    key: "3",
  },
  {
    id: "custom",
    title: "Custom route",
    sub: "Your own chain",
    key: "4",
  },
] as const;
export type RouteTemplate = (typeof ROUTE_TEMPLATES)[number]["id"];

export interface RouteStep {
  id: string;
  kind: RouteKind;
  backend: AgentBackend;
  modelId: string;
  modelName: string;
  enabled: boolean;
}

export interface SessionRoute {
  enabled: boolean;
  template: RouteTemplate | null;
  steps: RouteStep[];
}

const BACKENDS: AgentBackend[] = ["pi", "claude", "grok", "codex", "zcode"];

export function emptyRoute(): SessionRoute {
  return { enabled: false, template: null, steps: [] };
}

export function isRouteKind(value: string): value is RouteKind {
  return (ROUTE_KINDS as readonly string[]).includes(value);
}

export function isRouteTemplate(value: string): value is RouteTemplate {
  return ROUTE_TEMPLATES.some((item) => item.id === value);
}

export function isRouteBackend(value: string): value is AgentBackend {
  return BACKENDS.includes(value as AgentBackend);
}

export function roleAccess(kind: RouteKind): "read-only" | "writes" {
  return kind === "execute" ? "writes" : "read-only";
}

export function defaultBackendForKind(
  kind: RouteKind,
  sessionBackend: AgentBackend,
): AgentBackend {
  if (kind === "execute") return sessionBackend;
  if (kind === "diagnose") return "codex";
  return "claude";
}

export function newRouteStep(
  kind: RouteKind,
  sessionBackend: AgentBackend,
  id: string = crypto.randomUUID(),
): RouteStep {
  return {
    id,
    kind,
    backend: defaultBackendForKind(kind, sessionBackend),
    modelId: "",
    modelName: "",
    enabled: true,
  };
}

export function templateSteps(
  template: Exclude<RouteTemplate, "custom">,
  sessionBackend: AgentBackend,
  id: () => string = () => crypto.randomUUID(),
): RouteStep[] {
  const kinds: RouteKind[] =
    template === "diagnose"
      ? ["diagnose", "execute", "review"]
      : template === "fix"
        ? ["diagnose", "execute"]
        : ["plan", "execute", "review"];
  return kinds.map((kind) => newRouteStep(kind, sessionBackend, id()));
}

export function applyTemplate(
  template: RouteTemplate,
  sessionBackend: AgentBackend,
): SessionRoute {
  if (template === "custom") {
    return {
      enabled: true,
      template,
      steps: [newRouteStep("execute", sessionBackend)],
    };
  }
  return {
    enabled: true,
    template,
    steps: templateSteps(template, sessionBackend),
  };
}

export function firstEnabled(route: SessionRoute): RouteStep | null {
  return route.steps.find((step) => step.enabled) ?? null;
}

export function enabledSteps(route: SessionRoute): RouteStep[] {
  return route.steps.filter((step) => step.enabled);
}

export function routeTitle(route: SessionRoute): string {
  return (
    ROUTE_TEMPLATES.find((item) => item.id === route.template)?.title ?? "Routed"
  );
}

export function stepLabel(step: RouteStep): string {
  const model = step.modelName.trim() || step.modelId.trim();
  return model ? `${step.backend} · ${model}` : step.backend;
}

export function normalizeRoute(raw: unknown): SessionRoute | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<SessionRoute> & { steps?: unknown };
  const rawTemplate = String(row.template ?? "");
  const template = isRouteTemplate(rawTemplate) ? rawTemplate : null;
  const steps = Array.isArray(row.steps)
    ? row.steps.flatMap((item, index) => {
        if (!item || typeof item !== "object") return [];
        const step = item as Partial<RouteStep>;
        const kind = isRouteKind(String(step.kind ?? "")) ? step.kind : null;
        const backend = isRouteBackend(String(step.backend ?? ""))
          ? step.backend
          : null;
        if (!kind || !backend) return [];
        return [
          {
            id:
              typeof step.id === "string" && step.id.trim()
                ? step.id.trim()
                : `step-${index}`,
            kind,
            backend,
            modelId: typeof step.modelId === "string" ? step.modelId : "",
            modelName: typeof step.modelName === "string" ? step.modelName : "",
            enabled: step.enabled !== false,
          } satisfies RouteStep,
        ];
      })
    : [];
  return {
    enabled: Boolean(row.enabled),
    template,
    steps,
  };
}
