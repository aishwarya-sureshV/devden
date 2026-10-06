// Reproduce a ZCode notification lost while an empty event pull is in flight.
// No CLI, credentials, model request, or network connection is used.
import assert from 'node:assert/strict';
import { ZcodeAgentProcess } from '../server/zcode-agent.js';

const agent = new ZcodeAgentProcess('latency-audit');
agent.sessionId = 'synthetic';
const pending = Promise.withResolvers();
let calls = 0;
const received = [];
agent.handleSessionEvent = event => received.push(event);
agent.connection = {
  running: true,
  request: async () => {
    calls++;
    if (calls === 1) return pending.promise;
    return { events: calls === 2 ? [{ seq: 1, type: 'synthetic' }] : [] };
  },
};
const draining = agent.drainEvents();
agent.handleNotification({ method: 'state.updated', params: { sessionId: 'synthetic' } });
pending.resolve({ events: [] });
await draining;
assert.equal(calls, 1);
assert.equal(received.length, 0);
console.log('Reproduced: notification during empty in-flight pull did not trigger another pull.');
await agent.drainEvents();
assert.equal(received.length, 1);
assert.equal(agent.lastSeq, 1);
console.log('Event was delivered only after a later explicit drain.');
