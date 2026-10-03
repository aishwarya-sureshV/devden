// Share concurrent lookups, expire every backend, and retain the last good
// catalog when a provider is temporarily offline.
export const MODEL_CATALOG_TTL_MS = 5 * 60_000;
const catalogs = new Map();

export function clearModelCatalogs() {
  catalogs.clear();
}

export function cachedModels(agent) {
  const key = `${agent.__watchedBackend ?? "pi"}\0${agent.cwd ?? ""}`;
  const hit = catalogs.get(key);
  if (hit && Date.now() - hit.at < MODEL_CATALOG_TTL_MS) return hit.promise;
  const row = { at: Date.now(), result: hit?.result };
  row.promise = Promise.resolve()
    .then(() => agent.getAvailableModels())
    .catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
    .then((result) => {
      if (result?.ok && result.models?.length) row.result = result;
      else {
        // Retry on the next request; a failure must not extend the TTL.
        row.at = 0;
        result = row.result ?? result;
      }
      return result;
    });
  catalogs.set(key, row);
  return row.promise;
}
