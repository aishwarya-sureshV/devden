import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

type Phase = "none" | "available" | "updating" | "done" | "fail";

const POLL_MS = 30 * 60_000;
const FIRST_CHECK_MS = 4_000;

/**
 * Sidebar footer: DevDen's own update state only (Settings lives in the nav).
 * An available update shows a pill that stays until the user updates (no
 * dismiss); harness CLI updates stay in the floating UpdateTray.
 */
export function AppUpdateFooter({ collapsed }: { collapsed: boolean }) {
  const [phase, setPhase] = useState<Phase>("none");
  const [behind, setBehind] = useState(0);
  const [reason, setReason] = useState("");

  const poll = useCallback(async () => {
    try {
      const { updates } = await api.harnessUpdates();
      const row = updates?.find((u) => u.id === "devden");
      setPhase((p) => (p === "none" || p === "available" ? (row ? "available" : "none") : p));
      setBehind(row?.behind ?? 0);
    } catch {
      // Offline: keep the last answer.
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

  const run = async () => {
    setPhase("updating");
    try {
      const result = await api.runHarnessUpdate("devden");
      if (!result.ok) throw new Error(result.cmd ? `${result.error}\nBy hand: ${result.cmd}` : result.error);
      setPhase("done");
    } catch (err) {
      setReason(err instanceof Error && err.message ? err.message : "Update failed.");
      setPhase("fail");
    }
  };

  if (phase === "none")
    return collapsed ? null : (
      <span className="sidebar__footer app-update__status" title="DevDen is on the latest main">
        <span className="app-update__fine">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m3.5 8.4 3 3 6-6.6" />
          </svg>
          Up to date
        </span>
      </span>
    );

  const pill = {
    available: { label: "Update DevDen", icon: "up", onClick: () => void run(), title: `${behind || "New"} commit${behind === 1 ? "" : "s"} on main · takes about a minute` },
    updating: { label: "Updating…", icon: "spin", onClick: undefined, title: "Pulling and rebuilding. Keep working." },
    done: { label: "Reload to finish", icon: "reload", onClick: () => window.location.reload(), title: "New build is ready" },
    fail: { label: "Update failed · Retry", icon: "bad", onClick: () => void run(), title: reason },
  }[phase];

  return (
    <>
      <button
        type="button"
        className={`app-update is-${phase}${collapsed ? " is-compact" : ""}`}
        onClick={pill.onClick}
        disabled={phase === "updating"}
        title={pill.title}
        aria-label={collapsed ? pill.label : undefined}
        aria-live="polite"
      >
        <PillIcon kind={pill.icon} />
        {!collapsed && <span className="app-update__label">{pill.label}</span>}
      </button>
    </>
  );
}

function PillIcon({ kind }: { kind: string }) {
  if (kind === "spin") return <span className="app-update__spin" aria-hidden />;
  const d = {
    up: "M8 12.5V3.8M4.3 7.4 8 3.7l3.7 3.7",
    reload: "M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.6H9.9",
    bad: "M8 4.5v4M8 11.2v.1",
  }[kind];
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
