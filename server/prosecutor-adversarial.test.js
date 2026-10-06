import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.DEVDEN_HOME = mkdtempSync(join(tmpdir(), 'prosecutor-adversarial-home-'));
const { createProsecutor, caseBrief, executorBrief } = await import('./prosecutor.js');
const { createProsecutorStore } = await import('./prosecutor-store.js');
const { db } = await import('./db.js');
const { takeSnapshot, withScratchIndex } = await import('./snapshots.js');

const sessionId = '/tmp/sessions/a real session.jsonl';
const finding = 'F-17: false must disable the toggle';
const guilty = `${finding}\nVERDICT: GUILTY`;
const entry = { round: 1, by: 'reviewer', prompt: 'test the toggle', report: guilty };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('test setup did not reach the expected checkpoint');
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'prosecutor-adversarial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function repository(t) {
  const cwd = temp(t);
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(cwd, 'toggle.js'), 'export const enabled = true;\n');
  writeFileSync(join(cwd, 'remove.txt'), 'keep until edited\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  return { cwd, git };
}
function saved(overrides = {}) {
  return {
    id: 'case-1', sessionId, cwd: '', task: 'Fix the toggle', backend: 'codex',
    model: { provider: 'openai', id: 'reviewer' }, effort: 'high',
    executorBackend: 'pi', executorModel: { provider: 'anthropic', id: 'executor' },
    phase: 'repair_pending', round: 1, log: [{ ...entry }], lastReport: guilty,
    defense: 'I changed the toggle', ...overrides,
  };
}
function agent() {
  const listeners = new Set();
  return {
    prompts: [], alive: false,
    isAlive() { return this.alive; },
    start() { this.alive = true; return { ok: true }; },
    setThinkingLevel() {},
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    prompt(text) { this.prompts.push(text); return { ok: true }; },
    finish(text = guilty, error) {
      for (const fn of [...listeners]) fn({ type: 'message_end', message: {
        role: 'assistant', content: [{ type: 'text', text }],
        stopReason: error ? 'error' : 'end_turn', ...(error ? { errorMessage: error } : {}),
      } });
      for (const fn of [...listeners]) fn({ type: 'agent_end' });
    },
  };
}
function harness(t, initial, options = {}) {
  const home = temp(t);
  const store = createProsecutorStore(home);
  if (initial) store.save(initial);
  const reviewer = agent();
  const events = [];
  const info = { sessionId, cwd: initial?.cwd || '', executorBackend: 'pi' };
  const p = createProsecutor({
    store: options.store?.(store) || store,
    sessionInfo: () => info,
    poolFor: () => ({ stop() {}, get: () => reviewer }),
    publish: (key, event) => events.push({ key, ...event }),
  });
  const ex = {
    cwd: info.cwd, sessionFile: sessionId, prompts: [], getMessages: () => [],
    prompt(text) { this.prompts.push(text); return { ok: true }; },
  };
  const restart = () => createProsecutor({
    store, sessionInfo: () => info, publish() {},
    poolFor: () => ({ stop() {}, get: () => reviewer }),
  });
  return { home, store, reviewer, events, info, p, ex, restart };
}
async function startReview(h, key = 'tab') {
  h.p.arm(key, { backend: 'codex' });
  h.p.noteTask(key, 'Fix the toggle');
  h.p.onExecutorEvent(key, { type: 'agent_end' }, h.ex);
  await waitFor(() => h.reviewer.prompts.length === 1);
}

test('R2 transaction rolls back the case and all rounds if a round write fails', t => {
  const h = harness(t, saved());
  db(h.home).exec(`CREATE TRIGGER fail_round BEFORE INSERT ON case_rounds
    WHEN NEW.seq = 1 BEGIN SELECT RAISE(ABORT, 'simulated disk write failure'); END`);
  const before = h.store.loadBySession(sessionId);
  assert.throws(() => h.store.save(saved({ task: 'new value', log: [entry, { ...entry, round: 2 }] })), /disk write failure/);
  assert.deepEqual(h.store.loadBySession(sessionId), before);
});

