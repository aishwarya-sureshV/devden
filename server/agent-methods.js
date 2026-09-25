/**
 * Safe dispatch onto a backend process. Missing methods and capability
 * flags return `{ ok: false, unsupported: true }` instead of throwing, so a
 * new agent that has not implemented fork/steer/truncate cannot 500 the UI.
 */

export function unsupported(capability, message) {
  return {
    ok: false,
    unsupported: true,
    capability,
    error: message,
  };
}

export function hasMethod(agent, method) {
  return typeof agent?.[method] === "function";
}

export function agentIsAlive(agent) {
  if (!agent) return false;
  if (typeof agent.isAlive === "function") return Boolean(agent.isAlive());
  return Boolean(agent.process);
}

/**
 * A fork tab must spawn its own process. Adopting would steal the parent's
 * agent, so compact/prompt on the child would run on the parent. Page
 * refresh still adopts (`independent` is unset).
 */
export function shouldAdoptLiveAgent(body = {}) {
  return body.independent !== true;
}

/** Options the prompt and fork routes both have to hand to start(). */
export function startOptionsFromBody(body = {}) {
  const agentMode =
    body.agentMode === "plan" || body.agentMode === "manual"
      ? body.agentMode
      : undefined;
  return {
    sessionPath:
      typeof body.sessionPath === "string" && body.sessionPath
        ? body.sessionPath
        : undefined,
    model:
      body.model && typeof body.model === "object"
        ? {
            provider: String(body.model.provider || ""),
            id: String(body.model.id || ""),
          }
        : undefined,
    thinkingLevel:
      typeof body.thinkingLevel === "string" ? body.thinkingLevel : undefined,
    accessMode: body.accessMode === "read-only" ? "read-only" : undefined,
    ...(agentMode ? { agentMode } : {}),
  };
}

/**
 * A live turn, not a stale isStreaming bit and not a background child.
 * Pi's fork command rebinds the same process, so a fork during a turn aborts it.
 */
export function agentIsStreaming(agent) {
  if (!agent) return false;
  if (agent.status === "working") return true;
  if (agent.turn && agent.turn.idle !== true) return true;
  if (Array.isArray(agent.pendingTurns) && agent.pendingTurns.length > 0)
    return true;
  return false;
}

/** One fork per agent. Check-and-set is synchronous, so two requests can't both pass. */
export function claimFork(agent) {
  if (!agent) return { ok: false, error: "No session is available to fork." };
  if (agent.forking)
    return {
      ok: false,
      error: "A fork is already running for this session.",
    };
  if (agentIsStreaming(agent))
    return {
      ok: false,
      error: "Wait for the current reply to finish before forking.",
    };
  if (Array.isArray(agent.queuedMessages) && agent.queuedMessages.length > 0)
    return {
      ok: false,
      error: "Wait for queued messages to finish before forking.",
    };
  agent.forking = true;
  return { ok: true };
}

export function releaseFork(agent) {
  if (agent) agent.forking = false;
}

export async function callAgentMethod(agent, method, args = [], capability) {
  if (!hasMethod(agent, method)) {
    const name = capability ?? method;
    return unsupported(name, `This agent does not support ${name}.`);
  }
  return agent[method](...args);
}
