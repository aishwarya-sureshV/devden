#!/usr/bin/env node
// Deterministic context-pruning replay over Claude Code session logs.
// No model calls, no tokenizer: a tool result's token cost is the usage delta
//   tokens(step k) = ctx(k+1) - ctx(k) - output(k),  ctx = input + cache_read + cache_creation
// and the counterfactual is addition. Costs are input-token equivalents (ITE):
// uncached 1, cache read 0.1, cache write 1.25 (5m) / 2 (1h).
//
//   node scripts/replay-savings.mjs [file-or-dir ...]   (default: this repo's ~/.claude project dir)
//   node scripts/replay-savings.mjs --selftest
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const READ_MULT = 0.1;
const IMAGE_WEIGHT = 1600 * 4; // chars-equivalent, only used to split a mixed parallel step
const MUTATING = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const NO_SUPERSEDE = new Set([...MUTATING, "Agent", "Task", "AskUserQuestion", "TodoWrite", "Skill"]);

// ---------- parse: log lines -> calls with the tool results that followed each ----------
export function parseLog(lines) {
  const calls = [];
  const byId = new Map();
  const toolUses = new Map();
  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain) continue;
    const m = d.message;
    if (d.type === "assistant" && m?.usage) {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === "tool_use") toolUses.set(b.id, { name: b.name, input: b.input || {} });
      }
      const u = m.usage;
      const call = {
        ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        input: u.input_tokens || 0,
        read: u.cache_read_input_tokens || 0,
        write: u.cache_creation_input_tokens || 0,
        writeMult: u.cache_creation?.ephemeral_1h_input_tokens > 0 ? 2 : 1.25,
        out: u.output_tokens || 0,
        items: [], // content that entered the context after this call
        compact: false,
      };
      // Streaming writes one entry per content block; the last one carries final usage.
      const prev = byId.get(m.id);
      if (prev) Object.assign(prev, { ...call, items: prev.items, compact: prev.compact });
      else { byId.set(m.id, call); calls.push(call); }
      continue;
    }
    const last = calls.at(-1);
    if (!last) continue;
    if (d.isCompactSummary) last.compact = true;
    if (d.type === "user") {
      const content = typeof m?.content === "string" ? [{ type: "text", text: m.content }] : m?.content || [];
      for (const b of content) {
        if (b?.type === "tool_result") {
          const use = toolUses.get(b.tool_use_id) || { name: "?", input: {} };
          const parts = Array.isArray(b.content) ? b.content : [{ type: "text", text: String(b.content ?? "") }];
          const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
          const images = parts.filter((p) => p.type === "image").length;
          last.items.push({ tool: use.name, input: use.input, text, images, weight: text.length + images * IMAGE_WEIGHT });
        } else {
          const w = b?.type === "image" ? IMAGE_WEIGHT : JSON.stringify(b ?? "").length;
          last.items.push({ tool: null, weight: w });
        }
      }
    } else if (d.type === "attachment") {
      last.items.push({ tool: null, weight: JSON.stringify(d.attachment ?? "").length });
    }
  }
  return calls;
}

// ---------- price: usage deltas -> exact token cost per item ----------
export function priceSteps(calls) {
  const anomalies = { negative: 0, resets: 0 };
  for (let k = 0; k < calls.length; k++) {
    const c = calls[k], next = calls[k + 1];
    c.reset = k === 0;
    if (!next) { for (const it of c.items) it.tokens = 0; continue; }
    const delta = next.ctx - c.ctx - c.out;
    if (next.compact || next.ctx < c.ctx * 0.5) { next.resetBefore = true; anomalies.resets++; }
    const total = c.items.reduce((s, it) => s + it.weight, 0);
    const usable = !next.resetBefore && delta > 0;
    if (!next.resetBefore && delta < 0) anomalies.negative++;
    let pos = c.ctx + c.out;
    const results = c.items.filter((it) => it.tool);
    // Exact = the step's only tool result; per-turn reminders around it are <5% of the step.
    const exact = results.length === 1 && results[0].weight >= total * 0.95;
    for (const it of c.items) {
      it.tokens = usable && total ? Math.round(delta * it.weight / total) : 0;
      it.exact = exact;
      it.pos = pos;
      pos += it.tokens;
    }
  }
  return anomalies;
}

