import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setModelContextOverride, updateModelsJson } from "./pi-model-overrides.js";

const dir = await mkdtemp(join(tmpdir(), "pi-model-overrides-"));
const file = join(dir, "models.json");

// Starting from a config with unrelated user content that must survive.
await writeFile(file, JSON.stringify({
  providers: {
    openai: { apiKey: "$OPENAI_KEY" },
    ollama: {
      baseUrl: "http://localhost:11434/v1",
      models: [{ id: "llama3:8b", reasoning: false }],
      modelOverrides: { "llama3:8b": { maxTokens: 4096 } },
    },
  },
}));

// Set an override on a provider that exists.
assert.equal(await setModelContextOverride("ollama", "llama3:8b", 131072, file), true);
// Same value again is a no-op.
assert.equal(await setModelContextOverride("ollama", "llama3:8b", 131072, file), false);
// Set on a provider that does not exist yet (built-in, no block in the file).
assert.equal(await setModelContextOverride("openai-codex", "gpt-5.5", 272000, file), true);

let saved = JSON.parse(await readFile(file, "utf8"));
assert.equal(saved.providers.openai.apiKey, "$OPENAI_KEY");
assert.equal(saved.providers.ollama.models.length, 1);
assert.equal(saved.providers.ollama.modelOverrides["llama3:8b"].maxTokens, 4096);
assert.equal(saved.providers.ollama.modelOverrides["llama3:8b"].contextWindow, 131072);
assert.equal(saved.providers["openai-codex"].modelOverrides["gpt-5.5"].contextWindow, 272000);

// Remove an override; unrelated keys in the same override survive.
assert.equal(await setModelContextOverride("ollama", "llama3:8b", null, file), true);
saved = JSON.parse(await readFile(file, "utf8"));
assert.equal(saved.providers.ollama.modelOverrides["llama3:8b"].contextWindow, undefined);
assert.equal(saved.providers.ollama.modelOverrides["llama3:8b"].maxTokens, 4096);
// Removing a nonexistent override is a no-op.
assert.equal(await setModelContextOverride("ollama", "llama3:8b", null, file), false);

// Missing or corrupt file still yields a valid write.
const empty = join(dir, "missing.json");
assert.equal(await setModelContextOverride("ollama", "llama3:8b", 8192, empty), true);
saved = JSON.parse(await readFile(empty, "utf8"));
assert.equal(saved.providers.ollama.modelOverrides["llama3:8b"].contextWindow, 8192);

// A malformed models.json is reported, never silently replaced: the file
// keeps the user's bytes and the caller sees the parse error.
const malformed = join(dir, "malformed.json");
await writeFile(malformed, "{ not json at all");
await assert.rejects(
  setModelContextOverride("ollama", "llama3:8b", 4096, malformed),
  /not valid JSON/,
);
assert.equal(await readFile(malformed, "utf8"), "{ not json at all");

// Concurrent writers serialize instead of losing each other's updates:
// eight simultaneous overrides to distinct models must all survive.
const concurrent = join(dir, "concurrent.json");
await writeFile(concurrent, JSON.stringify({ providers: {} }));
const writers = Array.from({ length: 8 }, (_, i) =>
  setModelContextOverride("ollama", `model-${i}`, (i + 1) * 1000, concurrent),
);
await Promise.all(writers);
saved = JSON.parse(await readFile(concurrent, "utf8"));
const survivors = Object.keys(saved.providers.ollama.modelOverrides).sort();
assert.deepEqual(
  survivors,
  Array.from({ length: 8 }, (_, i) => `model-${i}`).sort(),
  "every concurrent override must survive the write race",
);

// updateModelsJson (the shared writer used by ollama sync) joins the same
// queue: a locked read-modify-write cannot interleave with an override.
await Promise.all([
  updateModelsJson((config) => {
    config.providers.shared = { models: [] };
    return true;
  }, concurrent),
  setModelContextOverride("ollama", "model-8", 9000, concurrent),
]);
saved = JSON.parse(await readFile(concurrent, "utf8"));
assert.ok(saved.providers.shared, "locked writer edit survived");
assert.equal(
  saved.providers.ollama.modelOverrides["model-8"].contextWindow,
  9000,
);

console.log("pi-model-overrides: all assertions passed");