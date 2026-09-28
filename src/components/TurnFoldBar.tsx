import type { TimelineItem } from "../lib/timeline";
import { formatTurnDuration } from "../lib/turnReview";
import { formatWorkedAt, splitFilePath } from "../lib/turnFold";
import {
  getToolDiff,
  getToolFileView,
  isFileChangeTool,
  toolPath,
  type ToolFileView,
} from "../lib/toolCards";
import { IconChevronDown } from "./icons";

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

export function TurnFilesCard({
  files,
  onOpenFile,
}: {
  files: TurnChangedFile[];
  onOpenFile: (view: ToolFileView) => void;
}) {
  if (!files.length) return null;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const firstView = files
    .map((file) => getToolFileView(file.item))
    .find((view): view is ToolFileView => view !== null);
  return (
    <div className="turn-files">
      <div className="turn-files__head">
        <span className="turn-files__label">
          {files.length} changed file{files.length === 1 ? "" : "s"}
        </span>
        {added > 0 && <span className="turn-files__add">+{added}</span>}
        {removed > 0 && <span className="turn-files__del">−{removed}</span>}
        <span className="turn-files__spacer" />
        {firstView && (
          <button
            type="button"
            className="turn-files__open"
            onClick={() => onOpenFile(firstView)}
          >
            Open diff
          </button>
        )}
      </div>
      {files.map((file) => {
        const view = getToolFileView(file.item);
        const { dir, name } = splitFilePath(file.path);
        const total = file.added + file.removed;
        const addW = total ? (file.added / total) * 100 : 0;
        const delW = total ? (file.removed / total) * 100 : 0;
        return (
          <button
            key={file.path}
            type="button"
            className="turn-files__row"
            disabled={!view}
            onClick={() => {
              if (view) onOpenFile(view);
            }}
          >
            <span className="turn-files__dir">{dir}</span>
            <span className="turn-files__name">{name}</span>
            <span className="turn-files__bar" aria-hidden>
              {total > 0 && (
                <>
                  <span
                    className="turn-files__bar-add"
                    style={{ width: `${addW}%` }}
                  />
                  <span
                    className="turn-files__bar-del"
                    style={{ width: `${delW}%` }}
                  />
                </>
              )}
            </span>
            {file.added > 0 && (
              <span className="turn-files__add">+{file.added}</span>
            )}
            {file.removed > 0 && (
              <span className="turn-files__del">−{file.removed}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
