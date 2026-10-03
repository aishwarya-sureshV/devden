import { useEffect, useMemo, useState } from "react";
import {
  api,
  type BackendInfo,
} from "../lib/api";
import { useStore } from "../lib/store";
import { AgentConnect } from "./AgentConnect";
import { BackendLogo } from "./icons";

type Step = "welcome" | "agents" | "start";

const CARD_ORDER = ["claude", "codex", "grok", "pi"];

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

function cardKind(agent: BackendInfo): "ready" | "signed-out" | "missing" {
  if (!agent.path) return "missing";
  if (agent.auth !== "ok") return "signed-out";
  return "ready";
}

function statusLabel(kind: ReturnType<typeof cardKind>) {
  if (kind === "ready") return "ready";
  if (kind === "signed-out") return "not signed in";
  return "not installed";
}

export function Onboarding() {
  const { finishSetup, setDefaultBackend, knownWorkspaces } = useStore();
  const [step, setStep] = useState<Step>("welcome");
  const [agents, setAgents] = useState<BackendInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [recents, setRecents] = useState<string[]>([]);
  const [defaultId, setDefaultId] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      const result = refresh ? await api.recheckBackends() : await api.backends();
      if (!result?.backends) throw new Error("Could not look up agents. Restart the devden server and re-check.");
      setAgents(ordered(result.backends));
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
    void api.sessions("recent", "all").then((result) => {
      const seen: string[] = [];
      for (const session of result.sessions ?? []) {
        if (session.cwd && !seen.includes(session.cwd)) seen.push(session.cwd);
      }
      setRecents(seen.slice(0, 4));
    }).catch(() => {});
  }, []);

  const cards = useMemo(() => ordered(agents), [agents]);
  const builtins = cards.filter((agent) => CARD_ORDER.includes(agent.id));
  const found = builtins.filter((agent) => agent.path).length;
  const readyCount = cards.filter(ready).length;
  const allReady = cards.length > 0 && cards.every(ready);
  const noneFound = found === 0 && readyCount === 0;
  const readyAgents = cards.filter(ready);
  const firstReady = readyAgents[0]?.id ?? "";

  useEffect(() => {
    if (!defaultId && firstReady) setDefaultId(firstReady);
  }, [defaultId, firstReady]);

  const finish = async (openWorkspace: boolean) => {
    setSaving(true);
    setError("");
    try {
      const backend = defaultId || readyAgents[0]?.id || "pi";
      setDefaultBackend(backend);
      await api.saveOnboarding({
        done: true,
        defaultBackend: backend,
        workspace: openWorkspace ? workspace : null,
      });
      finishSetup(openWorkspace && workspace ? workspace : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save setup.");
      setSaving(false);
    }
  };

  const recentChoices = [...recents, ...knownWorkspaces.filter((cwd) => !recents.includes(cwd))].slice(0, 4);

  return (
    <div className="setup">
      <aside className="setup__side">
        <div className="setup__brand">
          <div className="setup__mark"><BackendLogo backend="pi" size={26} /></div>
          <div>
            <strong>devden</strong>
            <span>first run</span>
          </div>
        </div>
        <div className="setup__kicker">SETUP</div>
        <div className="setup__steps">
          <StepMark n="01" label="What is this" state={step === "welcome" ? "current" : "done"} />
          <StepMark
            n="02"
            label="Agents"
            state={step === "agents" ? "current" : step === "start" ? "done" : "later"}
          />
          <StepMark n="03" label="Start" state={step === "start" ? "current" : "later"} />
        </div>
        <button type="button" className="setup__skip" onClick={() => void finish(false)}>
          Skip setup
        </button>
      </aside>
      <main className="setup__main">
        <div className="setup__bar">
          {step === "welcome" ? "Welcome" : step === "start" ? "Start" : "Agents"}
        </div>
        <div className="setup__body">
          <div className="setup__column">
            {step === "welcome" && (
              <Welcome onNext={() => setStep("agents")} />
            )}
            {step === "agents" && (
              <Agents
                cards={cards}
                loading={loading}
                found={found}
                builtinCount={builtins.length || 4}
                readyCount={readyCount}
                allReady={allReady}
                noneFound={noneFound}
                error={error}
                onRecheck={() => void load(true)}
                onConnected={setAgents}
                onBack={() => setStep("welcome")}
                onContinue={() => setStep("start")}
              />
            )}
            {step === "start" && (
              <Start
                agents={readyAgents}
                defaultId={defaultId}
                workspace={workspace}
                recents={recentChoices}
                saving={saving}
                error={error}
                onDefault={setDefaultId}
                onWorkspace={setWorkspace}
                onBrowse={async () => {
                  const picked = await api.pickDirectory("Choose a workspace");
                  if (picked.ok && picked.path) setWorkspace(picked.path);
                }}
                onBack={() => setStep("agents")}
                onOpen={() => void finish(true)}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function StepMark({
  n,
  label,
  state,
}: {
  n: string;
  label: string;
  state: "done" | "current" | "later";
}) {
  return (
    <div className={`setup__step${state === "done" ? " is-done" : state === "current" ? " is-current" : ""}`}>
      <span>{state === "done" ? "✓" : n}</span>
      <span>{label}</span>
    </div>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <>
      <h1>A web workbench for the coding agents you already have.</h1>
      <p>
        Choose an agent and we'll help you connect it. DevDen runs your agents
        on this machine, using your own accounts and saved sign-ins.
      </p>
      <div className="setup__choices">
        <div className="setup__kicker">WHAT YOU GET</div>
        <div className="setup__panel">
          <div className="setup__row"><strong>Chat</strong><span>Live tool cards, diffs, revert per chunk</span></div>
          <div className="setup__row"><strong>Battle</strong><span>One task, several agents, isolated worktrees</span></div>
          <div className="setup__row"><strong>Remote</strong><span>Check in from your phone over a tunnel</span></div>
        </div>
      </div>
      <div className="setup__footer">
        <span className="setup__quiet">about a minute</span>
        <button type="button" className="setup__primary" onClick={onNext}>Check my agents →</button>
      </div>
    </>
  );
}

function Agents({
  cards,
  loading,
  found,
  builtinCount,
  readyCount,
  allReady,
  noneFound,
  error,
  onRecheck,
  onConnected,
  onBack,
  onContinue,
}: {
  cards: BackendInfo[];
  loading: boolean;
  found: number;
  builtinCount: number;
  readyCount: number;
  allReady: boolean;
  noneFound: boolean;
  error: string;
  onRecheck: () => void;
  onConnected: (agents: BackendInfo[]) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const title = allReady ? "You're already set up" : noneFound ? "No agents found yet" : "Agents on this machine";
  const blurb = allReady
    ? "Every agent below was found and is signed in. Nothing to install."
    : noneFound
      ? "Pick an agent below. We'll install it and start sign-in for you. One is enough to get started."
      : "Your connected agents are ready. Connect any others whenever you like.";
  return (
    <>
      <div className="setup__lead">
        <h1>{title}</h1>
        <p>{blurb}</p>
      </div>
      <div className="setup__toolbar">
        <div className="setup__count">
          {loading ? "LOOKING…" : allReady ? `${readyCount} READY` : `${found} OF ${builtinCount} FOUND`}
        </div>
        <button type="button" className="setup__text-button" onClick={onRecheck} disabled={loading}>
          ↻ Re-check
        </button>
      </div>
      <div className="setup__grid">
        {cards.map((agent) => {
          const kind = cardKind(agent);
          return (
            <article key={agent.id} className={`setup__card is-${kind}`}>
              <div className="setup__card-top">
                <span className={`setup__dot is-${kind}`} />
                <strong>{agent.name || agent.id}</strong>
                <span className={`setup__status is-${kind}`}>{statusLabel(kind)}</span>
              </div>
              {agent.version && <div className="setup__version">{agent.version}</div>}
              {kind !== "ready" && <AgentConnect agent={agent} onConnected={onConnected} />}
              {kind === "missing" && !agent.installCommand && (
                <div className="setup__meta">{agent.command}</div>
              )}
              {kind === "ready" && (
                <div className="setup__meta">
                  {agent.pathLabel || agent.path}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {error && <p className="setup__error">{error}</p>}
      <div className="setup__footer">
        <button type="button" className="setup__back" onClick={onBack}>← Back</button>
        {readyCount > 0 ? (
          <button type="button" className="setup__primary" onClick={onContinue}>
            Continue with {readyCount} →
          </button>
        ) : (
          <div className="setup__actions">
            <span className="setup__hint">connect one agent to continue</span>
            <span className="setup__disabled">Continue</span>
          </div>
        )}
      </div>
    </>
  );
}

function Start({
  agents,
  defaultId,
  workspace,
  recents,
  saving,
  error,
  onDefault,
  onWorkspace,
  onBrowse,
  onBack,
  onOpen,
}: {
  agents: BackendInfo[];
  defaultId: string;
  workspace: string;
  recents: string[];
  saving: boolean;
  error: string;
  onDefault: (id: string) => void;
  onWorkspace: (value: string) => void;
  onBrowse: () => void;
  onBack: () => void;
  onOpen: () => void;
}) {
  return (
    <>
      <h1>Where do you want to start?</h1>
      <div className="setup__choices">
        <span>DEFAULT AGENT</span>
        <div className="setup__grid">
          {agents.map((agent) => (
            <label key={agent.id} className={`setup__choice${defaultId === agent.id ? " is-picked" : ""}`}>
              <input
                type="radio"
                name="default-agent"
                checked={defaultId === agent.id}
                onChange={() => onDefault(agent.id)}
              />
              <strong>{agent.name || agent.id}</strong>
              <span className="setup__meta">{agent.version?.replace(new RegExp(`^${agent.id}(?:-cli)?\\s*`), "") || ""}</span>
            </label>
          ))}
        </div>
        <span className="setup__hint">Switchable per conversation from the composer.</span>
      </div>
      <div className="setup__choices">
        <label htmlFor="setup-workspace">WORKSPACE</label>
        <div className="setup__path">
          <input id="setup-workspace" value={workspace} onChange={(event) => onWorkspace(event.target.value)} />
          <button type="button" className="setup__ghost" onClick={onBrowse}>Browse…</button>
        </div>
        {recents.length > 0 && (
          <div className="setup__recents">
            <span className="setup__hint">recent</span>
            {recents.map((cwd) => (
              <button key={cwd} type="button" className="setup__chip-button" onClick={() => onWorkspace(cwd)}>
                {cwd.replace(/^\/Users\/[^/]+/, "~")}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <p className="setup__error">{error}</p>}
      <div className="setup__footer">
        <button type="button" className="setup__back" onClick={onBack}>← Back</button>
        <button type="button" className="setup__primary" disabled={saving || !workspace.trim()} onClick={onOpen}>
          Open workbench →
        </button>
      </div>
    </>
  );
}