// ---------- supersession rules ----------
// keys: what identifies this item; kills: keys of older items this one makes stale.
function keysOf(it, rules) {
  const keys = [], kills = [];
  const { tool, input = {} } = it;
  const path = input.file_path || input.notebook_path;
  if (tool === "Read" && path) {
    const exact = `read:${path}:${input.offset ?? ""}:${input.limit ?? ""}`;
    keys.push(exact, `readpath:${path}`);
    kills.push(input.offset == null && input.limit == null ? `readpath:${path}` : exact);
  } else if (MUTATING.has(tool) && path) {
    if (rules.edits) kills.push(`readpath:${path}`);
  } else if (tool === "Bash" && input.command) {
    keys.push(`cmd:${input.command.trim()}`); kills.push(`cmd:${input.command.trim()}`);
  } else if (tool && !NO_SUPERSEDE.has(tool)) {
    const k = `call:${tool}:${JSON.stringify(input)}`;
    keys.push(k); kills.push(k);
  }
  if (it.images && tool && /browser|computer|screenshot|simulator|preview/i.test(tool)) {
    const k = `shot:${input.tabId ?? input.tab_id ?? ""}`;
    keys.push(k); kills.push(k);
  }
  if (it.text?.length > 200) {
    const k = `text:${createHash("sha1").update(it.text).digest("hex")}`;
    keys.push(k); kills.push(k);
  }
  return { keys, kills };
}

// ---------- replay: the pure function ----------
// policy.flush(call, pendingTokens) -> true to prune the pending stale items before this call.
export function replay(calls, policy, rules = { edits: false }) {
  const L = { calls: calls.length, actualInputITE: 0, saved: 0, rebuild: 0, reread: 0,
    prunedTokens: 0, prunedExact: 0, prunes: 0, rereads: 0 };
  let live = [];        // items in context, unpruned
  let pending = [];     // stale, awaiting flush
  let pruned = [];      // removed items still "would be in context" in the baseline
  let rereadLive = 0;   // re-read tokens charged as extra context
  const prunedPaths = new Map(); // path -> edited since prune?

  for (let j = 0; j < calls.length; j++) {
    const c = calls[j];
    const cold = c.read < c.ctx * 0.5;
    L.actualInputITE += c.input + c.read * READ_MULT + c.write * c.writeMult;
    if (c.resetBefore) { live = []; pending = []; pruned = []; rereadLive = 0; prunedPaths.clear(); }

    // Items from the previous step enter the context; each may make older ones stale.
    for (const it of j > 0 ? calls[j - 1].items : []) {
      if (!it.tool) continue;
      const { keys, kills } = keysOf(it, rules);
      const path = it.input.file_path || it.input.notebook_path;
      if (MUTATING.has(it.tool) && prunedPaths.has(path)) prunedPaths.set(path, true);
      if (it.tool === "Read" && prunedPaths.get(path) === false && !live.some((x) => x.input?.file_path === path)) {
        L.reread += it.tokens * (c.writeMult - READ_MULT); rereadLive += it.tokens; L.rereads++;
      }
      if (kills.length) {
        const stale = live.filter((x) => x.keys.some((k) => kills.includes(k)));
        live = live.filter((x) => !stale.includes(x));
        pending.push(...stale);
      }
      if (keys.length && it.tokens > 0) live.push({ ...it, keys });
    }

    const pendingTokens = pending.reduce((s, x) => s + x.tokens, 0);
    if (pending.length && policy.flush(c, pendingTokens, cold)) {
      if (!cold) {
        const minPos = Math.min(...pending.map((x) => x.pos));
        const removedAfter = pruned.filter((x) => x.pos > minPos).reduce((s, x) => s + x.tokens, 0);
        const suffix = Math.max(0, c.ctx - minPos - pendingTokens - removedAfter);
        L.rebuild += suffix * (c.writeMult - READ_MULT);
      }
      for (const x of pending) {
        if (x.tool === "Read") prunedPaths.set(x.input.file_path, false);
        L.prunedTokens += x.tokens; if (x.exact) L.prunedExact += x.tokens;
      }
      pruned.push(...pending); pending = []; L.prunes++;
    }

    // Baseline carries the pruned tokens on every call (read, or rewritten when cold).
    const mult = cold ? c.writeMult : READ_MULT;
    L.saved += pruned.reduce((s, x) => s + x.tokens, 0) * mult;
    L.reread += rereadLive * mult;
  }
  L.net = L.saved - L.rebuild - L.reread;
  return L;
}

