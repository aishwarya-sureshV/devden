/**
 * Single registry of coding-agent backends.
 *
 * The four built-ins stay a fixed list (session files live in their own
 * directories). listBackends() adds detection
 * results; the client reads that payload from /api/backends.
 */

import { detectBuiltins } from "./agent-detect.js";

export const AGENT_BACKENDS = ["pi", "claude", "grok", "codex"];

export function backendName(value) {
  if (value === "claude" || value === "grok" || value === "codex" || value === "pi")
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
};

export const BACKEND_CAPABILITIES = {
  pi: {
    ...DEFAULT_CAPABILITIES,
    setSessionName: true,
  },
  claude: {
    ...DEFAULT_CAPABILITIES,
    lazyStart: false,
    contextUsage: true,
    settings: true,
    mcp: true,
    rewindFiles: true,
  },
  grok: {
    ...DEFAULT_CAPABILITIES,
    steer: false,
    fork: true,
    warmStart: true,
  },
  codex: {
    ...DEFAULT_CAPABILITIES,
    fork: true,
    compactInstructions: false,
    setSessionName: true,
  },
};

export function capabilitiesFor(backend) {
  if (BACKEND_CAPABILITIES[backend]) return BACKEND_CAPABILITIES[backend];
  return BACKEND_CAPABILITIES[backendName(backend)] ?? DEFAULT_CAPABILITIES;
}

export async function listBackends() {
  const detected = await detectBuiltins();
  const byId = new Map(detected.map((row) => [row.id, row]));
  const builtins = AGENT_BACKENDS.map((id) => {
    const row = byId.get(id);
    return {
      id,
      name: id,
      command: id,
      args: id === "grok" ? ["agent", "stdio"] : [],
      path: row?.path ?? null,
      pathLabel: row?.pathLabel ?? null,
      version: row?.version ?? null,
      auth: row?.auth ?? "unknown",
      installCommand: row?.installCommand ?? null,
      loginCommand: row?.loginCommand ?? null,
      capabilities: capabilitiesFor(id),
    };
  });
  return builtins;
}
