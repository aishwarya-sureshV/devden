import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAnchoredPopover } from "../lib/anchoredPopover";
import { WorkspacePicker, type WorkspacePickerHandle } from "./WorkspacePicker";
import { DeployButton } from "./DeployButton";
import { DiffColorButton } from "./DiffColorEditor";
import { SettingsAppearance } from "./SettingsAppearance";
import { effortLabel } from "../lib/effortStops";
import {
  BackendLogo,
  ModelName,
  IconBranch,
  IconChat,
  IconCheck,
  IconCode,
  IconCopy,
  IconExpand,
  IconFolder,
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
  modelLabel,
  effort,
  backend,
}: {
  modelLabel?: string;
  effort?: string | null;
  backend?: string;
  /** Split view: the title + dropdown live on each pane instead. */
  multi: boolean;
  /** Set while a pane is maximized out of a split; returns to it. */
  onBack?: () => void;
  title: string;
  renaming: boolean;
  renameDraft: string;
  onRenameDraft: (value: string) => void;
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
  return (
    <header className="session-header">
      {onBack && <button type="button" className="session-header__back" onClick={onBack}>← Back</button>}
      <div className="session-header__view-switch" role="group" aria-label="Conversation view" hidden={multi}>
        {VIEWS.map(item => <button key={item.id} type="button" aria-pressed={view === item.id} onClick={() => onView(item.id)}>{item.label}</button>)}
      </div>
      <div className="session-header__tools">
        <DiffColorButton className="session-header__tool is-icon" label="Appearance"><SettingsAppearance /></DiffColorButton>
        {onWorkspaceToggle && <button type="button" className="session-header__tool is-icon" aria-label="Code" title="Code" aria-pressed={workspaceOpen} onClick={onWorkspaceToggle}><IconCode size={16} /></button>}
      </div>
      {deployCwd ? <DeployButton key={deployCwd} cwd={deployCwd} /> : null}
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
  modelLabel,
  effortText,
  view,
  onView,
}: SessionDetailsInfo & {
  modelLabel?: string;
  effortText?: string;
  view?: SessionView;
  onView?: (view: SessionView) => void;
}) {
  const [copied, setCopied] = useState(false);
  const popoverRef = useAnchoredPopover<HTMLDivElement>(true);
  // "91% cache hit · 46 tok/s · 184k input" → the same five tiles for every
  // backend; a metric the backend never reported reads "—".
  const metric = (pattern: RegExp) => usageLabel.match(pattern)?.[1] ?? "—";
  const hit = metric(/(\d+%) cache hit/);
  const usageTiles = [
    { label: "Input", value: metric(/(\S+) input/) },
    { label: "Output", value: metric(/(\S+) output/) },
    { label: "Cached", value: metric(/(\S+) cached/) },
    { label: "Speed", value: metric(/(\S+) tok\/s/), unit: "tok/s" },
    { label: "Cache hit", value: hit, bar: hit === "—" ? 0 : parseInt(hit, 10) },
  ];
  const project = pathLabel.split("/").filter(Boolean).pop() ?? pathLabel;
  return (
    <div
      ref={popoverRef}
      className="session-header__menu session-header__menu--details"
      role="dialog"
      aria-label="Session details"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="session-header__details-head">
        <span className="session-header__details-title">
          {modelLabel ? (
            <>
              <ModelName name={modelLabel} />
              {effortText && <em> {effortText}</em>}
            </>
          ) : (
            title
          )}
        </span>
        <span className="session-header__status">
          <i className={`session-header__dot is-${statusTone}`} aria-hidden />
          {statusLabel}
        </span>
      </div>
      <div className="session-header__project">
        <IconFolder size={13} />
        <b>{project}</b>
        {branchLabel && (
          <span className="session-header__branch-pill">
            <IconBranch size={11} />
            {branchLabel}
          </span>
        )}
      </div>
      {onView && (
        <div className="session-header__views" role="group" aria-label="View">
          {VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === view}
              className="session-header__view-item"
              onClick={() => onView(item.id)}
            >
              <span className="session-header__view-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
      <div className="session-header__details-grid">
        <span>Path</span>
        <span className="session-header__path">{pathLabel}</span>
        <span>Context</span>
        <span>{contextLabel}</span>
        <span>Session</span>
        <span className="session-header__id">
          {sessionId ? <code>{sessionId}</code> : <em>Assigned on first reply</em>}
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
      <div className="session-header__usage-head">Usage · this session</div>
      <div className="session-header__usage">
        {usageTiles.map((tile) => (
          <div key={tile.label} className={`session-header__usage-tile${tile.bar !== undefined ? " is-wide" : ""}`}>
            <span>{tile.label}</span>
            <b className={tile.value === "—" ? "is-empty" : undefined}>
              {tile.value}
              {tile.unit && tile.value !== "—" && <small>{tile.unit}</small>}
            </b>
            {tile.bar !== undefined && <i className="session-header__usage-bar"><i style={{ width: `${tile.bar}%` }} /></i>}
          </div>
        ))}
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

export function SessionTab({ title, backend, cwd, active, sessionKey, details, open, onOpen, contextPercent, disabled, onPickWorkspace }: {
  title: string; backend: string; cwd: string; active: boolean; sessionKey: string; details: SessionDetailsInfo & { modelLabel?: string; effortText?: string; view: SessionView; onView: (view: SessionView) => void };
  open: boolean; onOpen: (open: boolean) => void; contextPercent: number | null;
  disabled: boolean; onPickWorkspace: (path: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const workspacePicker = useRef<WorkspacePickerHandle>(null);
  useEffect(() => {
    if (!active || disabled) return;
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        workspacePicker.current?.openBrowser();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, disabled]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onOpen(false); };
    window.addEventListener("pointerdown", close); window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", key); };
  }, [open, onOpen]);
  const percent = contextPercent === null ? null : Math.max(0, Math.min(100, contextPercent));
  return <div className="session-tab-content" ref={ref}>
    <button type="button" className="session-tab-content__title" role="tab" aria-selected={active} aria-controls={`dock-${sessionKey}`} tabIndex={active ? 0 : -1} aria-haspopup="dialog" aria-expanded={open} title="Session details" onClick={() => onOpen(!open)}>{title}</button>
    <div className="session-tab-content__workspace">
      {details.modelLabel && details.modelLabel !== "model…" && <><span className="session-tab-content__model" title={details.modelLabel}>{details.modelLabel.toLowerCase()}</span><span aria-hidden className="session-tab-content__dot">·</span></>}
      <WorkspacePicker ref={workspacePicker} cwd={cwd} backend={backend as "pi" | "claude" | "codex" | "grok"} disabled={disabled} onPick={onPickWorkspace} variant="chip" sessionTitle={title} />
      {details.branchLabel && <><IconBranch size={10} /><span title={details.branchLabel}>{details.branchLabel}</span></>}
    </div>
    <button type="button" className="session-tab-content__context" title={details.contextLabel} aria-label={`Context: ${details.contextLabel}`} onClick={() => onOpen(!open)}>
      <span><i style={{ width: `${percent ?? 0}%`, background: percent !== null && percent >= 85 ? "#ff7a8a" : percent !== null && percent >= 60 ? "#f0b35a" : "#8fe39b" }} /></span><small>{percent === null ? "—" : `${percent}%`}</small>
    </button>
    {open && <SessionDetails {...details} />}
  </div>;
}
