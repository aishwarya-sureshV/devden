import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { apiOrigin, api, hasAuthToken } from "../lib/api";
import { commandToPtyInput, ingestPtyChunk } from "../lib/runInTerminal";
import { useTerminalRuns } from "../lib/terminalRuns";
import { IconContract, IconExpand } from "./icons";

type TerminalTab = {
  id: string;
  label: string;
  cwd?: string;
  runId?: string;
  command?: string;
};

const LIGHT_THEME = {
  background: "#f4f1e9",
  foreground: "#231f19",
  cursor: "#b05d13",
  cursorAccent: "#f4f1e9",
  selectionBackground: "rgba(176, 93, 19, .22)",
  black: "#231f19",
  red: "#a4392e",
  green: "#3f6f39",
  yellow: "#846214",
  blue: "#1f6f6a",
  magenta: "#875a8a",
  cyan: "#1f6f6a",
  white: "#ebe6da",
  brightBlack: "#6b6355",
  brightRed: "#c35043",
  brightGreen: "#568550",
  brightYellow: "#a27a22",
  brightBlue: "#318783",
  brightMagenta: "#9b6d9e",
  brightCyan: "#318783",
  brightWhite: "#fffdf7",
};

const DARK_THEME = {
  background: "#0e0d0b",
  foreground: "#f0ebe2",
  cursor: "#e8a765",
  cursorAccent: "#0e0d0b",
  selectionBackground: "rgba(232, 167, 101, .22)",
  black: "#12110f",
  red: "#d4796f",
  green: "#86b784",
  yellow: "#d9b972",
  blue: "#7cc7c0",
  magenta: "#c59ac7",
  cyan: "#7cc7c0",
  white: "#d6cfc4",
  brightBlack: "#6d655c",
  brightRed: "#e08d84",
  brightGreen: "#a0cb9d",
  brightYellow: "#e7cb89",
  brightBlue: "#99d7d1",
  brightMagenta: "#d8b2da",
  brightCyan: "#99d7d1",
  brightWhite: "#fffdf7",
};

