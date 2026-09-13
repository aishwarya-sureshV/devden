/**
 * Single registry of coding-agent backends.
 *
 * A new agent is: add its id here, declare what it can do, and register a
 * pool in index.js. UI and session listing read this list instead of
 * repeating `["pi","claude","grok","codex"]`.
 */

export const AGENT_BACKENDS = ["pi", "claude", "grok", "codex"];

export function backendName(value) {
  if (value === "claude" || value === "grok" || value === "codex") return value;
  return "pi";
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
  return BACKEND_CAPABILITIES[backendName(backend)] ?? DEFAULT_CAPABILITIES;
}

export function listBackends() {
  return AGENT_BACKENDS.map((id) => ({
    id,
    capabilities: capabilitiesFor(id),
  }));
}
