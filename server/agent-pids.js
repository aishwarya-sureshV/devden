/**
 * Ledger of the long-lived agent processes this server spawned, so the next
 * boot can kill the ones a hard death (kill -9, crash, OOM) left running.
 * Nothing runs at shutdown -- SIGKILL gives no chance -- so the file is
 * rewritten on every spawn/exit and read once at startup.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { devdenHome } from "./db.js";

const live = new Map();
const ledgerPath = () => join(devdenHome(), "agent-pids.json");

function save() {
  try {
    writeFileSync(ledgerPath(), JSON.stringify([...live.values()]));
  } catch {}
}

/** Record a spawned agent until it exits. */
export function trackAgentProcess(child) {
  if (!child?.pid) return;
  live.set(child.pid, {
    pid: child.pid,
    serverPid: process.pid,
    startedAt: Date.now(),
  });
  save();
  child.once("exit", () => {
    live.delete(child.pid);
    save();
  });
}

/** `[[dd-]hh:]mm:ss` -> seconds. */
export function parseEtime(text) {
  const [days, rest] = text.includes("-") ? text.split("-") : ["0", text];
  const seconds = rest
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
  return Number(days) * 86400 + seconds;
}

/**
 * Pick the ledger entries that are still the same orphaned process: alive,
 * no longer parented by the server that spawned them, and started when the
 * ledger says (a reused PID starts later). Their descendants come too: tool
 * shells (claude's Bash) run in process groups of their own and would keep
 * editing the workspace after the agent dies.
 */
export function orphansToKill(entries, table, now = Date.now()) {
  const victims = entries
    .filter((entry) => {
      const row = table.get(entry.pid);
      if (!row || row.ppid === entry.serverPid) return false;
      // ps reports whole seconds; allow slack for that and a slow fork.
      return Math.abs(now - row.etime * 1000 - entry.startedAt) <= 5000;
    })
    .map((entry) => entry.pid);
  for (let i = 0; i < victims.length; i++)
    for (const [pid, row] of table)
      if (row.ppid === victims[i] && !victims.includes(pid)) victims.push(pid);
  return victims.map((pid) => ({ pid, group: table.get(pid).pgid === pid }));
}

function processTable() {
  const table = new Map();
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,etime="], {
    encoding: "utf8",
  });
  for (const line of out.trim().split("\n")) {
    const [pid, ppid, pgid, etime] = line.trim().split(/\s+/);
    table.set(Number(pid), {
      ppid: Number(ppid),
      pgid: Number(pgid),
      etime: parseEtime(etime),
    });
  }
  return table;
}

/** Boot-time: kill agents a previous server instance left behind. */
export function reapOrphanAgents() {
  let entries;
  try {
    entries = JSON.parse(readFileSync(ledgerPath(), "utf8"));
  } catch {
    return [];
  }
  const killed = [];
  try {
    for (const { pid, group } of orphansToKill(entries, processTable())) {
      try {
        // Detached agents lead their own group: take their tool children too.
        process.kill(group ? -pid : pid, "SIGKILL");
        killed.push(pid);
      } catch {}
    }
  } catch {}
  save();
  if (killed.length)
    console.log(`devden: killed orphaned agent processes ${killed.join(", ")}`);
  return killed;
}
