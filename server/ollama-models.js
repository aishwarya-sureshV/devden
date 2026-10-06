/**
 * Discover Ollama (including :cloud) models from the local daemon and keep
 * ~/.pi/agent/models.json in sync so Pi can actually select them.
 */
import { updateModelsJson } from "./pi-model-overrides.js";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

function prettyName(id) {
  // Cloud models get a ☁ suffix instead of the old "(cloud)" word.
  return id.replace(/:cloud$/, " ☁").replace(/[:/-]/g, " ");
}

// Ollama's OpenAI-compatible endpoint accepts reasoning_effort of
// minimal|low|medium|high|xhigh|ultra|max|none (none disables thinking) --
// verified against the daemon's own validation error. Pi's levels are the
// same names, so every level passes through 1:1 except "off" -> "none".
const OLLAMA_THINKING_LEVEL_MAP = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * True when a stored map downgrades a level Ollama accepts verbatim -- the
 * signature of a map written when "high" was believed to be the ceiling.
 * User-authored entries that only remap names Ollama rejects are left alone.
 */
export function isStaleThinkingLevelMap(map) {
  return Object.entries(map ?? {}).some(
    ([from, to]) => OLLAMA_THINKING_LEVEL_MAP[from] === from && to !== from,
  );
}

function modelKey(model) {
  return `${String(model?.provider ?? "").toLowerCase()}\0${String(model?.id ?? "")}`;
}

export async function listOllamaModels() {
  const response = await fetch(`${OLLAMA_HOST.replace(/\/$/, "")}/api/tags`, {
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const payload = await response.json();
  const models = Array.isArray(payload?.models) ? payload.models : [];
  return models.flatMap((entry) => {
    const id = String(entry?.name ?? entry?.model ?? "").trim();
    if (!id) return [];
    const capabilities = Array.isArray(entry?.capabilities)
      ? entry.capabilities
      : [];
    const contextWindow = Number(entry?.details?.context_length);
    const reasoning = capabilities.includes("thinking");
    return [
      {
        id,
        name: prettyName(id),
        provider: "ollama",
        contextWindow:
          Number.isFinite(contextWindow) && contextWindow > 0
            ? contextWindow
            : undefined,
        // Cloud models used to leak reasoning into content as literal
        // <think> tags, so they were excluded here. Ollama's
        // openai-completions endpoint now returns a separate `reasoning`
        // field on both the blocking and streaming paths (verified against
        // the daemon: 58 `delta.reasoning` chunks, clean content), so the
        // capability flag is trusted for cloud models too.
        reasoning,
        // The daemon model object carries no thinkingLevelMap; without one,
        // supportedThinkingLevels caps reasoning models at "high" even
        // though Ollama accepts the full ladder through "max". Carry the
        // 1:1 map so the picker shows every level the model supports.
        ...(reasoning ? { thinkingLevelMap: OLLAMA_THINKING_LEVEL_MAP } : {}),
        vision: capabilities.includes("vision"),
      },
    ];
  });
}

export function mergeModelLists(primary, extra) {
  const merged = [];
  const seen = new Set();
  for (const model of [...extra, ...primary]) {
    if (!model?.id || !model?.provider) continue;
    const key = modelKey(model);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(model);
  }
  return merged;
}

export async function syncOllamaModelsJson(models) {
  if (!models.length) return false;
  // Runs under the same lock as every other models.json writer (context
  // overrides, …) with an atomic replace, and throws without writing when
  // the existing file is unreadable or malformed instead of clobbering it.
  return updateModelsJson((config) => {
    if (!config || typeof config !== "object") config = { providers: {} };
    if (!config.providers || typeof config.providers !== "object")
      config.providers = {};
    if (!config.providers.ollama || typeof config.providers.ollama !== "object") {
      config.providers.ollama = {
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        apiKey: "ollama",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [],
      };
    }
    if (!Array.isArray(config.providers.ollama.models))
      config.providers.ollama.models = [];
    const byId = new Map(
      config.providers.ollama.models
        .filter((model) => Boolean(model?.id))
        .map((model) => [model.id, model]),
    );
    let changed = false;
    for (const model of models) {
      const reasoning = model.reasoning !== false;
      const entry = byId.get(model.id);
      if (!entry) {
        const created = {
          id: model.id,
          reasoning,
          ...(reasoning
            ? {
                compat: { supportsReasoningEffort: true },
                thinkingLevelMap: OLLAMA_THINKING_LEVEL_MAP,
              }
            : {}),
          ...(model.vision ? { input: ["text", "image"] } : {}),
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        };
        config.providers.ollama.models.push(created);
        byId.set(model.id, created);
        changed = true;
        continue;
      }
      // Upgrade models registered before effort support: thinking models gain
      // a per-model compat override so Pi sends reasoning_effort, and any map
      // written when "high" was believed to be Ollama's ceiling is repaired so
      // xhigh/max/minimal reach the daemon instead of being downgraded.
      if (reasoning) {
        if (entry.reasoning !== true) {
          entry.reasoning = true;
          changed = true;
        }
        if (entry.compat?.supportsReasoningEffort !== true) {
          entry.compat = {
            ...(entry.compat ?? {}),
            supportsReasoningEffort: true,
          };
          changed = true;
        }
        const map = entry.thinkingLevelMap;
        if (!map) {
          entry.thinkingLevelMap = OLLAMA_THINKING_LEVEL_MAP;
          changed = true;
        } else if (isStaleThinkingLevelMap(map)) {
          entry.thinkingLevelMap = { ...map, ...OLLAMA_THINKING_LEVEL_MAP };
          changed = true;
        }
      } else if (entry.reasoning || entry.compat?.supportsReasoningEffort) {
        // Previously registered as reasoning-capable (e.g. GLM, before the
        // <think>-tag leak was known) -- strip the override so Pi stops
        // requesting reasoning_effort from a model that can't honor it cleanly.
        entry.reasoning = false;
        if (entry.compat) delete entry.compat.supportsReasoningEffort;
        delete entry.thinkingLevelMap;
        changed = true;
      }
    }
    if (!changed) return false;
    return true;
  });
}
