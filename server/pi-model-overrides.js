/**
 * Per-model context-window overrides in ~/.pi/agent/models.json.
 *
 * Pi reads a model's context window from its catalog; the only way to change
 * one is `providers.<provider>.modelOverrides.<id>.contextWindow`. Verified
 * against a live `pi --mode rpc`: `get_available_models` reflects the
 * override, but a running process only re-reads models.json at startup, so
 * callers must restart the pi process to apply a change mid-session.
 *
 * models.json is a shared user file with a second in-process writer
 * (server/ollama-models.js). All read-modify-write cycles run through
 * `withModelsJsonLock`, so concurrent sessions and catalog syncs serialize
 * instead of losing each other's edits, and the write is a tmp+rename
 * replacement so a crash can never leave a truncated file.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MODELS_JSON = join(homedir(), ".pi", "agent", "models.json");

// One queue for every models.json write in this process, whichever module
// started it. The tail swallows rejections so one failed update cannot
// poison the chain for the next writer.
let writeChain = Promise.resolve();
export function withModelsJsonLock(run) {
  const result = writeChain.then(run, run);
  writeChain = result.catch(() => {});
  return result;
}

/** Read the file. A missing file is an empty config; anything else — a
 * directory, unreadable permissions, malformed JSON — throws so the caller
 * can report it instead of silently replacing the user's configuration. */
async function readModelsJson(file) {
  let contents;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON (${error.message}); refusing to rewrite it`,
    );
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
    return parsed;
  throw new Error(`${file} is not a models.json object; refusing to rewrite it`);
}

/** Atomic replace: a crash mid-write can never leave a truncated file. */
async function writeModelsJson(file, config) {
  const tmp = `${file}.${process.pid}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`);
  await rename(tmp, file);
}

/**
 * One locked read-modify-write cycle over models.json for any writer
 * (this module, ollama catalog sync, …). `mutate(config)` edits the parsed
 * config in place; return false to skip the write. Throws without writing
 * when the existing file cannot be read or parsed.
 */
export async function updateModelsJson(mutate, file = MODELS_JSON) {
  return withModelsJsonLock(async () => {
    const config = await readModelsJson(file);
    const changed = await mutate(config);
    if (changed !== false) await writeModelsJson(file, config);
    return changed;
  });
}

/**
 * The set of "provider\0id" keys that currently carry a contextWindow
 * override. Read-only best-effort: a missing or malformed file yields an
 * empty set — model listing must never fail because of this.
 */
export async function readModelContextOverrides(file = MODELS_JSON) {
  const overridden = new Set();
  let config;
  try {
    config = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return overridden;
  }
  for (const [provider, block] of Object.entries(config?.providers ?? {})) {
    for (const [id, override] of Object.entries(block?.modelOverrides ?? {})) {
      if (override?.contextWindow != null) overridden.add(`${provider}\0${id}`);
    }
  }
  return overridden;
}

/**
 * Set (or, with `null`, remove) the contextWindow override for one model.
 * Preserves every other provider, model and override in the file. Returns
 * true when the file changed. Throws without writing when the existing
 * file cannot be read or parsed.
 */
export async function setModelContextOverride(
  provider,
  modelId,
  contextWindow,
  file = MODELS_JSON,
) {
  return updateModelsJson(
    (config) => {
      if (!config.providers || typeof config.providers !== "object")
        config.providers = {};
      const providerEntry = config.providers[provider];
      // The provider block may be a thin custom-models entry or absent for
      // built-ins; modelOverrides works on both.
      const block =
        providerEntry && typeof providerEntry === "object" ? providerEntry : {};
      if (!block.modelOverrides || typeof block.modelOverrides !== "object")
        block.modelOverrides = {};
      config.providers[provider] = block;

      const override = block.modelOverrides[modelId];
      if (contextWindow == null) {
        if (override == null || override.contextWindow == null) return false;
        // Drop only contextWindow: the entry may carry other user overrides.
        delete override.contextWindow;
        if (!Object.keys(override).length) delete block.modelOverrides[modelId];
        if (!Object.keys(block.modelOverrides).length)
          delete block.modelOverrides;
        // Leave a now-empty provider block behind: pi tolerates it, and
        // deleting a block the user hand-wrote would be worse than the
        // clutter.
      } else {
        const entry = override && typeof override === "object" ? override : {};
        if (entry.contextWindow === contextWindow) return false;
        entry.contextWindow = contextWindow;
        block.modelOverrides[modelId] = entry;
      }
      return true;
    },
    file,
  );
}