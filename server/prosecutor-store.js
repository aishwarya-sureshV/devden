/**
 * Durable prosecutor cases (server/db.js). One row per case, one row per
 * case.log entry. Process handles, timers and busy flags stay in memory.
 *
 * `extra` on cases and `findings` on rounds are JSON. Known fields are
 * written back when present; any other key in that JSON is saved and loaded
 * unchanged so a parallel change can add them without a new migration.
 */
import { db, transaction } from "./db.js";

export const PHASES = [
  "executor_running",
  "review_pending",
  "review_running",
  "repair_pending",
  "repair_running",
  "paused",
  "verification_pending",
  "accepted",
  "stopped",
];

const FINISHED = new Set(["accepted", "stopped"]);
/** Copied between the case object and `extra` when present. */
const EXTRA_KEYS = ["status", "gate", "owned", "findings", "flags", "gateNote", "paused", "interrupted", "caseId", "verdict"];
const REVIEW_PHASES = new Set(["review_pending", "review_running", "verification_pending"]);

function parseJson(text) {
  if (text == null || text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function jsonOrNull(value) {
  return value == null ? null : JSON.stringify(value);
}

function packExtra(current) {
  const extra = { ...(current.extra && typeof current.extra === "object" ? current.extra : {}) };
  for (const key of EXTRA_KEYS) {
    if (current[key] !== undefined) extra[key] = current[key];
  }
  delete extra.extra;
  delete extra.executor;
  delete extra.base;
  delete extra.log;
  delete extra.busy;
  return extra;
}

function baselineOf(current) {
  const base = current.base;
  if (base && typeof base.then !== "function" && base.commit) return base.commit;
  return current.baselineCommit || null;
}

function hydrate(row, rounds) {
  const extra = parseJson(row.extra);
  const bag = extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {};
  const commit = row.baseline_commit || null;
  const current = {
    id: row.id,
    sessionId: row.session_id,
    cwd: row.cwd || "",
    task: row.task || "",
    backend: row.prosecutor_backend || "",
    model: parseJson(row.prosecutor_model) ?? null,
    effort: row.prosecutor_effort ?? null,
    executorBackend: row.executor_backend || "",
    executorModel: parseJson(row.executor_model) ?? null,
    round: row.round || 0,
    phase: row.phase,
    baselineCommit: commit,
    base: commit ? { ok: true, commit } : null,
    defense: row.last_defense || "",
    lastReport: row.last_report || "",
    log: rounds.map(roundEntry),
    paused: null,
    busy: false,
    failed: "",
    resuming: "",
    extra: bag,
  };
  for (const [key, value] of Object.entries(bag)) {
    if (key === "extra" || key === "log" || key === "base" || key === "executor" || key === "busy")
      continue;
    if (current[key] === undefined || EXTRA_KEYS.includes(key)) current[key] = value;
  }
  return current;
}

function roundEntry(row) {
  const entry = {
    round: row.round,
    by: row.by ?? "",
    prompt: row.prompt ?? "",
    report: row.report ?? "",
  };
  if (row.reply != null) entry.reply = row.reply;
  if (row.reply_by != null) entry.replyBy = row.reply_by;
  if (row.died != null) entry.died = row.died;
  if (row.findings != null) {
    const findings = parseJson(row.findings);
    if (findings !== undefined) entry.findings = findings;
  }
  return entry;
}

const UPSERT = `INSERT INTO cases (
  id, session_id, cwd, task,
  prosecutor_backend, prosecutor_model, prosecutor_effort,
  executor_backend, executor_model,
  round, phase, baseline_commit, last_report, last_defense,
  updated_at, extra
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
  session_id = excluded.session_id,
  cwd = excluded.cwd,
  task = excluded.task,
  prosecutor_backend = excluded.prosecutor_backend,
  prosecutor_model = excluded.prosecutor_model,
  prosecutor_effort = excluded.prosecutor_effort,
  executor_backend = excluded.executor_backend,
  executor_model = excluded.executor_model,
  round = excluded.round,
  phase = excluded.phase,
  baseline_commit = excluded.baseline_commit,
  last_report = excluded.last_report,
  last_defense = excluded.last_defense,
  updated_at = excluded.updated_at,
  extra = excluded.extra`;

const INSERT_ROUND = `INSERT INTO case_rounds (
  case_id, seq, round, "by", prompt, report, reply, reply_by, died, findings
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export function saveCase(current, home) {
  if (!current?.id || !current.sessionId || !current.phase) return;
  const conn = db(home);
  const extra = packExtra(current);
  const blank = (value) => (value == null || value === "" ? null : String(value));
  transaction(conn, () => {
    conn.prepare(UPSERT).run(
      current.id,
      current.sessionId,
      current.cwd || "",
      current.task || "",
      blank(current.backend),
      jsonOrNull(current.model),
      current.effort ?? null,
      blank(current.executorBackend),
      jsonOrNull(current.executorModel),
      current.round || 0,
      current.phase,
      baselineOf(current),
      current.lastReport || null,
      current.defense || null,
      Date.now(),
      JSON.stringify(extra),
    );
    conn.prepare("DELETE FROM case_rounds WHERE case_id = ?").run(current.id);
    const insert = conn.prepare(INSERT_ROUND);
    (current.log ?? []).forEach((entry, seq) => {
      insert.run(
        current.id,
        seq,
        entry.round ?? 0,
        entry.by ?? "",
        entry.prompt ?? "",
        entry.report ?? null,
        entry.reply ?? null,
        entry.replyBy ?? null,
        entry.died ?? null,
        entry.findings === undefined ? null : JSON.stringify(entry.findings),
      );
    });
  });
}

function loadRounds(conn, caseId) {
  return conn
    .prepare(
      `SELECT round, "by" AS by, prompt, report, reply, reply_by, died, findings
       FROM case_rounds WHERE case_id = ? ORDER BY seq`,
    )
    .all(caseId);
}

function loadRow(row, home) {
  if (!row) return null;
  return hydrate(row, loadRounds(db(home), row.id));
}

export function loadBySession(sessionId, home) {
  if (!sessionId) return null;
  const row = db(home)
    .prepare(
      `SELECT * FROM cases
       WHERE session_id = ? AND phase NOT IN ('accepted', 'stopped')
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(sessionId);
  return loadRow(row, home);
}

export function unfinished(home) {
  const conn = db(home);
  return conn
    .prepare(
      `SELECT * FROM cases
       WHERE phase NOT IN ('accepted', 'stopped')
       ORDER BY updated_at`,
    )
    .all()
    .map((row) => hydrate(row, loadRounds(conn, row.id)));
}

/**
 * A case loaded after the process stopped. A round that was running has not
 * counted (it keeps its number and runs again). Verification is the same for
 * the round that just acquitted: that round runs again. Already-paused cases
 * keep their round. Finished cases are not resumed.
 */
export function interruptCase(saved) {
  if (!saved || FINISHED.has(saved.phase)) return null;
  const next = {
    ...saved,
    log: (saved.log ?? []).map((entry) => ({ ...entry })),
    extra: { ...(saved.extra ?? {}) },
    paused: saved.paused ? { ...saved.paused } : null,
    busy: false,
    failed: "",
    resuming: "",
    recoveryNote: "",
  };
  delete next.executor;
  const phase = saved.phase;
  if (phase === "verification_pending") {
    const entry = [...next.log].reverse().find((item) => item.round === saved.round && !item.died);
    if (entry) entry.died = "server restarted during verification";
    next.round = Math.max(0, (saved.round || 0) - 1);
  } else if (phase === "review_running") {
    next.round = Math.max(0, (saved.round || 0) - 1);
  }
  const side =
    phase === "paused"
      ? saved.paused?.side === "prosecutor"
        ? "prosecutor"
        : "executor"
      : REVIEW_PHASES.has(phase)
        ? "prosecutor"
        : "executor";
  const pausedRound =
    phase === "paused"
      ? (saved.paused?.round ?? (side === "prosecutor" ? next.round + 1 : next.round))
      : side === "prosecutor"
        ? next.round + 1
        : next.round;
  next.paused = {
    ...(next.paused ?? {}),
    side,
    reason: saved.paused?.reason || "server restarted",
    round: pausedRound,
  };
  next.interrupted = true;
  next.phase = "paused";
  return next;
}

export function createProsecutorStore(home) {
  return {
    save: (current) => saveCase(current, home),
    loadBySession: (sessionId) => loadBySession(sessionId, home),
    unfinished: () => unfinished(home),
  };
}
