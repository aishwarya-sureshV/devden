import { useSyncExternalStore } from "react";
import { api, type AgentBackend, type ProviderUsage } from "./api";
import { formatCountdown } from "./time";

/**
 * Backend quota usage, shared by the status footer and the model picker's
 * agent bars. One singleton fetch (GET /api/usage fans out to all four
 * backends server-side) refreshed every few minutes — every consumer
 * subscribes to the same store instead of polling its own.
 */

const REFRESH_MS = 5 * 60_000;
const TICK_MS = 30_000;

export type BackendUsageMap = Partial<Record<AgentBackend, ProviderUsage>>;

let usage: BackendUsageMap = {};
let fetchedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function stale() {
  return Date.now() - fetchedAt > REFRESH_MS;
}

function refresh(): Promise<void> {
  const request = api
    .backendUsage()
    .then((result) => {
      if (result.ok) {
        usage = result.usage;
        fetchedAt = Date.now();
        emit();
      }
    })
    .catch(() => {
      // Unreachable server: keep the last numbers, retry on the next tick.
    })
    .finally(() => {
      inflight = null;
    });
  inflight = request;
  return request;
}

function ensureFresh() {
  if (!inflight && stale()) void refresh();
}

export function useBackendUsage(): BackendUsageMap {
  useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      ensureFresh();
      const timer = setInterval(ensureFresh, TICK_MS);
      return () => {
        listeners.delete(onChange);
        clearInterval(timer);
      };
    },
    () => usage,
    () => usage,
  );
  return usage;
}

/** The pressing window: the session/5-hour limit, else the first measured one. */
export function usageLeft(u: ProviderUsage | undefined): {
  left: number | null;
  text?: string;
  resetIn?: string;
} {
  if (!u?.available) return { left: null };
  const windows = u.windows;
  const primary =
    windows.find((w) => /session|hour|24h/i.test(w.label)) ??
    windows.find((w) => w.usedPercent !== undefined) ??
    windows[0];
  if (!primary) return { left: null };
  const left =
    primary.usedPercent === undefined
      ? null
      : 100 - Math.max(0, Math.min(100, Math.round(primary.usedPercent)));
  return {
    left,
    text: primary.usedText,
    resetIn: primary.resetsAt ? formatCountdown(primary.resetsAt) : undefined,
  };
}