test('R3 repeated saves retain ordered rounds, unknown JSON and gate metadata without runtime objects', t => {
  const current = saved({
    log: [entry, { ...entry, round: 2, by: 'acceptance gate', reply: 'OBJECTION: scope', replyBy: 'executor', died: 'quota', findings: [{ id: 'F-17', command: 'node --test toggle.test.js' }] }],
    status: 'verifying', gate: { state: 'running', round: 2, configured: true, ok: false, at: 5, results: [] },
    owned: ['toggle.test.js'], findings: [{ id: 'F-17' }], flags: [{ round: 2, side: 'executor', text: 'scope' }],
    gateNote: 'still checking', paused: { side: 'prosecutor', round: 2, reason: 'limit', note: 'switch' },
    extra: { futureSetting: { nested: [1, false, null] } },
  });
  current.executor = current; // Serializing a process-like cyclic object must not be attempted.
  current.timer = { owner: current };
  current.busy = true;
  const h = harness(t, current);
  for (let n = 0; n < 3; n++) h.store.save(h.store.loadBySession(sessionId));
  const loaded = h.store.loadBySession(sessionId);
  assert.deepEqual(loaded.log, current.log);
  for (const key of ['status', 'gate', 'owned', 'findings', 'flags', 'gateNote', 'paused', 'extra'])
    if (key === 'extra') assert.deepEqual(loaded.extra.futureSetting, current.extra.futureSetting);
    else assert.deepEqual(loaded[key], current[key]);
  assert.equal(loaded.executor, undefined);
  assert.equal(loaded.timer, undefined);
  assert.equal(loaded.busy, false);
  assert.match(caseBrief(loaded.log, 3), /acceptance gate/);
  assert.match(caseBrief(loaded.log, 3), /OBJECTION: scope/);
  assert.match(executorBrief(loaded.log), /F-17/);
});

test('R4 session file learned during the initial executor turn makes the case durable', async t => {
  const { cwd } = repository(t);
  const base = await takeSnapshot(cwd);
  const h = harness(t);
  h.info.cwd = cwd;
  h.info.sessionId = '';
  h.p.arm('tab', { backend: 'codex' });
  h.p.noteTask('tab', 'Fix the toggle', Promise.resolve(base));
  await tick();
  h.info.sessionId = sessionId; // CLI creates the transcript after accepting the first prompt.
  h.p.state('tab', sessionId); // Composer learns the stable path while execution is in flight.
  h.p.onExecutorEvent('tab', { type: 'message_end', message: {
    role: 'assistant', content: [{ type: 'text', text: 'working on the fix' }],
  } }, h.ex);
  assert.equal(h.store.loadBySession(sessionId)?.task, 'Fix the toggle');
});

test('R5 a failed checkpoint prevents dispatching an unsaved repair', async t => {
  let rejectRepair = false;
  const h = harness(t, null, { store: inner => ({ ...inner, save(current) {
    if (rejectRepair && current.phase === 'repair_pending') throw new Error('SQLITE_FULL');
    inner.save(current);
  } }) });
  await startReview(h);
  rejectRepair = true;
  h.reviewer.finish();
  await waitFor(() => h.events.some(e => e.type === 'tool_execution_end'));
  assert.equal(h.ex.prompts.length, 0, 'repair must not dispatch without a durable failing report');
});

test('R7 a recovered review resumes on a fresh server without a live executor handle', async t => {
  const { cwd } = repository(t);
  const h = harness(t, saved({ cwd, phase: 'review_pending' }));
  await h.p.recover();
  const result = await h.p.resume('fresh-tab', undefined, sessionId);
  assert.equal(result.ok, true, result.error);
  await waitFor(() => h.reviewer.prompts.length === 1);
  assert.match(h.reviewer.prompts[0], /F-17/);
});

test('R8 recovery lists modified, deleted and untracked files without changing the tree or index', async t => {
  const { cwd, git } = repository(t);
  const base = await takeSnapshot(cwd);
  assert.equal(base.ok, true);
  writeFileSync(join(cwd, 'toggle.js'), 'export const enabled = false;\n');
  git('add', 'toggle.js');
  writeFileSync(join(cwd, 'toggle.js'), 'export const enabled = null;\n');
  rmSync(join(cwd, 'remove.txt'));
  writeFileSync(join(cwd, 'new test.js'), 'half written test\n');
  const index = readFileSync(join(cwd, '.git/index'));
  const status = git('status', '--porcelain');
  const h = harness(t, saved({ cwd, baselineCommit: base.commit }));
  await h.p.recover();
  const state = h.p.state('tab', sessionId);
  assert.match(state.changes, /M\s+toggle.js/);
  assert.match(state.changes, /D\s+remove.txt/);
  assert.match(state.changes, /A\s+new test.js/);
  assert.deepEqual(readFileSync(join(cwd, '.git/index')), index);
  assert.equal(git('status', '--porcelain'), status);
  assert.equal(readFileSync(join(cwd, 'new test.js'), 'utf8'), 'half written test\n');
});

