/**
 * Grok's own numbers, read off the session directory.
 *
 * `updates.jsonl` stamps the current context-window fill on every line
 * (`params._meta.totalTokens`). `usage.json` is the session ledger: each
 * turn's `inputTokens` already includes cached reads, and the `session`
 * object is the sum of those turns. Neither number is a character guess.
 */

export function contextTokensFromJournal(contents) {
  let total = 0;
  for (const line of String(contents || "").split("\n")) {
    if (!line.includes("totalTokens")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const value = Number(event?.params?._meta?.totalTokens);
    if (Number.isFinite(value) && value > 0) total = value;
  }
  return total;
}

/** turn_completed usage objects that actually carry token counts. */
export function turnUsagesFromJournal(contents) {
  const turns = [];
  for (const line of String(contents || "").split("\n")) {
    if (!line.includes("turn_completed")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const update = event?.params?.update;
    const usage = update?.usage;
    if (update?.sessionUpdate !== "turn_completed" || !usage) continue;
    if (!Number.isFinite(Number(usage.inputTokens)) && !Number.isFinite(Number(usage.outputTokens)))
      continue;
    turns.push(usage);
  }
  return turns;
}

/**
 * The catalog window for this model. A runtime id like `grok-4.7-build`
 * matches the catalog id it starts with (`grok-4.7`), longest prefix first.
 */
export function contextWindowForModel(catalog, modelId) {
  const models = Array.isArray(catalog) ? catalog : [];
  const id = String(modelId || "");
  const exact = models.find((model) => (model?.id ?? model?.model) === id);
  const prefixed = models
    .filter((model) => {
      const catalogId = String(model?.id ?? model?.model ?? "");
      return catalogId && id.startsWith(catalogId);
    })
    .sort(
      (left, right) =>
        String(right?.id ?? right?.model).length -
        String(left?.id ?? left?.model).length,
    );
  const entry = exact ?? prefixed[0];
  const maxTokens = Number(entry?.context_window);
  if (!entry || !Number.isFinite(maxTokens) || maxTokens <= 0) return null;
  const percent = Number(entry.auto_compact_threshold_percent);
  const auto =
    entry.compaction_at_tokens === true && Number.isFinite(percent) && percent > 0;
  return {
    maxTokens,
    model: String(entry.id ?? entry.model ?? id),
    autoCompactThreshold: auto ? Math.round((maxTokens * percent) / 100) : 0,
    isAutoCompactEnabled: auto,
  };
}
