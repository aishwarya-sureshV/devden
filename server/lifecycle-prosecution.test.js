import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { isAuthErrorText } from './auth-events.js';
import { signOutBackend, signOutPiCredentials } from './agent-detect.js';

// Execute the actual declarations without importing index.js (which listens).
function declarations(file, names, dependencies, tail) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const parts = ast.statements.filter(s => names.includes(s.name?.text));
  assert.equal(parts.length, names.length, 'all tested functions must exist');
  const code = parts.map(s => s.getText(ast).replace(/^export /, '')).join('\n');
  return new Function(...Object.keys(dependencies), `${code}\n${tail}`)(...Object.values(dependencies));
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function keepalive(bootAuth = 'ok', initial = { ok: true }) {
  let next = initial, ping;
  const events = [];
  const start = declarations('./claude-agent.js', ['startClaudeAuthKeepalive'], {
    AUTH_KEEPALIVE_MS: 100,
    loadClaudeUsage: () => Promise.resolve(next),
    console: { warn() {} },
    setInterval: fn => { ping = fn; return { unref() { return this; } }; },
  }, 'return startClaudeAuthKeepalive;');
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const boot = source.slice(source.indexOf('  const claudeSignedInAtBoot ='), source.indexOf('  listOllamaModels()', source.indexOf('  const claudeSignedInAtBoot =')));
  assert.match(boot, /startClaudeAuthKeepalive/);
  new Function('detectBuiltins', 'startClaudeAuthKeepalive', 'isAuthErrorText', 'emitBackendAuth', boot)(
    async () => [{ id: 'claude', auth: bootAuth }], start, isAuthErrorText,
    (backend, error) => events.push({ backend, error }),
  );
  return { events, async tick(result) { await settle(); next = result; await ping(); await settle(); } };
}

test('A4: a network failure must not consume the later expired-login notification', async () => {
  const k = keepalive();
  await k.tick({ ok: false, error: 'Network request timed out' });
  assert.equal(k.events.length, 0);
  await k.tick({ ok: false, error: 'OAuth token has expired' });
  assert.equal(k.events.length, 1, 'expired login must emit backend_auth after a network outage');
});

test('A5: an account connected after server boot still reports its later expiry', async () => {
  const k = keepalive('missing');
  await k.tick({ ok: true }); // Connect succeeded since startup.
  await k.tick({ ok: false, error: 'Not logged in' });
  assert.equal(k.events.length, 1, 'login after boot must not require a server restart');
});

test('A3: keepalive deduplicates one expiry and rearms after successful recovery', async () => {
  const k = keepalive();
  await k.tick({ ok: false, error: 'Not logged in' });
  await k.tick({ ok: false, error: 'Not logged in' });
  assert.equal(k.events.length, 1);
  await k.tick({ ok: true });
  await k.tick({ ok: false, error: 'Not logged in' });
  assert.equal(k.events.length, 2);
});

function publisher() {
  const broadcasts = [], logs = [];
  let invalidations = 0;
  const publish = declarations('./index.js', ['publishRuntimeEvent', 'emitBackendAuth'], {
    trackTurnLifecycle() {},
    recordRuntimeEvent(key, source, event) { logs.push({ key, event }); return { id: 'log', timestamp: 1 }; },
    broadcast: event => broadcasts.push(event),
    KEY_ALIASES: new Map([['old-tab', 'c1']]),
    AGENT_BACKENDS: ['claude', 'codex'],
    sessionBackends: new Map([['c1', 'claude'], ['c2', 'claude'], ['x1', 'codex']]),
    authAlerts: new Set(), isAuthErrorText,
    clearDetectionCache() { invalidations++; },
    prosecutor: { onExecutorEvent() {} }, poolFor: () => ({ agents: new Map() }),
  }, 'return publishRuntimeEvent;');
  return { publish, broadcasts, logs, invalidations: () => invalidations };
}

for (const [label, event, source] of [
  ['notice', { type: 'notice', tone: 'error', message: '401 Unauthorized' }, 'claude'],
  ['message_end', { type: 'message_end', message: { errorMessage: 'Not logged in' } }, 'claude'],
  ['server notice', { type: 'notice', tone: 'error', message: '401 Unauthorized' }, 'server'],
]) test(`A1/A2: ${label} fans auth loss to matching sessions and aliases only`, () => {
  const p = publisher();
  p.publish('c1', source, event);
  assert.deepEqual(p.broadcasts.filter(e => e.type === 'backend_auth').map(e => e.sessionKey), [undefined, 'c1', 'old-tab', 'c2']);
  assert.equal(p.invalidations(), 1);
  assert.deepEqual(p.logs.filter(e => e.event.type === 'backend_auth').map(e => e.key), ['c1', 'c2']);
});

