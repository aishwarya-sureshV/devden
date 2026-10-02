import { useEffect, useRef, useState } from "react";
import { api, type BackendInfo } from "../lib/api";
import { loginLink } from "../lib/agentConnect";
import { TerminalRunsProvider, useTerminalRuns } from "../lib/terminalRuns";
import { TerminalPage } from "./TerminalPage";
import "../styles/agentConnect.css";

export function AgentConnect({ agent, onConnected }: {
  agent: BackendInfo;
  onConnected: (agents: BackendInfo[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
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
        <ConnectSession agent={agent} onConnected={onConnected}
          onRetry={() => setAttempt((value) => value + 1)} onClose={() => setOpen(false)} />
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
  const [error, setError] = useState("");
  const run = runId ? terminal.runs[runId] : undefined;
  const link = loginLink(run?.output ?? "");
  const ended = run?.status === "exited" || run?.status === "error";

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

  useEffect(() => {
    if (!connected) return;
    const timer = setTimeout(() => callbacks.current.onClose(), 1200);
    return () => clearTimeout(timer);
  }, [connected]);

  return <>
    <div className="agent-connect__head">
      <div>
        <h2 id="agent-connect-title">{connected ? `${agent.name} connected` : `Connect ${agent.name}`}</h2>
        <p>{connected ? "You're ready to start." : agent.path
          ? "Finish signing in with your provider. We'll handle the rest."
          : "We'll install this agent, then help you sign in."}</p>
      </div>
      <button type="button" onClick={onClose}>{connected ? "Done" : "Cancel"}</button>
    </div>
    <div className="agent-connect__progress" role="status" aria-live="polite">
      {connected ? "Connected ✓" : error || (link ? "Sign-in page ready. Complete the steps in your browser." : "Preparing your connection…")}
    </div>
    {link && !connected && <a className="agent-connect__button" href={link} target="_blank" rel="noopener noreferrer">Open sign-in page ↗</a>}
    {agent.id === "pi" && !connected && <p>Choose your subscription from the numbered list below.</p>}
    {!connected && <p className="agent-connect__hint">If your provider gives you a code to paste back, enter it below.</p>}
    <div className="agent-connect__terminal">
      <TerminalPage theme={document.body.hasAttribute("data-ds-dark-theme") ? "dark" : "light"} />
    </div>
    <div className="agent-connect__footer">
      <span>Your subscription sign-in stays on the machine running DevDen.</span>
      {(error || ended) && !connected && <button type="button" onClick={onRetry}>Retry connection</button>}
    </div>
  </>;
}
