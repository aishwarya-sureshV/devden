import { useCallback, useEffect, useRef, useState } from "react";
import { api, backendLabel, backendMark } from "../lib/api";
import "../styles/updateTray.css";

type Status = "idle" | "queued" | "running" | "ok" | "fail";

interface Row {
  id: string;
  installed: string | null;
  latest: string | null;
  status: Status;
  reason?: string;
  log?: string;
  cmd?: string;
  open?: boolean;
}

const POLL_MS = 30 * 60_000;
/** Let the app finish loading before anything asks for attention. */
const FIRST_CHECK_MS = 4_000;
const FADE_MS = 6_000;

const rowName = (id: string) => (id === "devden" ? "Devden" : backendLabel(id));

function rowMark(id: string) {
  if (id === "devden") return { glyph: "◈", color: "var(--acc)" };
  const mark = backendMark(id);
  // Codex and Grok marks are near-white; keep them readable on light skins.
  return {
    glyph: mark.glyph,
    color: id === "codex" || id === "grok" ? "var(--fg0)" : mark.color,
  };
}

function rowSub(row: Row) {
  if (row.status === "fail") return row.reason ?? "Update failed.";
  if (row.id === "devden")
    return row.status === "ok" ? "Pulled and rebuilt" : "New commits on main";
  if (row.status === "ok") return `Now ${row.latest ?? "latest"}`;
  return `${row.installed ?? "?"}  →  ${row.latest ?? "?"}`;
}

/**
 * Update tray: one quiet card for every harness (and devden) with a newer
 * version. ✕ hides it until the page is refreshed. A failure of an update the
 * user started comes back once, because they are waiting on the answer.
 */
