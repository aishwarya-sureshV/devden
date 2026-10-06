/**
 * Single registry of coding-agent backends.
 *
 * The four built-ins stay a fixed list (session files live in their own
 * directories). listBackends() adds detection
 * results; the client reads that payload from /api/backends.
 */

import { connectionCommand, detectBuiltins } from "./agent-detect.js";
import { docGet, docSet } from "./db.js";

export const AGENT_BACKENDS = ["pi", "claude", "grok", "codex", "zcode"];

/**
 * Agents the user switched off in Settings: hidden from pickers, never
 * auto-started. Persisted as the disabled set so a missing row means enabled
 * (pre-toggle installs and old payloads stay untouched).
 */
export function readDisabledBackends() {
  const raw = docGet("setup", "agents");
  const disabled = Array.isArray(raw?.disabled) ? raw.disabled : [];
  return new Set(disabled.filter((id) => AGENT_BACKENDS.includes(id)));
}

/** Toggle one agent. `id` is coerced through backendName, so a client can
 *  never plant an arbitrary doc-store key. Returns the fresh disabled set. */
export function setBackendEnabled(id, enabled) {
  const name = backendName(id);
  const disabled = readDisabledBackends();
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  docSet("setup", "agents", { disabled: [...disabled] });
  return [...disabled];
}

export function backendName(value) {
  if (value === "claude" || value === "grok" || value === "codex" || value === "pi" || value === "zcode")
    return value;
  return "pi";
}

export function allBackendIds() {
  return [...AGENT_BACKENDS];
}

/** Same as backendName, but "all" survives — session listing/search accept it. */
export function sessionScope(value) {
  return value === "all" ? "all" : backendName(value);
}

/**
 * What the web workbench can offer for one backend.
 *
 * Protocol-specific methods stay on the process class. This map is the
 * contract the router and UI share so a missing method is hidden rather than
 * thrown, and a fifth agent can opt in without new `=== "foo"` branches.
 */
const DEFAULT_CAPABILITIES = {
  steer: true,
  fork: true,
  truncate: false,
  compact: true,
  compactInstructions: true,
  queue: true,
  subagents: true,
  contextUsage: false,
  settings: false,
  mcp: false,
  lazyStart: true,
  setSessionName: false,
  rewindFiles: false,
  warmStart: false,
  setContextWindow: false,
};

export const BACKEND_CAPABILITIES = {
  pi: {
    ...DEFAULT_CAPABILITIES,
    contextUsage: true,
    setSessionName: true,
    setContextWindow: true,
  },
  claude: {
    ...DEFAULT_CAPABILITIES,
    contextUsage: true,
    settings: true,
    mcp: true,
    rewindFiles: true,
  },
  grok: {
    ...DEFAULT_CAPABILITIES,
    steer: false,
    fork: true,
    contextUsage: true,
    warmStart: true,
  },
  codex: {
    ...DEFAULT_CAPABILITIES,
    fork: true,
    compactInstructions: false,
    setSessionName: true,
    contextUsage: true,
    settings: true,
    mcp: true,
    setContextWindow: true,
  },
  zcode: {
    // ponytail: first pass is the live-conversation vertical slice; flip
    // flags on as forkAt/compact/session listing land.
    ...DEFAULT_CAPABILITIES,
    steer: false,
    fork: false,
    truncate: false,
    compact: false,
    compactInstructions: false,
    queue: true,
    subagents: false,
    contextUsage: false,
    setSessionName: false,
    warmStart: false,
  },
};

export function capabilitiesFor(backend) {
  if (BACKEND_CAPABILITIES[backend]) return BACKEND_CAPABILITIES[backend];
  return BACKEND_CAPABILITIES[backendName(backend)] ?? DEFAULT_CAPABILITIES;
}

export async function listBackends() {
  const detected = await detectBuiltins();
  const disabled = readDisabledBackends();
  const byId = new Map(detected.map((row) => [row.id, row]));
  const builtins = AGENT_BACKENDS.map((id) => {
    const row = byId.get(id);
    return {
      id,
      name: id,
      command: id,
      args: id === "grok" ? ["agent", "stdio"] : id === "zcode" ? ["agent-server"] : [],
      path: row?.path ?? null,
      pathLabel: row?.pathLabel ?? null,
      version: row?.version ?? null,
      auth: row?.auth ?? "unknown",
      installCommand: row?.installCommand ?? null,
      loginCommand: row?.loginCommand ?? null,
      connectCommand: connectionCommand(id, row?.path),
      enabled: !disabled.has(id),
      capabilities: capabilitiesFor(id),
    };
  });
  return builtins;
}
