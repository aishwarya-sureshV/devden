import {
  AGENT_BACKENDS,
  backendLabel,
  type AgentBackend,
  type ResumeSession,
} from "./api.ts";

const BRANDS: Record<string, string> = {
  claude: "Claude",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  glm: "GLM",
  gpt: "GPT",
  grok: "Grok",
  kimi: "Kimi",
  llama: "Llama",
  mistral: "Mistral",
  qwen: "Qwen",
};

/** `deepseek-v4-pro:cloud` → "DeepSeek V4 Pro". */
export function formatSessionModelName(id: string | undefined): string {
  const raw = String(id || "").trim();
  if (!raw) return "Unknown model";
  return raw
    .replace(/:cloud$/i, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (BRANDS[lower]) return BRANDS[lower];
      if (/^v\d/i.test(part)) return part.toUpperCase();
      if (/^\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

function sessionModelIds(
  session: Pick<ResumeSession, "models" | "lastModel">,
): string[] {
  if (session.models && session.models.length > 0) return session.models;
  return session.lastModel ? [session.lastModel] : [];
}

/** True when this session used `modelId` on any turn, including a single swap. */
export function sessionUsesModel(
  session: Pick<ResumeSession, "models" | "lastModel">,
  modelId: string,
): boolean {
  if (!modelId) return true;
  return sessionModelIds(session).includes(modelId);
}

export function uniqueSessionModels(
  sessions: Array<Pick<ResumeSession, "models" | "lastModel">>,
): { id: string; label: string }[] {
  const ids = new Set<string>();
  for (const session of sessions) {
    for (const id of sessionModelIds(session)) ids.add(id);
  }
  return [...ids]
    .sort((a, b) =>
      formatSessionModelName(a).localeCompare(formatSessionModelName(b)),
    )
    .map((id) => ({ id, label: formatSessionModelName(id) }));
}

const GENERIC_PI_MODELS = new Set([
  "pi-local",
  "pi-shell",
  "pi-shell-acp",
  "local",
  "unknown",
  "unknown model",
]);

function isGenericPiModel(id: string): boolean {
  const lower = id.trim().toLowerCase();
  if (!lower) return true;
  if (GENERIC_PI_MODELS.has(lower)) return true;
  return /^pi-(local|shell)/i.test(lower);
}

/**
 * Model to show on a session row: the last real model, not a generic
 * "pi-local" placeholder. For Pi/Ollama sessions that is the last Ollama
 * id that produced a turn.
 */
export function sessionDisplayModel(
  session: Pick<ResumeSession, "models" | "lastModel" | "lastModelProvider">,
): string {
  const last = String(session.lastModel || "").trim();
  if (session.lastModelProvider === "ollama" && last && !isGenericPiModel(last))
    return last;
  if (last && !isGenericPiModel(last)) return last;
  const ids = sessionModelIds(session);
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    if (id && !isGenericPiModel(id)) return id;
  }
  return last;
}

export function formatEffort(effort: string | undefined): string {
  const raw = String(effort || "")
    .trim()
    .toLowerCase();
  if (!raw || raw === "off") return "";
  if (raw === "high" || raw.startsWith("hi")) return "high";
  if (raw === "medium" || raw.startsWith("med")) return "medium";
  if (raw === "low" || raw.startsWith("lo")) return "low";
  return raw;
}

/** Sidebar meta line: `DeepSeek V4 Pro · medium`. */
export function sessionMetaLine(
  session: Pick<
    ResumeSession,
    "models" | "lastModel" | "lastModelProvider" | "lastEffort" | "backend"
  >,
): string {
  const modelId = sessionDisplayModel(session);
  const model = modelId
    ? formatSessionModelName(modelId)
    : backendLabel(session.backend).toLowerCase();
  const effort = formatEffort(session.lastEffort);
  return effort ? `${model} · ${effort}` : model;
}

export type SessionModelGroup = {
  backend: AgentBackend;
  count: number;
  models: { id: string; label: string; count: number }[];
};

/** 2C catalog: each backend with the last-used models under it. */
export function sessionFilterCatalog(
  sessions: Array<
    Pick<
      ResumeSession,
      "backend" | "models" | "lastModel" | "lastModelProvider"
    >
  >,
): SessionModelGroup[] {
  const byBackend = new Map<
    AgentBackend,
    { count: number; models: Map<string, number> }
  >();
  for (const backend of AGENT_BACKENDS) {
    byBackend.set(backend, { count: 0, models: new Map() });
  }
  for (const session of sessions) {
    const group = byBackend.get(session.backend);
    if (!group) continue;
    group.count += 1;
    const model = sessionDisplayModel(session);
    if (!model) continue;
    group.models.set(model, (group.models.get(model) ?? 0) + 1);
  }
  return AGENT_BACKENDS.map((backend) => {
    const group = byBackend.get(backend)!;
    return {
      backend,
      count: group.count,
      models: [...group.models.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([id, count]) => ({
          id,
          label: formatSessionModelName(id),
          count,
        })),
    };
  });
}

export function sessionMatchesFilters(
  session: Pick<
    ResumeSession,
    "backend" | "models" | "lastModel" | "lastModelProvider"
  >,
  backends: ReadonlySet<AgentBackend> | null,
  models: ReadonlySet<string>,
): boolean {
  if (backends && backends.size > 0 && !backends.has(session.backend))
    return false;
  if (models.size === 0) return true;
  const last = sessionDisplayModel(session);
  if (last && models.has(last)) return true;
  return sessionModelIds(session).some((id) => models.has(id));
}
