import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { TimelineItem } from "../lib/timeline";
import {
  subagentDescription,
  subagentLabel,
  subagentType,
  isSubagentTool,
  type SubagentRun,
} from "../lib/subagents";
import type { ToolFileView } from "../lib/toolCards";
import { RichText } from "./RichText";
import { ToolCard } from "./ToolCard";

const MIN_WIDTH = 280;
const MAX_WIDTH = 480;

function persistWidth(width: number): number {
  const next = Math.min(
    MAX_WIDTH,
    Math.max(MIN_WIDTH, Math.round(width)),
  );
  localStorage.setItem("devden.subagent-width", String(next));
  return next;
}

function whyText(run: SubagentRun): string {
  return subagentDescription(run.parent) || subagentType(run.parent);
}

export function SubagentPanel({
  runs,
  activeId,
  onSelect,
  onClose,
  onOpenFile,
  onOpenSubagent,
}: {
  runs: SubagentRun[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  onOpenFile: (view: ToolFileView) => void;
  onOpenSubagent?: (id: string) => void;
}) {
  const run = runs.find((candidate) => candidate.id === activeId) ?? runs[0];
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem("devden.subagent-width"));
    return Number.isFinite(stored)
      ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, stored))
      : 360;
  });
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [run?.items, run?.status]);

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (moveEvent: PointerEvent) => {
      setWidth(
        persistWidth(startWidth + (startX - moveEvent.clientX)),
      );
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove("is-resizing-subagent");
    };
    document.body.classList.add("is-resizing-subagent");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

  if (!run) return null;

  const title = subagentLabel(run.parent);
  const why = whyText(run);
  const elapsed = run.parent?.elapsed
    ? `${(run.parent.elapsed / 1000).toFixed(1)}s`
    : "";
  const streaming = run.status === "running";
  const rows = transcriptRows(run.items);
  const liveText = run.items.some(
    (item) => item.kind === "assistant" && item.live,
  );

  return (
    <aside
      className={`subagent-panel subagent-panel--${run.status}`}
      aria-label={title}
      style={{ width, flexBasis: width }}
    >
      <button
        type="button"
        className="subagent-panel__resize"
        aria-label="Resize subagent panel"
        title="Drag to resize"
        onPointerDown={beginResize}
      />
      <header className="subagent-panel__head">
        <span className="subagent-panel__pulse" aria-hidden />
        <div className="subagent-panel__identity">
          <strong title={title}>{title}</strong>
          {why && why !== title ? <span>{why}</span> : null}
        </div>
        <em>
          {run.status === "running"
            ? "running"
            : run.status === "error"
              ? "failed"
              : elapsed || "done"}
        </em>
        <button
          type="button"
          className="subagent-panel__close"
          aria-label="Close subagent panel"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {runs.length > 1 ? (
        <div className="subagent-panel__tabs" role="tablist">
          {runs.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={candidate.id === run.id}
              className={candidate.id === run.id ? "is-active" : undefined}
              onClick={() => onSelect(candidate.id)}
            >
              {subagentLabel(candidate.parent)}
            </button>
          ))}
        </div>
      ) : null}
      <div
        className="subagent-panel__body"
        ref={bodyRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {rows.map((item) => (
          <SubagentItem
            key={item.id}
            item={item}
            onOpenFile={onOpenFile}
            onOpenSubagent={onOpenSubagent}
          />
        ))}
        {streaming && !liveText && run.items.every((item) => item.kind !== "tool" || item.status !== "running") ? (
          <div className="thinking">
            <span className="thinking__spinner" />
            <span>Subagent is working</span>
            <span className="thinking__dots" aria-hidden="true" />
          </div>
        ) : null}
        {run.status !== "running" ? (
          <p className="subagent-panel__handoff">
            {run.status === "error"
              ? "Task failed — handing back to the main agent."
              : "Task completed — handing over to the main agent."}
          </p>
        ) : null}
      </div>
    </aside>
  );
}

function transcriptRows(items: TimelineItem[]): TimelineItem[] {
  return items.filter((item) => item.kind !== "rationale");
}

function SubagentItem({
  item,
  onOpenFile,
  onOpenSubagent,
}: {
  item: TimelineItem;
  onOpenFile: (view: ToolFileView) => void;
  onOpenSubagent?: (id: string) => void;
}) {
  if (item.kind === "tool") {
    return (
      <ToolCard
        item={item}
        onOpenFile={onOpenFile}
        onOpenSubagent={
          isSubagentTool(item.name) ? onOpenSubagent : undefined
        }
      />
    );
  }
  if (item.kind === "notice") {
    return <div className={`notice notice--${item.tone}`}>{item.text}</div>;
  }
  if (item.kind === "assistant" || item.kind === "rationale") {
    return (
      <article
        className={`tl tl--assistant${item.kind === "rationale" ? " tl--rationale" : ""}`}
      >
        <RichText text={item.text} live={item.live} />
      </article>
    );
  }
  return null;
}
