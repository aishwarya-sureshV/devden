import { useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  CARD_NOTE_MAX,
  leadLine,
  patchCard,
  pushCard,
} from "../lib/board";
import { copyText } from "./CopyButton";
import { IconCheck, IconColumns, IconCopy } from "./icons";

type Spot = { text: string; x: number; y: number };

/** Selection has to start inside the chat — not the composer or the sidebar. */
function chatSelection(): Spot | null {
  const selection = window.getSelection();
  const text = selection?.toString().trim();
  if (!selection || !text || selection.isCollapsed || !selection.rangeCount)
    return null;
  const node = selection.anchorNode;
  const host = node instanceof Element ? node : node?.parentElement;
  if (!host?.closest(".conversation")) return null;
  if (host.closest(".composer")) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return { text, x: rect.left + rect.width / 2, y: rect.top };
}

export function SelectionTools({
  cwd,
  sessionPath,
}: {
  cwd: string;
  /** Recorded on the card so opening it can reopen this session. */
  sessionPath?: string;
}) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const [done, setDone] = useState<"copy" | "board" | null>(null);

  useEffect(() => {
    // Read after the browser has settled the selection, so a drag that ends on
    // mouseup reports its final range rather than the one under the cursor.
    const settle = () => window.setTimeout(() => setSpot(chatSelection()), 0);
    // A mousedown on the toolbar itself must not dismiss it — that would
    // unmount the button before its own click could land.
    const onDown = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".selection-tools"))
        return;
      setSpot(null);
    };
    document.addEventListener("mouseup", settle);
    document.addEventListener("keyup", settle);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onDown, true);
    return () => {
      document.removeEventListener("mouseup", settle);
      document.removeEventListener("keyup", settle);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onDown, true);
    };
  }, []);

  useEffect(() => setDone(null), [spot?.text]);

  if (!spot) return null;

  const flash = (kind: "copy" | "board") => {
    setDone(kind);
    window.setTimeout(() => setSpot(null), 700);
  };

  return (
    <div
      className="selection-tools"
      style={{ left: spot.x, top: spot.y }}
      role="toolbar"
      aria-label="Selection actions"
      // Keep the selection alive: a mousedown here would otherwise clear it.
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        title="Copy selection"
        aria-label="Copy selection"
        onClick={() => void copyText(spot.text).then(() => flash("copy"))}
      >
        {done === "copy" ? <IconCheck size={13} /> : <IconCopy size={13} />}
        <span>{done === "copy" ? "Copied" : "Copy"}</span>
      </button>
      <span className="selection-tools__rule" aria-hidden />
      <button
        type="button"
        title="Send selection to the board's To-do lane"
        aria-label="Add selection to board"
        onClick={() => {
          // The excerpt is the card's description; the title is named for it.
          const id = crypto.randomUUID();
          const text = spot.text;
          pushCard(cwd, leadLine(text), "backlog", {
            id,
            sessionPath,
            note: text.slice(0, CARD_NOTE_MAX),
          });
          flash("board");
          // Best-effort rename a beat later: the card is already on the board,
          // so a slow, failed, or absent model costs nothing but the fallback.
          void api
            .cardTitle(text)
            .then((result) => {
              if (result.ok && result.title)
                patchCard(cwd, id, { title: result.title });
            })
            .catch(() => {
              /* the fallback title stands */
            });
        }}
      >
        {done === "board" ? <IconCheck size={13} /> : <IconColumns size={13} />}
        <span>{done === "board" ? "Added" : "Board"}</span>
      </button>
    </div>
  );
}
