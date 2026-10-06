/**
 * Keep ZCode's personal provider config (~/.zcode/v2/provider_config.json,
 * resolved by apps/zcode-cli/packages/cli/src/provider-runtime-env.ts) in
 * sync with the local Ollama daemon, the same way ollama-models.js feeds
 * Pi's models.json. Without an entry here ZCode cannot see Ollama at all:
 * its model catalog is config-driven, not endpoint-discovered.
 *
 * Format verified against zai-org/ZCode v3.14.3:
 * packages/provider-node/src/provider-config-file-codec.ts (file envelope)
 * + packages/provider/src/config/rule-data-schema.ts (rule shapes).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const OLLAMA_PROVIDER_ID = "ollama";
// The reasoningLevel values are passed through 1:1 as `reasoning_effort`;
// "none" disables thinking, mirroring Ollama's own validation.
const OLLAMA_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// The user picks "Use local Ollama" in the connect dialog; until then devden
// never writes its rule, and a rule it wrote earlier doesn't count as wired.
const optInPath = () => join(homedir(), ".devden", "zcode-ollama-opt-in");
export const zcodeOllamaOptedIn = () => existsSync(optInPath());

/** Opt in and wire the rule now. False when Ollama has no models to offer. */
export function optInZcodeOllama(models) {
  if (!models.length) return false;
  mkdirSync(dirname(optInPath()), { recursive: true });
  writeFileSync(optInPath(), `${new Date().toISOString()}\n`);
  syncZcodeProviderConfig(models);
  return true;
}

export function zcodeProviderConfigPath() {
  return process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
    || join(homedir(), ".zcode", "v2", "provider_config.json");
}

/** One Ollama model (from listOllamaModels) -> zcode providerModel rule. */
function ollamaModelRule(model) {
  return {
    providerId: OLLAMA_PROVIDER_ID,
    modelId: model.id,
    config: {
      enabled: true,
      properties: {
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: true,
        requiresMfjsToolSchema: false,
        inputFormat: {
          supportsText: true,
          supportsImage: Boolean(model.vision),
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
      },
      optionSpecs: {
        ...(model.reasoning
          ? {
              reasoningLevel: {
                values: OLLAMA_REASONING_LEVELS,
                map: "{'reasoning_effort': reasoningLevel}",
              },
            }
          : {}),
        maxOutputTokens: { max: 32768 },
      },
    },
  };
}

const OLLAMA_PROVIDER_RULE = {
  providerId: OLLAMA_PROVIDER_ID,
  providerName: "Ollama",
  enabled: true,
  config: {
    group: "standard-personal",
    access: { type: "api-key", apiKey: "ollama" },
    api: {
      type: "openai-chat-completions",
      baseUrl: process.env.OLLAMA_HOST
        ? `${String(process.env.OLLAMA_HOST).replace(/\/$/, "")}/v1`
        : "http://127.0.0.1:11434/v1",
    },
  },
};

function ensureArray(container, key) {
  if (!Array.isArray(container[key])) container[key] = [];
  return container[key];
}

/**
 * Merge the Ollama provider + its models into the config. ZCode owns the
 * file; we only touch rules with providerId "ollama", preserve everything
 * else (including defaultModelSelection), and never write an empty catalog.
 * Returns true when the file changed.
 */
export function mergeZcodeProviderConfig(config, models) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  if (!models.length) return false;
  let changed = false;

  config.schemaVersion ??= 1;
  config.config ??= {};
  const layer = config.config;

  const providerRules = (layer.providerConfigRules ??= {}).providerRules ??= [];
  const at = providerRules.findIndex(
    (rule) => rule?.providerId === OLLAMA_PROVIDER_ID,
  );
  if (at === -1) {
    providerRules.push(OLLAMA_PROVIDER_RULE);
    changed = true;
  } else {
    // Keep the stored baseUrl/apiKey; refresh only enabled state.
    if (providerRules[at].enabled !== true) {
      providerRules[at].enabled = true;
      changed = true;
    }
  }

  const order = ensureArray(layer, "providerOrder");
  if (!order.includes(OLLAMA_PROVIDER_ID)) {
    order.push(OLLAMA_PROVIDER_ID);
    changed = true;
  }

  const modelRules = (layer.modelConfigRules ??= {}).providerModelRules ??= [];
  const byId = new Map(
    modelRules
      .map((rule, index) => [rule?.providerId === OLLAMA_PROVIDER_ID ? rule.modelId : null, index])
      .filter(([id]) => Boolean(id)),
  );
  for (const model of models) {
    const rule = ollamaModelRule(model);
    const index = byId.get(model.id);
    const existing = index === undefined ? undefined : modelRules[index];
    if (!existing || JSON.stringify(existing) !== JSON.stringify(rule)) {
      if (index === undefined) modelRules.push(rule);
      else modelRules[index] = rule;
      changed = true;
    }
  }
  return changed;
}

/** Read + merge + atomic write. A malformed file is left untouched. */
export function syncZcodeProviderConfig(models) {
  const path = zcodeProviderConfigPath();
  let config = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // ZCode owns this file; a malformed read means we back off entirely.
      return false;
    }
  }
  if (!mergeZcodeProviderConfig(config, models)) return false;
  // A machine that only ran the desktop app may not have ~/.zcode/v2 yet.
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.devden.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temp, path);
  return true;
}