import { useEffect, useRef, useState } from "react";
import {
  AGENT_BACKENDS,
  backendLabel,
  backendMark,
  type AgentBackend,
} from "../lib/api";
import { useStore } from "../lib/store";
import { useAnchoredPopover } from "../lib/anchoredPopover";
import type { TurnStats } from "../lib/turnReview";
import { BackendLogo, IconChevronDown } from "./icons";

const REVIEWER_KEY = "devden.reviewer";

function readReviewer(): string | null {
  try {
    return localStorage.getItem(REVIEWER_KEY);
  } catch {
    return null;
  }
}

/** Which backend the one-click half of the split button runs. */
function pickReviewer(
  reviewers: AgentBackend[],
  remembered: string | null,
): AgentBackend | undefined {
  // TODO(human): choose the default reviewer.
  void remembered;
  return reviewers[0];
}

/* Split button that lives in the Changes header, between the diffstat and the
   view icons: the main half reruns the last reviewer, the caret picks another.
   Rendered standalone in the turn bar when the Changes card is not shown. */
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
  const [remembered, setRemembered] = useState(readReviewer);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useAnchoredPopover<HTMLDivElement>(open, "end");
  const { backendCatalog } = useStore();
  const reviewers = (backendCatalog.length
    ? backendCatalog.map((item) => item.id)
    : [...AGENT_BACKENDS]
  ).filter((item) => item !== backend);
  const reviewer = pickReviewer(reviewers, remembered);

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

  const run = (item: AgentBackend) => {
    setOpen(false);
    setRemembered(item);
    try {
      localStorage.setItem(REVIEWER_KEY, item);
    } catch {
      /* private mode: the default just won't stick */
    }
    onReview(item);
  };

  const tools = `${stats.toolCount} tool${stats.toolCount === 1 ? "" : "s"}`;
  const files = `${stats.fileCount} file${stats.fileCount === 1 ? "" : "s"}`;
  const label = reviewer ? backendLabel(reviewer) : "";

  return (
    <div
      ref={rootRef}
      className={`turn-complete${open ? " is-open" : ""}`}
      // The Changes header toggles on click; keep review clicks (including
      // the top-layer menu, which still bubbles through React) out of it.
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="turn-complete__review"
        disabled={!reviewer || Boolean(starting)}
        onClick={() => reviewer && run(reviewer)}
        title={`Review this turn with ${label} · ${tools} · ${files}`}
      >
        {reviewer && (
          <span style={{ color: backendMark(reviewer).color }} aria-hidden>
            <BackendLogo backend={reviewer} size={12} />
          </span>
        )}
        <strong>
          {starting ? (
            "Starting…"
          ) : (
            <>
              Review
              <span className="turn-complete__agent"> with {label}</span>
            </>
          )}
        </strong>
      </button>
      <button
        type="button"
        className="turn-complete__caret"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Choose reviewer"
        title="Choose reviewer"
        disabled={Boolean(starting) || reviewers.length === 0}
        onClick={() => setOpen((value) => !value)}
      >
        <IconChevronDown size={11} />
      </button>
      {open && (
        <div ref={menuRef} className="turn-complete__menu" role="menu">
          {reviewers.map((item) => (
            <button
              type="button"
              role="menuitem"
              key={item}
              className={item === reviewer ? "is-current" : undefined}
              onClick={() => run(item)}
            >
              <span style={{ color: backendMark(item).color }} aria-hidden>
                <BackendLogo backend={item} size={16} />
              </span>
              <span>{backendLabel(item)}</span>
            </button>
          ))}
          <p className="turn-complete__hint">
            Sends this turn’s transcript to another agent. The reviewer does not
            write to the worktree.
          </p>
        </div>
      )}
    </div>
  );
}
