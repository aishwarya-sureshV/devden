import { useState } from "react";
import type { TimelineItem } from "../lib/timeline";
import { formatTurnDuration } from "../lib/turnReview";
import { fileKind, formatWorkedAt, splitFilePath } from "../lib/turnFold";
import {
  getToolDiff,
  getToolFileView,
  isFileChangeTool,
  toolPath,
  type ToolFileView,
} from "../lib/toolCards";
import type { RewindFilesResult } from "../lib/api";
import { IconBranch, IconChevronDown, IconFileKind, IconRestore } from "./icons";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

export interface TurnChangedFile {
  path: string;
  added: number;
  removed: number;
  item: ToolItem;
}

export function turnChangedFiles(turn: TimelineItem[]): TurnChangedFile[] {
  const byPath = new Map<string, TurnChangedFile>();
  for (const item of turn) {
    if (item.kind !== "tool" || !isFileChangeTool(item)) continue;
    const path = toolPath(item.args);
    if (!path) continue;
    const diff = getToolDiff(item);
    const prev = byPath.get(path) ?? { path, added: 0, removed: 0, item };
    prev.added += diff?.added ?? 0;
    prev.removed += diff?.removed ?? 0;
    prev.item = item;
    byPath.set(path, prev);
  }
  return [...byPath.values()];
}

export function TurnFoldBar({
  durationMs,
  endedAt,
  toolCount,
  fileCount,
  failedCount = 0,
  open,
  onToggle,
}: {
  durationMs: number;
  endedAt: number;
  toolCount: number;
  fileCount: number;
  failedCount?: number;
  open: boolean;
  onToggle: () => void;
}) {
  const workedAt = formatWorkedAt(endedAt);
  const meta = [
    workedAt,
    `${toolCount} tool${toolCount === 1 ? "" : "s"}`,
    `${fileCount} file${fileCount === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      className={`turn-fold${open ? " is-open" : ""}`}
      aria-expanded={open}
      aria-label={open ? "Collapse output" : "Expand output"}
      onClick={onToggle}
    >
      <span className="turn-fold__row">
        <span className="turn-fold__worked">
          Worked for {formatTurnDuration(durationMs)}
        </span>
        <span
          className={`turn-fold__chevron${open ? " is-open" : ""}`}
          aria-hidden
        >
          <IconChevronDown size={12} />
        </span>
        <span className="turn-fold__meta">{meta}</span>
        {failedCount > 0 && (
          <span className="turn-fold__failed">
            {failedCount} failed
          </span>
        )}
        <span className="turn-fold__action">
          {open ? "Collapse" : "Expand output"}
        </span>
      </span>
      <span className="turn-fold__rule" />
    </button>
  );
}

const TURN_FILES_MAX = 4;

/** Five-cell GitHub-style split of additions vs deletions. */
function diffCells(added: number, removed: number): ("add" | "del" | "none")[] {
  const total = added + removed;
  if (!total) return Array(5).fill("none");
  const adds = Math.round((added / total) * 5);
  return Array.from({ length: 5 }, (_, i) => (i < adds ? "add" : "del"));
}

export function TurnFilesCard({
  files,
  onOpenFile,
  onUndo,
  latest = false,
}: {
  files: TurnChangedFile[];
  onOpenFile: (view: ToolFileView) => void;
  /** Restores every file to before this turn; only offered on the last turn. */
  onUndo?: () => Promise<RewindFilesResult>;
  latest?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [undo, setUndo] = useState<"idle" | "confirm" | "busy" | "done">("idle");
  const [undoError, setUndoError] = useState<string | null>(null);
  if (!files.length) return null;
  const hidden = files.length - TURN_FILES_MAX;
  const shown = expanded || hidden <= 0 ? files : files.slice(0, TURN_FILES_MAX);
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const firstView = files
    .map((file) => getToolFileView(file.item))
    .find((view): view is ToolFileView => view !== null);
  const label = `${files.length} file${files.length === 1 ? "" : "s"} changed`;

  if (undo === "done") {
    return (
      <div className="turn-files turn-files--reverted">
        <IconRestore size={14} />
        <s>{label}</s>
        <span>· turn reverted</span>
      </div>
    );
  }

  const runUndo = async () => {
    if (!onUndo) return;
    if (undo === "idle") return setUndo("confirm");
    setUndo("busy");
    const result = await onUndo();
    setUndoError(result.error ?? null);
    setUndo(result.error ? "idle" : "done");
  };

  return (
    <div className={`turn-files${latest ? " turn-files--latest" : ""}`}>
      <div className="turn-files__head">
        <span className="turn-files__tile" aria-hidden>
          <IconBranch size={16} />
        </span>
        <span className="turn-files__icon" aria-hidden><IconBranch size={14} /></span>
        <span className="turn-files__title">
          <span className="turn-files__label">{label}</span>
          <span className="turn-files__sum">
            <span className="turn-files__add">+{added}</span>
            <span className="turn-files__del">−{removed}</span>
            <span className="turn-files__cells" aria-hidden>
              {diffCells(added, removed).map((cell, i) => (
                <i key={i} data-cell={cell} />
              ))}
            </span>
            {undoError && <span className="turn-files__error">{undoError}</span>}
          </span>
        </span>
        {onUndo && (
          <button
            type="button"
            className={`turn-files__undo${undo === "confirm" ? " is-confirm" : ""}`}
            disabled={undo === "busy"}
            onBlur={() => undo === "confirm" && setUndo("idle")}
            title={undo === "confirm" ? "Confirm undo" : "Undo turn"}
            onClick={() => void runUndo()}
          >
            <IconRestore size={13} />
            <span className="turn-files__undo-label">
              {undo === "confirm" ? "Confirm undo" : "Undo turn"}
            </span>
          </button>
        )}
        {firstView && (
          <button
            type="button"
            className="turn-files__open"
            onClick={() => onOpenFile(firstView)}
          >
            Review
          </button>
        )}
      </div>
      <ul className="turn-files__list">
        {shown.map((file) => {
          const view = getToolFileView(file.item);
          const { dir, name } = splitFilePath(file.path);
          return (
            <li key={file.path}>
              <button
                type="button"
                className="turn-files__row"
                disabled={!view}
                title={file.path}
                onClick={() => {
                  if (view) onOpenFile(view);
                }}
              >
                <span className="turn-files__kind fbadge-k" data-kind={fileKind(file.path)}>
                  <IconFileKind kind={fileKind(file.path)} size={15} />
                </span>
                <span className="turn-files__path">
                  <span className="turn-files__dir">{dir}</span>
                  <span className="turn-files__name">{name}</span>
                </span>
                <span className="turn-files__stat">
                  <span className={file.added ? "turn-files__add" : "turn-files__zero"}>+{file.added}</span>
                  <span className={file.removed ? "turn-files__del" : "turn-files__zero"}>−{file.removed}</span>
                </span>
              </button>
            </li>
          );
        })}
        {hidden > 0 && (
          <li>
            <button
              type="button"
              className="turn-files__more"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded
                ? "Show fewer"
                : `Show ${hidden} more file${hidden === 1 ? "" : "s"}`}
              {!expanded && hidden === 1 && (
                <span className="turn-files__dir">· {files[TURN_FILES_MAX].path}</span>
              )}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
