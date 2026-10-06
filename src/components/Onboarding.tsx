import { useEffect, useState } from "react";
import { api, type BackendInfo } from "../lib/api";
import { useStore } from "../lib/store";
import { Backdrop } from "./Backdrop";
import { AgentConnect } from "./AgentConnect";
import { AgentMascot } from "./icons";

const CARD_ORDER = ["claude", "codex", "grok", "pi", "zcode", "opencode"];

function ordered(list: BackendInfo[]) {
  const rank = (id: string) => {
    const at = CARD_ORDER.indexOf(id);
    return at === -1 ? CARD_ORDER.length : at;
  };
  return [...list].sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

function ready(agent: BackendInfo) {
  return Boolean(agent.path) && agent.auth === "ok";
}

export function Onboarding() {
  const { finishSetup } = useStore();
  // Starts on "agents" until the intro piece exists: a blank first screen
  // reads as broken to someone who just installed DevDen.
  const [step, setStep] = useState<"intro" | "agents">("agents");
  const [agents, setAgents] = useState<BackendInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [hop, setHop] = useState(false);

  const celebrate = () => {
    setHop(true);
    window.setTimeout(() => setHop(false), 1300);
  };

  const load = async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      const result = refresh ? await api.recheckBackends() : await api.backends();
      if (!result?.backends) throw new Error("Could not look up agents. Restart the devden server and re-check.");
      setAgents(ordered(result.backends));
      if (refresh) celebrate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not look up agents.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
    void api.health().then((health) => {
      if (health.cwd) setWorkspace((current) => current || health.cwd);
    }).catch(() => {});
  }, []);

  const readyAgents = agents.filter(ready);

  const finish = async () => {
    const backend = readyAgents[0]?.id ?? "pi";
    try {
      await api.saveOnboarding({
        done: true,
        defaultBackend: backend,
        workspace: workspace || null,
      });
      finishSetup(workspace || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save setup.");
    }
  };

  return (
    <div className="dd-on">
      <Backdrop />
      <div className="dd-on__tint" aria-hidden="true" />
      {step === "intro" ? (
        // ponytail: intro motion piece (merge-conflict story) not built yet —
        // screen left blank; add the canvas animation here when designed.
        <div className="dd-on__intro">
          <button type="button" className="dd-on__skip-intro" onClick={() => setStep("agents")}>
            Skip intro
          </button>
        </div>
      ) : (
        <div className="dd-on__setup">
          <div className="dd-on__card">
            <div className="dd-on__perch" aria-hidden="true">
              {agents.map((agent) => (
                <span
                  key={agent.id}
                  className={`dd-on__perch-item${ready(agent) ? "" : " is-off"}${hop && ready(agent) ? " is-hop" : ""}`}
                >
                  <AgentMascot kind={agent.id} size={26} />
                </span>
              ))}
            </div>
            <div className="dd-on__agents">
              <div className="dd-on__agents-head">
                <div>
                  <h1>Who's joining?</h1>
                  <p>
                    {loading
                      ? "Looking for agents on this machine…"
                      : "Found on this machine. Connect any that need a sign-in."}
                  </p>
                </div>
                <button type="button" className="dd-on__recheck" onClick={() => void load(true)} disabled={loading}>
                  Re-check
                </button>
              </div>
              <div className="dd-on__list">
                {agents.map((agent) => (
                  <div key={agent.id} className="dd-on__agent">
                    <AgentMascot kind={agent.id} size={22} />
                    <div className="dd-on__agent-name">
                      <span>{agent.name || agent.id}</span>
                      <span className="dd-on__cli">{agent.command}</span>
                    </div>
                    {ready(agent) ? (
                      <span className="dd-on__ready"><i />Ready</span>
                    ) : (
                      <AgentConnect
                        agent={agent}
                        onConnected={(list) => {
                          setAgents(ordered(list));
                          celebrate();
                        }}
                      />
                    )}
                  </div>
                ))}
                {agents.length === 0 && !loading && (
                  <div className="dd-on__empty">No agents found yet. Re-check after installing one.</div>
                )}
              </div>
              <div className="dd-on__agents-foot">
                <span>
                  {readyAgents.length} of {agents.length} ready
                </span>
                <button
                  type="button"
                  className="dd-on__start"
                  disabled={readyAgents.length === 0}
                  onClick={() => void finish()}
                >
                  Start with {readyAgents.length} →
                </button>
              </div>
            </div>
          </div>
          {error && <p className="dd-on__error">{error}</p>}
          <button type="button" className="dd-on__skip" onClick={() => void finish()}>
            Skip setup
          </button>
        </div>
      )}
    </div>
  );
}