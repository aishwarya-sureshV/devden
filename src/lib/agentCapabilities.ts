import type { AgentBackend } from "./api";

/**
 * Mirrors server/agent-registry.js. A test compares the two so a new
 * backend cannot ship with the UI offering a control the server will 500.
 */
export type AgentCapabilities = {
  steer: boolean;
  fork: boolean;
  truncate: boolean;
  compact: boolean;
  compactInstructions: boolean;
  queue: boolean;
  subagents: boolean;
  contextUsage: boolean;
  settings: boolean;
  mcp: boolean;
  lazyStart: boolean;
  setSessionName: boolean;
  rewindFiles: boolean;
  warmStart: boolean;
};

const DEFAULT_CAPABILITIES: AgentCapabilities = {
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

const BACKEND_CAPABILITIES: Record<AgentBackend, AgentCapabilities> = {
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

export function capabilitiesFor(backend: AgentBackend): AgentCapabilities {
  return BACKEND_CAPABILITIES[backend] ?? DEFAULT_CAPABILITIES;
}
