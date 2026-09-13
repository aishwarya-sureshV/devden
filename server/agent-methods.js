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

export async function callAgentMethod(agent, method, args = [], capability) {
  if (!hasMethod(agent, method)) {
    const name = capability ?? method;
    return unsupported(name, `This agent does not support ${name}.`);
  }
  return agent[method](...args);
}
