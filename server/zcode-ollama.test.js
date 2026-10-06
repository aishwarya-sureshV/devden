import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeZcodeProviderConfig } from "./zcode-ollama.js";

const models = [
  {
    id: "qwen3:latest",
    name: "qwen3 latest",
    provider: "ollama",
    contextWindow: 131072,
    reasoning: true,
    vision: false,
  },
  { id: "llama4:8b", name: "llama4 8b", provider: "ollama", reasoning: false, vision: true },
];

test("merges the ollama provider and model rules without clobbering", () => {
  const config = {
    schemaVersion: 1,
    config: {
      providerOrder: ["account:zai-individual-coding-plan"],
      providerConfigRules: {
        providerRules: [
          { providerId: "account:zai-individual-coding-plan", config: { group: "zai-family" } },
        ],
      },
      modelConfigRules: {
        manualProviderModelRules: [{ providerId: "other", modelId: "m", config: { enabled: true } }],
      },
      defaultModelSelection: { providerId: "zai", modelId: "GLM-5.3" },
    },
  };
  assert.equal(mergeZcodeProviderConfig(config, models), true);
  const layer = config.config;
  assert.deepEqual(layer.providerOrder, ["account:zai-individual-coding-plan", "ollama"]);

  const provider = layer.providerConfigRules.providerRules.find(
    (rule) => rule.providerId === "ollama",
  );
  assert.equal(provider.config.api.type, "openai-chat-completions");
  assert.equal(provider.config.api.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(provider.config.access.apiKey, "ollama");

  const qwen = layer.modelConfigRules.providerModelRules.find(
    (rule) => rule.modelId === "qwen3:latest",
  );
  assert.equal(qwen.config.properties.contextWindow, 131072);
  assert.deepEqual(
    qwen.config.optionSpecs.reasoningLevel.values,
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  );
  // A non-reasoning model carries no reasoningLevel spec, a vision one
  // declares image input.
  const llama = layer.modelConfigRules.providerModelRules.find(
    (rule) => rule.modelId === "llama4:8b",
  );
  assert.equal(llama.config.optionSpecs.reasoningLevel, undefined);
  assert.equal(llama.config.properties.inputFormat.supportsImage, true);

  // Untouched sections survive.
  assert.deepEqual(layer.defaultModelSelection, { providerId: "zai", modelId: "GLM-5.3" });
  assert.equal(layer.modelConfigRules.manualProviderModelRules.length, 1);

  // A second merge with the same models is a no-op.
  assert.equal(mergeZcodeProviderConfig(config, models), false);
});

test("rejects junk and empty catalogs", () => {
  assert.equal(mergeZcodeProviderConfig(null, models), false);
  assert.equal(mergeZcodeProviderConfig({}, []), false);
});