test('R8 missing baseline leaves the interrupted case resumable without claiming a clean tree', async t => {
  const { cwd } = repository(t);
  const h = harness(t, saved({ cwd, baselineCommit: '0000000000000000000000000000000000000000' }));
  await h.p.recover();
  const state = h.p.state('tab', sessionId);
  assert.equal(state.interrupted, true);
  assert.equal(state.changes, null);
  const result = h.p.resume('tab', h.ex);
  assert.equal(result.ok, true);
  assert.match(result.prompt, /Recheck the files/);
  assert.doesNotMatch(result.prompt, /workspace matches/);
});

test('R9 repair resume includes workspace edits made after server startup', async t => {
  const { cwd } = repository(t);
  const base = await takeSnapshot(cwd);
  const h = harness(t, saved({ cwd, baselineCommit: base.commit }));
  await h.p.recover();
  h.p.state('tab', sessionId);
  writeFileSync(join(cwd, 'later.test.js'), 'test added after recovery\n');
  const result = await h.p.resume('tab', h.ex);
  assert.equal(result.ok, true);
  assert.ok(result.prompt.includes('later.test.js'), 'resume must list current changes, not the startup snapshot');
  assert.doesNotMatch(result.prompt, /workspace matches/);
});

test('R9 resume waits for an in-progress checkpoint comparison before sending the repair brief', async t => {
  const { cwd } = repository(t);
  const base = await takeSnapshot(cwd);
  writeFileSync(join(cwd, 'during-repair.js'), 'partial edit\n');
  const h = harness(t, saved({ cwd, baselineCommit: base.commit }));
  const release = deferred();
  const entered = deferred();
  const lock = withScratchIndex(cwd, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  h.p.state('tab', sessionId); // Adoption starts changedSince asynchronously.
  const resumed = Promise.resolve(h.p.resume('tab', h.ex));
  release.resolve();
  await lock;
  const result = await resumed;
  assert.equal(result.ok, true);
  assert.ok(result.prompt.includes('during-repair.js'), 'repair brief must wait for the changed-file list');
});

test('R10 a second process rebuilds the saved case without backend conversation IDs', t => {
  const h = harness(t, saved({ log: [{ ...entry, reply: 'OBJECTION: keep existing API', replyBy: 'executor' }] }));
  const script = `import { createProsecutorStore } from './server/prosecutor-store.js';
    import { executorBrief } from './server/prosecutor.js';
    const current = createProsecutorStore(process.env.DEVDEN_HOME).loadBySession(${JSON.stringify(sessionId)});
    process.stdout.write(JSON.stringify({ task: current.task, brief: executorBrief(current.log) }));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, DEVDEN_HOME: h.home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.equal(result.task, 'Fix the toggle');
  assert.match(result.brief, /F-17/);
  assert.match(result.brief, /OBJECTION: keep existing API/);
});

test('R11 failed prosecutor CLI startup pauses and survives restart at the same round', async t => {
  const h = harness(t, saved({ phase: 'review_pending' }));
  h.reviewer.start = () => ({ ok: false, error: 'spawn codex ENOENT' });
  await h.p.recover();
  assert.equal(h.p.resume('tab', h.ex, sessionId).ok, true);
  await waitFor(() => h.p.state('tab').paused);
  const restarted = h.restart();
  await restarted.recover();
  const state = restarted.state('tab', sessionId);
  assert.equal(state.round, 1);
  assert.equal(state.paused.side, 'prosecutor');
  assert.match(state.paused.reason, /ENOENT/);
});

test('R11 prosecutor quota failure retains partial findings and retries the uncounted round', async t => {
  const h = harness(t, saved({ phase: 'review_pending' }));
  await h.p.recover();
  h.p.resume('tab', h.ex, sessionId);
  await waitFor(() => h.reviewer.prompts.length);
  h.reviewer.finish('F-18: partial finding', '429 usage limit');
  await waitFor(() => h.p.state('tab').paused);
  const restarted = h.restart();
  await restarted.recover();
  const state = restarted.state('tab', sessionId);
  assert.equal(state.round, 1);
  assert.equal(state.paused.round, 2);
  assert.match(caseBrief(restarted.armed('tab').log, 2), /F-18: partial finding/);
});

for (const mode of ['refusal', 'rejection', 'throw']) {
  test(`R11 executor repair ${mode} pauses on the executor side without uncounting the guilty review`, async t => {
    const h = harness(t);
    h.ex.prompt = () => {
      if (mode === 'refusal') return { ok: false, error: 'executor unavailable' };
      if (mode === 'rejection') return Promise.reject(new Error('executor unavailable'));
      throw new Error('executor unavailable');
    };
    await startReview(h);
    h.reviewer.finish();
    await waitFor(() => h.events.some(e => e.type === 'tool_execution_end'));
    await tick();
    const state = h.p.state('tab');
    assert.deepEqual({ phase: state.phase, side: state.paused?.side, round: state.round },
      { phase: 'paused', side: 'executor', round: 1 });
    const restarted = h.restart();
    await restarted.recover();
    const result = restarted.resume('new-tab', h.ex, sessionId);
    assert.equal(result.side, 'executor');
    assert.match(result.prompt, /F-17/);
  });
}

test('R12 double review resume dispatches once and re-arming an interrupted case never starts it', async t => {
  const h = harness(t, saved({ phase: 'review_running', round: 2 }));
  await h.p.recover();
  h.p.arm('tab', { backend: 'pi', sessionFile: sessionId });
  assert.equal(h.reviewer.prompts.length, 0);
  assert.equal(h.p.resume('tab', h.ex).ok, true);
  assert.equal(h.p.resume('tab', h.ex).ok, false);
  await waitFor(() => h.reviewer.prompts.length === 1);
  assert.equal(h.p.state('tab').round, 2);
});

test('R12 a lost client dispatch can request the pending repair again', async t => {
  const h = harness(t, saved());
  await h.p.recover();
  const first = h.p.resume('tab', h.ex, sessionId);
  assert.equal(first.ok, true);
  // The client receives the brief, but its /prompt request fails before reaching the server.
  const retry = h.p.resume('tab', h.ex, sessionId);
  assert.equal(retry.ok, true, 'pending repair must remain explicitly resumable until dispatched');
  assert.equal(retry.prompt, first.prompt);
});

test('R13 refreshing the tab during a review retains the arriving verdict and repair', async t => {
  const h = harness(t);
  await startReview(h, 'old-tab');
  assert.equal(h.p.state('new-tab', sessionId).round, 1);
  h.reviewer.finish();
  await waitFor(() => h.events.some(e => e.type === 'tool_execution_end'));
  assert.equal(h.store.loadBySession(sessionId).lastReport, guilty);
  assert.equal(h.ex.prompts.length, 1);
});

test('R13 an old review verdict cannot accept a new user task', async t => {
  const h = harness(t);
  await startReview(h);
  const oldId = h.p.armed('tab').id;
  h.p.noteTask('tab', 'Now add keyboard navigation');
  const newId = h.p.armed('tab').id;
  assert.notEqual(newId, oldId);
  h.reviewer.finish('Old toggle change is fine\nVERDICT: ACQUITTED');
  await waitFor(() => h.events.some(e => e.type === 'tool_execution_end'));
  const next = db(h.home).prepare('SELECT phase, task FROM cases WHERE id = ?').get(newId);
  assert.equal(next.phase, 'executor_running', 'verdict belongs to the previous task');
  assert.equal(h.p.armed('tab').task, 'Now add keyboard navigation');
});

test('R14 a late baseline from the previous task cannot overwrite the next checkpoint', async t => {
  const h = harness(t);
  const old = deferred();
  h.p.arm('tab', { backend: 'codex' });
  h.p.noteTask('tab', 'first task', old.promise);
  h.p.noteTask('tab', 'second task', { ok: true, commit: 'new-commit' });
  old.resolve({ ok: true, commit: 'old-commit' });
  await tick();
  assert.equal(h.store.loadBySession(sessionId).baselineCommit, 'new-commit');
  assert.equal(h.store.loadBySession(sessionId).task, 'second task');
});

test('R16 a new task stops the prior case and clears its acceptance-gate metadata', async t => {
  const h = harness(t, saved({ status: 'verifying', gate: { ok: false }, owned: ['old.test.js'], findings: [{ id: 'old' }], flags: [], gateNote: 'old', extra: { laterField: 'old' } }));
  await h.p.recover();
  h.p.state('tab', sessionId);
  h.p.noteTask('tab', 'new task');
  const loaded = h.store.loadBySession(sessionId);
  assert.notEqual(loaded.id, 'case-1');
  assert.equal(db(h.home).prepare('SELECT phase FROM cases WHERE id = ?').get('case-1').phase, 'stopped');
  // Hardening fields start fresh: nothing from the stopped case carries over.
  assert.equal(loaded.status, 'fixing');
  assert.equal(loaded.gate, null);
  assert.equal(loaded.gateNote, '');
  for (const key of ['owned', 'findings', 'flags']) assert.deepEqual(loaded[key], []);
  assert.equal(loaded.extra.laterField, undefined);
  assert.deepEqual(loaded.log, []);
});

test('S1 late executor prompt completion must not change the next running review into a repair on restart', async t => {
  const h = harness(t);
  const completed = deferred();
  // Codex runTurn() returns settled.promise; finishTurn emits agent_end
  // before resolving it. Grok also resolves prompt() after its end events.
  h.ex.prompt = text => { h.ex.prompts.push(text); return completed.promise; };
  await startReview(h);
  h.reviewer.finish();
  await waitFor(() => h.ex.prompts.length === 1);
  h.p.onExecutorEvent('tab', { type: 'message_end', message: {
    role: 'assistant', content: [{ type: 'text', text: 'Fixed F-17 and reran the test' }],
  } }, h.ex);
  h.p.onExecutorEvent('tab', { type: 'agent_end' }, h.ex);
  await waitFor(() => h.reviewer.prompts.length === 2);
  completed.resolve({ ok: true });
  await tick();
  const restarted = h.restart();
  await restarted.recover();
  const state = restarted.state('after-crash', sessionId);
  assert.deepEqual({ side: state.paused.side, round: state.round },
    { side: 'prosecutor', round: 1 }, 'round 2 was still reviewing and must rerun as round 2');
});

test('S2 review dispatch stops when its review_pending checkpoint cannot be saved', async t => {
  const h = harness(t, null, { store: inner => ({ ...inner, save(current) {
    if (current.phase === 'review_pending') throw new Error('SQLITE_FULL');
    inner.save(current);
  } }) });
  h.p.arm('tab', { backend: 'codex' });
  h.p.noteTask('tab', 'Fix the toggle');
  h.p.onExecutorEvent('tab', { type: 'agent_end' }, h.ex);
  await tick();
  assert.equal(h.reviewer.prompts.length, 0, 'review dispatched after its next-step checkpoint failed');
});

test('S3 a baseline resolving after tab adoption is saved under the adopted case', async t => {
  const { cwd } = repository(t);
  const snapshot = await takeSnapshot(cwd);
  assert.equal(snapshot.ok, true);
  const pending = deferred();
  const h = harness(t);
  h.info.cwd = cwd;
  h.p.arm('old-tab', { backend: 'codex' });
  h.p.noteTask('old-tab', 'Fix the toggle', pending.promise);
  h.p.state('new-tab', sessionId);
  pending.resolve(snapshot);
  await tick();
  assert.equal(h.store.loadBySession(sessionId).baselineCommit, snapshot.commit);
});

test('S4 retrying repair resume while comparison is pending still waits for current changes', async t => {
  const { cwd } = repository(t);
  const snapshot = await takeSnapshot(cwd);
  const h = harness(t, saved({ cwd, baselineCommit: snapshot.commit }));
  await h.p.recover();
  h.p.state('tab', sessionId);
  writeFileSync(join(cwd, 'late-fix.js'), 'partial repair\n');
  const entered = deferred();
  const release = deferred();
  const lock = withScratchIndex(cwd, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const first = Promise.resolve(h.p.resume('tab', h.ex));
  const retry = Promise.resolve(h.p.resume('tab', h.ex));
  release.resolve();
  await lock;
  const results = await Promise.all([first, retry]);
  assert.equal(results[0].ok, true);
  assert.ok(results[0].prompt.includes('late-fix.js'));
  assert.equal(results[1].ok, true);
  assert.ok(results[1].prompt.includes('late-fix.js'), 'retry returned the stale pre-comparison brief');
});

test('S5 starting a new task cancels an older repair resume waiting on workspace comparison', async t => {
  const { cwd } = repository(t);
  const snapshot = await takeSnapshot(cwd);
  const h = harness(t, saved({ cwd, baselineCommit: snapshot.commit }));
  await h.p.recover();
  h.p.state('tab', sessionId);
  const entered = deferred();
  const release = deferred();
  const lock = withScratchIndex(cwd, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const pending = Promise.resolve(h.p.resume('tab', h.ex));
  h.p.noteTask('tab', 'Now add keyboard navigation');
  release.resolve();
  await lock;
  const result = await pending;
  assert.equal(result.ok, false, 'stopped case returned a successful repair prompt for the client to dispatch');
  assert.equal(h.store.loadBySession(sessionId).task, 'Now add keyboard navigation');
});

test('S6 recovered prosecutor brief does not claim a clean checkpoint after new workspace edits', async t => {
  const { cwd } = repository(t);
  const snapshot = await takeSnapshot(cwd);
  const h = harness(t, saved({ cwd, baselineCommit: snapshot.commit, phase: 'review_pending' }));
  await h.p.recover();
  h.p.state('tab', sessionId);
  writeFileSync(join(cwd, 'late-review.js'), 'new edit before resume\n');
  assert.equal((await h.p.resume('tab', h.ex)).ok, true);
  await waitFor(() => h.reviewer.prompts.length === 1);
  assert.ok(h.reviewer.prompts[0].includes('late-review.js'));
  assert.ok(!h.reviewer.prompts[0].includes('The workspace matches the last checkpoint.'),
    'resumed review falsely claims the changed workspace matches the checkpoint');
});

test('T1 a review resumed across tab adoption starts the saved next round on the new key', async t => {
  const { cwd } = repository(t);
  const snapshot = await takeSnapshot(cwd);
  const h = harness(t, saved({ cwd, baselineCommit: snapshot.commit, phase: 'review_pending' }));
  await h.p.recover();
  h.p.state('old-tab', sessionId);
  const entered = deferred();
  const release = deferred();
  const lock = withScratchIndex(cwd, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const resuming = Promise.resolve(h.p.resume('old-tab', h.ex));
  h.p.state('new-tab', sessionId);
  release.resolve();
  await lock;
  assert.equal((await resuming).ok, true);
  await tick();
  assert.equal(h.p.state('new-tab').round, 2,
    'resume reported success but never started saved round 2 after tab adoption');
  await waitFor(() => h.reviewer.prompts.length === 1);
  assert.match(h.reviewer.prompts[0], /F-17/);
});

test('T2 switching prosecutor during a repair comparison does not poison later resume requests', async t => {
  const { cwd } = repository(t);
  const snapshot = await takeSnapshot(cwd);
  const h = harness(t, saved({ cwd, baselineCommit: snapshot.commit }));
  await h.p.recover();
  h.p.state('tab', sessionId);
  const entered = deferred();
  const release = deferred();
  const lock = withScratchIndex(cwd, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const original = Promise.resolve(h.p.resume('tab', h.ex));
  h.p.arm('tab', { backend: 'pi', sessionFile: sessionId });
  release.resolve();
  await lock;
  await original; // The superseded request may be cancelled, as in S5.
  const retry = await h.p.resume('tab', h.ex);
  assert.equal(retry.ok, true, 'live switched case reuses a cancelled resume Promise');
  assert.equal(retry.side, 'executor');
  assert.match(retry.prompt, /F-17/);
  assert.equal(h.p.state('tab').backend, 'pi');
});

test('T3 an actively executing asynchronous repair is persisted as repair_running before it finishes', async t => {
  const h = harness(t);
  const completion = deferred();
  // Codex and Grok return a Promise that resolves only after the turn ends.
  h.ex.prompt = text => { h.ex.prompts.push(text); return completion.promise; };
  await startReview(h);
  h.reviewer.finish();
  await waitFor(() => h.ex.prompts.length === 1);
  // An intermediate assistant response followed by tool work is positive
  // evidence of execution; this is not a dispatch still waiting for acceptance.
  h.p.onExecutorEvent('tab', { type: 'message_end', message: {
    role: 'assistant', stopReason: 'tool_use',
    content: [{ type: 'text', text: 'I am editing the failing toggle now.' }],
  } }, h.ex);
  assert.equal(h.store.loadBySession(sessionId).phase, 'repair_running',
    'repair is executing but SQLite still records an undispatched repair');
});

test('T4 delivering the resumed repair clears its pause while preserving case identity and findings', async t => {
  const h = harness(t, saved());
  await h.p.recover();
  h.p.state('tab', sessionId);
  const resumed = await h.p.resume('tab', h.ex);
  assert.equal(resumed.ok, true);
  assert.ok(h.p.state('tab').paused, 'until dispatch the repair must remain retryable');
  h.p.noteTask('tab', resumed.prompt);
  const state = h.p.state('tab');
  assert.equal(state.paused, null);
  assert.equal(state.interrupted, false);
  assert.equal(state.phase, 'repair_running');
  const stored = h.store.loadBySession(sessionId);
  assert.equal(stored.id, 'case-1');
  assert.equal(stored.task, 'Fix the toggle');
  assert.equal(stored.round, 1);
  assert.equal(stored.paused, null);
  assert.match(stored.log[0].report, /F-17/);
});

test('U1 Claude exiting after partial repair output durably pauses the executor and permits resume', async t => {
  const { ClaudeAgentProcess } = await import('./claude-agent.js');
  const h = harness(t);
  h.info.executorBackend = 'claude';
  h.ex.pendingTurns = [];
  h.ex.queuedMessages = [];
  h.ex.pendingControlRequests = new Map();
  h.ex.prompt = text => {
    h.ex.prompts.push(text);
    return new Promise(resolve => h.ex.pendingTurns.push({ resolve, kind: 'prompt' }));
  };
  await startReview(h);
  h.reviewer.finish();
  await waitFor(() => h.ex.prompts.length === 1);
  h.p.onExecutorEvent('tab', { type: 'message_end', message: {
    role: 'assistant', stopReason: 'tool_use',
    content: [{ type: 'text', text: 'I found the broken toggle and am applying the fix.' }],
  } }, h.ex);
  assert.equal(h.p.state('tab').phase, 'repair_running');
  // Use the real adapter's exit behavior: outstanding sendTurn promises
  // resolve with ok:false, without an agent_end/agent_settled event.
  ClaudeAgentProcess.prototype.failPending.call(h.ex, new Error('Claude exited (SIGKILL)'));
  await tick();
  const stored = h.store.loadBySession(sessionId);
  assert.deepEqual({ phase: stored.phase, side: stored.paused?.side, round: stored.round },
    { phase: 'paused', side: 'executor', round: 1 }, 'a dead repair must be paused, not stored as running');
  assert.match(stored.paused.reason, /Claude exited/);
  const resumed = await h.p.resume('tab', h.ex);
  assert.equal(resumed.ok, true);
  assert.match(resumed.prompt, /F-17/);
});

test('V1 changing the prosecutor during an executor repair preserves failure recovery for that same case', async t => {
  const { ClaudeAgentProcess } = await import('./claude-agent.js');
  const h = harness(t);
  h.info.executorBackend = 'claude';
  h.ex.pendingTurns = [];
  h.ex.queuedMessages = [];
  h.ex.pendingControlRequests = new Map();
  h.ex.prompt = text => {
    h.ex.prompts.push(text);
    return new Promise(resolve => h.ex.pendingTurns.push({ resolve, kind: 'prompt' }));
  };
  await startReview(h);
  h.reviewer.finish();
  await waitFor(() => h.ex.prompts.length === 1);
  h.p.onExecutorEvent('tab', { type: 'message_end', message: {
    role: 'assistant', stopReason: 'tool_use', content: [{ type: 'text', text: 'Applying the repair' }],
  } }, h.ex);
  const caseId = h.p.armed('tab').id;
  // Pick the prosecutor for the next review while the existing executor
  // continues its repair. This preserves the task, case id, and round.
  h.p.arm('tab', { backend: 'pi', sessionFile: sessionId });
  assert.equal(h.p.armed('tab').id, caseId);
  assert.equal(h.p.state('tab').phase, 'repair_running');
  assert.equal(h.reviewer.prompts.length, 1);
  ClaudeAgentProcess.prototype.failPending.call(h.ex, new Error('Claude exited (SIGKILL)'));
  await tick();
  const stored = h.store.loadBySession(sessionId);
  assert.deepEqual({ phase: stored.phase, side: stored.paused?.side, round: stored.round },
    { phase: 'paused', side: 'executor', round: 1 },
    'changing the reviewer must not detach failure handling from the ongoing executor repair');
  assert.equal(stored.backend, 'pi');
  const result = await h.p.resume('tab', h.ex);
  assert.equal(result.ok, true);
  assert.match(result.prompt, /F-17/);
});
