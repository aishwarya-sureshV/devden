import { useEffect, useRef, useState } from "react";
import {
  addCard,
  BOARD_COLUMNS,
  BOARD_EVENT,
  columnCards,
  dropShot,
  loadBoard,
  loadShot,
  moveCard,
  PRIORITIES,
  removeCard,
  saveBoard,
  saveShot,
  shrinkImage,
  updateCard,
  type BoardCard,
  type BoardColumn,
  type BoardPriority,
} from "../lib/board";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { IconChat, IconCode, IconPlus, IconTrash, IconUpload } from "./icons";

type DropTarget = { column: BoardColumn; beforeId?: string };

/**
 * Per-workspace kanban. Mount with `key={cwd}` — the card list is seeded from
 * localStorage once, so a workspace switch has to remount rather than reload
 * into a component that would immediately save the old board over the new one.
 */
export function BoardPanel({
  cwd,
  sessionPath,
  onClose,
}: {
  cwd: string;
  /** Session showing in the pane behind the board, stamped onto cards that
   *  reach Done without one, so the card can reopen where it was finished. */
  sessionPath?: string;
  onClose: () => void;
}) {
  const { resumeSessions, resumeConversation, openConversation, seedTask } =
    useStore();
  const [dispatching, setDispatching] = useState<string | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [cards, setCards] = useState<BoardCard[]>(() => loadBoard(cwd));
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<BoardColumn, string>>>(
    {},
  );
  const [shot, setShot] = useState<string | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const refocus = useRef<string | null>(null);

  const opened = cards.find((card) => card.id === openId) ?? null;

  useEffect(() => saveBoard(cwd, cards), [cwd, cards]);

  // The shot is the one part of a card that does not live in `cards` — it is
  // too big to carry in the list, so it is fetched when a card is opened.
  useEffect(() => {
    setShotError(null);
    setShot(openId ? loadShot(openId) : null);
  }, [openId]);

  useEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)?.focus();
  });

  // Cards pushed from the selection toolbar land in localStorage, not in this
  // component's state — reload when one arrives for this workspace.
  useEffect(() => {
    const onExternal = (event: Event) => {
      const detail = (event as CustomEvent<{ cwd: string }>).detail;
      if (!detail || detail.cwd === cwd) setCards(loadBoard(cwd));
    };
    window.addEventListener(BOARD_EVENT, onExternal);
    return () => window.removeEventListener(BOARD_EVENT, onExternal);
  }, [cwd]);

  /**
   * Every move goes through here, drag and keyboard alike: a card landing in
   * Done with no session of its own adopts the one on screen, which is the
   * session it was just finished in.
   */
  const place = (id: string, column: BoardColumn, beforeId?: string) =>
    setCards((current) => {
      const next = moveCard(current, id, column, beforeId);
      if (next === current || column !== "done" || !sessionPath) return next;
      const moved = next.find((card) => card.id === id);
      return moved && !moved.sessionPath
        ? updateCard(next, id, { sessionPath })
        : next;
    });

  /**
   * Hand a card to its own agent in its own checkout. Several cards dispatched
   * this way run at once without seeing each other's files, and each leaves a
   * branch to review instead of a shared dirty tree.
   */
  const dispatch = async (card: BoardCard) => {
    if (dispatching) return;
    setDispatching(card.id);
    setDispatchError(null);
    try {
      // Any session key will do for the call; the server keys worktrees off
      // the repo, not the caller.
      const made = await api.createWorktree("board", cwd, card.title);
      if (!made.ok || !made.data) {
        setDispatchError(made.error ?? "Could not create a worktree.");
        return;
      }
      const key = openConversation(made.data.path, card.title);
      seedTask(key, {
        prompt: card.note ? `${card.title}\n\n${card.note}` : card.title,
      });
      // Write the lane change straight through: closing the board unmounts
      // it in the same tick, so the save-on-change effect would never run.
      const next = moveCard(cards, card.id, "doing");
      setCards(next);
      saveBoard(cwd, next);
      onClose();
    } finally {
      setDispatching(null);
    }
  };

  const drop = (target: DropTarget) => {
    if (dragId && dragId !== target.beforeId)
      place(dragId, target.column, target.beforeId);
    setDragId(null);
    setOver(null);
  };

  /** Keyboard equivalent of a drag: the board is not mouse-only. */
  const nudge = (card: BoardCard, delta: number) => {
    const at = BOARD_COLUMNS.findIndex((column) => column.id === card.column);
    const next = BOARD_COLUMNS[at + delta];
    if (!next) return;
    // The card is re-created in the new lane, so the focused element is gone
    // by the next paint — without this, only the first arrow press lands.
    refocus.current = card.id;
    place(card.id, next.id);
  };

  const commitDraft = (column: BoardColumn) => {
    const title = drafts[column] || "";
    if (title.trim()) setCards((current) => addCard(current, title, column));
    setDrafts((current) => ({ ...current, [column]: "" }));
  };

  const discard = (card: BoardCard) => {
    dropShot(card.id);
    setCards((current) => removeCard(current, card.id));
    if (openId === card.id) setOpenId(null);
  };

  const attach = async (file: File | null | undefined) => {
    if (!file || !opened) return;
    if (!file.type.startsWith("image/")) {
      setShotError("That is not an image.");
      return;
    }
    try {
      const url = await shrinkImage(file);
      if (!saveShot(opened.id, url)) {
        setShotError("Too large to store — the board is out of room.");
        return;
      }
      setShot(url);
      setShotError(null);
      setCards((current) => updateCard(current, opened.id, { shot: true }));
    } catch {
      setShotError("Could not read that image.");
    }
  };

  const detachShot = () => {
    if (!opened) return;
    dropShot(opened.id);
    setShot(null);
    setCards((current) => updateCard(current, opened.id, { shot: false }));
  };

  // Resolved live: a session can be archived or deleted after a card points at
  // it, and an opened card should say so rather than offer a dead button.
  const openedSession = opened?.sessionPath
    ? resumeSessions.find((session) => session.path === opened.sessionPath)
    : undefined;

  return (
    <aside className="board-pane" aria-label="Board">
      <header className="board-pane__head">
        {opened ? (
          <button
            type="button"
            className="board-pane__back"
            onClick={() => setOpenId(null)}
          >
            ← board
          </button>
        ) : null}
        <div className="board-pane__identity">
          <strong>{opened ? "card" : "board"}</strong>
          <span>
            {opened
              ? BOARD_COLUMNS.find((column) => column.id === opened.column)
                  ?.label
              : `${cards.length} ${cards.length === 1 ? "card" : "cards"} · this workspace`}
          </span>
        </div>
        <button
          type="button"
          className="board-pane__close"
          aria-label="Close board"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      {opened ? (
        <div
          className="board-detail"
          onPaste={(event) => {
            const file = event.clipboardData.files[0];
            if (!file) return;
            event.preventDefault();
            void attach(file);
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files"))
              event.preventDefault();
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            void attach(event.dataTransfer.files[0]);
          }}
        >
          <input
            className="board-detail__title"
            aria-label="Card title"
            defaultValue={opened.title}
            key={`${opened.id}:title`}
            onBlur={(event) =>
              setCards((current) =>
                event.target.value.trim()
                  ? updateCard(current, opened.id, {
                      title: event.target.value.trim(),
                    })
                  : current,
              )
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />

          <textarea
            className="board-detail__note"
            aria-label="Description"
            placeholder="Description — what this is, how to reproduce it, what done looks like."
            defaultValue={opened.note || ""}
            key={`${opened.id}:note`}
            onBlur={(event) =>
              setCards((current) =>
                updateCard(current, opened.id, { note: event.target.value }),
              )
            }
          />

          <section className="board-detail__shot" aria-label="Screenshot">
            {shot ? (
              <figure>
                <img src={shot} alt="Screenshot attached to this card" />
                <figcaption>
                  <button type="button" onClick={detachShot}>
                    <IconTrash size={12} />
                    <span>Remove screenshot</span>
                  </button>
                </figcaption>
              </figure>
            ) : (
              <button
                type="button"
                className="board-detail__drop"
                onClick={() => fileRef.current?.click()}
              >
                <IconUpload size={14} />
                <span>Attach a screenshot</span>
                <small>paste, drop, or click to browse</small>
              </button>
            )}
            {shotError || dispatchError ? (
              <p className="board-detail__error" role="status">
                {shotError ?? dispatchError}
              </p>
            ) : null}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                void attach(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </section>

          <footer className="board-detail__foot">
            {openedSession ? (
              <button
                type="button"
                className="board-detail__open"
                onClick={() => {
                  resumeConversation(openedSession);
                  onClose();
                }}
              >
                <IconChat size={13} />
                <span>Open {openedSession.name}</span>
              </button>
            ) : opened.sessionPath ? (
              <span className="board-detail__gone">
                its session is no longer on disk
              </span>
            ) : (
              <span className="board-detail__gone">
                no session attached — cards made from a selection carry theirs
              </span>
            )}
            <span className="board-detail__spacer" />
            {opened.column !== "done" && (
              <button
                type="button"
                className="board-detail__open"
                disabled={dispatching !== null}
                title="Run this card in its own checkout, on its own branch"
                onClick={() => void dispatch(opened)}
              >
                <IconCode size={13} />
                <span>
                  {dispatching === opened.id
                    ? "Preparing…"
                    : "Run in a worktree"}
                </span>
              </button>
            )}
            <button
              type="button"
              className="board-detail__delete"
              onClick={() => discard(opened)}
            >
              <IconTrash size={13} />
              <span>Delete card</span>
            </button>
          </footer>
        </div>
      ) : (
        <>
          <div className="board-pane__columns">
            {BOARD_COLUMNS.map((column) => {
              const list = columnCards(cards, column.id);
              const appending = over?.column === column.id && !over.beforeId;
              return (
                <section
                  key={column.id}
                  className={`board-col${appending ? " is-over" : ""}`}
                  aria-label={column.label}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setOver({ column: column.id });
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    drop({ column: column.id });
                  }}
                >
                  <div className="board-col__head">
                    <span
                      className="board-col__dot"
                      style={{ background: column.tone }}
                      aria-hidden
                    />
                    <span className="board-col__name">{column.label}</span>
                    <span className="board-col__count">{list.length}</span>
                  </div>

                  <div className="board-col__list">
                    {list.map((card) => (
                      <article
                        key={card.id}
                        data-card-id={card.id}
                        className={`board-card${dragId === card.id ? " is-dragging" : ""}${
                          over?.beforeId === card.id ? " is-before" : ""
                        }`}
                        draggable
                        tabIndex={0}
                        onClick={() => setOpenId(card.id)}
                        onDragStart={(event) => {
                          // The priority control is inside the draggable card:
                          // opening it must not start a drag.
                          if (
                            event.target instanceof Element &&
                            event.target.closest("select")
                          ) {
                            event.preventDefault();
                            return;
                          }
                          event.dataTransfer.setData("text/plain", card.id);
                          event.dataTransfer.effectAllowed = "move";
                          setDragId(card.id);
                        }}
                        onDragEnd={() => {
                          setDragId(null);
                          setOver(null);
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setOver({ column: column.id, beforeId: card.id });
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          drop({ column: column.id, beforeId: card.id });
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowRight") nudge(card, 1);
                          else if (event.key === "ArrowLeft") nudge(card, -1);
                          else if (event.key === "Enter") setOpenId(card.id);
                          else return;
                          event.preventDefault();
                        }}
                      >
                        <span className="board-card__title">{card.title}</span>
                        {column.id === "backlog" ||
                        card.note ||
                        card.shot ||
                        card.sessionPath ? (
                          <span className="board-card__marks">
                            {column.id === "backlog" ? (
                              <select
                                className={`board-card__priority is-${card.priority ?? "normal"}`}
                                aria-label={`Priority for ${card.title}`}
                                value={card.priority ?? "normal"}
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => event.stopPropagation()}
                                onChange={(event) =>
                                  setCards((current) =>
                                    updateCard(current, card.id, {
                                      priority: event.target
                                        .value as BoardPriority,
                                    }),
                                  )
                                }
                              >
                                {PRIORITIES.map((level) => (
                                  <option key={level} value={level}>
                                    {level}
                                  </option>
                                ))}
                              </select>
                            ) : null}
                            {card.note ? <span>note</span> : null}
                            {card.shot ? <span>shot</span> : null}
                            {card.sessionPath ? <span>session</span> : null}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className="board-card__drop"
                          aria-label={`Delete ${card.title}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            discard(card);
                          }}
                        >
                          <IconTrash size={13} />
                        </button>
                      </article>
                    ))}

                    {list.length === 0 ? (
                      <div className="board-col__empty">
                        <span>{column.emptyTitle}</span>
                        <small>{column.emptyNote}</small>
                      </div>
                    ) : null}
                  </div>

                  <label className="board-col__add">
                    <IconPlus size={13} />
                    <input
                      value={drafts[column.id] || ""}
                      placeholder="Add card"
                      aria-label={`Add card to ${column.label}`}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [column.id]: event.target.value,
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitDraft(column.id);
                      }}
                      onBlur={() => commitDraft(column.id)}
                    />
                  </label>
                </section>
              );
            })}
          </div>

          <footer className="board-pane__foot">
            <span>
              <kbd>drag</kbd> move card
            </span>
            <span className="board-pane__rule" aria-hidden />
            <span>
              <kbd>⏎</kbd> open card
            </span>
            <span className="board-pane__rule" aria-hidden />
            <span>
              <kbd>←→</kbd> change lane
            </span>
          </footer>
        </>
      )}
    </aside>
  );
}
