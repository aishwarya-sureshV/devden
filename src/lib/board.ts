/**
 * Kanban board state. One flat card array per workspace — array order is the
 * board order, `column` is the only grouping. Kept in localStorage next to the
 * notes board (same reasoning: no server round-trip for a per-person list).
 */

export type BoardColumn = "backlog" | "doing" | "review" | "done";

export type BoardPriority = "high" | "normal" | "low";

/** Sort order for the To-do lane. An unset priority reads as "normal". */
const PRIORITY_RANK: Record<BoardPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

export const PRIORITIES: BoardPriority[] = ["high", "normal", "low"];

export type BoardCard = {
  id: string;
  title: string;
  column: BoardColumn;
  /** Longer body, shown when the card is opened. */
  note?: string;
  /** Unset means "normal" — most cards never need to say so. */
  priority?: BoardPriority;
  /** True when a screenshot is stored under this card's own shot key. */
  shot?: boolean;
  /**
   * Session this card came from, or was finished in. Never rendered on the
   * card — it exists so an opened card can reopen the whole session.
   */
  sessionPath?: string;
};

export const BOARD_COLUMNS: {
  id: BoardColumn;
  label: string;
  /** Lane dot, so the four tracks read apart at a glance. */
  tone: string;
  emptyTitle: string;
  emptyNote: string;
}[] = [
  // Column ids are the persisted shape — only the label reads "To-do", so
  // boards saved before the rename keep working.
  {
    id: "backlog",
    label: "To-do",
    tone: "var(--pw-fg-4)",
    emptyTitle: "nothing queued",
    emptyNote: "Select text in a session and send it here, or type below.",
  },
  {
    id: "doing",
    label: "In progress",
    tone: "var(--pw-accent)",
    emptyTitle: "nothing started",
    emptyNote: "Drag a card across when you pick it up.",
  },
  {
    id: "review",
    label: "Review",
    tone: "var(--pw-teal)",
    emptyTitle: "nothing waiting",
    emptyNote: "Finished, but you have not read it yet.",
  },
  {
    id: "done",
    label: "Done",
    tone: "var(--pw-green)",
    emptyTitle: "nothing finished",
    emptyNote: "A card dropped here remembers the session it was done in.",
  },
];

const key = (cwd: string) => `devden:board:${cwd}`;

export function loadBoard(cwd: string): BoardCard[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key(cwd)) || "[]");
    return Array.isArray(parsed) ? (parsed as BoardCard[]) : [];
  } catch {
    return [];
  }
}

export function saveBoard(cwd: string, cards: BoardCard[]) {
  try {
    localStorage.setItem(key(cwd), JSON.stringify(cards));
  } catch (error) {
    console.warn("board: could not persist", error);
  }
}

/**
 * Move `id` into `column`, landing before `beforeId` when the drop targeted a
 * card and at the end of the column when it targeted empty space. Returns the
 * same array reference when the card is unknown so a stray drop is a no-op.
 */
export function moveCard(
  cards: BoardCard[],
  id: string,
  column: BoardColumn,
  beforeId?: string,
): BoardCard[] {
  const moving = cards.find((card) => card.id === id);
  if (!moving) return cards;
  const rest = cards.filter((card) => card.id !== id);
  const next = { ...moving, column };
  const before = beforeId
    ? rest.findIndex((card) => card.id === beforeId)
    : -1;
  if (before >= 0) {
    rest.splice(before, 0, next);
    return rest;
  }
  // Append: sit just after the column's current last card. -1 (empty column)
  // puts it at the array head, which is fine — it is the column's only card.
  let last = -1;
  rest.forEach((card, index) => {
    if (card.column === column) last = index;
  });
  rest.splice(last + 1, 0, next);
  return rest;
}

/** A selected paragraph makes an unreadable card — cap every entry point. */
export const CARD_TITLE_MAX = 140;

export function addCard(
  cards: BoardCard[],
  title: string,
  column: BoardColumn,
  extra: Partial<BoardCard> = {},
): BoardCard[] {
  const clean = title.trim().replace(/\s+/g, " ");
  if (!clean) return cards;
  const capped =
    clean.length > CARD_TITLE_MAX
      ? `${clean.slice(0, CARD_TITLE_MAX - 1).trimEnd()}…`
      : clean;
  const id = extra.id ?? crypto.randomUUID();
  return moveCard(
    [...cards, { ...extra, id, title: capped, column }],
    id,
    column,
  );
}