export function TerminalPage({
  cwd,
  theme,
  pane = false,
  expanded = false,
  onExpand,
  onCollapse,
  onClose,
}: {
  cwd?: string;
  theme: "light" | "dark";
  /** Docked side-pane mode: shows expand/collapse + close controls. */
  pane?: boolean;
  expanded?: boolean;
  onExpand?: () => void;
  onCollapse?: () => void;
  onClose?: () => void;
}) {
  const initialId = useRef(crypto.randomUUID());
  const nextNumber = useRef(2);
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [
    { id: initialId.current, label: "Terminal 1", cwd },
  ]);
  const [activeId, setActiveId] = useState<string>(initialId.current);
  const [statuses, setStatuses] = useState<Record<string, TerminalStatus>>({});
  // Live working directory per tab, pushed by the server as the shell cd's.
  const [cwds, setCwds] = useState<Record<string, string>>({});
  const terminalRuns = useTerminalRuns();

  const addTerminal = () => {
    const id = crypto.randomUUID();
    const label = `Terminal ${nextNumber.current++}`;
    setTabs((current) => [...current, { id, label, cwd }]);
    setActiveId(id);
  };

  useEffect(() => {
    if (!terminalRuns) return;
    const queued = Object.values(terminalRuns.runs).filter(
      (run) => run.status === "queued",
    );
    for (const run of queued) {
      if (!terminalRuns.claimRun(run.id)) continue;
      setTabs((current) => {
        const first = current[0];
        const idle =
          current.length === 1 &&
          first != null &&
          !first.runId &&
          (statuses[first.id] ?? "connecting") === "connecting";
        if (idle && first) {
          setActiveId(first.id);
          return [
            {
              ...first,
              runId: run.id,
              command: run.command,
              label: run.tabLabel,
            },
          ];
        }
        const id = crypto.randomUUID();
        setActiveId(id);
        return [
          ...current,
          {
            id,
            label: run.tabLabel,
            cwd,
            runId: run.id,
            command: run.command,
          },
        ];
      });
    }
  }, [terminalRuns, cwd, statuses]);

  const closeTerminal = (id: string) => {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      if (id === activeId)
        setActiveId(next[Math.min(index, next.length - 1)]?.id ?? "");
      return next;
    });
    setStatuses((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setCwds((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  return (
    <section className="terminal-page" aria-label="Terminal">
      <div className="terminal-page__tabbar">
        <div
          className="terminal-page__tabs"
          role="tablist"
          aria-label="Terminal tabs"
        >
          {tabs.map((tab) => {
            const status = statuses[tab.id] ?? "connecting";
            return (
              <div
                className={`terminal-page__tab${tab.id === activeId ? " is-active" : ""}`}
                key={tab.id}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.id === activeId}
                  onClick={() => setActiveId(tab.id)}
                >
                  <span className={`terminal-page__tab-status is-${status}`} />
                  <span>{tab.label}</span>
                </button>
                <button
                  type="button"
                  className="terminal-page__tab-close"
                  onClick={() => closeTerminal(tab.id)}
                  aria-label={`Close ${tab.label}`}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="terminal-page__tab-add"
            onClick={addTerminal}
            aria-label="New terminal tab"
            title="New terminal"
          >
            +
          </button>
        </div>
        <div className="terminal-page__actions">
          <span
            className="terminal-page__cwd"
            title={cwds[activeId] ?? cwd ?? "Home"}
          >
            {(cwds[activeId] ?? cwd ?? "Home")
              .split(/[\\/]/)
              .filter(Boolean)
              .at(-1) ?? "Home"}
          </span>
          {pane && (
            <button
              type="button"
              className="terminal-page__pane-btn"
              onClick={expanded ? onCollapse : onExpand}
              aria-label={
                expanded ? "Collapse terminal to pane" : "Expand terminal"
              }
              title={expanded ? "Collapse to pane" : "Expand"}
            >
              {expanded ? <IconContract size={15} /> : <IconExpand size={15} />}
            </button>
          )}
          {pane && (
            <button
              type="button"
              className="terminal-page__pane-btn"
              onClick={onClose}
              aria-label="Close terminal pane"
              title="Close"
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className="terminal-page__shells">
        {tabs.map((tab) => (
          <TerminalSession
            key={tab.id}
            cwd={tab.cwd}
            theme={theme}
            active={tab.id === activeId}
            command={tab.command}
            runId={tab.runId}
            onCwd={(value) =>
              setCwds((current) =>
                current[tab.id] === value
                  ? current
                  : { ...current, [tab.id]: value },
              )
            }
            onStatus={(status) =>
              setStatuses((current) =>
                current[tab.id] === status
                  ? current
                  : { ...current, [tab.id]: status },
              )
            }
            onRunOutput={
              tab.runId && terminalRuns
                ? (output) => terminalRuns.reportOutput(tab.runId!, output)
                : undefined
            }
            onRunExit={
              tab.runId && terminalRuns
                ? (code, error) =>
                    terminalRuns.finishRun(tab.runId!, code, error)
                : undefined
            }
          />
        ))}
        {tabs.length === 0 && (
          <div className="terminal-page__empty">
            <span>No terminals are open.</span>
            <button type="button" onClick={addTerminal}>
              New terminal
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

type TerminalStatus = "connecting" | "ready" | "closed";

/** Survives React Strict Mode remounts so a run is pasted into the PTY once. */
const injectedRuns = new Set<string>();

function TerminalSession({
  cwd,
  theme,
  active,
  command,
  runId,
  onCwd,
  onStatus,
  onRunOutput,
  onRunExit,
}: {
  cwd?: string;
  theme: "light" | "dark";
  active: boolean;
  command?: string;
  runId?: string;
  onCwd: (cwd: string) => void;
  onStatus: (status: TerminalStatus) => void;
  onRunOutput?: (output: string) => void;
  onRunExit?: (exitCode: number | null, error?: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const statusCallbackRef = useRef(onStatus);
  const cwdCallbackRef = useRef(onCwd);
  const runOutputRef = useRef(onRunOutput);
  const runExitRef = useRef(onRunExit);
  const capturingRef = useRef(false);
  const injectedRef = useRef(false);
  const outputRef = useRef("");
  const [socketReady, setSocketReady] = useState(false);

  useEffect(() => {
    statusCallbackRef.current = onStatus;
  }, [onStatus]);

  useEffect(() => {
    cwdCallbackRef.current = onCwd;
  }, [onCwd]);

  useEffect(() => {
    runOutputRef.current = onRunOutput;
  }, [onRunOutput]);

  useEffect(() => {
    runExitRef.current = onRunExit;
  }, [onRunExit]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 10_000,
      theme: theme === "dark" ? DARK_THEME : LIGHT_THEME,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    terminal.focus();
    terminalRef.current = terminal;
    fitRef.current = fit;

    const origin =
      apiOrigin() || `${window.location.protocol}//${window.location.host}`;
    const wsOrigin = origin.replace(/^http/i, "ws");
    // WebSocket cannot send Authorization headers, so with a token configured
    // the connection authenticates with a one-time ticket (cross-origin) or
    // the HttpOnly cookie (same-origin, sent automatically).
    const connect = async () => {
      let url = `${wsOrigin}/api/terminal?cwd=${encodeURIComponent(cwd || "")}`;
      if (hasAuthToken()) {
        try {
          const result = await api.auth(
            hasAuthToken() ? (localStorage.getItem("devden.token") ?? "") : "",
          );
          if (result.ok && result.ticket)
            url = `${url}&ticket=${encodeURIComponent(result.ticket)}`;
        } catch {
          /* cookie may already authenticate; fall through */
        }
      }
      const socket = new WebSocket(url);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        statusCallbackRef.current("ready");
        setSocketReady(true);
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      });
      socket.addEventListener("message", (event) => {
        const data = String(event.data);
        // Control channel from the server (NUL-prefixed JSON): live shell cwd.
        if (data.startsWith("\u0000{")) {
          try {
            const control = JSON.parse(data.slice(1)) as {
              type?: string;
              cwd?: string;
            };
            if (control.type === "cwd" && control.cwd)
              cwdCallbackRef.current(control.cwd);
          } catch {
            /* malformed control message; ignore */
          }
          return;
        }
        terminal.write(data);
        if (!capturingRef.current) return;
        const next = ingestPtyChunk(outputRef.current, data);
        outputRef.current = next.output;
        runOutputRef.current?.(next.output);
        if (next.exitCode != null) {
          capturingRef.current = false;
          runExitRef.current?.(next.exitCode);
        }
      });
      socket.addEventListener("close", () => {
        statusCallbackRef.current("closed");
        setSocketReady(false);
        if (capturingRef.current) {
          capturingRef.current = false;
          runExitRef.current?.(null, "Terminal closed");
        }
      });
      socket.addEventListener("error", () =>
        terminal.write("\r\n\x1b[31mTerminal connection failed.\x1b[0m\r\n"),
      );
    };
    void connect();

    const input = terminal.onData((data) => {
      if (socketRef.current?.readyState === WebSocket.OPEN)
        socketRef.current.send(JSON.stringify({ type: "input", data }));
    });
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (socketRef.current?.readyState === WebSocket.OPEN)
        socketRef.current.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
    });
    resizeObserver.observe(host);

    return () => {
      resizeObserver.disconnect();
      input.dispose();
      socketRef.current?.close();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      socketRef.current = null;
      setSocketReady(false);
      if (capturingRef.current) {
        capturingRef.current = false;
        runExitRef.current?.(null, "Terminal closed");
      }
    };
  }, [cwd]);

  useEffect(() => {
    if (!command || !socketReady) return;
    if (runId && injectedRuns.has(runId)) return;
    if (injectedRef.current) return;
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const timer = window.setTimeout(() => {
      if (injectedRef.current) return;
      if (runId && injectedRuns.has(runId)) return;
      if (socketRef.current?.readyState !== WebSocket.OPEN) return;
      injectedRef.current = true;
      if (runId) injectedRuns.add(runId);
      capturingRef.current = true;
      outputRef.current = "";
      socketRef.current.send(
        JSON.stringify({ type: "input", data: commandToPtyInput(command) }),
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [command, runId, socketReady]);

  useEffect(() => {
    if (terminalRef.current)
      terminalRef.current.options.theme =
        theme === "dark" ? DARK_THEME : LIGHT_THEME;
  }, [theme]);

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      fitRef.current?.fit();
      terminalRef.current?.focus();
      const socket = socketRef.current;
      const terminal = terminalRef.current;
      if (socket?.readyState === WebSocket.OPEN && terminal) {
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  return (
    <div
      className={`terminal-page__viewport${active ? " is-active" : ""}`}
      ref={hostRef}
      onPointerDown={() => terminalRef.current?.focus()}
    />
  );
}
