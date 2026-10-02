/**
 * Pi's own context fill: the last assistant reply's provider usage.
 * `totalTokens` is that reply's prompt plus completion (what pi's footer
 * treats as the window). It is not a sum across the session.
 */
export function contextTokensFromPiMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "aborted" || message.stopReason === "error")
      continue;
    const usage = message.usage;
    if (!usage || typeof usage !== "object") continue;
    const total =
      Number(usage.totalTokens) ||
      Number(usage.input || 0) +
        Number(usage.output || 0) +
        Number(usage.cacheRead || 0) +
        Number(usage.cacheWrite || 0);
    if (Number.isFinite(total) && total > 0) return total;
  }
  return 0;
}