export function UpdateTray() {
  const [rows, setRows] = useState<Row[]>([]);
  const [phase, setPhase] = useState<"available" | "updating" | "done">(
    "available",
  );
  // Session-only on purpose: plain state, never persisted, never keyed to a
  // version, so a newer release does not bring the card back.
  const [dismissed, setDismissed] = useState(false);
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const poll = useCallback(async () => {
    try {
      const result = await api.harnessUpdates();
      // Never swap rows out from under a run or its result.
      if (phaseRef.current !== "available") return;
      // DevDen itself lives in the sidebar footer (AppUpdateFooter).
      setRows(
        (result.updates ?? []).filter((u) => u.id !== "devden").map(({ id, installed, latest }) => ({
          id,
          installed,
          latest,
          status: "idle",
        })),
      );
    } catch {
      // Server unreachable: keep whatever the last check showed.
    }
  }, []);
  useEffect(() => {
    const first = window.setTimeout(() => void poll(), FIRST_CHECK_MS);
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [poll]);

  const patch = (id: string, change: Partial<Row>) =>
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...change } : row)),
    );

  const run = useCallback(async (targets: Row[]) => {
    if (phaseRef.current === "updating" || !targets.length) return;
    phaseRef.current = "updating";
    setPhase("updating");
    const ids = targets.map((row) => row.id);
    setRows((current) =>
      current.map((row) =>
        ids.includes(row.id) ? { ...row, status: "queued", open: false } : row,
      ),
    );
    const failed = new Map<string, Partial<Row>>();
    for (const id of ids) {
      patch(id, { status: "running" });
      try {
        const result = await api.runHarnessUpdate(id);
        if (!result.ok)
          failed.set(id, {
            reason: result.error,
            log: result.log,
            cmd: result.cmd,
          });
      } catch (err) {
        failed.set(id, {
          reason: err instanceof Error ? err.message : "Update failed.",
        });
      }
      if (!failed.has(id)) patch(id, { status: "ok" });
    }
    // Trust a fresh version check over the runner's own word.
    try {
      const fresh = await api.harnessUpdates();
      for (const row of fresh.updates ?? [])
        if (ids.includes(row.id) && !failed.has(row.id))
          failed.set(row.id, { reason: "Still on the old version afterwards." });
    } catch {
      // Can't verify; keep the runner's verdict.
    }
    for (const [id, info] of failed)
      patch(id, { status: "fail", open: true, ...info });
    void api.recheckBackends().catch(() => {});
    phaseRef.current = "done";
    setPhase("done");
    if (failed.size) setDismissed(false);
  }, []);

  const failedRows = rows.filter((row) => row.status === "fail");
  const okRows = rows.filter((row) => row.status === "ok");
  const hasDevden = rows.some((row) => row.id === "devden");

  // A clean result fades on its own (pausing while hovered or focused), but
  // never reloads the page: that can wipe a half-typed prompt.
  const clean = phase === "done" && !failedRows.length && !hasDevden;
  useEffect(() => {
    if (!clean || paused) return;
    const timer = window.setTimeout(() => {
      setRows([]);
      setPhase("available");
    }, FADE_MS);
    return () => window.clearTimeout(timer);
  }, [clean, paused]);

  if (dismissed || !rows.length) return null;

  const n = rows.length;
  const finished = okRows.length + failedRows.length;
  let title: string;
  let sub: string;
  let tone: "up" | "spin" | "ok" | "bad";
  if (phase === "available") {
    title =
      n === 1 ? `${rowName(rows[0].id)} update available` : `${n} updates available`;
    sub = rows.some((row) => row.id !== "devden")
      ? "New models and fixes. Sessions keep running."
      : "New build ready. Takes about a minute.";
    tone = "up";
  } else if (phase === "updating") {
    title = `Updating ${Math.min(finished + 1, n)} of ${n}…`;
    sub = "Runs in the background. Keep working.";
    tone = "spin";
  } else if (!failedRows.length) {
    title = "Everything's up to date";
    sub = hasDevden
      ? "Reload to load the new build."
      : "New sessions use the latest versions.";
    tone = "ok";
  } else {
    title = !okRows.length
      ? n === 1
        ? `${rowName(rows[0].id)} update failed`
        : `${n} updates failed`
      : `${okRows.length} updated · ${failedRows.length} failed`;
    sub = okRows.length
      ? "Successful updates are already in place."
      : "Your current versions still work.";
    tone = "bad";
  }

  let primary: { label: string; onClick: () => void } | null = null;
  if (phase === "available")
    primary = {
      label: n === 1 ? "Update" : "Update all",
      onClick: () => void run(rows),
    };
  else if (phase === "done" && failedRows.length)
    primary = {
      label: n === 1 ? "Retry" : "Retry failed",
      onClick: () => void run(failedRows),
    };
  else if (phase === "done" && hasDevden)
    primary = { label: "Reload", onClick: () => window.location.reload() };

  const copy = (row: Row) => {
    if (!row.cmd) return;
    void navigator.clipboard?.writeText(row.cmd).catch(() => {});
    setCopied(row.id);
    window.setTimeout(() => setCopied((id) => (id === row.id ? null : id)), 1800);
  };

  return (
    <section
      className="update-tray"
      aria-label="Updates"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {phase === "updating" && (
        <div
          className="update-tray__bar"
          style={{
            width: `${Math.round(((finished + 0.5) / n) * 100)}%`,
          }}
        />
      )}
      <header className="update-tray__head">
        <span className={`update-tray__badge is-${tone}`} aria-hidden>
          <TrayIcon tone={tone} />
        </span>
        <div
          className="update-tray__titles"
          aria-live={tone === "bad" ? "assertive" : "polite"}
        >
          <div className="update-tray__title">{title}</div>
          <div className="update-tray__sub">{sub}</div>
        </div>
        <button
          type="button"
          className="update-tray__x"
          aria-label="Dismiss update notice"
          onClick={() => setDismissed(true)}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <ul className="update-tray__rows">
        {rows.map((row) => {
          const mark = rowMark(row.id);
          return (
            <li
              key={row.id}
              className={`update-tray__row is-${row.status}`}
            >
              <div className="update-tray__line">
                <span className="update-tray__mark" style={{ color: mark.color }}>
                  {mark.glyph}
                </span>
                <span className="update-tray__who">
                  <span className="update-tray__name">{rowName(row.id)}</span>
                  <span className="update-tray__ver">{rowSub(row)}</span>
                </span>
                {row.status === "running" && (
                  <span className="update-tray__state is-running">
                    <span className="update-tray__spin" aria-hidden />
                    Updating
                  </span>
                )}
                {row.status === "queued" && (
                  <span className="update-tray__state">Queued</span>
                )}
                {row.status === "ok" && (
                  <span className="update-tray__state is-ok">
                    <svg
                      viewBox="0 0 16 16"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="m3.5 8.4 3 3 6-6.6" />
                    </svg>
                    Updated
                  </span>
                )}
                {row.status === "fail" && (
                  <button
                    type="button"
                    className="update-tray__chip is-bad"
                    aria-expanded={!!row.open}
                    onClick={() => patch(row.id, { open: !row.open })}
                  >
                    {row.open ? "Hide" : "Details"}
                  </button>
                )}
              </div>
              {row.status === "fail" && row.open && (
                <div className="update-tray__details">
                  {row.log && <pre className="update-tray__log">{row.log}</pre>}
                  {row.cmd && (
                    <div className="update-tray__cmd">
                      <code>{row.cmd}</code>
                      <button
                        type="button"
                        className="update-tray__chip"
                        onClick={() => copy(row)}
                      >
                        {copied === row.id ? "Copied" : "Copy command"}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {primary && (
        <footer className="update-tray__foot">
          <button
            type="button"
            className="update-tray__primary"
            onClick={primary.onClick}
          >
            {primary.label}
          </button>
        </footer>
      )}
    </section>
  );
}

function TrayIcon({ tone }: { tone: "up" | "spin" | "ok" | "bad" }) {
  const common = {
    viewBox: "0 0 16 16",
    width: 16,
    height: 16,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (tone === "spin") return <span className="update-tray__spin" />;
  if (tone === "ok")
    return (
      <svg {...common}>
        <path d="m3.5 8.4 3 3 6-6.6" />
      </svg>
    );
  if (tone === "bad")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 5v3.4M8 10.9v.1" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M8 12.5V3.8M4.3 7.4 8 3.7l3.7 3.7" />
    </svg>
  );
}
