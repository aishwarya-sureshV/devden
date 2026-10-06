// Run: node scripts/performance-audit.mjs (Node with TypeScript stripping).
// Synthetic CPU checks; no agents, network, or user session data.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { isSubagentCheckIn } from '../src/lib/subagents.ts';
import { childSessionEvents } from '../server/pi-subagent.js';

function medianMs(run) {
  run();
  const samples = Array.from({ length: 5 }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  });
  return Number(samples.sort((a, b) => a - b)[2].toFixed(2));
}

for (const count of [1000, 5000, 10000]) {
  const items = Array.from({ length: count }, (_, i) => ({
    id: String(i), kind: 'assistant', text: 'Ordinary reply', live: false,
    timestamp: i,
  }));
  assert.equal(items.filter(item => !isSubagentCheckIn(item, items)).length, count);
  console.log(JSON.stringify({ check: 'conversation check-in filter, no subagents',
    items: count,
    medianMs: medianMs(() => items.filter(item => !isSubagentCheckIn(item, items))),
  }));
}

for (const count of [1000, 10000, 50000]) {
  const row = JSON.stringify({ type: 'message', message: {
    role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(900) }],
  } });
  const contents = `${row}\n`.repeat(count);
  const replay = () => childSessionEvents(contents, count, 'stream', 'parent');
  assert.equal(replay().events.length, 0);
  console.log(JSON.stringify({ check: 'unchanged Pi child log reparse',
    bytes: Buffer.byteLength(contents), medianMs: medianMs(replay),
  }));
}

const images = Object.fromEntries(Array.from({ length: 12 }, (_, i) =>
  [String(i), { name: 'photo.jpg', data: 'x'.repeat(200000) }]));
const serialized = JSON.stringify(images);
assert.ok(serialized.length > 2400000);
console.log(JSON.stringify({ check: 'Notes image JSON per edit (excludes localStorage I/O)',
  bytes: serialized.length, medianMs: medianMs(() => JSON.stringify(images)),
}));