/** Patch one card by id. Unknown ids return the same array reference. */
export function updateCard(
  cards: BoardCard[],
  id: string,
  patch: Partial<Omit<BoardCard, "id">>,
): BoardCard[] {
  if (!cards.some((card) => card.id === id)) return cards;
  return cards.map((card) => (card.id === id ? { ...card, ...patch } : card));
}

export function renameCard(
  cards: BoardCard[],
  id: string,
  title: string,
): BoardCard[] {
  const clean = title.trim();
  if (!clean) return cards;
  return updateCard(cards, id, { title: clean });
}

export const removeCard = (cards: BoardCard[], id: string) =>
  cards.filter((card) => card.id !== id);

/**
 * Cards in one lane, in display order. To-do is sorted by priority; every
 * other lane keeps the order you dragged it into. The sort is display-only —
 * `cards` itself stays in board order, so a drop still lands where it was
 * aimed. It is stable, so within one priority the manual order survives, and
 * a drop across priorities is re-sorted rather than pinned, which is the
 * point of having the priority at all.
 */
export const columnCards = (cards: BoardCard[], column: BoardColumn) => {
  const list = cards.filter((card) => card.column === column);
  if (column !== "backlog") return list;
  return list.sort(
    (a, b) =>
      PRIORITY_RANK[a.priority ?? "normal"] -
      PRIORITY_RANK[b.priority ?? "normal"],
  );
};

/**
 * Screenshots live under one key per card rather than inside the board array:
 * a shot that blows the storage quota then fails on its own instead of taking
 * the whole card list down with it.
 *
 * ponytail: downscaled data URLs in localStorage. Good for a handful of
 * screenshots per workspace; move to IndexedDB if a board needs dozens.
 */
const shotKey = (id: string) => `devden:board:shot:${id}`;

export function loadShot(id: string): string | null {
  try {
    return localStorage.getItem(shotKey(id));
  } catch {
    return null;
  }
}

export function saveShot(id: string, dataUrl: string): boolean {
  try {
    localStorage.setItem(shotKey(id), dataUrl);
    return true;
  } catch (error) {
    console.warn("board: could not store screenshot", error);
    return false;
  }
}

export function dropShot(id: string) {
  try {
    localStorage.removeItem(shotKey(id));
  } catch {
    /* nothing to clean up */
  }
}

/** Longest edge of a stored screenshot, in px. Full-size shots do not fit. */
const SHOT_MAX_EDGE = 1400;

/** Downscale to a JPEG data URL, so a 4MB retina PNG lands around 150KB. */
export async function shrinkImage(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(
    1,
    SHOT_MAX_EDGE / Math.max(bitmap.width, bitmap.height),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.72);
}

/**
 * Fired when the board is changed by something other than the open panel, so
 * a mounted BoardPanel can reload instead of holding a stale list. The
 * `storage` event is no use here — it only fires in *other* tabs.
 */
export const BOARD_EVENT = "devden:board";

function announce(cwd: string) {
  window.dispatchEvent(new CustomEvent(BOARD_EVENT, { detail: { cwd } }));
}

/** Add a card without owning the board state — used by the selection toolbar. */
export function pushCard(
  cwd: string,
  title: string,
  column: BoardColumn = "backlog",
  extra: Partial<BoardCard> = {},
): BoardCard[] {
  const next = addCard(loadBoard(cwd), title, column, extra);
  saveBoard(cwd, next);
  announce(cwd);
  return next;
}

/**
 * Patch a card without owning the board state. Used to drop a generated title
 * onto a card that was already added — the card appears the moment it is sent,
 * and the model's title lands a second or two later.
 */
export function patchCard(
  cwd: string,
  id: string,
  patch: Partial<Omit<BoardCard, "id">>,
) {
  const current = loadBoard(cwd);
  const next = updateCard(current, id, patch);
  if (next === current) return;
  saveBoard(cwd, next);
  announce(cwd);
}

/** A card description holds the whole excerpt, but not an entire transcript. */
export const CARD_NOTE_MAX = 4000;

/**
 * Title for a card made from a selection, shown until the generated one lands
 * — and the permanent one when no model is available. First line, then first
 * sentence: a selection is usually one paragraph, so the line alone still
 * leaves a wrapped run-on. List markers are stripped so a card made from
 * "6. Fleet race…" is not titled "6.".
 */
export function leadLine(text: string): string {
  const first = text.trim().split("\n", 1)[0] ?? "";
  const stripped = first
    .replace(/^\s*(?:\d{1,3}[.)]|[-*\u2022])\s+/, "")
    .trim();
  if (!stripped) return text;
  if (stripped.length <= 60) return stripped;
  return stripped.match(/^.{20,80}?[.!?](?=\s|$)/)?.[0] ?? stripped;
}
