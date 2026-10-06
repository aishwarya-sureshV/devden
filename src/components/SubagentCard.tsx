import { useEffect, useState } from "react";
import type { TimelineItem } from "../lib/timeline";
import { displayToolName, type ToolFileView } from "../lib/toolCards";
import {
  subagentDescription,
  subagentType,
  type SubagentRun,
} from "../lib/subagents";
import { formatDuration } from "../lib/toolRow";
import { CallRow, ToolCard } from "./ToolCard";
import type { ResultPart, ToolRowModel } from "../lib/toolRow";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

function elapsedMs(item: ToolItem, now: number, running: boolean): number {
  if (running && item.startedAt) return Math.max(0, now - item.startedAt);
  return item.elapsed ?? 0;
}

export function SubagentCard({
  item,
  children = [],
  onOpenFile,
  onOpenSubagent,
  onBackground,
  cwd = "",
}: {
  item: ToolItem;
  children?: ToolItem[];
  onOpenFile: (view: ToolFileView) => void;
  onOpenSubagent?: (id: string) => void;
  onBackground?: (id: string) => void;
  cwd?: string;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
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

  const failed = children.filter((child) => child.status === "error").length;
  const bloom = item.status === "error" && failed === 0;
  const title = subagentDescription(item) || displayToolName(item.name);
  const type = subagentType(item);
  const ms = elapsedMs(item, now, running);
  const returned = oneLine(item.output) || title;
  const parts: ResultPart[] = [
    { text: String(children.length), tone: "num" },
    { text: " calls", tone: "dim" },
  ];
  if (failed > 0) {
    parts.push(
      { text: " · ", tone: "dim" },
      { text: `${failed} failed`, tone: "fail" },
    );
  }
  const model: ToolRowModel = {
    verb: item.name === "prosecutor" ? "prosecute" : "agent",
    accent: true,
    tag: "",
    prefix: "",
    main: title,
    suffix: type ? ` · ${type}` : "",
    sans: false,
    strike: false,
    dimVerb: false,
    title,
    parts,
    duration: formatDuration(ms, running),
    thread: bloom ? "failed" : running ? "running" : "settled",
    breakAt: bloom ? 40 : 100,
    note: "",
    tail: "",
    detail: "none",
    list: [],
    pattern: "",
    diffLines: [],
    diffMore: false,
    diffLabel: "",
  };

  return (
    <article className="tl tl--tool" aria-label={`${type || "agent"} subagent`}>
      <span className="tl__node" />
      <div className={`trow-stack is-${model.thread}`}>
        <CallRow
          model={model}
          signal={item.output}
          expanded={open || running}
          onClick={() => setOpen((value) => !value)}
        />
        {!running && returned && (
          <div className="trow__note">Returned: {returned}</div>
        )}
        {(running || open) && children.length > 0 && (
          <div className="trow-nest trow-nest--agent">
            {children.map((child, index) => (
              <div key={child.id} style={{ animationDelay: `${index * 50}ms` }}>
                <ToolCard item={child} onOpenFile={onOpenFile} cwd={cwd} />
              </div>
            ))}
          </div>
        )}
        {(running || onOpenSubagent) && (
          <div className="trow__actions">
            {running && (
              <span>{background ? "Running in background" : "Main thread is waiting"}</span>
            )}
            {running && onBackground && (
              <button type="button" onClick={() => onBackground(item.id)}>
                Run in background
              </button>
            )}
            {onOpenSubagent && (
              <button type="button" onClick={() => onOpenSubagent(item.id)}>
                Open panel
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function oneLine(text: string): string {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > 180 ? `${line.slice(0, 179)}…` : line;
}

export function runningSubagentSummary(runs: SubagentRun[]): string | null {
  const running = runs.filter((run) => run.status === "running");
  if (running.length === 0) return null;
  return running.length === 1 ? "1 subagent" : `${running.length} subagents`;
}
