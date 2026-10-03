import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedModels, clearModelCatalogs, MODEL_CATALOG_TTL_MS } from "./model-catalog.js";
import { CodexAgentPool } from "./codex-agent.js";
import { GrokAgentPool } from "./grok-agent.js";
import { ClaudeAgentProcess } from "./claude-agent.js";
import { PiAgentProcess } from "./pi-agent.js";

test("every backend shares lookups, expires, retries outages, and invalidates after updates", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  t.after(clearModelCatalogs);
  for (const backend of ["pi", "claude", "grok", "codex"]) {
    let calls = 0;
    let offline = false;
    const agent = { __watchedBackend: backend, cwd: "/project", getAvailableModels: async () => {
      calls++;
      if (offline) throw new Error("offline");
      return { ok: true, models: [{ id: `new-${calls}` }] };
    } };
    const [first, shared] = await Promise.all([cachedModels(agent), cachedModels(agent)]);
    assert.equal(calls, 1);
    assert.equal(first, shared);
    t.mock.timers.tick(MODEL_CATALOG_TTL_MS);
    assert.equal((await cachedModels(agent)).models[0].id, "new-2");
    offline = true;
    t.mock.timers.tick(MODEL_CATALOG_TTL_MS);
    assert.equal((await cachedModels(agent)).models[0].id, "new-2");
    offline = false;
    assert.equal((await cachedModels(agent)).models[0].id, "new-4");
    clearModelCatalogs();
    assert.equal((await cachedModels(agent)).models[0].id, "new-5");
  }
});

test("live catalogs discover future releases in existing sessions, with model capabilities", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "devden-models-"));
  const previous = { ...process.env };
  t.after(async () => {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, "auth.json"), JSON.stringify({
    tokens: { access_token: "test-token", account_id: "test-account" },
    "https://accounts.x.ai/sign-in": { key: "test-token" },
  }));
  process.env.CODEX_HOME = dir;
  process.env.GROK_HOME = dir;
  process.env.PATH = `${dir}:${process.env.PATH}`;
  const script = `#!${process.execPath}
if (process.argv[1].endsWith('/npm')) { console.log('0.160.0'); process.exit(); }
if (process.argv[2] === 'update') { process.exit(); }
process.stdin.setEncoding('utf8');
process.stdin.once('data', line => {
  const request = JSON.parse(line);
  console.log(JSON.stringify({type:'response',id:request.id,success:true,data:{models:[
    {provider:'openai-codex',id:'future-sol',reasoning:true,thinkingLevelMap:{xhigh:'xhigh',max:'max'}}
  ]}}));
});
`;
  for (const bin of ["npm", "pi"]) await writeFile(join(dir, bin), script, { mode: 0o755 });
  process.env.DEVDEN_PI_BIN = join(dir, "pi");
  // Claude's credential lookup uses HOME via homedir(). Keep tests entirely
  // local; no keychain prompt or account network calls.
  process.env.HOME = dir;
  await mkdir(join(dir, ".claude"));
  await writeFile(join(dir, ".claude", ".credentials.json"), JSON.stringify({claudeAiOauth:{accessToken:"test-token"}}));
  let release = "6.1";
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = String(input);
    if (url.includes("/api/tags")) return Response.json({models:[]});
    assert.equal(options.headers.Authorization, "Bearer test-token");
    if (url.includes("chatgpt.com")) {
      assert.match(url, /client_version=0\.160\.0/);
      return Response.json({models:[
        {slug:`gpt-${release}-sol`,display_name:`Sol ${release}`,visibility:"list",supported_reasoning_levels:[{effort:"high"}],default_reasoning_level:"high",context_window:1050000},
        {slug:"gpt-6-luna",visibility:"list"},
        {slug:"private",visibility:"hide"},
      ]});
    }
    if (url.includes("api.anthropic.com")) {
      if (url.includes("after_id")) return Response.json({data:[{id:"claude-newfamily-10",display_name:"New Family 10"}],has_more:false});
      return Response.json({data:[{id:`claude-sonnet-${release.replace('.', '-')}`},{id:"foreign"}],has_more:true,last_id:"cursor"});
    }
    if (url.includes("grok.com")) return Response.json({models:[{id:`grok-${release}`,reasoning_efforts:[{id:"high"}]}]});
    throw new Error(`Unexpected URL ${url}`);
  });
  const codex = new CodexAgentPool().get("existing");
  codex.request = async () => ({ data: [{ id: `gpt-${release}-sol`, displayName: `Sol ${release}`, supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high" }], nextCursor: null });
  const grok = new GrokAgentPool().get("existing");
  const claude = new ClaudeAgentProcess("existing");
  assert.equal((await codex.getAvailableModels()).models[0].id, "gpt-6.1-sol");
  assert.equal((await grok.getAvailableModels()).models[0].id, "grok-6.1");
  release = "7.2";
  const newest = await codex.getAvailableModels();
  // The remote catalog adds slugs the CLI doesn't list yet (and hides "private").
  assert.deepEqual(newest.models.map(m => m.id), ["gpt-7.2-sol", "gpt-6-luna"]);
  assert.deepEqual(newest.models[0].levels, ["high"]);
  assert.equal(newest.models[0].contextWindow, 1050000);
  assert.equal((await grok.getAvailableModels()).models[0].id, "grok-7.2");
  assert.deepEqual((await claude.getAvailableModels()).models.map(m => m.id), ["claude-sonnet-7-2", "claude-newfamily-10"]);
  const pi = new PiAgentProcess("existing");
  pi.process = {}; // the live process still has an older catalog
  pi.send = () => { throw new Error("must use fresh discovery"); };
  const models = await pi.getAvailableModels();
  assert.equal(models.models[0].id, "future-sol");
  assert.ok(models.models[0].levels.includes("max"));
});

test("Pi resumes with a new catalog only for unknown models while idle", async () => {
  const pi = new PiAgentProcess("existing");
  pi.process = {};
  pi.cwd = "/project";
  pi.lastState = { sessionFile: "/saved/session.jsonl", thinkingLevel: "high" };
  let stopped = false;
  pi.stop = () => { stopped = true; };
  pi.start = async (cwd, options) => ({ ok: true, cwd, options });
  pi.runCommand = async () => ({ ok: false, error: "Model not found" });
  pi.status = "working";
  assert.equal((await pi.setModel("openai-codex", "new-sol")).ok, false);
  assert.equal(stopped, false);
  pi.status = "ready";
  const resumed = await pi.setModel("openai-codex", "new-sol");
  assert.equal(stopped, true);
  assert.deepEqual(resumed.options, {model:{provider:"openai-codex",id:"new-sol"},sessionPath:"/saved/session.jsonl",thinkingLevel:"high"});
  stopped = false;
  pi.runCommand = async () => ({ ok: false, error: "Authentication failed" });
  assert.equal((await pi.setModel("openai-codex", "new-sol")).ok, false);
  assert.equal(stopped, false);
});
