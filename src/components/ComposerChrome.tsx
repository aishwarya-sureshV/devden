import type { KeyboardEvent, ReactNode, RefObject } from "react";
import {
  backendLabel,
  backendMark,
  type AgentBackend,
  type ProviderUsage,
} from "../lib/api";
import { useAnchoredPopover } from "../lib/anchoredPopover";
import { effortEstimate, effortLabel } from "../lib/effortStops";
import { BackendLogo, IconChevronDown, IconSearch, ModelName } from "./icons";

export type ModelOption = {
  provider: string;
  id: string;
  label: string;
  context?: number;
  /** Thinking levels this model supports, when the catalog knows them. */
  levels?: string[];
};

type AgentMode = "standard" | "plan" | "routed" | "manual" | "auto-edit";

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
};

function formatContext(tokens?: number): string {
  if (!tokens) return "";
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

export function UsageChip({ popRef, open, hour, week, current, usage, reset, onToggle, context }: {
  popRef: RefObject<HTMLDivElement | null>; open: boolean; split: boolean;
  hour: number | null; week: number | null; current: AgentBackend;
  usage: Partial<Record<AgentBackend, ProviderUsage>>; reset?: string | null;
  onToggle: () => void; context: { percent: number | null; label: string };
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
  return <div ref={popRef} className="composer__usage-wrap">
    <button type="button" className={`composer__usage${open ? " is-open" : ""}`} aria-haspopup="dialog" aria-expanded={open} aria-label={`Usage: 5-hour ${h === null ? "unavailable" : `${h}% used`}, week ${w === null ? "unavailable" : `${w}% used`}`} title={reset ? `Usage used · resets ${reset}` : "Usage used"} onClick={onToggle}>
      <span className="usage-bars">{[["5h", h], ["wk", w]].map(([label, n]) => <span key={String(label)}><small>{label}</small><i><b style={{ width: `${n ?? 0}%`, background: color(n as number | null) }} /></i><small>{n === null ? "—" : `${n}%`}</small></span>)}</span>
      <span className="usage-rings"><svg viewBox="0 0 22 22" width="20" height="20" aria-hidden="true">{[h, w].map((n, i) => <g key={i}><circle cx="11" cy="11" r={i ? 5 : 9} fill="none" stroke="currentColor" opacity=".15" strokeWidth="2.2" /><circle cx="11" cy="11" r={i ? 5 : 9} fill="none" stroke={color(n)} strokeWidth="2.2" pathLength="100" strokeDasharray={`${n ?? 0} 100`} transform="rotate(-90 11 11)" /></g>)}</svg><small style={{ color: color(h === null && w === null ? null : Math.max(h ?? 0, w ?? 0)) }}>{h === null && w === null ? "—" : `${Math.max(h ?? 0, w ?? 0)}%`}</small></span>
    </button>
    {open && <div ref={popoverRef} className="usage-pop" role="dialog" aria-label="Usage">
      <div className="usage-pop__row-head"><strong>{backendLabel(current)} usage</strong><span>% used</span></div>
      {rows.map(row => <div className="usage-pop__card" key={row.label}><div className="usage-pop__row-head"><strong>{row.label}</strong><span>{row.percent === null ? "—" : `${row.percent}% used`}</span></div><div className="usage-pop__meter"><b><i style={{ width: `${row.percent ?? 0}%`, background: color(row.percent) }} /></b></div><small>{row.detail}</small></div>)}
    </div>}
  </div>;
}

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
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onWarm: () => void;
  /** Rendered on the second line beside effort (the mode chip). */
  children?: ReactNode;
}) {
  const trackIndex = Math.max(0, levels.indexOf(effort));
  const offered = (level: string) =>
    !supported?.length || supported.includes(level) || level === effort;
  const hovered =
    effortHover != null && offered(levels[effortHover] ?? "")
      ? effortHover
      : null;
  const shown = hovered ?? trackIndex;
  const shownLevel = levels[shown] ?? effort;
  const providers = new Set(options.map((option) => option.provider));
  const groups: {
    name: string;
    items: { option: ModelOption; index: number }[];
  }[] = [];
  options.forEach((option, index) => {
    const name = providers.size > 1 ? option.provider : "Models";
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.items.push({ option, index });
    else groups.push({ name, items: [{ option, index }] });
  });
  const stopAt = (index: number) =>
    levels.length <= 1 ? 0 : index / (levels.length - 1);
  const popoverRef = useAnchoredPopover<HTMLDivElement>(open);
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
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={`${backendLabel(backend)} · ${modelLabel}`}
        onClick={onToggle}
      >
        <BackendLogo backend={backend} size={14} />
        <span className="composer__chip-name"><ModelName name={modelLabel} /></span>
      </button>
      <div className="composer__chip-meta">
        {levels.length > 0 && effort && (
          <button
            type="button"
            className="composer__chip-effort"
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            title="Effort"
            onClick={onToggle}
          >
            {effortLabel(effort)}
          </button>
        )}
        {children}
      </div>
      {open && (
        <div
          ref={popoverRef}
          className="composer__mode-menu composer__model-menu"
          role="menu"
          onKeyDown={onKeyDown}
        >
          <label className="composer__model-search">
            <IconSearch size={14} />
            <input
              ref={searchRef}
              value={query}
              placeholder={`Search ${backendLabel(browseBackend)} models`}
              aria-label="Search models"
              onChange={(event) => onQuery(event.target.value)}
            />
            <kbd className="composer__model-search-kbd">⇥</kbd>
            <span className="composer__model-search-hint">agent</span>
          </label>
          <div className="composer__model-columns">
            <div className="composer__model-backends">
              <div className="composer__model-colhead">AGENT</div>
              {backends.map((id) => (
                <button
                  type="button"
                  key={id}
                  className={id === browseBackend ? "is-active" : undefined}
                  onClick={() => onBrowse(id)}
                >
                  <span
                    className="composer__model-glyph"
                    style={{ color: backendMark(id).color }}
                  >
                    <BackendLogo backend={id} size={14} />
                  </span>
                  {backendLabel(id).toLowerCase()}
                </button>
              ))}
            </div>
            <div className="composer__model-models">
              <div className="composer__model-list">
                {options.length === 0 && (
                  <div className="composer__model-empty">
                    {query
                      ? `No ${backendLabel(browseBackend)} models match “${query}”`
                      : "Loading models…"}
                  </div>
                )}
                {groups.map((group) => (
                  <div
                    className="composer__model-group-block"
                    key={`${group.name}-${group.items[0]?.index ?? 0}`}
                  >
                    <div className="composer__model-group">
                      <span>{group.name}</span>
                      <span>Context</span>
                    </div>
                    {group.items.map(({ option, index }) => {
                      const value = `${option.provider}/${option.id}`;
                      const selected =
                        browseBackend === backend && value === currentModel;
                      const hot = index === highlight;
                      return (
                        <button
                          type="button"
                          key={value}
                          className={
                            selected
                              ? hot
                                ? "is-active is-highlighted"
                                : "is-active"
                              : hot
                                ? "is-highlighted"
                                : undefined
                          }
                          onMouseEnter={() => onHighlight(index)}
                          onClick={() => onPick(option)}
                        >
                          <span className="composer__model-name">
                            <ModelName name={option.label} />
                          </span>
                          <span className="composer__model-context">
                            {option.context
                              ? formatContext(option.context)
                              : ""}
                          </span>
                          <span className="composer__model-check">
                            {selected ? "✓" : ""}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              {levels.length > 0 && (
                <div
                  className="think-track"
                  onMouseLeave={() => onEffortHover(null)}
                >
                  <div className="think-track__label">
                    <span>Thinking time</span>
                    <span className="think-track__est">
                      {effortEstimate(shownLevel)}
                    </span>
                    <span>per reply</span>
                  </div>
                  <div className="think-track__rail">
                    <div className="think-track__base" />
                    <div
                      className="think-track__fill"
                      style={{
                        width: `calc((100% - 14px) * ${stopAt(shown)})`,
                      }}
                    />
                    <div
                      className="think-track__thumb"
                      style={{
                        left: `calc((100% - 14px) * ${stopAt(shown)})`,
                      }}
                    />
                    <div className="think-track__stops">
                      {levels.map((level, index) => {
                        const open = offered(level);
                        return (
                          <button
                            type="button"
                            key={level}
                            className={`think-track__stop${index < shown ? " is-on" : ""}${index === shown ? " is-current" : ""}${open ? "" : " is-unavailable"}`}
                            style={{
                              left: `calc((100% - 14px) * ${stopAt(index)})`,
                            }}
                            aria-label={level}
                            aria-disabled={!open}
                            onMouseEnter={() => {
                              if (open) onEffortHover(index);
                            }}
                            onClick={() => {
                              if (open) onEffort(level);
                            }}
                          >
                            <i />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="think-track__names">
                    {levels.map((level, index) => {
                      const open = offered(level);
                      return (
                        <button
                          type="button"
                          key={level}
                          className={`think-track__name${index === 0 ? " is-first" : ""}${index === levels.length - 1 && index !== 0 ? " is-last" : ""}${index === shown ? " is-current" : ""}${open ? "" : " is-unavailable"}`}
                          style={{
                            left: `calc((100% - 14px) * ${stopAt(index)})`,
                          }}
                          onMouseEnter={() => {
                            if (open) onEffortHover(index);
                          }}
                          onClick={() => {
                            if (open) onEffort(level);
                          }}
                        >
                          {level}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
          {browseBackend !== backend && (
            <div className="composer__handoff-note">
              <span
                className="composer__model-glyph"
                style={{ color: backendMark(browseBackend).color }}
              >
                <BackendLogo backend={browseBackend} size={13} />
              </span>
              <span>
                Your next message continues this session in{" "}
                {backendLabel(browseBackend)}.
              </span>
            </div>
          )}
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
