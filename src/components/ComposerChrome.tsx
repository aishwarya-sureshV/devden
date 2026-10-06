import { useRef, useState, useEffect, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  backendLabel,
  backendMark,
  type AgentBackend,
  type ProviderUsage,
} from "../lib/api";
import { useAnchoredPopover } from "../lib/anchoredPopover";
import { effortEstimate, effortLabel } from "../lib/effortStops";
import { belowFloor } from "../lib/prosecutorEffort";

const FLOOR_REASON = "Prosecutor round 1 builds at High or above";
import { BackendLogo, IconChevronDown, IconSearch, ModelName } from "./icons";

export type ModelOption = {
  provider: string;
  id: string;
  label: string;
  context?: number;
  /** Thinking levels this model supports, when the catalog knows them. */
  levels?: string[];
  backend?: AgentBackend;
};

type AgentMode = "standard" | "plan" | "routed" | "prosecutor" | "manual" | "auto-edit";

const MODE_COPY: Record<
  AgentMode,
  { icon: string; label: string; blurb: string }
> = {
  manual: {
    icon: "?",
    label: "Ask",
    blurb: "Ask before every edit and command",
  },
  "auto-edit": {
    icon: "✎",
    label: "Auto-edit",
    blurb: "Apply edits, ask before commands",
  },
  plan: { icon: "◇", label: "Plan", blurb: "Read and plan, change nothing" },
  standard: { icon: "»", label: "Full auto", blurb: "Run everything" },
  routed: {
    icon: "⟳",
    label: "Routed",
    blurb: "Pass the turn through a chain of agents",
  },
  prosecutor: {
    icon: "⚖",
    label: "Prosecutor",
    blurb: "A second agent must fail to break the fix",
  },
};

function formatContext(tokens?: number): string {
  if (!tokens) return "";
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0)
    return `${tokens / 1_000_000}M`;
  if (tokens >= 1000) return `${tokens / 1000}k`;
  return String(tokens);
}

