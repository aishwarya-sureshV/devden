import type { KeyboardEvent, RefObject } from "react";
import {
  AGENT_BACKENDS,
  backendLabel,
  backendMark,
  type AgentBackend,
  type ProviderUsage,
} from "../lib/api";
import { useAnchoredPopover } from "../lib/anchoredPopover";
import { usagePair } from "../lib/backendUsage";
import { effortLabel } from "../lib/effortStops";
import { BackendLogo, IconChevronDown, IconSearch } from "./icons";

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

const EFFORT_ESTIMATE = ["~2s", "~6s", "~15s", "~40s"];

function tone(left: number | null): string | undefined {
  if (left === null) return undefined;
  if (left < 10) return "is-critical";
  if (left < 25) return "is-low";
  return undefined;
}

function formatContext(tokens?: number): string {
  if (!tokens) return "";
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

export function UsageChip({
  popRef,
  open,
  split,
  hour,
  week,
  current,
  usage,
  reset,
  onToggle,
}: {
  popRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  split: boolean;
  hour: number | null;
  week: number | null;
  current: AgentBackend;
  usage: Partial<Record<AgentBackend, ProviderUsage>>;
  reset?: string | null;
  onToggle: () => void;
}) {
  const rows = AGENT_BACKENDS.map((backend) => ({
    backend,
    pair: usagePair(usage[backend]),
  }));
  const weeks = rows
    .map((row) => row.pair.week)
    .filter((value): value is number => value !== null);
  const overall = weeks.length
    ? Math.round(weeks.reduce((sum, value) => sum + value, 0) / weeks.length)
    : null;
  const popoverRef = useAnchoredPopover<HTMLDivElement>(open, "end");
  return (
    <div ref={popRef}>
      <button
        type="button"
        className={`composer__usage${open ? " is-open" : ""}`}
        onClick={onToggle}
      >
        {hour !== null && <span className={tone(hour)}>5h {hour}%</span>}
        {week !== null && <span className={tone(week)}>wk {week}%</span>}
        {hour === null && week === null && <span>usage</span>}
        {reset && <small className="composer__usage-reset">resets {reset}</small>}
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="usage-pop"
          role="dialog"
          aria-label="Usage"
        >
          <div className="usage-pop__card">
            <div className="usage-pop__row-head">
              <strong>Overall this week</strong>
              <span>{overall === null ? "—" : `${overall}% left`}</span>
            </div>
            <div className="usage-pop__stack">
              {rows.map((row) => (
                <i
                  key={row.backend}
                  style={{
                    flex: Math.max(row.pair.week ?? 1, 1),
                    background: backendMark(row.backend).color,
                  }}
                />
              ))}
            </div>
            <div className="usage-pop__legend">
              {rows.map((row) => (
                <span key={row.backend}>
                  {backendMark(row.backend).glyph} {backendLabel(row.backend)}
                </span>
              ))}
            </div>
          </div>
          {rows.map((row) => (
            <div
              key={row.backend}
              className={`usage-pop__row${row.backend === current ? " is-current" : ""}`}
            >
              <BackendLogo backend={row.backend} size={14} />
              <div>
                <div className="usage-pop__row-head">
                  <strong>{backendLabel(row.backend)}</strong>
                  {row.backend === current && <span>current</span>}
                  {row.pair.reset && <span>resets {row.pair.reset}</span>}
                </div>
                <Meter label="5h" left={row.pair.hour} />
                <Meter label="wk" left={row.pair.week} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Meter({ label, left }: { label: string; left: number | null }) {
  return (
    <div className="usage-pop__meter">
      <span>{label}</span>
      <b>
        <i style={{ width: `${left ?? 0}%` }} />
      </b>
      <span className={tone(left)}>{left === null ? "—" : `${left}%`}</span>
    </div>
  );
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
}) {
  const trackIndex = Math.max(0, levels.indexOf(effort));
  const shown = effortHover ?? trackIndex;
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
      className="native-model-controls"
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
        <span className="composer__chip-name">{modelLabel}</span>
        {levels.length > 0 && effort && (
          <span className="composer__chip-effort">{effortLabel(effort)}</span>
        )}
        <IconChevronDown size={12} />
      </button>
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
                            {option.label}
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
                      {EFFORT_ESTIMATE[
                        Math.min(shown, EFFORT_ESTIMATE.length - 1)
                      ] ?? ""}
                    </span>
                    <span>per reply</span>
                  </div>
                  <div className="think-track__rail">
                    <div className="think-track__base" />
                    <div
                      className="think-track__fill"
                      style={{
                        width: `calc((100% - 14px) * ${stopAt(trackIndex)})`,
                      }}
                    />
                    <div className="think-track__stops">
                      {levels.map((level, index) => (
                        <button
                          type="button"
                          key={level}
                          className={`think-track__stop${index < trackIndex ? " is-on" : ""}${index === trackIndex ? " is-current" : ""}`}
                          style={{
                            left: `calc((100% - 14px) * ${stopAt(index)})`,
                          }}
                          aria-label={level}
                          onMouseEnter={() => onEffortHover(index)}
                          onClick={() => onEffort(level)}
                        >
                          <i />
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="think-track__names">
                    {levels.map((level, index) => (
                      <button
                        type="button"
                        key={level}
                        className={`think-track__name${index === 0 ? " is-first" : ""}${index === levels.length - 1 && index !== 0 ? " is-last" : ""}${index === trackIndex ? " is-current" : ""}`}
                        style={{
                          left: `calc((100% - 14px) * ${stopAt(index)})`,
                        }}
                        onMouseEnter={() => onEffortHover(index)}
                        onClick={() => onEffort(level)}
                      >
                        {level}
                      </button>
                    ))}
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
