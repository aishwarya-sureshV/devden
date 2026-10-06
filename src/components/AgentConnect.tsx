import { useEffect, useRef, useState } from "react";
import { api, type BackendInfo } from "../lib/api";
import { loginLink, loginCode } from "../lib/agentConnect";
import { TerminalRunsProvider, useTerminalRuns } from "../lib/terminalRuns";
import { TerminalPage } from "./TerminalPage";
import { AgentMascot, IconCopy } from "./icons";
import "../styles/agentConnect.css";

export function AgentConnect({ agent, onConnected }: {
  agent: BackendInfo;
  onConnected: (agents: BackendInfo[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Retry re-detects first: once an install lands, connectCommand flips from
  // install to login, so a stale prop would just reinstall.
  const [current, setCurrent] = useState(agent);
  useEffect(() => setCurrent(agent), [agent]);
  const retry = async () => {
    try {
      const fresh = (await api.recheckBackends()).backends.find((entry) => entry.id === agent.id);
      if (fresh?.connectCommand) setCurrent(fresh);
    } catch { /* keep the last command; the session surfaces server errors */ }
    setAttempt((value) => value + 1);
  };
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  if (!agent.connectCommand) return null;
  return <>
    <button type="button" className="agent-connect__button" onClick={() => setOpen(true)}>
      {agent.path ? "Connect" : "Install & connect"}
    </button>
    {open && <dialog ref={dialog} className="agent-connect" aria-labelledby="agent-connect-title" onCancel={() => setOpen(false)}>
      <TerminalRunsProvider key={attempt} onNeedOpen={() => {}}>
        <ConnectSession agent={current} onConnected={onConnected}
          onRetry={() => void retry()} onClose={() => setOpen(false)} />
      </TerminalRunsProvider>
    </dialog>}
  </>;
}

function ConnectSession({ agent, onConnected, onRetry, onClose }: {
  agent: BackendInfo;
  onConnected: (agents: BackendInfo[]) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const terminal = useTerminalRuns()!;
  const started = useRef(false);
  const callbacks = useRef({ onConnected, onClose });
  callbacks.current = { onConnected, onClose };
  const [runId, setRunId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState("");
  const run = runId ? terminal.runs[runId] : undefined;
  // ZCode's install step only downloads a DMG (no sign-in URL), so offer the
  // official download page as a manual way out when curl can't reach the CDN.
  const download = agent.id === "zcode" && !agent.path ? "https://zcode.z.ai" : null;
  const link = loginLink(run?.output ?? "") ?? download;
  const code = loginCode(run?.output ?? "");
  const ended = run?.status === "exited" || run?.status === "error";
  const phase = connected ? "done" : error ? "error" : opened ? "waiting" : "idle";

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    setRunId(terminal.runCommand(agent.connectCommand!, true));
  }, [agent.connectCommand, terminal.runCommand]);

  useEffect(() => {
    if (!runId || connected) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const result = await api.recheckBackends();
        if (disposed) return;
        const found = result.backends.find((entry) => entry.id === agent.id);
        if (found?.path && found.auth === "ok") {
          setConnected(true);
          setError("");
          callbacks.current.onConnected(result.backends);
          return;
        }
        if (ended) {
          setError(run?.error || "Sign-in did not finish. You can retry below.");
          return;
        }
      } catch {
        if (disposed) return;
        setError("Could not check the connection. Check the server connection and retry.");
        if (ended) return;
      }
      timer = setTimeout(() => void check(), 4000);
    };
    void check();
    return () => { disposed = true; clearTimeout(timer); };
  }, [agent.id, runId, run?.status, ended, connected]);

  const wireOllama = async () => {
    try {
      const result = await api.zcodeUseOllama();
      if (!result.ok || !result.backends) return setError(result.error || "Could not wire Ollama into ZCode.");
      setConnected(true);
      setError("");
      callbacks.current.onConnected(result.backends);
    } catch {
      setError("Could not reach the devden server. Retry in a moment.");
    }
  };

  useEffect(() => {
    if (!connected) return;
    const timer = setTimeout(() => callbacks.current.onClose(), 1200);
    return () => clearTimeout(timer);
  }, [connected]);

  return <>
    <div className="agent-connect__head">
      <span className="agent-connect__mascot"><AgentMascot kind={agent.id} size={30} /></span>
      <div>
        <h2 id="agent-connect-title">{connected ? `${agent.name} connected` : `Connect ${agent.name}`}</h2>
        <p>{connected ? "Signed in. Welcome to the den." : "Sign in with your provider account."}</p>
      </div>
    </div>
    <ol className="agent-connect__steps">
      <li>
        <span className="agent-connect__num">1</span>
        <span className="agent-connect__step-text">{download ? "Download ZCode" : "Open the sign-in page"}</span>
        {link && !connected
          ? <a className="agent-connect__open" href={link} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>Open ↗</a>
          : <button type="button" className="agent-connect__open" disabled>Open ↗</button>}
      </li>
      {code && !connected && (
        <li>
          <span className="agent-connect__num">2</span>
          <span className="agent-connect__step-text">Confirm this code</span>
          <code className="agent-connect__code">{code}</code>
          <button type="button" className="agent-connect__copy" aria-label="Copy code"
            onClick={() => void navigator.clipboard?.writeText(code)}><IconCopy size={13} /></button>
        </li>
      )}
    </ol>
    <div className={`agent-connect__status is-${phase}`} role="status" aria-live="polite">
      <i />
      {phase === "done" ? `Signed in. ${agent.name} joined the den.`
        : phase === "error" ? error
        : phase === "waiting" ? "Waiting for authorization…"
        : "Waiting for you to sign in"}
    </div>
    {agent.id === "pi" && !connected && (
      <p className="agent-connect__note">Choose your subscription from the numbered list below.</p>
    )}
    {agent.id === "zcode" && agent.path && !connected && (
      <p className="agent-connect__note">
        No Z.AI account?{" "}
        <button type="button" className="agent-connect__open" onClick={() => void wireOllama()}>Use local Ollama</button>
      </p>
    )}
    <div className="agent-connect__terminal">
      <TerminalPage theme={document.body.hasAttribute("data-ds-dark-theme") ? "dark" : "light"} />
    </div>
    <div className="agent-connect__footer">
      <span>Sign-in stays on this machine.</span>
      <span className="agent-connect__footer-actions">
        {(error || ended) && !connected && <button type="button" onClick={onRetry}>Retry connection</button>}
        <button type="button" onClick={onClose}>{connected ? "Done" : "Cancel"}</button>
      </span>
    </div>
  </>;
}
