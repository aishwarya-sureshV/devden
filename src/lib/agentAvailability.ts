// Which agents the UI may offer: enabled in Settings, installed, signed in.
// One module so the model picker, the sidebar and the orphaned-session
// handoff all judge "usable" the same way.
import { AGENT_BACKENDS, type AgentBackend, type BackendInfo } from "./api.ts";

/** An agent a session can actually run on right now. */
export function backendUsable(row: BackendInfo | undefined): boolean {
  return Boolean(row?.path) && row?.auth === "ok" && row?.enabled !== false;
}

/**
 * Backend ids offered in pickers. Disabled agents are hidden; an empty
 * catalog (fetch failed, old server) falls back to every built-in so a
 * transient error can never empty the picker.
 */
export function pickerBackendIds(catalog: BackendInfo[]): AgentBackend[] {
  const ids = catalog
    .filter((row) => row.enabled !== false)
    .map((row) => row.id);
  return ids.length ? ids : ([...AGENT_BACKENDS] as AgentBackend[]);
}

/**
 * The agent to offer when a session's own agent is gone (CLI uninstalled,
 * signed out, or disabled): the preferred one when usable, else the first
 * usable agent. Null when the current agent works or nothing can take over.
 */
export function handoffTarget(
  current: AgentBackend,
  catalog: BackendInfo[],
  preferred?: AgentBackend,
): AgentBackend | null {
  if (backendUsable(catalog.find((row) => row.id === current))) return null;
  const usable = catalog.filter(backendUsable).map((row) => row.id);
  if (usable.length === 0) return null;
  if (preferred && usable.includes(preferred)) return preferred;
  return usable[0];
}