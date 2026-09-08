/**
 * Codex plan/rate-limit reporting. Reads the signed-in user's snapshot
 * through the app-server protocol -- no thread is started and no account
 * state is mutated. Shared by the Pi agent (when it is driving an
 * openai-codex model) and by the Codex agent itself.
 */
import { codexRequest } from "./codex-app-server.js";

export function readCodexRateLimits() {
  return codexRequest("account/rateLimits/read");
}

function usageWindowLabel(seconds) {
  if (seconds <= 6 * 60 * 60) return "Current session";
  if (seconds >= 6 * 24 * 60 * 60 && seconds <= 8 * 24 * 60 * 60)
    return "Current week";
  const hours = Math.round(seconds / 3600);
  return hours >= 48
    ? `${Math.round(hours / 24)} day limit`
    : `${hours} hour limit`;
}

function formatResetTime(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return undefined;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(epochSeconds * 1000));
}

/**
 * The usage panel's shape, from Codex's rate limits. `modelId` only picks
 * which limit bucket applies -- Spark models bill against their own.
 */
export async function loadCodexUsage(modelId) {
  try {
    const payload = await readCodexRateLimits();
    const normalizedModel = String(modelId ?? "").toLowerCase();
    const rateLimits = Object.values(payload?.rateLimitsByLimitId ?? {}).filter(
      Boolean,
    );
    const selected = normalizedModel.includes("spark")
      ? rateLimits.find((entry) =>
          `${entry?.limitId ?? ""} ${entry?.limitName ?? ""}`
            .toLowerCase()
            .includes("spark"),
        )
      : rateLimits.find(
          (entry) => String(entry?.limitId ?? "").toLowerCase() === "codex",
        );
    const limits = selected ?? payload?.rateLimits ?? rateLimits[0];
    const windows = [limits?.primary, limits?.secondary]
      .filter(Boolean)
      .map((window) => ({
        label: usageWindowLabel(Number(window.windowDurationMins ?? 0) * 60),
        usedPercent: Number(window.usedPercent ?? 0),
        ...(formatResetTime(Number(window.resetsAt))
          ? { resetsAt: formatResetTime(Number(window.resetsAt)) }
          : {}),
      }));
    return {
      ok: true,
      usage: {
        available: windows.length > 0,
        provider: "Codex",
        plan:
          String(limits?.planType ?? "")
            .replace(
              /(^|_)(\w)/g,
              (_match, _prefix, letter) => ` ${letter.toUpperCase()}`,
            )
            .trim() || undefined,
        windows,
        updatedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
