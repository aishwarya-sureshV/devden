import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AGENT_BACKENDS,
  backendLabel,
  backendMark,
  type AgentBackend,
} from "../lib/api";
import type { TurnStats } from "../lib/turnReview";
import { BackendLogo, IconChevronDown } from "./icons";

export function TurnCompleteBar({
  backend,
  stats,
  starting,
  onReview,
}: {
  backend: AgentBackend;
  stats: TurnStats;
  starting?: AgentBackend | null;
  onReview: (backend: AgentBackend) => void;
}) {
  const [open, setOpen] = useState(false);
  // Composer sits on the bottom edge, so default above and only drop down
  // when there is actually room under the pill.
  const [above, setAbove] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const reviewers = AGENT_BACKENDS.filter((item) => item !== backend);

  useLayoutEffect(() => {
    if (!open || !rootRef.current || !menuRef.current) return;
    const root = rootRef.current.getBoundingClientRect();
    const menuHeight = menuRef.current.offsetHeight;
    const spaceBelow = window.innerHeight - root.bottom - 8;
    setAbove(spaceBelow < menuHeight);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const tools = `${stats.toolCount} tool${stats.toolCount === 1 ? "" : "s"}`;
  const files = `${stats.fileCount} file${stats.fileCount === 1 ? "" : "s"}`;

  return (
    <div
      ref={rootRef}
      className={`turn-complete${open ? " is-open" : ""}${above ? " is-above" : ""}`}
    >
      <button
        type="button"
        className="turn-complete__review"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={Boolean(starting) || reviewers.length === 0}
        onClick={() => setOpen((value) => !value)}
      >
        <strong>Review</strong>
        <span className="turn-complete__meta">
          {tools} · {files}
        </span>
        <IconChevronDown size={11} />
      </button>
      {open && (
        <div ref={menuRef} className="turn-complete__menu" role="menu">
          {reviewers.map((item) => {
            const mark = backendMark(item);
            return (
              <button
                type="button"
                role="menuitem"
                key={item}
                disabled={starting === item}
                onClick={() => {
                  setOpen(false);
                  onReview(item);
                }}
              >
                <span style={{ color: mark.color }} aria-hidden>
                  <BackendLogo backend={item} size={16} />
                </span>
                <span>
                  {backendLabel(item).toLowerCase()}
                  {starting === item ? " · starting" : ""}
                </span>
              </button>
            );
          })}
          <p className="turn-complete__hint">
            Sends this turn’s transcript to another agent. The reviewer does
            not write to the worktree.
          </p>
        </div>
      )}
    </div>
  );
}
