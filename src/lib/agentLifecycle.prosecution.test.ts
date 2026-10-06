// @ts-nocheck -- test-only React hook driver, with injected I/O and actual TSX bodies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
// Real pure modules merged in from other work (handoffs, effort controls):
// the tests exercise them as shipped rather than stubbing them out.
import * as exportSession from './exportSession.ts';
import * as prosecutorEffort from './prosecutorEffort.ts';

const require = createRequire(import.meta.url);
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const ids = ['pi', 'claude', 'grok', 'codex', 'zcode'];
const baseApi = { AGENT_BACKENDS: ids, backendLabel: id => ({ claude: 'Claude', codex: 'Codex', pi: 'Pi', grok: 'Grok', zcode: 'ZCode' })[id], backendMark: () => ({ color: 'green' }) };
const row = (id, extra = {}) => ({ id, name: baseApi.backendLabel(id), path: `/fake/${id}`, auth: 'ok', connectCommand: `${id} login`, ...extra });

// Uses the installed compiler, not a copied implementation. Imports are explicit
// seams; an unexpected import fails the test rather than reaching a real service.
function load(file, deps = {}, globals = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { fileName: file, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  const localRequire = name => {
    if (name in deps) return deps[name];
    if (name === 'react/jsx-runtime') return require(name);
    if (name.endsWith('.css')) return {};
    throw new Error(`Unmocked import ${name} in ${file}`);
  };
  new Function('require', 'exports', ...Object.keys(globals), code)(localRequire, exports, ...Object.values(globals));
  return exports;
}

function hooks() {
  const slots = [];
  let cursor = 0, effects = [], dirty = false, fn, props, output;
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, value => { const next = typeof value === 'function' ? value(slots[i].value) : value; if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; } }];
    },
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useEffect(effect, deps) {
      const i = cursor++;
      if (changed(slots[i]?.deps, deps)) {
        effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; });
      }
    },
    useCallback(value, deps) {
      const i = cursor++;
      if (changed(slots[i]?.deps, deps)) slots[i] = { deps, value };
      return slots[i].value;
    },
    useSyncExternalStore(subscribe, snapshot) {
      react.useEffect(() => subscribe(() => { dirty = true; }), [subscribe]);
      return snapshot();
    },
  };
  return { react,
    mount(f, p = {}) { fn = f; props = p; return this.render(); },
    render(p = props) {
      props = p;
      for (let n = 0; n < 30; n++) {
        cursor = 0; effects = []; dirty = false;
        output = fn(props);
        for (const effect of effects) effect();
        if (!dirty) return output;
      }
      throw new Error('Hook harness did not settle');
    },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(node => nodes(node, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree == null || typeof tree === 'boolean') return '';
  return typeof tree === 'object' ? text(tree.props?.children) : String(tree);
}
const button = (tree, label) => nodes(tree, n => n.type === 'button' && text(n) === label)[0];
const check = (tree, id) => nodes(tree, n => n.props?.className === 'agents-settings__item' && n.key === id).flatMap(n => nodes(n, c => c.type === 'input'))[0];
const icons = new Proxy({}, { get: (_t, key) => String(key) });
const browser = { addEventListener() {}, removeEventListener() {}, hidden: false };
const availability = load('./agentAvailability.ts', { './api.ts': baseApi });

async function settings(catalog, apiOverrides = {}, defaultBackend = 'pi') {
  const h = hooks(), installed = [], calls = [];
  const store = { defaultBackend, setDefaultBackend(id) { store.defaultBackend = id; }, refreshBackendCatalog: async list => { installed.push(list); } };
  const api = {
    backends: async () => ({ ok: true, backends: catalog }),
    onboarding: async () => ({ done: true }), saveOnboarding: async () => ({ done: true }),
    setBackendEnabled: async (id, enabled) => ({ ok: true, backends: catalog.map(r => r.id === id ? { ...r, enabled } : r) }),
    logoutBackend: async id => { calls.push(id); return { ok: true, backends: catalog.map(r => r.id === id ? { ...r, auth: 'missing' } : r) }; },
    ...apiOverrides,
  };
  const AgentConnect = () => null;
  const { SettingsAgents } = load('../components/SettingsAgents.tsx', {
    react: h.react, '../lib/api': { api }, '../lib/store': { useStore: () => store }, './AgentConnect': { AgentConnect },
  });
  h.mount(SettingsAgents); await flush();
  return { h, store, installed, calls, AgentConnect, tree: () => h.render() };
}

test('E1: disable and re-enable publish the saved catalog to pickers', async () => {
  let catalog = [row('pi'), row('claude')];
  const s = await settings(catalog, { setBackendEnabled: async (id, enabled) => {
    catalog = catalog.map(r => r.id === id ? { ...r, enabled } : r);
    return { ok: true, backends: catalog };
  } });
  check(s.tree(), 'claude').props.onChange({ target: { checked: false } }); await flush();
  assert.equal(check(s.tree(), 'claude').props.checked, false);
  assert.deepEqual(availability.pickerBackendIds(s.installed.at(-1)), ['pi']);
  check(s.tree(), 'claude').props.onChange({ target: { checked: true } }); await flush();
  assert.deepEqual(availability.pickerBackendIds(s.installed.at(-1)), ['pi', 'claude']);
});

for (const failure of [new Error('disk full'), Object.assign(new Error('late'), { name: 'TimeoutError' })])
test(`E2: toggle failure rolls back and is visible (${failure.name})`, async () => {
  const s = await settings([row('pi'), row('claude')], { setBackendEnabled: async () => { throw failure; } });
  check(s.tree(), 'claude').props.onChange({ target: { checked: false } }); await flush();
  assert.equal(check(s.tree(), 'claude').props.checked, true);
  assert.match(text(s.tree()), failure.name === 'TimeoutError' ? /took too long/ : /disk full/);
  assert.equal(s.installed.length, 1);
});

test('E3: quick off/on does not let an older response hide the agent again', async () => {
  const first = deferred(), second = deferred(); let n = 0;
  const catalog = [row('pi'), row('claude')];
  const s = await settings(catalog, { setBackendEnabled: () => (++n === 1 ? first : second).promise });
  check(s.tree(), 'claude').props.onChange({ target: { checked: false } });
  const input = check(s.tree(), 'claude');
  if (input.props.disabled) { first.resolve({ ok: true, backends: [catalog[0], row('claude', { enabled: false })] }); await flush(); return; }
  input.props.onChange({ target: { checked: true } });
  second.resolve({ ok: true, backends: catalog }); await flush();
  first.resolve({ ok: true, backends: [catalog[0], row('claude', { enabled: false })] }); await flush();
  assert.equal(check(s.tree(), 'claude').props.checked, true, 'latest toggle must win even if the earlier reply arrives last');
});

test('E4: the reviewer picker hides disabled agents', () => {
  const h = hooks();
  const { TurnCompleteBar } = load('../components/TurnCompleteBar.tsx', {
    react: h.react, '../lib/api': baseApi,
    '../lib/store': { useStore: () => ({ backendCatalog: [row('pi'), row('claude', { enabled: false }), row('codex')] }) },
    '../lib/anchoredPopover': { useAnchoredPopover: () => ({ current: null }) }, './icons': icons,
  }, { document: browser, localStorage: { getItem: () => null, setItem() {} } });
  let tree = h.mount(TurnCompleteBar, { backend: 'pi', stats: { toolCount: 1, fileCount: 1 }, onReview() {} });
  nodes(tree, n => n.props?.['aria-label'] === 'Choose reviewer')[0].props.onClick();
  tree = h.render();
  assert.equal(nodes(tree, n => n.props?.role === 'menuitem').some(n => text(n).includes('Claude')), false, 'disabled Claude must not remain a reviewer option');
  h.dispose();
});

test('E5: Settings allows disabling the cancelled default subscription', async () => {
  const s = await settings([row('claude'), row('codex')], {}, 'claude');
  assert.equal(Boolean(check(s.tree(), 'claude').props.disabled), false, 'Enabled is required per agent, including the default');
});

test('E6: making a hidden agent default does not leave it disabled and locked', async () => {
  const s = await settings([row('pi'), row('claude', { enabled: false })]);
  const action = button(s.tree(), 'Make default');
  if (!action || action.props.disabled) return;
  action.props.onClick(); await flush();
  const input = check(s.tree(), 'claude');
  assert.equal(!input.props.checked && input.props.disabled, false, 'a disabled default must at least be re-enableable');
});

test('L3: successful logout opens Connect; cancellation can be retried', async () => {
  const s = await settings([row('pi'), row('claude')]);
  const agentRow = nodes(s.tree(), n => n.props?.className === 'agents-settings__item' && n.key === 'claude')[0];
  button(agentRow, 'Sign out / switch account').props.onClick(); await flush();
  const connect = nodes(s.tree(), n => n.type === s.AgentConnect)[0];
  assert.equal(connect.props.autoOpen, true);
  assert.deepEqual(s.calls, ['claude']);
  const h = hooks();
  const { AgentConnect } = load('../components/AgentConnect.tsx', {
    react: h.react, '../lib/api': { api: {} }, '../lib/agentConnect': {},
    '../lib/terminalRuns': { TerminalRunsProvider: () => null }, './TerminalPage': {}, './icons': icons,
  });
  let tree = h.mount(AgentConnect, connect.props);
  nodes(tree, n => n.type === 'dialog')[0].props.onCancel();
  tree = h.render(); assert.equal(nodes(tree, n => n.type === 'dialog').length, 0);
  button(tree, 'Connect').props.onClick();
  assert.equal(nodes(h.render(), n => n.type === 'dialog').length, 1);
});

for (const failure of [{ ok: false, error: 'CLI logout failed' }, new Error('network offline')])
test(`L3: failed logout keeps Connect closed (${failure.error ?? failure.message})`, async () => {
  const s = await settings([row('claude')], { logoutBackend: async () => { if (failure instanceof Error) throw failure; return failure; } });
  button(s.tree(), 'Sign out / switch account').props.onClick(); await flush();
  assert.equal(nodes(s.tree(), n => n.type === s.AgentConnect).length, 0);
  assert.match(text(s.tree()), /CLI logout failed|network offline/);
  assert.equal(button(s.tree(), 'Sign out / switch account').props.disabled, false);
});

test('L4: logout still opens Connect when ZCode has a working local provider', async () => {
  // authFor(zcode) stays ok after OAuth logout when a local provider is configured.
  const catalog = [row('zcode')];
  const s = await settings(catalog, { logoutBackend: async () => ({ ok: true, backends: catalog }) });
  button(s.tree(), 'Sign out / switch account').props.onClick(); await flush();
  assert.equal(nodes(s.tree(), n => n.type === s.AgentConnect && n.props.autoOpen).length, 1, 'logout must proceed to Connect even if another provider remains usable');
});

test('L5: connect, sign out again, and connect again reopens the dialog', async () => {
  const catalog = [row('claude')], s = await settings(catalog);
  for (let i = 0; i < 2; i++) {
    button(s.tree(), 'Sign out / switch account').props.onClick(); await flush();
    const connect = nodes(s.tree(), n => n.type === s.AgentConnect)[0];
    assert.equal(connect.props.autoOpen, true);
    connect.props.onConnected(catalog); await flush();
  }
  assert.equal(s.calls.length, 2);
});

function issueHarness(props) {
  const h = hooks(); const subscribers = new Set();
  const { useAgentIssue } = load('../components/useAgentIssue.ts', {
    react: h.react, '../lib/api': { subscribeEvents: cb => { subscribers.add(cb); return () => subscribers.delete(cb); } },
    '../lib/agentAvailability.ts': availability,
  });
  return { h, props, initial: h.mount(useAgentIssue, props), event: (extra = {}) => {
    for (const cb of subscribers) cb({ type: 'backend_auth', ok: false, backend: 'claude', error: 'Not logged in', ...extra });
    return h.render();
  } };
}

for (const [reason, extra] of [['missing', { path: null }], ['signed out', { auth: 'missing' }], ['disabled', { enabled: false }]])
test(`O1: opening a ${reason} agent session offers an available handoff immediately`, () => {
  const i = issueHarness({ backend: 'claude', catalog: [row('claude', extra), row('codex')], hasItems: true, preferred: 'codex' });
  assert.equal(i.initial.issue.handoffTo, 'codex');
  assert.equal(i.initial.issue.reconnectable, reason !== 'disabled');
  const { AgentIssueCard } = load('../components/AgentIssueCard.tsx', { '../lib/api': baseApi });
  let chosen;
  const card = AgentIssueCard({ issue: i.initial.issue, onReconnect() {}, onHandoff: next => { chosen = next; }, onDismiss() {} });
  button(card, 'Continue with Codex').props.onClick();
  assert.equal(chosen, 'codex'); assert.match(text(card), /Claude isn't available/);
  i.h.dispose();
});

// Regression cases for the follow-up executor changes. Reuse the same real
// module/hook driver; no server, browser, or provider account is involved.
function sharedUsageHarness(t, initial) {
  const h = hooks(), timers = [];
  let now = Date.parse('2026-10-06T10:00:00Z'), response = initial;
  const mod = load('./backendUsage.ts', {
    react: h.react,
    './api.ts': { ...baseApi, api: { backendUsage: () => response instanceof Error ? Promise.reject(response) : Promise.resolve(response) } },
    './time.ts': { formatCountdown: () => '' },
  }, { Date: { now: () => now, parse: Date.parse }, setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval() {} });
  h.mount(() => ({ usage: mod.useBackendUsage(), at: mod.useBackendUsageFetchedAt() }));
  t.after(() => h.dispose());
  return {
    status(backend = 'claude') {
      const current = h.render();
      return mod.composeUsageStatus({ at: null, error: null }, false, current.usage[backend], current.at);
    },
    async poll(value) { response = value; now += 30_000; timers[0](); await flush(); },
  };
}

test('U6: the first shared network failure is visible before any usage has been cached', async t => {
  const u = sharedUsageHarness(t, new Error('Network request failed'));
  await flush();
  assert.ok(u.status().error, 'a first-load network failure must show the usage error state');
  assert.equal(u.status().at, null);
});

test('U7: an initial shared provider failure cannot claim a successful last-updated time', async t => {
  const u = sharedUsageHarness(t, { ok: true, usage: { claude: { available: false } } });
  await flush();
  assert.ok(u.status().error);
  assert.equal(u.status().at, null, 'no successful Claude usage has ever been fetched');
});

test('U8: shared cached usage reports the provider data time, not the cache-read time', async t => {
  const updatedAt = '2026-10-06T09:55:00Z';
  const u = sharedUsageHarness(t, { ok: true, usage: { claude: { ...good, updatedAt } } });
  await flush();
  assert.equal(u.status().at, Date.parse(updatedAt), 'shared cached numbers are five minutes old');
});

test('U9: a shared provider refresh failure preserves its last successful update time', async t => {
  // No provider timestamp: the client fetch time is the available fallback.
  const u = sharedUsageHarness(t, { ok: true, usage: { claude: { ...good, updatedAt: undefined } } });
  await flush();
  const before = u.status().at;
  await u.poll({ ok: true, usage: { claude: { available: false } } });
  assert.ok(u.status().error);
  assert.equal(u.status().at, before, 'a failed refresh is not a successful usage update');
});

test('U10: shared network failure preserves time and successful retry clears the error', async t => {
  const result = { ok: true, usage: { claude: { ...good, updatedAt: undefined } } };
  const u = sharedUsageHarness(t, result);
  await flush();
  const before = u.status().at;
  await u.poll(new Error('offline'));
  assert.ok(u.status().error);
  assert.equal(u.status().at, before);
  await u.poll(result);
  assert.equal(u.status().error, null);
  assert.ok(u.status().at > before);
});

test('U11: a shared provider failure does not mark another healthy backend as failed', async t => {
  const u = sharedUsageHarness(t, { ok: true, usage: {
    claude: { available: false }, codex: { ...good, updatedAt: undefined },
  } });
  await flush();
  assert.ok(u.status('claude').error);
  assert.equal(u.status('codex').error, null);
  assert.ok(u.status('codex').at);
});

test('U12: shared provider recovery clears the error and resumes last-updated reporting', async t => {
  const u = sharedUsageHarness(t, { ok: true, usage: { claude: { available: false } } });
  await flush();
  assert.ok(u.status().error);
  await u.poll({ ok: true, usage: { claude: { ...good, updatedAt: undefined } } });
  assert.equal(u.status().error, null);
  assert.ok(u.status().at);
});

test('E7: disabling two different agents preserves both successful choices when requests finish out of order', async () => {
  const first = deferred(), second = deferred();
  let catalog = [row('pi'), row('claude'), row('codex')];
  const s = await settings(catalog, { setBackendEnabled: id => (id === 'claude' ? first : second).promise });
  check(s.tree(), 'claude').props.onChange({ target: { checked: false } });
  check(s.tree(), 'codex').props.onChange({ target: { checked: false } });
  // Codex reaches the server first. Claude then persists and returns the
  // up-to-date catalog, which must not be discarded as a stale same-row edit.
  catalog = catalog.map(r => r.id === 'codex' ? { ...r, enabled: false } : r);
  second.resolve({ ok: true, backends: catalog }); await flush();
  catalog = catalog.map(r => r.id === 'claude' ? { ...r, enabled: false } : r);
  first.resolve({ ok: true, backends: catalog }); await flush();
  assert.deepEqual(availability.pickerBackendIds(s.installed.at(-1)), ['pi'], 'both disabled agents must disappear from pickers');
});

test('E8: a failed disable remains visible when another agent toggle succeeds', async () => {
  const first = deferred(), second = deferred();
  const catalog = [row('pi'), row('claude'), row('codex')];
  const s = await settings(catalog, { setBackendEnabled: id => (id === 'claude' ? first : second).promise });
  check(s.tree(), 'claude').props.onChange({ target: { checked: false } });
  check(s.tree(), 'codex').props.onChange({ target: { checked: false } });
  second.resolve({ ok: true, backends: catalog.map(r => r.id === 'codex' ? { ...r, enabled: false } : r) });
  await flush();
  first.reject(new Error('Could not save Claude preference: disk full'));
  await flush();
  assert.match(text(s.tree()), /disk full/, 'another agent toggle must not silently swallow this failed save');
  assert.equal(check(s.tree(), 'claude').props.checked, true);
  assert.equal(check(s.tree(), 'codex').props.checked, false);
});

test('E9: a delayed catalog reply cannot permanently restore another successfully disabled agent', async () => {
  const first = deferred(), second = deferred();
  const catalog = [row('pi'), row('claude'), row('codex')];
  const s = await settings(catalog, { setBackendEnabled: id => (id === 'claude' ? first : second).promise });
  check(s.tree(), 'claude').props.onChange({ target: { checked: false } });
  // The server saves Claude first and captures this response; delivery is delayed.
  const afterClaude = catalog.map(r => r.id === 'claude' ? { ...r, enabled: false } : r);
  check(s.tree(), 'codex').props.onChange({ target: { checked: false } });
  const afterBoth = afterClaude.map(r => r.id === 'codex' ? { ...r, enabled: false } : r);
  second.resolve({ ok: true, backends: afterBoth });
  await flush();
  first.resolve({ ok: true, backends: afterClaude });
  await flush();
  assert.deepEqual(availability.pickerBackendIds(s.installed.at(-1)), ['pi'], 'both saves finished successfully; neither agent may return to the picker');
  assert.equal(check(s.tree(), 'codex').props.checked, false);
});

test('E10: a failed disable rolls back the picker after another reply published its pending choice', async () => {
  const first = deferred(), second = deferred();
  const catalog = [row('pi'), row('claude'), row('codex')];
  const s = await settings(catalog, { setBackendEnabled: id => (id === 'claude' ? first : second).promise });
  check(s.tree(), 'claude').props.onChange({ target: { checked: false } });
  check(s.tree(), 'codex').props.onChange({ target: { checked: false } });
  second.resolve({ ok: true, backends: catalog.map(r => r.id === 'codex' ? { ...r, enabled: false } : r) });
  await flush();
  first.reject(new Error('Could not save Claude preference: disk full'));
  await flush();
  assert.equal(check(s.tree(), 'claude').props.checked, true);
  assert.match(text(s.tree()), /disk full/);
  assert.deepEqual(availability.pickerBackendIds(s.installed.at(-1)), ['pi', 'claude'], 'Settings rolled Claude back to Enabled, so the picker must restore it too');
});

test('E11: retrying a failed disable updates the recorded choice and the picker', async () => {
  let attempts = 0;
  const catalog = [row('pi'), row('claude')];
  const s = await settings(catalog, { setBackendEnabled: async (id, enabled) => {
    if (++attempts === 1) throw new Error('disk full');
    return { ok: true, backends: catalog.map(r => r.id === id ? { ...r, enabled } : r) };
  } });
  check(s.tree(), 'claude').props.onChange({ target: { checked: false } });
  await flush();
  assert.equal(check(s.tree(), 'claude').props.checked, true);
  check(s.tree(), 'claude').props.onChange({ target: { checked: false } });
  await flush();
  assert.equal(check(s.tree(), 'claude').props.checked, false);
  assert.deepEqual(availability.pickerBackendIds(s.installed.at(-1)), ['pi']);
});

test('E12: toggling another agent does not undo a successful re-enable through Make default', async () => {
  let catalog = [row('pi'), row('claude'), row('codex')];
  const s = await settings(catalog, { setBackendEnabled: async (id, enabled) => {
    catalog = catalog.map(r => r.id === id ? { ...r, enabled } : r);
    return { ok: true, backends: catalog };
  } });
  check(s.tree(), 'claude').props.onChange({ target: { checked: false } });
  await flush();
  const claudeRow = nodes(s.tree(), n => n.props?.className === 'agents-settings__item' && n.key === 'claude')[0];
  const action = button(claudeRow, 'Make default');
  if (!action || action.props.disabled) return;
  action.props.onClick();
  await flush();
  // No requirement to auto-enable on promotion; if it does, that successful
  // choice must survive a later edit to a different agent.
  if (!check(s.tree(), 'claude').props.checked) return;
  assert.equal(catalog.find(r => r.id === 'claude').enabled, true);
  check(s.tree(), 'codex').props.onChange({ target: { checked: false } });
  await flush();
  assert.deepEqual(availability.pickerBackendIds(s.installed.at(-1)), ['pi', 'claude'], 'editing Codex must not hide the already re-enabled Claude');
});

test('E13: a failed enable restores the hidden state in Settings and the picker', async () => {
  const first = deferred(), second = deferred();
  const catalog = [row('pi'), row('claude', { enabled: false }), row('codex')];
  const s = await settings(catalog, { setBackendEnabled: id => (id === 'claude' ? first : second).promise });
  check(s.tree(), 'claude').props.onChange({ target: { checked: true } });
  check(s.tree(), 'codex').props.onChange({ target: { checked: false } });
  second.resolve({ ok: true, backends: catalog.map(r => r.id === 'codex' ? { ...r, enabled: false } : r) });
  await flush();
  first.reject(new Error('Could not enable Claude'));
  await flush();
  assert.equal(check(s.tree(), 'claude').props.checked, false);
  assert.deepEqual(availability.pickerBackendIds(s.installed.at(-1)), ['pi']);
});

test('E14: two successful saves settling before a render preserve both disabled rows', async () => {
  const first = deferred(), second = deferred();
  const catalog = [row('pi'), row('claude'), row('codex')];
  const s = await settings(catalog, { setBackendEnabled: id => (id === 'claude' ? first : second).promise });
  check(s.tree(), 'claude').props.onChange({ target: { checked: false } });
  check(s.tree(), 'codex').props.onChange({ target: { checked: false } });
  first.resolve({ ok: true, backends: catalog.map(r => r.id === 'claude' ? { ...r, enabled: false } : r) });
  second.resolve({ ok: true, backends: catalog.map(r => r.id !== 'pi' ? { ...r, enabled: false } : r) });
  await flush();
  assert.deepEqual(availability.pickerBackendIds(s.installed.at(-1)), ['pi']);
  assert.equal(check(s.tree(), 'claude').props.checked, false);
  assert.equal(check(s.tree(), 'codex').props.checked, false);
});

test('L6: a pending toggle reply preserves the later sign-out state and open Connect dialog', async () => {
  const pending = deferred();
  const catalog = [row('pi'), row('claude'), row('codex')];
  const s = await settings(catalog, { setBackendEnabled: () => pending.promise });
  check(s.tree(), 'codex').props.onChange({ target: { checked: false } });
  const claudeRow = nodes(s.tree(), n => n.props?.className === 'agents-settings__item' && n.key === 'claude')[0];
  button(claudeRow, 'Sign out / switch account').props.onClick();
  await flush();
  // This earlier toggle response still describes Claude as signed in.
  pending.resolve({ ok: true, backends: catalog.map(r => r.id === 'codex' ? { ...r, enabled: false } : r) });
  await flush();
  const connect = nodes(s.tree(), n => n.type === s.AgentConnect && n.props.agent.id === 'claude')[0];
  assert.ok(connect, 'Connect must remain available after logout');
  assert.equal(connect.props.autoOpen, true);
  assert.equal(connect.props.agent.auth, 'missing');
  assert.equal(s.installed.at(-1).find(r => r.id === 'claude').auth, 'missing');
  assert.equal(s.installed.at(-1).find(r => r.id === 'codex').enabled, false);
});

test('U15: repeated provider and network failures retain the original data time until recovery', async t => {
  const updatedAt = '2026-10-06T09:55:00Z';
  const u = sharedUsageHarness(t, { ok: true, usage: { claude: { ...good, updatedAt } } });
  await flush();
  for (const failure of [
    { ok: true, usage: { claude: { available: false } } },
    new Error('offline'),
    { ok: true, usage: { claude: { available: false } } },
  ]) {
    await u.poll(failure);
    assert.ok(u.status().error);
    assert.equal(u.status().at, Date.parse(updatedAt));
  }
  const recoveredAt = '2026-10-06T10:02:00Z';
  await u.poll({ ok: true, usage: { claude: { ...good, updatedAt: recoveredAt } } });
  assert.deepEqual(u.status(), { error: null, at: Date.parse(recoveredAt) });
});

function recoveryHandoffHarness(t, overrides = {}) {
  const i = issueHarness({ backend: 'codex', catalog: [row('codex', { path: null }), row('claude')], hasItems: true });
  t.after(() => i.h.dispose());
  const { switchBackend } = load('../components/conversationModel.ts', {
    '../lib/api': { ...baseApi, api: { stop: overrides.stop ?? (async () => {}) } },
    '../lib/effortStops': {}, './conversationHelpers': {}, '../lib/store': { isUnstartedTab: () => false }, '../lib/exportSession': exportSession,
  });
  const source = readFileSync(new URL('../components/Conversation.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('Conversation.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handoffToAgent') handler = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(handler);
  const code = ts.transpileModule(`const handoff = ${handler};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let selected = 'codex', pending;
  const ctx = {
    // Tab shape after the backend-handoff rework: switchBackend reads the
    // session file and can re-point a switch-back at it.
    setModelMenuOpen() {}, tab: { key: 'saved', backend: 'codex', timeline: { state: null } },
    setConversationSessionPath() {},
    streaming: false, configuring: false,
    transcriptBackendRef: { current: 'codex' }, usageSinceRef: { current: 0 },
    saveTranscript: async () => '/scratch/transcript.md',
    setConversationBackend: (_key, backend) => { selected = backend; },
    pendingHandoffRef: { current: null }, timeline: { appendNotice() {} },
    ...overrides,
  };
  const handoff = new Function('dismissAgentIssue', 'switchBackend', `${code}; return handoff;`)(
    i.initial.dismiss, next => pending = switchBackend(ctx, next),
  );
  return { i, ctx, get selected() { return selected; }, async click() { handoff('claude'); await pending; await flush(); } };
}

test('O5: a handoff blocked by a running turn must leave recovery available', async t => {
  const r = recoveryHandoffHarness(t, { streaming: true });
  await r.click();
  assert.equal(r.selected, 'codex');
  assert.ok(r.i.h.render().issue, 'a resolved no-op switch must not dismiss orphan recovery');
});

test('O6: a stop failure keeps recovery available and a retry hands off the transcript', async t => {
  let attempts = 0;
  const r = recoveryHandoffHarness(t, { stop: async () => {
    if (++attempts === 1) throw new Error('stop request failed');
  } });
  await assert.rejects(r.click(), /stop request failed/);
  assert.equal(r.selected, 'codex');
  assert.ok(r.i.h.render().issue);
  await r.click();
  assert.equal(r.selected, 'claude');
  assert.deepEqual(r.ctx.pendingHandoffRef.current, { path: '/scratch/transcript.md', from: 'codex', sessionPath: undefined });
  assert.equal(r.i.h.render().issue, null);
});

test('O2/O3: unavailable alternatives, empty catalogs and fresh chats do not invent handoffs', () => {
  assert.equal(availability.handoffTarget('claude', [row('claude', { path: null }), row('codex', { enabled: false })], 'codex'), null);
  assert.equal(issueHarness({ backend: 'claude', catalog: [], hasItems: true }).initial.issue, null);
  assert.equal(issueHarness({ backend: 'claude', catalog: [row('claude', { path: null })], hasItems: false }).initial.issue, null);
});

test('A2: an auth event for another backend does not affect this conversation', () => {
  const i = issueHarness({ backend: 'claude', catalog: [row('claude')], hasItems: true });
  assert.equal(i.event({ backend: 'codex' }).issue, null); i.h.dispose();
});

test('A6: successful reconnect clears an event even when detection always said auth ok', () => {
  // A revoked token can still exist on disk, so detection need not change status.
  const i = issueHarness({ backend: 'claude', catalog: [row('claude')], hasItems: true });
  assert.ok(i.event().issue);
  assert.equal(i.h.render({ ...i.props, catalog: [row('claude')] }).issue, null, 'a fresh successful connection catalog must clear the expired-login alert');
  i.h.dispose();
});

test('A7: dismissing an expiry does not suppress a later expiry after reconnect', () => {
  const i = issueHarness({ backend: 'claude', catalog: [row('claude', { auth: 'missing' })], hasItems: true });
  i.initial.dismiss(); assert.equal(i.h.render().issue, null);
  i.h.render({ ...i.props, catalog: [row('claude')] });
  assert.ok(i.event().issue, 'new backend_auth after recovery needs a new Reconnect action');
  i.h.dispose();
});

test('A8: an expired login still offers Reconnect while detection is stale', () => {
  const i = issueHarness({ backend: 'claude', catalog: [row('claude'), row('codex')], hasItems: true, preferred: 'codex' });
  // Auth loss explicitly requires Reconnect; an immediate alternative-agent
  // offer before catalog detection completes is not required by the task.
  assert.equal(i.event().issue.reconnectable, true);
  i.h.dispose();
});

test('A6: missing-to-healthy catalog transition clears Reconnect', () => {
  const i = issueHarness({ backend: 'claude', catalog: [row('claude', { auth: 'missing' })], hasItems: true });
  i.event();
  assert.equal(i.h.render({ ...i.props, catalog: [row('claude')] }).issue, null);
  i.h.dispose();
});

function usageHarness() {
  const h = hooks(); let result, usage = null;
  const { useUsageRefresh } = load('../components/useUsageRefresh.ts', {
    react: h.react, '../lib/api': { api: { usage: () => result instanceof Error ? Promise.reject(result) : Promise.resolve(result) } },
    './conversationSend': { resumeFromLimit() {} }, './conversationHelpers': {},
  });
  const props = { usageRequestRef: { current: null }, tab: { key: 'a', backend: 'claude' }, timeline: {},
    setProviderUsage: value => { usage = value; }, visible: false, status: 'idle', usageRefreshPendingRef: { current: false } };
  h.mount(useUsageRefresh, props);
  return { h, props, get usage() { return usage; }, set result(value) { result = value; }, async fetch(value) { result = value; await h.render().refreshUsage(); return h.render(); } };
}

const good = { available: true, windows: [{ label: 'Current session', usedPercent: 25 }], updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() };

for (const [label, failure] of [['provider', { ok: false, error: 'provider timed out' }], ['network', new Error('offline')]])
test(`U1: initial ${label} failure has an error and no fabricated successful timestamp`, async () => {
  const u = usageHarness(), out = await u.fetch(failure);
  assert.ok(out.usageMeta.error); assert.equal(out.usageMeta.at, null);
});

test('U2: refresh failure preserves last-success time; successful retry clears the error', async () => {
  const u = usageHarness();
  const before = (await u.fetch({ ok: true, usage: good })).usageMeta.at;
  const failed = await u.fetch({ ok: false, error: 'provider timed out' });
  assert.equal(failed.usageMeta.at, before); assert.match(failed.usageMeta.error, /timed out/);
  assert.equal((await u.fetch({ ok: true, usage: good })).usageMeta.error, null);
});

test('U5: a delayed old-backend response cannot overwrite the newly selected backend', async () => {
  const u = usageHarness(), pending = deferred();
  u.result = pending.promise;
  const old = u.h.render().refreshUsage();
  u.h.render({ ...u.props, tab: { key: 'a', backend: 'codex' } });
  const fresh = { ...good, provider: 'Codex' };
  await u.fetch({ ok: true, usage: fresh });
  pending.resolve({ ok: false, error: 'old Claude failure' }); await old;
  assert.equal(u.usage.provider, 'Codex'); assert.equal(u.h.render().usageMeta.error, null);
});

test('U14: changing sessions on the same backend discards the previous session failure and pending response', async () => {
  const u = usageHarness();
  await u.fetch({ ok: false, error: 'old session timed out' });
  const pending = deferred();
  u.result = pending.promise;
  const old = u.h.render().refreshUsage();
  u.h.render({ ...u.props, tab: { key: 'b', backend: 'claude' } });
  assert.deepEqual(u.h.render().usageMeta, { at: null, error: null });
  await u.fetch({ ok: true, usage: good });
  pending.resolve({ ok: false, error: 'old session still unavailable' });
  await old;
  assert.equal(u.h.render().usageMeta.error, null);
  assert.equal(u.h.render().usageMeta.at, Date.parse(good.updatedAt));
});

test('U4: cached usage retains its data timestamp instead of claiming it just updated', async () => {
  const u = usageHarness();
  const out = await u.fetch({ ok: true, usage: good });
  assert.equal(out.usageMeta.at, Date.parse(good.updatedAt), 'last updated must describe the cached data, not this cache read');
});

for (const mode of ['network', 'provider'])
test(`U3: shared ${mode} usage failure is visible in a fresh conversation`, async () => {
  const h = hooks(), timers = []; let now = 100_000;
  let response = { ok: true, usage: { claude: good } };
  const mod = load('./backendUsage.ts', {
    react: h.react, './api.ts': { api: { backendUsage: () => response instanceof Error ? Promise.reject(response) : Promise.resolve(response) } },
    './time.ts': { formatCountdown: () => '' },
  }, { Date: { now: () => now }, setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval() {} });
  const render = () => ({ usage: mod.useBackendUsage(), at: mod.useBackendUsageFetchedAt() });
  h.mount(render); await flush();
  assert.equal(h.render().usage.claude.available, true);
  now += 100_000;
  // This is the actual /api/usage envelope when one provider throws.
  response = mode === 'network' ? new Error('offline') : { ok: true, usage: { claude: { available: false } } };
  timers[0](); await flush();
  const current = h.render();
  const status = mod.composeUsageStatus({ at: null, error: null }, false, current.usage.claude, current.at);
  assert.ok(status.error, 'the only usage fetch in a fresh conversation failed but the widget has no error');
  h.dispose();
});

test('U1/U2: usage popover renders the error and last-updated label', () => {
  const { UsageChip } = load('../components/ComposerChrome.tsx', {
    react: hooks().react, '../lib/api': baseApi,
    '../lib/anchoredPopover': { useAnchoredPopover: () => ({ current: null }) }, '../lib/effortStops': {}, '../lib/prosecutorEffort': prosecutorEffort, './icons': icons,
  });
  const tree = UsageChip({ popRef: { current: null }, open: true, hour: null, week: null, current: 'claude', usage: {},
    context: { percent: null, label: '' }, status: { at: 1000, error: 'offline' } });
  assert.match(text(tree), /Couldn't refresh usage/); assert.match(text(tree), /Updated/);
});

test('O4: handoff saves the old transcript and queues its path for the next prompt', async () => {
  const sequence = [];
  const { switchBackend } = load('../components/conversationModel.ts', {
    '../lib/api': { ...baseApi, api: { stop: async () => { sequence.push('stop'); } } },
    '../lib/effortStops': {}, './conversationHelpers': {}, '../lib/store': { isUnstartedTab: () => false }, '../lib/exportSession': exportSession,
  });
  const pendingHandoffRef = { current: null };
  await switchBackend({ setModelMenuOpen() {}, tab: { key: 'saved', backend: 'codex', timeline: { state: null } }, setConversationSessionPath() {}, streaming: false, configuring: false,
    transcriptBackendRef: { current: 'codex' }, usageSinceRef: { current: 0 },
    saveTranscript: async () => { sequence.push('save'); return '/scratch/transcript.md'; },
    setConversationBackend: (_key, backend) => { sequence.push(backend); }, pendingHandoffRef,
    timeline: { appendNotice() {} },
  }, 'claude');
  assert.deepEqual(sequence, ['save', 'stop', 'claude']);
  assert.deepEqual(pendingHandoffRef.current, { path: '/scratch/transcript.md', from: 'codex', sessionPath: undefined });
});

test('O4: failed transcript save leaves the orphan recovery action available', async () => {
  const i = issueHarness({ backend: 'codex', catalog: [row('codex', { path: null }), row('claude')], hasItems: true });
  const { switchBackend } = load('../components/conversationModel.ts', {
    '../lib/api': { ...baseApi, api: { stop: async () => {} } },
    '../lib/effortStops': {}, './conversationHelpers': {}, '../lib/store': { isUnstartedTab: () => false }, '../lib/exportSession': exportSession,
  });
  // Execute the new Conversation handler verbatim, retaining the existing
  // switchBackend implementation. Observe its promise to avoid an unhandled
  // rejection in the runner; production currently does not observe it.
  const source = readFileSync(new URL('../components/Conversation.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('Conversation.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handoffToAgent') handler = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(handler);
  const code = ts.transpileModule(`const handoff = ${handler};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let pending, selected = 'codex';
  const handoff = new Function('dismissAgentIssue', 'switchBackend', `${code}; return handoff;`)(i.initial.dismiss, next => {
    pending = switchBackend({ setModelMenuOpen() {}, tab: { key: 'saved', backend: 'codex', timeline: { state: null } }, setConversationSessionPath() {},
      transcriptBackendRef: { current: 'codex' }, usageSinceRef: { current: 0 },
      saveTranscript: async () => { throw new Error('Could not reach the devden server'); },
      setConversationBackend: (_key, backend) => { selected = backend; },
      pendingHandoffRef: { current: null }, timeline: { appendNotice() {} },
    }, next);
    return pending;
  });
  handoff('claude');
  await assert.rejects(pending, /Could not reach/);
  assert.equal(selected, 'codex');
  assert.ok(i.h.render().issue, 'failed handoff must not permanently dismiss the only recovery card');
  i.h.dispose();
});
