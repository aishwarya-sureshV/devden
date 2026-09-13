/**
 * Grok account usage. Shared by the grok backend and by pi sessions that
 * are running a grok-sdk model — both used to fetch the same billing
 * endpoint with copy-pasted token + HTTP code.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const GROK_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";
export const GROK_PROXY_HEADERS = {
  "User-Agent": "grok-cli",
  "x-xai-token-auth": "xai-grok-cli",
};

export function grokHome() {
  return process.env.GROK_HOME || join(homedir(), ".grok");
}

export function grokAuthPath() {
  return join(grokHome(), "auth.json");
}

export async function readGrokToken() {
  try {
    const auth = JSON.parse(await readFile(grokAuthPath(), "utf8"));
    return (
      auth?.["https://accounts.x.ai/sign-in"]?.key ??
      Object.values(auth ?? {}).find((entry) => typeof entry?.key === "string")
        ?.key
    );
  } catch {
    return undefined;
  }
}

const EMPTY = {
  ok: true,
  usage: { available: false, provider: "Grok", windows: [] },
};

export async function loadGrokUsage() {
  try {
    const token = await readGrokToken();
    if (typeof token !== "string" || token.length === 0) return EMPTY;
    const response = await fetch(`${GROK_PROXY_BASE}/billing?format=credits`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...GROK_PROXY_HEADERS,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`Grok usage returned ${response.status}`);
    const payload = await response.json();
    const config = payload?.config ?? payload;
    const usedPercent = Number(config?.creditUsagePercent);
    const resetAt =
      Date.parse(
        String(config?.currentPeriod?.end ?? config?.billingPeriodEnd ?? ""),
      ) / 1000;
    const resetsAt = Number.isFinite(resetAt) ? resetAt * 1000 : undefined;
    const windows = Number.isFinite(usedPercent)
      ? [
          {
            label: "Current week",
            usedPercent,
            ...(resetsAt ? { resetsAt } : {}),
          },
        ]
      : [];
    return {
      ok: true,
      usage: {
        available: windows.length > 0,
        provider: "Grok",
        windows,
        updatedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
