import { useSyncExternalStore } from "react";
import { AGENT_BACKENDS, api, type AgentBackend, type ProviderUsage } from "./api.ts";
import { formatCountdown } from "./time.ts";

/**
 * Backend quota usage, shared by the status footer and the model picker's
 * agent bars. One singleton fetch (GET /api/usage fans out to all four
 * backends server-side) refreshed every 30s — every consumer
 * subscribes to the same store instead of polling its own.
 */

// Just under TICK_MS so timer jitter never skips a tick.
const REFRESH_MS = 25_000;
const TICK_MS = 30_000;

export type BackendUsageMap = Partial<Record<AgentBackend, ProviderUsage>>;

type BackendUsageState = { usage: BackendUsageMap; fetchedAt: number };

let state: BackendUsageState = { usage: {}, fetchedAt: 0 };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function stale() {
  return Date.now() - state.fetchedAt > REFRESH_MS;
}

function refresh(): Promise<void> {
  const request = api
    .backendUsage()
    .then((result) => {
      if (result.ok) {
        // Unreachable server keeps the last numbers and their timestamp, so
        // "last updated" tells the truth instead of the widget going dark.
        // A provider that failed this round keeps its last good numbers
        // (and their time), flagged, instead of claiming a fresh update.
        const now = Date.now();
        const usage: BackendUsageMap = {};
        for (const [id, u] of Object.entries(result.usage) as [AgentBackend, ProviderUsage][]) {
          const prev = state.usage[id];
          usage[id] = u.available
            ? { ...u, okAt: now }
            : prev?.okAt
              ? { ...prev, error: "Usage unavailable" }
              : u;
        }
        state = { usage, fetchedAt: now };
        emit();
      }
    })
    .catch((error) => {
      // Unreachable server: keep the last numbers (and their timestamp) but
      // tag them, so the widget can say the refresh failed. Retry next tick.
      const message = error instanceof Error ? error.message : String(error);
      state = {
        ...state,
        usage: Object.fromEntries(
          // Cached backends plus every known one, so a first-load failure
          // still has an entry to carry the error.
          [...new Set([...Object.keys(state.usage), ...(AGENT_BACKENDS ?? [])])].map((id) => [
            id,
            { ...(state.usage[id as AgentBackend] ?? { available: false, windows: [] }), error: message },
          ]),
        ) as BackendUsageMap,
      };
      emit();
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

function subscribeUsage(onChange: () => void) {
  listeners.add(onChange);
  ensureFresh();
  const timer = setInterval(ensureFresh, TICK_MS);
  return () => {
    listeners.delete(onChange);
    clearInterval(timer);
  };
}

export function useBackendUsage(): BackendUsageMap {
  useSyncExternalStore(
    subscribeUsage,
    () => state.usage,
    () => state.usage,
  );
  return state.usage;
}

/** When the shared numbers were last fetched, for the widget's "updated" line. */
export function useBackendUsageFetchedAt(): number {
  useSyncExternalStore(
    subscribeUsage,
    () => state.fetchedAt,
    () => state.fetchedAt,
  );
  return state.fetchedAt;
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

function percentLeft(window: { usedPercent?: number } | undefined): number | null {
  if (window?.usedPercent === undefined) return null;
  return 100 - Math.max(0, Math.min(100, Math.round(window.usedPercent)));
}

/** 5-hour window and weekly window, as percent left. */
export function usagePair(u: ProviderUsage | undefined): {
  hour: number | null;
  week: number | null;
  reset?: string;
} {
  if (!u?.available) return { hour: null, week: null };
  const hour =
    u.windows.find((window) => /session|hour|5h|24h/i.test(window.label)) ??
    u.windows.find((window) => window.usedPercent !== undefined);
  const week =
    u.windows.find((window) => /week|7d/i.test(window.label)) ??
    u.windows.find(
      (window) => window !== hour && window.usedPercent !== undefined,
    );
  const nearest =
    hour?.resetsAt !== undefined &&
    (week?.resetsAt === undefined || hour.resetsAt <= week.resetsAt)
      ? hour
      : week;
  return {
    hour: percentLeft(hour),
    week: percentLeft(week),
    reset: nearest?.resetsAt ? formatCountdown(nearest.resetsAt) : undefined,
  };
}

export type UsageStatus = { at: number | null; error: string | null };

/** What the usage widget should say about the numbers it is showing: the
 *  fetch's outcome plus when the data was last good. Pure so it can be
 *  tested without a store. */
export function composeUsageStatus(
  /** This session's own fetch: last success time, last failure text. */
  meta: UsageStatus,
  /** True when the widget is showing that per-session result. */
  hasLive: boolean,
  /** The shared all-backends entry for this backend, if the widget fell back. */
  entry: ProviderUsage | undefined,
  /** When the shared fetch last succeeded. */
  fetchedAt: number,
): UsageStatus {
  if (hasLive) return { at: meta.at, error: null };
  const shared =
    entry?.error ?? (entry && !entry.available ? "Usage unavailable" : null);
  // The provider's own data time beats our fetch time (cached numbers).
  const entryAt = entry?.updatedAt ? new globalThis.Date(entry.updatedAt).getTime() : entry?.okAt;
  if (entry?.available) return { at: entryAt ?? fetchedAt, error: meta.error ?? shared };
  if (entry) return { at: meta.at, error: meta.error ?? shared };
  return { at: meta.at ?? (fetchedAt || null), error: meta.error ?? shared };
}
