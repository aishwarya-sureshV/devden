import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
// Execute the actual component and its effects, controlling only React hooks
// and network boundaries. No browser, CLI, or additional dependency is needed.
function moduleFrom(path, imports, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: id => { assert.ok(id in imports, `unexpected import ${id}`); return imports[id]; },
    localStorage: { getItem: () => null, setItem() {} },
    ...globals,
  }, { filename: path });
  return exports;
}
function component() {
  const requests = [];
  const stateResponse = deferred();
  const slots = [];
  let cursor = 0;
  let effects = [];
  let listener;
  const props = { sessionKey: 'new-tab', sessionPath: '/tmp/sessions/a b.jsonl', executorBackend: 'pi', executorModel: 'executor', onSend: text => requests.push(['send', text]) };
  const api = {
    prosecutorState: (...args) => { requests.push(['state', ...args]); return stateResponse.promise; },
    putProsecutor: (...args) => { requests.push(['arm', ...args]); return Promise.resolve({ ok: true }); },
    resumeProsecutor: (...args) => { requests.push(['resume', ...args]); return Promise.resolve({ ok: true, side: 'executor', prompt: 'recovered brief' }); },
    models: () => Promise.resolve({ ok: true, models: [] }),
  };
  const hooks = {
    useState(initial) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }];
    },
    useEffect(fn, deps) {
      const slot = cursor++;
      const old = slots[slot];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        old?.cleanup?.();
        slots[slot] = { deps };
        effects.push(() => { slots[slot].cleanup = fn(); });
      }
    },
  };
  const jsx = (type, props) => ({ type, props });
  const { ProsecutorSetup } = moduleFrom('../src/components/ProsecutorSetup.tsx', {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../lib/api': {
      api, AGENT_BACKENDS: ['pi', 'codex'], backendLabel: x => x,
      backendMark: () => ({ color: 'black' }),
      subscribeEvents: fn => { listener = fn; return () => { listener = undefined; }; },
    },
    '../lib/store': { useStore: () => ({ backendCatalog: [] }) },
    './icons': { BackendLogo() {} },
    './AskCard': { IconClose() {} },
    '../lib/agentAvailability.ts': { pickerBackendIds: catalog => catalog.map(row => row.id) },
    '../lib/effortStops': { effortLabel: x => x },
    '../lib/prosecutorEffort': { nudgeChoices: () => ({ choices: [], preset: '' }), showLowerNudge: () => false },
  });
  // The case state comes from useProsecutorCase, as in Conversation.tsx.
  const { useProsecutorCase } = moduleFrom('../src/components/useProsecutorCase.ts', {
    react: hooks,
    '../lib/api': { api, subscribeEvents: fn => { listener = fn; return () => { listener = undefined; }; } },
    '../lib/prosecutorEffort': { liftedEffort: () => null },
  });
  const render = () => {
    cursor = 0;
    const caseState = useProsecutorCase(props.sessionKey, true, props.sessionPath);
    const result = ProsecutorSetup({ ...props, caseState, effort: 'high', levels: [], onEffort() {} });
    const pending = effects;
    effects = [];
    pending.forEach(fn => fn());
    return result;
  };
  return { api, props, requests, stateResponse, render, event: event => listener(event) };
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
const interrupted = { armed: true, interrupted: true, paused: { side: 'executor', round: 1, reason: 'server restarted' }, changes: 'M\ttoggle.js' };

test('R15 UI shows changed files before Resume review and sends the stable file path', async () => {
  const h = component();
  h.render();
  h.stateResponse.resolve(interrupted);
  await tick();
  const rendered = nodes(h.render());
  const pre = rendered.findIndex(n => n.type === 'pre');
  const button = rendered.findIndex(n => n.type === 'button' && n.props.children === 'Resume review');
  assert.ok(pre >= 0 && button > pre);
  assert.equal(rendered[pre].props.children, 'M\ttoggle.js');
  assert.equal(h.requests.some(r => r[0] === 'resume'), false, 'mount must not auto-resume');
  rendered[button].props.onClick();
  await tick();
  // Third arg is the gate config's cwd (hardening); this test is about the stable session path.
  assert.deepEqual(h.requests.find(r => r[0] === 'state').slice(0, 3), ['state', 'new-tab', h.props.sessionPath]);
  assert.equal(h.requests.find(r => r[0] === 'arm').at(-1), h.props.sessionPath);
  assert.deepEqual(h.requests.find(r => r[0] === 'resume'), ['resume', 'new-tab', h.props.sessionPath]);
  assert.deepEqual(h.requests.find(r => r[0] === 'send'), ['send', 'recovered brief']);
});

