import { useEffect, useState } from "react";
import { api, type BackendInfo } from "../lib/api";
import { useStore } from "../lib/store";
import { AgentConnect } from "./AgentConnect";

/** Row order matches onboarding's card order. */
const ROW_ORDER = ["claude", "codex", "grok", "pi"];

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
  const { defaultBackend, setDefaultBackend } = useStore();
  const [agents, setAgents] = useState<BackendInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not look up agents.",
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

  const rows = [...agents].sort(
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
                  <span>{agent.version ?? "not installed"}</span>
                  <span>{agent.pathLabel || agent.path || "not on PATH"}</span>
                </div>
                <span className={`agents-settings__status is-${kind}`}>
                  {look.label}
                </span>
                <div className="agents-settings__buttons">
                  {kind === "ready" && !isDefault && (
                    <button
                      type="button"
                      onClick={() => void makeDefault(agent.id)}
                    >
                      Make default
                    </button>
                  )}
                  {kind !== "ready" && <AgentConnect agent={agent} onConnected={setAgents} />}
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
