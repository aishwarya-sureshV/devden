import { useEffect, useState } from "react";
import type { TimelineItem } from "../lib/timeline";
import {
  canonicalizeToolName,
  isFileEditTool,
  toolPath,
  displayToolName,
  type ToolFileView,
} from "../lib/toolCards";
import {
  subagentDescription,
  subagentType,
  type SubagentRun,
} from "../lib/subagents";
import { ToolCard } from "./ToolCard";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) || path;
}

function isReadOnlyRun(item: ToolItem): boolean {
  const type = subagentType(item).toLowerCase();
  if (/(explore|read.?only|plan|scout)/.test(type)) return true;
  const blob = JSON.stringify(item.args ?? {});
  return /read.?only/i.test(blob);
}

function elapsedLabel(item: ToolItem, now: number, running: boolean): string {
  const ms =
    running && item.startedAt
      ? Math.max(0, now - item.startedAt)
      : (item.elapsed ?? 0);
  if (!ms) return running ? "0.0s" : "";
  return `${(ms / 1000).toFixed(1)}s`;
}

export function SubagentCard({
  item,
  children = [],
  onOpenFile,
  onOpenSubagent,
  onBackground,
}: {
  item: ToolItem;
  children?: ToolItem[];
  onOpenFile: (view: ToolFileView) => void;
  onOpenSubagent?: (id: string) => void;
  onBackground?: (id: string) => void;
}) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Claude's background Agent call completes with an "async launched"
  // receipt while nested work is still going; Grok holds spawn_subagent
  // open until the child finishes. Prefer live children over the parent
  // status so the card does not flip to "done" mid-run if the hold is late.
  const running =
    item.status === "running" ||
    children.some((child) => child.status === "running");
  const background =
    item.args?.run_in_background === true || item.args?.background === true;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 400);
    return () => window.clearInterval(timer);
  }, [running]);

  const type = subagentType(item) || item.name;
  const title =
    subagentDescription(item) || displayToolName(item.name);
  const reads = children.filter(
    (child) => canonicalizeToolName(child.name) === "read",
  ).length;
  const writes = children.filter((child) => isFileEditTool(child.name)).length;
  const done = children.filter((child) => child.status !== "running").length;
  const current =
    [...children].reverse().find((child) => child.status === "running") ??
    children.at(-1);
  const currentPath = current ? toolPath(current.args) : "";
  const progress =
    children.length === 0
      ? running
        ? 12
        : 100
      : Math.round((done / Math.max(children.length, 1)) * 100);
  const time = elapsedLabel(item, now, running);
  const canPopout = Boolean(onOpenSubagent);

  return (
    <article
      className={`subagent-card subagent-card--${running ? "running" : item.status}`}
      aria-label={`${type} subagent ${running ? "running" : item.status}`}
    >
      <span className="subagent-card__pulse" aria-hidden />
      <div className="subagent-card__panel">
        <div className="subagent-card__head">
          <div className="subagent-card__identity">
            <div className="subagent-card__kicker">
              <span>subagent · {type}</span>
              {isReadOnlyRun(item) && <em>read-only</em>}
            </div>
            <strong>{title}</strong>
          </div>
          {canPopout && (
            <button
              type="button"
              className="subagent-card__open"
              onClick={() => onOpenSubagent?.(item.id)}
            >
              Open panel
            </button>
          )}
        </div>

        <div className="subagent-card__stats">
          <div className="subagent-card__counts">
            <span>{children.length} steps</span>
            <span aria-hidden>·</span>
            <span>{reads} files read</span>
            <span aria-hidden>·</span>
            <span>{writes} writes</span>
            <span className="subagent-card__elapsed">
              {running ? `running ${time}` : time || item.status}
            </span>
          </div>
          <div
            className="subagent-card__meter"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <span style={{ width: `${Math.min(100, progress)}%` }} />
          </div>
          {current && (
            <div className="subagent-card__now">
              {running ? (
                <span className="subagent-card__spinner" aria-hidden />
              ) : (
                <span className="subagent-card__now-dot" aria-hidden />
              )}
              <span className="subagent-card__now-label">
                {running ? "now" : "last"}
              </span>
              <span className="subagent-card__now-step">
                {displayToolName(current.name)}
                {currentPath ? ` ${basename(currentPath)}` : ""}
              </span>
            </div>
          )}
        </div>

        <div className="subagent-card__foot">
          <button
            type="button"
            className="subagent-card__steps-toggle"
            aria-expanded={stepsOpen}
            onClick={() => setStepsOpen((open) => !open)}
            disabled={children.length === 0}
          >
            {stepsOpen ? "▾" : "▸"} Show all {children.length} steps
          </button>
          {running && (
            <span>
              {background
                ? "Running in background"
                : "Main thread is waiting"}
            </span>
          )}
          {running && onBackground && (
            <button
              type="button"
              className="subagent-card__background"
              onClick={() => onBackground(item.id)}
            >
              Run in background
            </button>
          )}
        </div>

        {stepsOpen && children.length > 0 && (
          <div className="subagent-card__steps">
            {children.map((child) => (
              <ToolCard
                key={child.id}
                item={child}
                onOpenFile={onOpenFile}
              />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

export function runningSubagentSummary(runs: SubagentRun[]): string | null {
  const running = runs.filter((run) => run.status === "running");
  if (running.length === 0) return null;
  return running.length === 1
    ? "1 subagent"
    : `${running.length} subagents`;
}