test('R15 a late initial GET must not hide a newer interrupted-case notification', async () => {
  const h = component();
  h.render();
  h.event({ type: 'prosecutor_state', sessionKey: 'new-tab', ...interrupted });
  assert.ok(nodes(h.render()).some(n => n.props?.children === 'Resume review'));
  h.stateResponse.resolve({ armed: false }); // Request started before the session was adopted.
  await tick();
  assert.ok(nodes(h.render()).some(n => n.props?.children === 'Resume review'), 'stale GET hid the recovered case');
});

test('R15 a failed resume request shows an error and leaves the explicit resume action available', async () => {
  const h = component();
  h.api.resumeProsecutor = () => Promise.reject(new Error('network disconnected'));
  h.render();
  h.stateResponse.resolve(interrupted);
  await tick();
  nodes(h.render()).find(n => n.props?.children === 'Resume review').props.onClick();
  await tick();
  const rendered = nodes(h.render());
  assert.ok(rendered.some(n => n.props?.children === 'Resume review'));
  assert.ok(rendered.some(n => n.type === 'em' && n.props.children === 'network disconnected'));
});

test('R15 API query and request bodies retain session paths containing spaces, ampersands and hashes', async () => {
  const calls = [];
  const { api } = moduleFrom('../src/lib/api.ts', {}, {
    Headers, URLSearchParams,
    window: { location: { hostname: 'localhost', search: '' } },
    fetch: async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () => ({ ok: true }) }; },
  });
  const file = '/tmp/sessions/a & b#2.jsonl';
  await api.prosecutorState('tab', file);
  await api.putProsecutor('tab', { backend: 'codex' }, file);
  await api.resumeProsecutor('tab', file);
  assert.equal(new URL(calls[0].url, 'http://localhost').searchParams.get('sessionFile'), file);
  assert.equal(JSON.parse(calls[1].init.body).sessionFile, file);
  assert.deepEqual(JSON.parse(calls[2].init.body), { resume: true, sessionFile: file });
});

test('S7 an undispatched recovered repair retains a visible resume action after the client send fails', async () => {
  const { createProsecutor } = await import('./prosecutor.js');
  const h = component();
  // In-memory storage at the persistence boundary; no user database is opened.
  const record = {
    id: 'case-ui', sessionId: h.props.sessionPath, cwd: '', task: 'Fix the toggle',
    backend: 'codex', phase: 'repair_pending', round: 1,
    log: [{ round: 1, by: 'reviewer', prompt: 'test', report: 'F-17\nVERDICT: GUILTY' }],
  };
  const p = createProsecutor({
    store: { unfinished: () => [record], save() {}, loadBySession: () => record },
    poolFor: () => ({ stop() {}, get() { assert.fail('must not auto-run'); } }),
    publish() {},
  });
  await p.recover();
  const initial = p.state(h.props.sessionKey, h.props.sessionPath);
  h.api.resumeProsecutor = async (key, path) => {
    const result = await p.resume(key, undefined, path);
    h.event({ type: 'prosecutor_state', sessionKey: key, ...p.state(key) });
    return result;
  };
  let attempted = false;
  // The composer handles its network error; no /prompt reaches noteTask.
  // Its parent callback returns void, exactly as ConversationComposer does.
  h.props.onSend = () => { attempted = true; };
  h.render();
  h.stateResponse.resolve(initial);
  await tick();
  nodes(h.render()).find(n => n.props?.children === 'Resume review').props.onClick();
  await tick();
  assert.equal(attempted, true);
  assert.equal(p.state(h.props.sessionKey).phase, 'repair_pending');
  assert.ok(nodes(h.render()).some(n => n.type === 'button' && /Resume/.test(n.props.children)),
    'the undispatched repair has no visible resume action');
});

test('S8 changing sessions prevents the prior session GET from replacing the new recovery state', async () => {
  const h = component();
  h.render();
  h.props.sessionKey = 'other-tab';
  h.props.sessionPath = '/tmp/sessions/other.jsonl';
  h.api.prosecutorState = async () => ({ ...interrupted, changes: 'M\tother.js' });
  h.render();
  await tick();
  h.stateResponse.resolve({ ...interrupted, changes: 'M\twrong-session.js' });
  await tick();
  const pre = nodes(h.render()).find(n => n.type === 'pre');
  assert.equal(pre.props.children, 'M\tother.js');
});
