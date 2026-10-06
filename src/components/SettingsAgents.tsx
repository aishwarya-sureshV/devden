import { useEffect, useRef, useState } from "react";
import { api, type BackendInfo } from "../lib/api";
import { useStore } from "../lib/store";
import { AgentConnect } from "./AgentConnect";

/** Row order matches onboarding's card order. */
const ROW_ORDER = ["claude", "codex", "grok", "pi", "zcode"];

type Kind = "ready" | "auth" | "missing";

function kindOf(agent: BackendInfo): Kind {
  if (!agent.path) return "missing";
  if (agent.auth !== "ok") return "auth";
  return "ready";
}

const STATUS: Record<
  Kind,
  { label: string; dot: string; dotRing: string }
> = {
  ready: {
    label: "Connected",
    dot: "var(--pw-green)",
    dotRing: "var(--pw-green)",
  },
  auth: {
    label: "Sign in needed",
    dot: "var(--pw-yellow-soft)",
    dotRing: "var(--pw-yellow)",
  },
  missing: {
    label: "Not installed",
    dot: "transparent",
    dotRing: "var(--pw-fg-5)",
  },
};

export function SettingsAgents() {
  const { defaultBackend, setDefaultBackend, refreshBackendCatalog } = useStore();
  // The server-confirmed catalog: the only thing the pickers ever see.
  const [agents, setAgents] = useState<BackendInfo[]>([]);
  // Latest confirmed rows, for replies that land after an await.
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  // Enabled clicks still being saved: shown here at once, but published to
  // the pickers only when that agent's own save is confirmed.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState<string | null>(null);
  // The agent whose Connect dialog should open by itself — set after a
  // sign-out so the next sign-in is one click away.
  const [signedOut, setSignedOut] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState<{
    done: boolean;
    workspace: string | null;
  } | null>(null);

  const load = async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      const result = refresh
        ? await api.recheckBackends()
        : await api.backends();
      if (!result?.backends)
        throw new Error(
          "Could not look up agents. Restart the devden server and re-check.",
        );
      setAgents(result.backends);
      // Keep the store copy (pickers, banners) in step with this page.
      void refreshBackendCatalog(result.backends);
    } catch (err) {
      setError(
        err instanceof Error && err.name === "TimeoutError"
          ? "Agent lookup timed out. Check the devden server, then re-check."
          : err instanceof Error ? err.message : "Could not look up agents.",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
    void api
      .onboarding()
      .then((result) =>
        setOnboarding({
          done: Boolean(result?.done),
          workspace: result?.workspace ?? null,
        }),
      )
      .catch(() => {});
  }, []);

  const rows = agents
    .map((row) =>
      row.id in pending ? { ...row, enabled: pending[row.id] } : row,
    )
    .sort(
    (a, b) =>
      (ROW_ORDER.indexOf(a.id) + 1 || ROW_ORDER.length + 1) -
        (ROW_ORDER.indexOf(b.id) + 1 || ROW_ORDER.length + 1) ||
      a.id.localeCompare(b.id),
  );
  const counts = rows.reduce(
    (acc, agent) => {
      acc[kindOf(agent)] += 1;
      return acc;
    },
    { ready: 0, auth: 0, missing: 0 } as Record<Kind, number>,
  );
  const kicker = (
    [
      [counts.ready, "READY"],
      [counts.auth, "NEEDS SIGN-IN"],
      [counts.missing, "MISSING"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(" · ");

  const makeDefault = async (id: string) => {
    setDefaultBackend(id);
    // A hidden agent promoted to default returns to the pickers: a default
    // nobody can select is a trap. A failed write still leaves the toggle.
    const row = agents.find((agent) => agent.id === id);
    // Same path as the toggle, so a later toggle can't resurrect "hidden".
    if (row?.enabled === false) await saveEnabled(id, true);
    try {
      const saved = await api.saveOnboarding({
        done: onboarding?.done ?? true,
        defaultBackend: id,
        workspace: onboarding?.workspace ?? null,
      });
      setOnboarding((current) => ({
        done: saved.done,
        workspace: current?.workspace ?? null,
      }));
    } catch {
      // The store already persisted the choice locally; the server copy can
      // be updated from setup's Start screen.
    }
  };

  /** Confirmed rows changed: update Settings and the pickers together. */
  const confirm = (next: BackendInfo[]) => {
    agentsRef.current = next;
    setAgents(next);
    void refreshBackendCatalog(next);
  };

  const handleConnected = (backends: BackendInfo[]) => {
    setSignedOut(null);
    confirm(backends);
  };

  // Each save is authoritative for its own agent only: its reply's other
  // rows may predate a newer save of theirs, so they are ignored. A newer
  // click on the same agent supersedes an older one's reply or failure.
  const saveSeq = useRef(new Map<string, number>());

  /** Save one agent's Enabled choice. Resolves true when it was saved. */
  const saveEnabled = async (id: string, enabled: boolean) => {
    const seq = (saveSeq.current.get(id) ?? 0) + 1;
    saveSeq.current.set(id, seq);
    const latest = () => saveSeq.current.get(id) === seq;
    setPending((current) => ({ ...current, [id]: enabled }));
    const settle = () =>
      setPending((current) => {
        const { [id]: _done, ...rest } = current;
        return rest;
      });
    try {
      const result = await api.setBackendEnabled(id, enabled);
      if (!result.ok || !result.backends)
        throw new Error(result.error ?? "Could not save that choice.");
      if (!latest()) return false;
      const saved = result.backends.find((row) => row.id === id);
      settle();
      if (saved && saved.enabled !== agentsRef.current.find((row) => row.id === id)?.enabled)
        confirm(
          agentsRef.current.map((row) =>
            row.id === id ? { ...row, enabled: saved.enabled } : row,
          ),
        );
      return true;
    } catch (err) {
      if (!latest()) return false;
      // Nothing was confirmed, so the pickers never changed: only the
      // optimistic row goes back.
      settle();
      setError(
        err instanceof Error && err.name === "TimeoutError"
          ? "Saving took too long. Check the devden server, then retry."
          : err instanceof Error
            ? err.message
            : "Could not save that choice.",
      );
      return false;
    }
  };

  /** Hide or show an agent everywhere it would be picked. */
  const toggleEnabled = (agent: BackendInfo, enabled: boolean) =>
    saveEnabled(agent.id, enabled);

  /** Run the CLI's own logout, then reopen Connect so a different account
   *  can sign straight back in. */
  const signOut = async (id: string) => {
    setSigningOut(id);
    setError("");
    try {
      const result = await api.logoutBackend(id);
      if (!result.ok || !result.backends)
        throw new Error(result.error ?? "Sign-out failed.");
      handleConnected(result.backends);
      setSignedOut(id);
    } catch (err) {
      setError(
        err instanceof Error && err.name === "TimeoutError"
          ? "Sign-out timed out. Check the devden server, then retry."
          : err instanceof Error
            ? err.message
            : "Sign-out failed.",
      );
    } finally {
      setSigningOut(null);
    }
  };

  const runSetupAgain = async () => {
    try {
      await api.saveOnboarding({
        done: false,
        defaultBackend,
        workspace: onboarding?.workspace ?? null,
      });
    } catch {
      // Reload anyway; a failed write just leaves setup marked done.
    }
    window.location.reload();
  };

  return (
    <div className="agents-settings">
      <div className="agents-settings__head">
        <div>
          <h2>Your agents</h2>
          <p>
            Connect an agent here. We'll handle installation and help you sign
            in. New sessions start on your default agent.
          </p>
        </div>
        <div className="agents-settings__actions">
          {kicker && <span className="agents-settings__kicker">{kicker}</span>}
          <button
            type="button"
            className="agents-settings__recheck"
            onClick={() => void load(true)}
            disabled={loading}
          >
            ↻ Re-check
          </button>
        </div>
      </div>

      {error && <p className="agents-settings__error">{error}</p>}

      <div className="agents-settings__list" aria-busy={loading}>
        {loading && !rows.length && (
          <div className="agents-settings__loading">Looking…</div>
        )}
        {rows.map((agent) => {
          const kind = kindOf(agent);
          const look = STATUS[kind];
          const isDefault = defaultBackend === agent.id;
          const hidden = agent.enabled === false;
          return (
            <div className="agents-settings__item" key={agent.id}>
              <div className="agents-settings__row">
                <div className="agents-settings__id">
                  <span
                    className="agents-settings__dot"
                    style={{ background: look.dot, borderColor: look.dotRing }}
                  />
                  <strong>{agent.id}</strong>
                  {isDefault && (
                    <span className="agents-settings__badge">DEFAULT</span>
                  )}
                </div>
                <div className="agents-settings__meta">
                  <span>{agent.version ?? (agent.path ? "installed" : "not installed")}</span>
                  <span>{agent.pathLabel || agent.path || "not on PATH"}</span>
                </div>
                <span className={`agents-settings__status is-${kind}${hidden ? " is-hidden" : ""}`}>
                  {hidden ? "Hidden from pickers" : look.label}
                </span>
                <div className="agents-settings__buttons">
                  <label
                    className="agents-settings__toggle"
                    title={
                      hidden
                        ? "Hidden from pickers; sessions on it still open."
                        : "Shown in pickers."
                    }
                  >
                    <input
                      type="checkbox"
                      checked={!hidden}
                      onChange={(event) =>
                        void toggleEnabled(agent, event.target.checked)
                      }
                    />
                    Enabled
                  </label>
                  {kind === "ready" && !isDefault && (
                    <button
                      type="button"
                      onClick={() => void makeDefault(agent.id)}
                    >
                      Make default
                    </button>
                  )}
                  {kind === "ready" && (
                    <button
                      type="button"
                      disabled={signingOut !== null}
                      onClick={() => void signOut(agent.id)}
                    >
                      {signingOut === agent.id
                        ? "Signing out…"
                        : "Sign out / switch account"}
                    </button>
                  )}
                  {kind !== "ready" || signedOut === agent.id ? (
                    <AgentConnect
                      agent={agent}
                      autoOpen={signedOut === agent.id}
                      onConnected={handleConnected}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="agents-settings__setup">
        <div>
          <strong>First-run setup</strong>
          <span>
            {onboarding?.done
              ? "Completed · saved on this machine"
              : "Not finished yet · runs before the workbench opens"}
          </span>
        </div>
        <button type="button" onClick={() => void runSetupAgain()}>
          Run setup again
        </button>
      </div>
    </div>
  );
}
