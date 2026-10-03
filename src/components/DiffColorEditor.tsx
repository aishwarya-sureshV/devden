import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  DIFF_ROLES,
  diffTone,
  getAppearance,
  resetDiffColors,
  setDiffColor,
  subscribeAppearance,
} from "../lib/appearance";

/** One color picker per code role; edits repaint all code on screen live. */
export function DiffColorEditor() {
  const settings = useSyncExternalStore(subscribeAppearance, getAppearance);
  const tone = diffTone(settings.background);
  const colors = settings.diffColors[tone];
  return (
    <div className="diff-colors">
      <div className="diff-colors__head">
        <span>
          {tone === "dark" ? "Dark surfaces · Glass, Black, Aurora" : "Light surfaces · White, Cream"}
        </span>
        <button type="button" onClick={() => resetDiffColors(tone)}>
          Reset
        </button>
      </div>
      <div className="diff-colors__grid">
        {DIFF_ROLES.map(([role, label]) => (
          <label key={role} className="diff-colors__row">
            <input
              type="color"
              value={colors[role]}
              onChange={(event) => setDiffColor(tone, role, event.target.value)}
            />
            <span>{label}</span>
            <code style={{ color: colors[role] }}>{colors[role]}</code>
          </label>
        ))}
      </div>
    </div>
  );
}

/** Palette button for a diff header; the editor floats in the top layer.
 *  The popover is placed once per frame while open and clamped inside the
 *  viewport, so pane open animations, scrolls and resizes can't strand it
 *  overlapping the file explorer. */
/** Palette button + popover. `children` replaces the default code-color
 *  editor (the explorer passes the whole Appearance panel). */
export function DiffColorButton({ className = "review-dock__nav", label = "Code colors", children }: { className?: string; label?: string; children?: React.ReactNode }) {
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = pop.current;
    const anchor = btn.current;
    if (!el || !anchor) return;
    let raf = 0;
    const place = () => {
      if (!el.matches(":popover-open")) return;
      const rect = anchor.getBoundingClientRect();
      const height = el.getBoundingClientRect().height;
      const top = Math.min(
        Math.max(8, rect.bottom + 6),
        Math.max(8, window.innerHeight - height - 8),
      );
      el.style.top = `${top}px`;
      el.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
      raf = requestAnimationFrame(place);
    };
    el.addEventListener("toggle", place);
    return () => {
      el.removeEventListener("toggle", place);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={className}
        aria-label={label}
        title={label}
        onClick={() => pop.current?.togglePopover()}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.9 1.2-1.8-.5-1-.1-2.2 1.1-2.2H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10Z" />
          <circle cx="7.5" cy="11" r="1" />
          <circle cx="10" cy="7" r="1" />
          <circle cx="15" cy="7.5" r="1" />
        </svg>
      </button>
      <div ref={pop} popover="auto" className={`diff-colors-pop${children ? " is-appearance" : ""}`}>
        {children ?? <DiffColorEditor />}
      </div>
    </>
  );
}
