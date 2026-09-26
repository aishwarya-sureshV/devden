/**
 * Same wall the composer banner uses (src/lib/usageLimit.ts). A turn that
 * dies on one of these did not finish — a queued follow-up has to stay
 * queued until a later turn actually completes.
 *
 * Keep the patterns in lockstep with LIMIT_ERROR_PATTERNS in that file.
 */
const LIMIT_ERROR_PATTERNS = [
  /usage [a-z ]{0,12}limit/i,
  /usage balance/i,
  /insufficient_quota/i,
  /exceeded your current quota/i,
  /quota exceeded/i,
  /out of budget/i,
  /credit balance is too low/i,
  /hit your [^.]{0,30}(?:limit|spend cap)/i,
];

export function isUsageLimitError(text) {
  const value = String(text ?? "");
  return LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(value));
}

/** Provider sentence on a pi/codex/claude turn event, if it is a quota wall. */
export function limitErrorText(event) {
  const parts = [];
  const push = (value) => {
    if (typeof value === "string" && value.trim()) parts.push(value);
  };
  push(event?.message?.errorMessage);
  push(event?.errorMessage);
  push(event?.finalError);
  if (Array.isArray(event?.messages)) {
    for (const message of event.messages) push(message?.errorMessage);
  }
  return parts.find((text) => isUsageLimitError(text)) ?? "";
}