test('A1: network and quota errors do not request reauthentication', () => {
  const p = publisher();
  for (const message of ['Network request timed out', 'rate limit reached', 'exit code 1401'])
    p.publish('c1', 'claude', { type: 'notice', tone: 'error', message });
  assert.equal(p.broadcasts.filter(e => e.type === 'backend_auth').length, 0);
});

test('A3: runtime auth logs deduplicate until a new turn starts', () => {
  const p = publisher(), event = { type: 'notice', tone: 'error', message: 'Not logged in' };
  p.publish('c1', 'claude', event);
  p.publish('c1', 'claude', event);
  assert.equal(p.logs.filter(e => e.event.type === 'backend_auth' && e.key === 'c1').length, 1);
  p.publish('c1', 'claude', { type: 'agent_start' });
  p.publish('c1', 'claude', event);
  assert.equal(p.logs.filter(e => e.event.type === 'backend_auth' && e.key === 'c1').length, 2);
});

test('L2: CLI failure and disappearing executable return actionable logout errors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prosecution-logout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'cli with spaces');
  await writeFile(bin, '#!/bin/sh\necho "logout service unavailable" >&2\nexit 1\n', { mode: 0o755 });
  assert.match((await signOutBackend('codex', { path: bin })).error, /logout service unavailable/);
  assert.equal((await signOutBackend('claude', { path: join(dir, 'missing') })).ok, false);
});

test('L2: logout timeout is bounded and surfaced as a failed result', async () => {
  const fn = declarations('./agent-detect.js', ['signOutBackend'], {
    LOGOUT_ARGS: { codex: ['logout'] },
    execFileAsync: async (_path, _args, options) => {
      assert.equal(options.timeout, 20_000);
      throw new Error('logout timed out');
    },
  }, 'return signOutBackend;');
  assert.deepEqual(await fn('codex', { path: '/fake/codex' }), { ok: false, error: 'logout timed out' });
});

test('L2: malformed Pi credentials are preserved; repeated logout reports signed out', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prosecution-pi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'auth.json');
  await writeFile(file, '{broken');
  assert.equal((await signOutPiCredentials(dir)).ok, false);
  assert.equal(await readFile(file, 'utf8'), '{broken');
  await writeFile(file, JSON.stringify({ anthropic: { type: 'oauth', access: 'test' } }));
  assert.equal((await signOutPiCredentials(dir)).ok, true);
  assert.equal((await signOutPiCredentials(dir)).ok, false);
});

test('L2: Pi disk write failure cannot be reported as successful logout', async () => {
  const fn = declarations('./agent-detect.js', ['signOutPiCredentials'], {
    join, readFile: async () => '{"anthropic":{"type":"oauth","access":"test"}}',
    writeFile: async () => { throw new Error('EACCES: permission denied'); },
  }, 'return signOutPiCredentials;');
  await assert.rejects(fn('/scratch'), /permission denied/);
});

test('A9: a genuinely signed-out boot can recover and later announce expiry', async () => {
  // The older A5 harness begins with a successful immediate ping even when
  // detection says "missing". Exercise the real initially failing ping too.
  const k = keepalive('missing', { ok: false, error: 'Not logged in' });
  await settle();
  assert.equal(k.events.length, 0);
  await k.tick({ ok: true });
  await k.tick({ ok: false, error: 'OAuth token has expired' });
  assert.equal(k.events.length, 1);
});

test('U13: the shared usage route isolates a throwing provider from healthy providers', async () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.js', source, ts.ScriptTarget.Latest, true);
  let route;
  function visit(node) {
    if (ts.isIfStatement(node) && node.expression.getText(ast) === 'pathname === "/api/usage" && req.method === "GET"')
      route = node.thenStatement.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(route, 'test must execute the actual usage route');
  const usage = { available: true, windows: [{ label: '5 hours', usedPercent: 25 }], updatedAt: '2026-10-06T09:55:00Z' };
  const run = new Function('AGENT_BACKENDS', 'poolFor', 'sendJson', 'res', `return (async () => ${route})();`);
  const result = await run(['claude', 'codex'], backend => ({
    get: () => ({ getUsage: () => {
      if (backend === 'claude') throw new Error('provider unavailable');
      return Promise.resolve({ ok: true, usage });
    } }),
  }), (_res, status, body) => ({ status, body }), {});
  assert.equal(result.status, 200);
  assert.equal(result.body.usage.claude.available, false);
  assert.deepEqual(result.body.usage.codex, usage);
});