export function UsageChip({ popRef, open, hour, week, current, usage, reset, onToggle, context, status }: {
  popRef: RefObject<HTMLDivElement | null>; open: boolean; split: boolean;
  hour: number | null; week: number | null; current: AgentBackend;
  usage: Partial<Record<AgentBackend, ProviderUsage>>; reset?: string | null;
  onToggle: () => void; context: { percent: number | null; label: string };
  /** Fetch outcome + when the shown numbers were last good. */
  status?: { at: number | null; error: string | null };
}) {
  const used = (left: number | null) => left === null ? null : Math.max(0, Math.min(100, 100 - left));
  const h = used(hour), w = used(week);
  const color = (n: number | null) => n !== null && n >= 85 ? "#ff7a8a" : n !== null && n >= 60 ? "#f0b35a" : "#5fd49a";
  const popoverRef = useAnchoredPopover<HTMLDivElement>(open, "end");
  const windows = usage[current]?.windows ?? [];
  const resetFor = (pattern: RegExp) => {
    const time = windows.find(window => pattern.test(window.label))?.resetsAt;
    return time ? `Resets ${new Date(time).toLocaleString()}` : "Reset time unavailable";
  };
  const rows = [
    { label: "5-hour window", percent: h, detail: resetFor(/session|hour|5h|24h/i) },
    { label: "This week", percent: w, detail: resetFor(/week|7d/i) },
    { label: "Context window", percent: context.percent, detail: context.label },
  ];
  const updatedText = status?.at != null
    ? `Updated ${new Date(status.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : null;
  const failed = Boolean(status?.error);
  const title = failed
    ? `Usage fetch failed${updatedText ? ` · last updated ${updatedText.replace("Updated ", "")}` : ""}${status?.error ? ` · ${status.error}` : ""}`
    : reset ? `Usage used · resets ${reset}` : "Usage used";
  return <div ref={popRef} className="composer__usage-wrap">
    <button type="button" className={`composer__usage${open ? " is-open" : ""}`} aria-haspopup="dialog" aria-expanded={open} aria-label={`Usage: 5-hour ${h === null ? "unavailable" : `${h}% used`}, week ${w === null ? "unavailable" : `${w}% used`}`} title={title} onClick={onToggle}>
      <span className="usage-bars">{[["5h", h], ["wk", w]].map(([label, n]) => <span key={String(label)}><small>{label}</small><i><b style={{ width: `${n ?? 0}%`, background: color(n as number | null) }} /></i><small>{n === null ? "—" : `${n}%`}</small></span>)}</span>
      <span className="usage-rings"><svg viewBox="0 0 22 22" width="20" height="20" aria-hidden="true">{[h, w].map((n, i) => <g key={i}><circle cx="11" cy="11" r={i ? 5 : 9} fill="none" stroke="currentColor" opacity=".15" strokeWidth="2.2" /><circle cx="11" cy="11" r={i ? 5 : 9} fill="none" stroke={color(n)} strokeWidth="2.2" pathLength="100" strokeDasharray={`${n ?? 0} 100`} transform="rotate(-90 11 11)" /></g>)}</svg><small style={{ color: color(h === null && w === null ? null : Math.max(h ?? 0, w ?? 0)) }}>{h === null && w === null ? "—" : `${Math.max(h ?? 0, w ?? 0)}%`}</small></span>
    </button>
    {open && <div ref={popoverRef} className="usage-pop" role="dialog" aria-label="Usage">
      <div className="usage-pop__row-head"><strong>{backendLabel(current)} usage</strong><span>% used</span></div>
      {rows.map(row => <div className="usage-pop__card" key={row.label}><div className="usage-pop__row-head"><strong>{row.label}</strong><span>{row.percent === null ? "—" : `${row.percent}% used`}</span></div><div className="usage-pop__meter"><b><i style={{ width: `${row.percent ?? 0}%`, background: color(row.percent) }} /></b></div><small>{row.detail}</small></div>)}
      {(failed || updatedText) && <div className={`usage-pop__foot${failed ? " is-error" : ""}`} title={status?.error ?? undefined}>
        {failed ? "Couldn't refresh usage — showing the last known numbers." : "Live numbers from this agent."}
        {updatedText && <span className="usage-pop__updated">{updatedText}</span>}
      </div>}
    </div>}
  </div>;
}

const RECENT_KEY = "devden.picker.recent";

export function ModelChip({
  menuRef,
  searchRef,
  open,
  split,
  disabled,
  backend,
  browseBackend,
  backends,
  modelLabel,
  effort,
  levels,
  supported,
  effortHover,
  effortFloor = null,
  options,
  highlight,
  query,
  currentModel,
  onToggle,
  onQuery,
  onHighlight,
  onBrowse,
  onPick,
  onEffort,
  onEffortHover,
  contextChoices,
  currentContext,
  defaultContext,
  onContext,
  onKeyDown,
  onWarm,
  children,
}: {
  menuRef: RefObject<HTMLDivElement | null>;
  searchRef: RefObject<HTMLInputElement | null>;
  open: boolean;
  split: boolean;
  disabled: boolean;
  backend: AgentBackend;
  browseBackend: AgentBackend;
  backends: AgentBackend[];
  modelLabel: string;
  effort: string;
  levels: string[];
  /** Levels the highlighted model accepts. Missing means the whole ladder. */
  supported?: string[];
  effortHover: number | null;
  /** Prosecutor round 1: levels below this show disabled, with the reason. */
  effortFloor?: string | null;
  options: ModelOption[];
  highlight: number;
  query: string;
  currentModel: string;
  onToggle: () => void;
  onQuery: (value: string) => void;
  onHighlight: (index: number) => void;
  onBrowse: (backend: AgentBackend) => void;
  onPick: (option: ModelOption) => void;
  onEffort: (level: string) => void;
  onEffortHover: (index: number | null) => void;
  /** Context-window choices for the session's model; null hides the row. */
  contextChoices?: number[] | null;
  /** Effective window for the session's model right now. */
  currentContext?: number;
  /** The model's catalog default (what the Default choice restores). */
  defaultContext?: number;
  onContext: (tokens: number | null) => void | Promise<void>;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onWarm: () => void;
  /** Rendered on the second line beside effort (the mode chip). */
  children?: ReactNode;
}) {
  // Recents outlive the menu and the page (mock 2a: the last few backends you
  // used stay on top), most recent first, capped at three.
  const [recentBackends, setRecentBackends] = useState<AgentBackend[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRecentBackends(previous => {
      if (previous[0] === browseBackend) return previous;
      const next = [browseBackend, ...previous.filter(id => id !== browseBackend)].slice(0, 3);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, [browseBackend]);
  const choices = [...new Set([...(contextChoices ?? []), ...(currentContext ? [currentContext] : [])])];
  const changeContext = async (tokens: number | null) => {
    setBusy(true);
    try { await onContext(tokens); } finally { setBusy(false); }
  };
  const shownLevel = effortHover != null ? levels[effortHover] ?? effort : effort;
  const effortIndex = levels.indexOf(shownLevel);
  const recent = [...new Set([...recentBackends, backend])].filter(id => backends.includes(id));
  const railGroups = [
    { label: "RECENT", ids: recent },
    { label: "ALL", ids: backends.filter(id => !recent.includes(id)) },
  ].filter(group => group.ids.length);
  const groups: { name: string; items: { option: ModelOption; index: number }[] }[] = [];
  const providers = new Set(options.map(option => option.provider));
  options.forEach((option, index) => {
    const name = query ? backendLabel(option.backend ?? browseBackend)
      : browseBackend === "pi" && providers.size === 1 ? option.provider : "Models";
    const group = groups.find(group => group.name === name);
    if (group) group.items.push({ option, index });
    else groups.push({ name, items: [{ option, index }] });
  });
  const browse = (id: AgentBackend) => onBrowse(id);
  const anchorRef = useRef<HTMLElement | null>(null);
  const popoverRef = useAnchoredPopover<HTMLDivElement>(open, "start", {
    anchor: anchorRef,
    prefer: "above",
  });
  const openFrom = (event: { currentTarget: HTMLElement }) => {
    anchorRef.current = event.currentTarget;
    onToggle();
  };
  return (
    <div
      className="native-model-controls composer__stack"
      ref={menuRef}
      onPointerDown={onWarm}
      onFocus={onWarm}
    >
      <button
        type="button"
        className={`composer__chip${open ? " is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title={`${backendLabel(backend)} · ${modelLabel}`}
        onClick={openFrom}
      >
        <BackendLogo backend={backend} size={14} />
        <span className="composer__chip-name"><ModelName name={modelLabel} /></span>
      </button>
      <div className="composer__chip-meta">
        {levels.length > 0 && effort && (
          <button
            type="button"
            className="composer__chip-effort"
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={disabled}
            title="Effort"
            onClick={openFrom}
          >
            {effortLabel(effort)}
          </button>
        )}
        {children}
      </div>
      {open && (
        <div ref={popoverRef} className="composer__mode-menu composer__model-menu compact-picker" role="dialog" aria-label="Choose model"
          onKeyDown={event => {
            if (event.key === "Escape" || event.target === searchRef.current) onKeyDown(event);
          }}>
          <div className="compact-picker__head">
            <IconSearch size={14} />
            <input ref={searchRef} value={query} placeholder="Search models and backends"
              aria-label="Search models and backends" onChange={event => onQuery(event.target.value)} />
            <kbd>⇥</kbd><span>backend</span>
          </div>
          <div className="compact-picker__body">
            <div className="compact-picker__rail" aria-label="Backends">
              {railGroups.map(group => <div key={group.label}>
                <div className="compact-picker__rail-heading"><span>{group.label}</span>{group.label === "ALL" && <span>{group.ids.length}</span>}</div>
                {group.ids.map(id => {
                  const hits = options.filter(option => (option.backend ?? browseBackend) === id).length;
                  return <button type="button" key={id} aria-pressed={id === browseBackend}
                    className={`${id === browseBackend ? "is-active" : ""} ${query && !hits ? "is-dimmed" : ""}`}
                    onClick={() => { browse(id); onQuery(""); onHighlight(0); }}>
                    <span className="compact-picker__glyph" style={{ color: backendMark(id).color }} aria-hidden="true"><BackendLogo backend={id} size={14} /></span><span>{backendLabel(id).toLowerCase()}</span>
                    {query && hits > 0 && <small>{hits}</small>}
                  </button>;
                })}
              </div>)}
            </div>
            <div className="compact-picker__pane">
              <div className="composer__model-list">
              {options.length === 0 && <div className="composer__model-empty">{query ? "No models match" : "Loading models…"}</div>}
              {groups.map(group => <div className="composer__model-group-block" key={group.name}>
                <div className={`composer__model-group${query ? " compact-picker__result-heading" : ""}`}>
                  {query && <span className="compact-picker__glyph" style={{ color: backendMark(group.items[0].option.backend ?? browseBackend).color }} aria-hidden="true"><BackendLogo backend={group.items[0].option.backend ?? browseBackend} size={14} /></span>}
                  <span>{group.name}</span>{!query && <span>Context</span>}
                </div>
                {group.items.map(({ option, index }) => {
                  const value = `${option.provider}/${option.id}`;
                  const selected = (option.backend ?? browseBackend) === backend && value === currentModel;
                  return <button type="button" key={value} aria-pressed={selected}
                    className={`${selected && !query ? "is-active" : ""} ${index === highlight ? "is-highlighted" : ""} ${query ? "is-search-result" : ""}`}
                    title={`${option.label}${option.context ? ` · ${option.context.toLocaleString()} tokens` : ""}`}
                    onMouseEnter={() => onHighlight(index)} onClick={() => onPick(option)}>
                    <span className="composer__model-name"><ModelName name={option.label} truncate /></span>
                    <span className="composer__model-context">{formatContext(option.context)}</span>
                    {!query && <span className="composer__model-check">{selected ? "✓" : ""}</span>}
                  </button>;
                })}
              </div>)}
              </div>
          {!query && <div className="compact-picker__settings">
            {browseBackend === backend && (currentContext || defaultContext) && <div className="compact-picker__setting">
              <span title="How much this session’s model can read at once, in tokens">Context</span>
              {contextChoices ? <div className="compact-picker__segments" role="group" aria-label="Session context window" aria-busy={busy}>
                <button type="button" disabled={busy} aria-pressed={currentContext == null || currentContext === defaultContext}
                  className={currentContext == null || currentContext === defaultContext ? "is-current" : undefined}
                  title={defaultContext ? `Backend default: ${defaultContext.toLocaleString()} tokens` : "Backend default"}
                  onClick={() => void changeContext(null)}>Default</button>
                {choices.filter(tokens => tokens !== defaultContext).map(tokens => <button type="button" key={tokens} disabled={busy}
                  aria-pressed={tokens === currentContext} className={tokens === currentContext ? "is-current" : undefined}
                  title={`${tokens.toLocaleString()} tokens`} onClick={() => void changeContext(tokens)}>{formatContext(tokens)}</button>)}
              </div> : <span title="The backend manages this model’s context window">{formatContext(currentContext ?? defaultContext)}</span>}
            </div>}
            {levels.length > 0 && <>
              <div className="compact-picker__setting" onMouseLeave={() => onEffortHover(null)}><span>Thinking</span>
                <div className="compact-picker__thinking" role="group" aria-label="Thinking effort">
                  {levels.map((level, index) => {
                    const floored = belowFloor(level, effortFloor);
                    const offered = !floored && browseBackend === backend && (!supported?.length || supported.includes(level) || level === effort);
                    return <button type="button" key={level} disabled={!offered} aria-label={effortLabel(level)} aria-pressed={level === effort}
                      title={floored ? FLOOR_REASON : undefined}
                      className={`${index === effortIndex ? "is-current" : ""} ${index <= effortIndex ? "is-on" : ""}`}
                      onMouseEnter={() => { if (offered) onEffortHover(index); }} onClick={() => onEffort(level)}>
                      <span className="compact-picker__stop" aria-hidden="true"><i className={index > 0 && index <= effortIndex ? "is-on" : ""} /><b /><i className={index < levels.length - 1 && index < effortIndex ? "is-on" : ""} /></span>
                      <span>{level}</span>
                    </button>;
                  })}
                </div>
              </div>
              <div className="compact-picker__eta" title="Approximate thinking time; actual reply time varies"><span>{effortEstimate(shownLevel)}</span> per reply</div>
              {effortFloor && <div className="compact-picker__eta compact-picker__floor">{FLOOR_REASON}</div>}
            </>}

          </div>}
            </div>
          </div>
          <div className="compact-picker__note"><span className="compact-picker__glyph" style={{ color: backendMark(browseBackend).color }} aria-hidden="true"><BackendLogo backend={browseBackend} size={14} /></span>
            <span>Your next message continues this session in {backendLabel(browseBackend)}.</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function ModeChip({
  menuRef,
  open,
  split,
  disabled,
  mode,
  readOnly,
  onToggle,
  onPick,
}: {
  menuRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  split: boolean;
  disabled: boolean;
  mode: AgentMode;
  readOnly: boolean;
  onToggle: () => void;
  onPick: (mode: AgentMode) => void;
}) {
  const copy = MODE_COPY[mode];
  const items: AgentMode[] = [
    "manual",
    "auto-edit",
    "plan",
    "standard",
    "routed",
    "prosecutor",
  ];
  const popoverRef = useAnchoredPopover<HTMLDivElement>(open);
  return (
    <div className="composer__mode" ref={menuRef}>
      <button
        type="button"
        className={`composer__chip${mode === "standard" && !readOnly ? " is-amber" : ""}${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={readOnly ? "Read-only" : copy.label}
        onClick={onToggle}
      >
        <span aria-hidden>{readOnly ? "⊘" : copy.icon}</span>
        <span className="composer__chip-name">
          {readOnly ? "Read-only" : copy.label}
        </span>
        <IconChevronDown size={8} />
      </button>
      {open && (
        <div ref={popoverRef} className="composer__mode-menu" role="menu">
          <span className="composer__mode-heading">Mode</span>
          {items.map((id) => {
            const item = MODE_COPY[id];
            const selected = !readOnly && mode === id;
            return (
              <button
                type="button"
                key={id}
                className={selected ? "is-active" : undefined}
                onClick={() => onPick(id)}
              >
                <span>
                  <strong>
                    {item.icon} {item.label}
                  </strong>
                  <em>{item.blurb}</em>
                </span>
                {selected ? <span>✓</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
