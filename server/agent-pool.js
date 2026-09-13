/**
 * One process pool for every backend. Each agent file used to copy this
 * Map get/stop verbatim.
 */
export class AgentPool {
  constructor(createProcess) {
    this.createProcess = createProcess;
    this.agents = new Map();
  }

  get(sessionKey) {
    let agent = this.agents.get(sessionKey);
    if (!agent) {
      agent = this.createProcess(sessionKey);
      this.agents.set(sessionKey, agent);
    }
    return agent;
  }

  stop(sessionKey) {
    if (sessionKey) {
      this.agents.get(sessionKey)?.stop();
      this.agents.delete(sessionKey);
      return;
    }
    for (const agent of this.agents.values()) agent.stop();
    this.agents.clear();
  }
}