export const POLICIES = {
  off: { flush: () => false },
  eager: { flush: () => true },                         // prune the moment something is stale
  cold: { flush: (_c, _p, cold) => cold },              // prune only when the cache is cold anyway
  // TODO(human): flush a warm cache only when it pays back. Inputs: c.ctx, pendingTokens, cold.
  breakEven: { flush: (c, pendingTokens, cold) => cold },
};

// ---------- CLI ----------
function files(args) {
  const roots = args.length ? args : [join(homedir(), ".claude/projects", process.cwd().replaceAll("/", "-"))];
  return roots.flatMap((r) => statSync(r).isDirectory()
    ? readdirSync(r).filter((f) => f.endsWith(".jsonl")).map((f) => join(r, f)) : [r]);
}

function selftest() {
  const u = (id, ctx, out, read = ctx) => JSON.stringify({ type: "assistant", message: { id, usage:
    { input_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: ctx - read, output_tokens: out },
    content: [{ type: "tool_use", id: `t${id}`, name: "Read", input: { file_path: "/a" } }] } });
  const r = (id, text) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${id}`, content: text }] } });
  // Read /a (1000 tok) twice, then 3 more calls.
  const calls = parseLog([u(1, 10000, 100), r(1, "x"), u(2, 11100, 100), r(2, "y"), u(3, 12200, 100), u(4, 12300, 100), u(5, 12400, 100)]);
  const anomalies = priceSteps(calls);
  console.assert(anomalies.negative === 0 && calls[0].items[0].tokens === 1000, "delta pricing");
  const off = replay(calls, POLICIES.off);
  console.assert(off.net === 0 && off.prunedTokens === 0, "off is a no-op");
  const eager = replay(calls, POLICIES.eager);
  // first read pruned before call 3; saved at calls 3,4,5 = 1000*0.1*3; rebuild suffix = 12200-10100-1000 = 1100
  console.assert(eager.prunedTokens === 1000 && Math.abs(eager.saved - 300) < 1e-6, "saved");
  console.assert(Math.abs(eager.rebuild - 1100 * 1.15) < 1e-6, "rebuild");
  console.log("selftest ok", { eager });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--selftest")) { selftest(); process.exit(); }
  const sessions = files(process.argv.slice(2)).map((f) => {
    const calls = parseLog(readFileSync(f, "utf8").split("\n"));
    return { f, calls, anomalies: priceSteps(calls) };
  }).filter((s) => s.calls.length > 1);
  const total = sessions.reduce((s, x) => s + x.calls.length, 0);
  const neg = sessions.reduce((s, x) => s + x.anomalies.negative, 0);
  const resets = sessions.reduce((s, x) => s + x.anomalies.resets, 0);
  console.log(`${sessions.length} sessions, ${total} calls; negative deltas ${neg} (${(neg / total * 100).toFixed(2)}%), compaction resets ${resets}`);
  // Sanity: delta-priced text results vs the chars/4 rule of thumb (should cluster near 1).
  const ratios = sessions.flatMap((s) => s.calls.flatMap((c) => c.items))
    .filter((it) => it.exact && !it.images && it.text?.length > 2000 && it.tokens > 0)
    .map((it) => it.tokens / (it.text.length / 4)).sort((a, b) => a - b);
  const q = (p) => ratios[Math.floor(p * (ratios.length - 1))]?.toFixed(2);
  console.log(`delta tokens / (chars/4) over ${ratios.length} exact text results: p10 ${q(0.1)}  median ${q(0.5)}  p90 ${q(0.9)}\n`);
  const fmt = (n) => Math.round(n).toLocaleString().padStart(13);
  console.log("rules      policy  " + ["pruned tok", "exact %", "saved ITE", "rebuild ITE", "reread ITE", "net ITE", "net % input"].map((h) => h.padStart(13)).join(""));
  for (const edits of [false, true]) for (const [name, policy] of Object.entries(POLICIES)) {
    const L = sessions.map((s) => replay(s.calls, policy, { edits })).reduce((a, b) => {
      for (const k in b) a[k] = (a[k] || 0) + b[k]; return a; }, {});
    console.log((edits ? "+edits " : "strict ").padEnd(11) + name.padEnd(8) + fmt(L.prunedTokens)
      + `${(L.prunedTokens ? L.prunedExact / L.prunedTokens * 100 : 0).toFixed(1)}%`.padStart(13)
      + fmt(L.saved) + fmt(L.rebuild) + fmt(L.reread) + fmt(L.net)
      + `${(L.net / L.actualInputITE * 100).toFixed(2)}%`.padStart(13));
  }
}
