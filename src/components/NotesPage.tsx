import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { IconPencil, IconTrash } from "./icons";
import {
  continueList,
  imageIds,
  indentAt,
  joinSegments,
  notePreview,
  noteTitle,
  parseSegments,
  startCodeBlock,
  type Note,
  type StoredImage,
} from "../lib/notes";

const NOTES_KEY = "devden.notes";
const IMAGES_KEY = "devden.notes.images";

function loadNotes(): Note[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTES_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (note) =>
            typeof note?.id === "string" &&
            typeof note?.body === "string" &&
            typeof note?.updatedAt === "number",
        )
      : [];
  } catch {
    return [];
  }
}

function loadImages(): Record<string, StoredImage> {
  try {
    const parsed = JSON.parse(localStorage.getItem(IMAGES_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Dropped images become data URLs kept in a separate localStorage key so a
 * keystroke never re-serializes them. Big files are downscaled through a
 * canvas — localStorage has a ~5MB quota and a phone photo would eat it in
 * one drop.
 * ponytail: browser-local storage caps notes at roughly a dozen photos;
 * upgrade path is a server upload endpoint plus a URL in the marker.
 */
async function fileToStoredImage(file: File): Promise<StoredImage> {
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  if (file.size < 200_000) return { name: file.name, data: raw };
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return { name: file.name, data: canvas.toDataURL("image/jpeg", 0.82) };
}

const PLACEHOLDER =
  "Write a note…\nType “1. ” then Enter for lists · Tab indents · ``` then Enter makes a code block · drop images to attach them.";

export function NotesPage() {
  const [notes, setNotes] = useState<Note[]>(() =>
    [...loadNotes()].sort((a, b) => b.updatedAt - a.updatedAt),
  );
  const [images, setImages] = useState<Record<string, StoredImage>>(loadImages);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  // Focus a segment textarea at a caret after React commits the new body.
  const [pendingFocus, setPendingFocus] = useState<{
    seg: number;
    caret: number;
  } | null>(null);
  const segRefs = useRef<Array<HTMLTextAreaElement | null>>([]);

  useEffect(() => {
    try {
      localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
      // Prune image entries no note refers to anymore (a deleted marker
      // line frees its ~200KB entry).
      const referenced = new Set(notes.flatMap((note) => imageIds(note.body)));
      setImages((current) => {
        const next = Object.fromEntries(
          Object.entries(current).filter(([id]) => referenced.has(id)),
        );
        localStorage.setItem(IMAGES_KEY, JSON.stringify(next));
        return Object.keys(next).length === Object.keys(current).length
          ? current
          : next;
      });
    } catch (error) {
      // Quota exceeded must not crash the app — the note stays in state.
      console.warn("notes: could not persist", error);
    }
  }, [notes]);

  useEffect(() => {
    if (!pendingFocus) return;
    const el = segRefs.current[pendingFocus.seg];
    el?.focus();
    el?.setSelectionRange(pendingFocus.caret, pendingFocus.caret);
    setPendingFocus(null);
  }, [pendingFocus]);

  useEffect(() => {
    if (!activeId) return;
    const el = segRefs.current[0];
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [activeId]);

  const active = notes.find((note) => note.id === activeId) ?? null;
  const segments = useMemo(
    () => parseSegments(active?.body ?? ""),
    [active?.body],
  );

  const createNote = () => {
    const note: Note = {
      id: crypto.randomUUID(),
      body: "",
      updatedAt: Date.now(),
    };
    setNotes((current) => [note, ...current]);
    setActiveId(note.id);
  };

  const updateNote = (id: string, body: string) => {
    setNotes((current) =>
      [...current]
        .map((note) =>
          note.id === id ? { ...note, body, updatedAt: Date.now() } : note,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    );
  };

  const updateSegment = (index: number, text: string) => {
    if (!active) return;
    updateNote(
      active.id,
      joinSegments(
        segments.map((segment, i) =>
          i === index ? { ...segment, text } : segment,
        ),
      ),
    );
  };

  const deleteNote = (id: string) => {
    setNotes((current) => current.filter((note) => note.id !== id));
    if (activeId === id) setActiveId(null);
  };

  // Remove a code block: the surrounding text segments merge back together.
  const removeBlock = (index: number) => {
    if (!active) return;
    updateNote(active.id, joinSegments(segments.filter((_, i) => i !== index)));
    setPendingFocus({
      seg: Math.max(0, index - 1),
      caret: segments[index - 1]?.text.length ?? 0,
    });
  };

  const applyEdit = (
    index: number,
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
    next: { text: string; caret: number } | null,
    target?: { seg: number; caret: number },
  ) => {
    if (!next) return false;
    event.preventDefault();
    updateSegment(index, next.text);
    setPendingFocus(target ?? { seg: index, caret: next.caret });
    return true;
  };

  const onKeyDown =
    (index: number, isCode: boolean) =>
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      const { selectionStart, selectionEnd, value } = event.currentTarget;
      // Backspace on an empty block removes the block itself and hands
      // the cursor back to the text before it.
      if (isCode && event.key === "Backspace" && value === "") {
        event.preventDefault();
        removeBlock(index);
        return;
      }
      if (event.key === "Tab" && !event.shiftKey) {
        applyEdit(index, event, indentAt(value, selectionStart, selectionEnd));
        return;
      }
      if (isCode || event.key !== "Enter" || event.shiftKey) return;
      // A bare ``` line + Enter becomes a block rectangle; blockAt says
      // where the new code segment lands, and the cursor goes inside it.
      const block = startCodeBlock(value, selectionStart, selectionEnd);
      if (
        block &&
        applyEdit(index, event, block, {
          seg: index + block.blockAt,
          caret: 0,
        })
      )
        return;
      applyEdit(
        index,
        event,
        continueList(value, selectionStart, selectionEnd),
      );
    };

  // Drop images: each becomes an entry in the image store plus a
  // ![name](image:id) marker line at the drop position in that segment.
  const onDrop = async (
    index: number,
    event: ReactDragEvent<HTMLTextAreaElement>,
  ) => {
    const files = [...event.dataTransfer.files].filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length === 0 || !active) return;
    event.preventDefault();
    let pos = event.currentTarget.selectionStart ?? 0;
    let text = segments[index]!.text;
    const added: Array<[string, StoredImage]> = [];
    for (const file of files) {
      const stored = await fileToStoredImage(file);
      const id = crypto.randomUUID();
      added.push([id, stored]);
      const marker = `![${file.name}](image:${id})`;
      if (pos > 0 && text[pos - 1] !== "\n") {
        text = text.slice(0, pos) + "\n" + text.slice(pos);
        pos += 1;
      }
      text = text.slice(0, pos) + marker + "\n" + text.slice(pos);
      pos += marker.length + 1;
    }
    setImages((current) => {
      const next = { ...current, ...Object.fromEntries(added) };
      localStorage.setItem(IMAGES_KEY, JSON.stringify(next));
      return next;
    });
    updateSegment(index, text);
    setPendingFocus({ seg: index, caret: pos });
  };

  // Images of the open note, in body order.
  const activeImages = useMemo(
    () =>
      active
        ? imageIds(active.body).flatMap((id) =>
            images[id] ? [{ id, ...images[id]! }] : [],
          )
        : [],
    [active, images],
  );

  if (active) {
    return (
      <div className="notes-page resource-page">
        <header className="resource-page__header">
          <div>
            <h1>{noteTitle(active)}</h1>
            <p>{new Date(active.updatedAt).toLocaleString()}</p>
          </div>
          <div className="notes-header-actions">
            <button
              type="button"
              className="resource-page__refresh"
              onClick={() => deleteNote(active.id)}
              title="Delete note"
            >
              <IconTrash size={14} /> Delete
            </button>
            <button
              type="button"
              className="resource-page__refresh"
              onClick={() => setActiveId(null)}
            >
              All notes
            </button>
          </div>
        </header>
        <div className="notes-blocks">
          {segments.map((segment, index) =>
            segment.kind === "code" ? (
              <div className="notes-code" key={index}>
                <button
                  type="button"
                  className="notes-code__remove"
                  aria-label="Remove block"
                  title="Remove block"
                  onClick={() => removeBlock(index)}
                >
                  ×
                </button>
                <textarea
                  ref={(el) => {
                    segRefs.current[index] = el;
                  }}
                  value={segment.text}
                  rows={Math.max(1, segment.text.split("\n").length)}
                  wrap="off"
                  spellCheck={false}
                  aria-label={`Block${segment.lang ? ` (${segment.lang})` : ""}`}
                  onChange={(event) => updateSegment(index, event.target.value)}
                  onKeyDown={onKeyDown(index, true)}
                  onDrop={(event) => void onDrop(index, event)}
                />
              </div>
            ) : (
              <textarea
                key={index}
                ref={(el) => {
                  segRefs.current[index] = el;
                }}
                className="notes-text"
                value={segment.text}
                rows={Math.max(1, segment.text.split("\n").length)}
                placeholder={
                  index === 0 && segments.length === 1 ? PLACEHOLDER : undefined
                }
                aria-label="Note body"
                onChange={(event) => updateSegment(index, event.target.value)}
                onKeyDown={onKeyDown(index, false)}
                onDrop={(event) => void onDrop(index, event)}
              />
            ),
          )}
        </div>
        {activeImages.length > 0 && (
          <div className="notes-images" aria-label="Note images">
            {activeImages.map((image) => (
              <button
                type="button"
                key={image.id}
                className="notes-image"
                onClick={() => setViewing(image.id)}
                aria-label={`View ${image.name}`}
              >
                <img src={image.data} alt={image.name} />
              </button>
            ))}
          </div>
        )}
        {viewing && images[viewing] && (
          <div
            className="notes-image-viewer"
            role="dialog"
            aria-label={images[viewing]!.name}
            onClick={() => setViewing(null)}
          >
            <img src={images[viewing]!.data} alt={images[viewing]!.name} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="notes-page resource-page">
      <header className="resource-page__header">
        <div>
          <h1>Notes</h1>
          <p>Quick thoughts, saved in this browser.</p>
        </div>
        <button
          type="button"
          className="resource-page__refresh"
          onClick={createNote}
          title="New note"
        >
          <IconPencil size={14} /> New note
        </button>
      </header>
      <div className="resource-page__content">
        {notes.length === 0 ? (
          <div className="resource-page__empty">
            No notes yet. Tap the pen to write one.
          </div>
        ) : (
          <div className="resource-grid">
            {notes.map((note) => (
              <article
                key={note.id}
                className="resource-card notes-card"
                role="button"
                tabIndex={0}
                onClick={() => setActiveId(note.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ")
                    setActiveId(note.id);
                }}
              >
                <div className="resource-card__body">
                  <div className="resource-card__title">
                    <strong>{noteTitle(note)}</strong>
                    <button
                      type="button"
                      className="notes-card-delete"
                      aria-label={`Delete ${noteTitle(note)}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteNote(note.id);
                      }}
                    >
                      <IconTrash size={13} />
                    </button>
                  </div>
                  <p>{notePreview(note)}</p>
                  <code>{new Date(note.updatedAt).toLocaleDateString()}</code>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
