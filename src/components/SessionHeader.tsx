import { useEffect, useRef, useState, type ReactNode } from "react";
import { DeployButton } from "./DeployButton";
import {
  IconBranch,
  IconChat,
  IconCheck,
  IconCode,
  IconCopy,
  IconExpand,
  IconKanban,
  IconList,
  IconTerminal,
} from "./icons";

export type SessionView = "chat" | "trajectory" | "backend";
export type SessionTone = "running" | "waiting" | "error" | "idle";

const VIEWS: { id: SessionView; label: string; icon: ReactNode }[] = [
  { id: "chat", label: "Chat", icon: <IconChat size={14} /> },
  {
    id: "trajectory",
    label: "Trajectory",
    icon: <IconBranch size={14} />,
  },
  { id: "backend", label: "Backend log", icon: <IconList size={14} /> },
];

function Chevron() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

export function SessionHeader({
  multi,
  onBack,
  title,
  renaming,
  renameDraft,
  onRenameDraft,
  onStartRename,
  onFinishRename,
  onCancelRename,
  detailsOpen,
  onDetailsOpen,
  statusLabel,
  statusTone,
  pathLabel,
  branchLabel,
  contextLabel,
  usageLabel,
  sessionId,
  onCopyId,
  logUrl,
  view,
  onView,
  terminalOpen,
  onTerminalToggle,
  workspaceOpen,
  onWorkspaceToggle,
  boardOpen,
  onBoardToggle,
  deployCwd,
}: {
  /** Split view: the title + dropdown live on each pane instead. */
  multi: boolean;
  /** Set while a pane is maximized out of a split; returns to it. */
  onBack?: () => void;
  title: string;
  renaming: boolean;
  renameDraft: string;
  onRenameDraft: (value: string) => void;
  onStartRename: () => void;
  onFinishRename: () => void;
  onCancelRename: () => void;
  detailsOpen: boolean;
  onDetailsOpen: (open: boolean) => void;
  statusLabel: string;
  statusTone: SessionTone;
  pathLabel: string;
  /** `null` when the cwd is not a git repo — rendered as a hyphen. */
  branchLabel: string | null;
  /** Current context window fill in tokens, exact or estimated. */
  contextLabel: string;
  usageLabel: string;
  sessionId?: string;
  onCopyId: () => Promise<void> | void;
  logUrl?: string;
  view: SessionView;
  onView: (view: SessionView) => void;
  terminalOpen: boolean;
  onTerminalToggle?: () => void;
  workspaceOpen: boolean;
  onWorkspaceToggle?: () => void;
  boardOpen: boolean;
  onBoardToggle?: () => void;
  deployCwd?: string;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const skipBlur = useRef(false);
  const [viewOpen, setViewOpen] = useState(false);
  const current = VIEWS.find((item) => item.id === view) ?? VIEWS[0]!;

  useEffect(() => {
    if (!detailsOpen && !viewOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setViewOpen(false);
        onDetailsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setViewOpen(false);
        onDetailsOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [detailsOpen, viewOpen, onDetailsOpen]);

  return (
    <header className="session-header" ref={rootRef}>
      {onBack && (
        <button
          type="button"
          className="session-header__back"
          onClick={onBack}
          title="Back to split view"
        >
          <span aria-hidden>←</span> Back
        </button>
      )}
      {!multi && (
        <div className="session-header__lead">
          {renaming ? (
            <div className="session-header__identity">
              <input
                className="session-header__title-input"
                value={renameDraft}
                onChange={(event) => onRenameDraft(event.target.value)}
                onBlur={() => {
                  if (skipBlur.current) {
                    skipBlur.current = false;
                    return;
                  }
                  onFinishRename();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    skipBlur.current = true;
                    onCancelRename();
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                onFocus={(event) => event.target.select()}
                aria-label="Session title"
              />
            </div>
          ) : (
            <button
              type="button"
              className="session-header__identity"
              aria-expanded={detailsOpen}
              aria-haspopup="dialog"
              title="Click for details · double-click to rename"
              onClick={() => {
                setViewOpen(false);
                onDetailsOpen(!detailsOpen);
              }}
              onDoubleClick={() => {
                setViewOpen(false);
                onDetailsOpen(false);
                onStartRename();
              }}
            >
              <span className="session-header__title">{title}</span>
              <Chevron />
            </button>
          )}
          {detailsOpen && (
            <SessionDetails
              title={title}
              statusLabel={statusLabel}
              statusTone={statusTone}
              pathLabel={pathLabel}
              branchLabel={branchLabel}
              contextLabel={contextLabel}
              usageLabel={usageLabel}
              sessionId={sessionId}
              onCopyId={onCopyId}
              logUrl={logUrl}
            />
          )}
        </div>
      )}

      <div className="session-header__view">
        <button
          type="button"
          className="session-header__view-btn"
          aria-haspopup="menu"
          aria-expanded={viewOpen}
          onClick={() => {
            onDetailsOpen(false);
            setViewOpen((open) => !open);
          }}
        >
          <span className="session-header__view-icon">{current.icon}</span>
          {current.label}
          <Chevron />
        </button>
        {viewOpen && (
          <div
            className="session-header__menu session-header__menu--view"
            role="menu"
          >
            {VIEWS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitemradio"
                aria-checked={item.id === view}
                className="session-header__view-item"
                onClick={() => {
                  onView(item.id);
                  setViewOpen(false);
                }}
              >
                <span className="session-header__view-icon">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="session-header__rule" aria-hidden />
      <div className="session-header__tools">
        {onTerminalToggle && (
          <button
            type="button"
            className={`session-header__tool${terminalOpen ? " is-active" : ""}`}
            aria-pressed={terminalOpen}
            aria-label="Terminal"
            title="Terminal"
            onClick={onTerminalToggle}
          >
            <IconTerminal size={15} />
          </button>
        )}
        {onWorkspaceToggle && (
          <button
            type="button"
            className={`session-header__tool${workspaceOpen ? " is-active" : ""}`}
            aria-pressed={workspaceOpen}
            aria-label="Workspace"
            title="Workspace"
            onClick={onWorkspaceToggle}
          >
            <IconCode size={15} />
          </button>
        )}
        {onBoardToggle && (
          <>
            <span className="session-header__tool-rule" aria-hidden />
            <button
              type="button"
              className={`session-header__tool${boardOpen ? " is-active" : ""}`}
              aria-pressed={boardOpen}
              aria-label="Kanban"
              title="Kanban"
              onClick={onBoardToggle}
            >
              <IconKanban size={15} />
            </button>
          </>
        )}
      </div>
      {deployCwd ? <DeployButton cwd={deployCwd} /> : null}
    </header>
  );
}

export interface SessionDetailsInfo {
  title: string;
  statusLabel: string;
  statusTone: SessionTone;
  pathLabel: string;
  /** `null` when the cwd is not a git repo — rendered as a hyphen. */
  branchLabel: string | null;
  contextLabel: string;
  usageLabel: string;
  sessionId?: string;
  onCopyId: () => Promise<void> | void;
  logUrl?: string;
}

/** The title dropdown: path, branch, context, usage, id. Shared by the
 *  full-width header and every split pane's title. */
export function SessionDetails({
  title,
  statusLabel,
  statusTone,
  pathLabel,
  branchLabel,
  contextLabel,
  usageLabel,
  sessionId,
  onCopyId,
  logUrl,
}: SessionDetailsInfo) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="session-header__menu session-header__menu--details"
      role="dialog"
      aria-label="Session details"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="session-header__details-head">
        <span className="session-header__details-title">{title}</span>
        <span className="session-header__status">
          <i className={`session-header__dot is-${statusTone}`} aria-hidden />
          {statusLabel}
        </span>
      </div>
      <div className="session-header__details-grid">
        <span>Path</span>
        <span className="session-header__path">{pathLabel}</span>
        <span>Branch</span>
        <span className="session-header__path">{branchLabel ?? "—"}</span>
        <span>Context</span>
        <span>{contextLabel}</span>
        <span>Usage</span>
        <span>{usageLabel}</span>
        <span>Session ID</span>
        <span className="session-header__id">
          <code>{sessionId ?? "—"}</code>
          {sessionId && (
            <button
              type="button"
              aria-label="Copy session ID"
              title="Copy session ID"
              onClick={() => {
                void Promise.resolve(onCopyId()).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1200);
                });
              }}
            >
              {copied ? "Copied" : <IconCopy size={12} />}
            </button>
          )}
        </span>
        {logUrl && (
          <>
            <span>Log</span>
            <a className="session-header__log" href={logUrl} download>
              Download
            </a>
          </>
        )}
      </div>
    </div>
  );
}

/** Pane state painted on the title: "done" is a finished run the user
 *  hasn't looked at yet. */
export type PaneTone = SessionTone | "done";

export function PaneChrome({
  active,
  title,
  markGlyph,
  markColor,
  tone,
  live,
  details,
  detailsOpen,
  onDetailsOpen,
  onMaximize,
  onClose,
}: {
  active: boolean;
  title: string;
  markGlyph: string;
  markColor: string;
  tone: PaneTone;
  live: boolean;
  details: SessionDetailsInfo;
  detailsOpen: boolean;
  onDetailsOpen: (open: boolean) => void;
  onMaximize?: () => void;
  onClose?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!detailsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node))
        onDetailsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDetailsOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [detailsOpen, onDetailsOpen]);
  return (
    <div
      ref={rootRef}
      className={`pane-chrome is-${tone}${active ? " is-active" : ""}`}
    >
      <span
        className={`pane-chrome__mark${live ? " is-live" : ""}`}
        style={{ color: markColor }}
        aria-label={`Status: ${tone}`}
      >
        {markGlyph}
        {tone === "done" && (
          <span className="pane-chrome__badge" aria-hidden>
            <IconCheck size={8} />
          </span>
        )}
      </span>
      <button
        type="button"
        className="pane-chrome__title"
        aria-haspopup="dialog"
        aria-expanded={detailsOpen}
        title="Session details"
        onClick={(event) => {
          event.stopPropagation();
          onDetailsOpen(!detailsOpen);
        }}
      >
        <span className="pane-chrome__title-text">{title}</span>
        <Chevron />
      </button>
      {detailsOpen && <SessionDetails {...details} />}
      {onMaximize && (
        <button
          type="button"
          className="pane-chrome__btn"
          aria-label="Expand session"
          title="Expand"
          onClick={(event) => {
            event.stopPropagation();
            onMaximize();
          }}
        >
          <IconExpand size={11} />
        </button>
      )}
      {onClose && (
        <button
          type="button"
          className="pane-chrome__btn"
          aria-label={`Close ${title}`}
          title="Close"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** ~/rest when the path is under a user home directory. */
export function displayPath(cwd: string): string {
  const match = cwd.match(/^\/(?:Users|home)\/[^/]+/);
  if (match && cwd.startsWith(match[0]))
    return `~${cwd.slice(match[0].length)}` || "~";
  return cwd || "—";
}
