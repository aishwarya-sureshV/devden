import { useLayoutEffect, useRef } from "react";

const GAP = 8;
const EDGE = 8;

/* Opens a conditionally rendered menu in the browser's top layer (popover
   API) and pins it to its anchor — the menu's parent element. Split panes
   clip (overflow), stack (z-index) and blur (backdrop-filter) their children;
   the top layer escapes all three, so a menu never hides behind a
   neighbouring pane or past the window edge. Opens above the anchor when it
   fits, otherwise on whichever side has more room, clamped to the viewport.
   The menu stays in its DOM spot, so outside-click `contains()` checks and
   descendant selectors keep working. */
export function useAnchoredPopover<T extends HTMLElement>(
  open: boolean,
  align: "start" | "end" = "start",
  options?: {
    /** Element the menu hangs off. Defaults to the menu's parent. */
    anchor?: { current: HTMLElement | null };
    /** Which side of the anchor to try first. */
    prefer?: "above" | "below";
  },
) {
  const ref = useRef<T | null>(null);
  const prefer = options?.prefer ?? "above";
  const anchorRef = options?.anchor;
  useLayoutEffect(() => {
    const menu = ref.current;
    const anchor = anchorRef?.current ?? menu?.parentElement;
    if (!open || !menu || !anchor || !menu.showPopover) return;
    menu.popover = "manual";
    Object.assign(menu.style, {
      position: "fixed",
      inset: "auto",
      margin: "0",
      transform: "none",
    });
    menu.showPopover();
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const above = a.top - GAP - EDGE;
      const below = window.innerHeight - a.bottom - GAP - EDGE;
      menu.style.maxHeight = `${Math.max(above, below)}px`;
      const { width, height } = menu.getBoundingClientRect();
      const top =
        prefer === "below"
          ? height <= below
            ? a.bottom + GAP
            : a.top - GAP - height
          : height <= above
            ? a.top - GAP - height
            : a.bottom + GAP;
      const left = align === "end" ? a.right - width : a.left;
      menu.style.top = `${Math.max(EDGE, top)}px`;
      menu.style.left = `${Math.max(
        EDGE,
        Math.min(left, window.innerWidth - EDGE - width),
      )}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align, prefer, anchorRef]);
  return ref;
}
