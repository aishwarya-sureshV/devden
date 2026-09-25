import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  api,
  backendLabel,
  type AgentBackend,
  type DirectoryListingResponse,
} from "../lib/api";
import { useStore } from "../lib/store";
import { IconChevronDown, IconCode, IconFolder } from "./icons";

export type WorkspacePickerHandle = { openBrowser: () => void };

const RECENT_WORKSPACES_KEY = "pi-web.workspaces.v1";

function folderLabel(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function storedWorkspaces(): string[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(RECENT_WORKSPACES_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter((path): path is string => typeof path === "string")
      : [];
  } catch {
    return [];
  }
}

export const WorkspacePicker = forwardRef<
  WorkspacePickerHandle,
  {
    cwd: string;
    backend?: AgentBackend;
    disabled: boolean;
    onPick: (path: string) => Promise<void>;
    onViewWorkspace?: () => void;
    /** Cut an isolated checkout of `cwd` and move this session into it. The
     *  server refuses outside a git repo, which surfaces as a notice. */
    onIsolate?: () => Promise<void>;
    hideTrigger?: boolean;
    variant?: "default" | "chip";
  }
>(function WorkspacePicker(
  {
    cwd,
    backend = "pi",
    disabled,
    onPick,
    onViewWorkspace,
    onIsolate,
    hideTrigger = false,
    variant = "default",
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [listing, setListing] = useState<DirectoryListingResponse | null>(null);
  const [pathDraft, setPathDraft] = useState(cwd);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  // The menu flips above the trigger when the viewport is too short below it,
  // and its height is clamped to the space on the chosen side so it always
  // scrolls instead of clipping off-screen.
  const [dropUp, setDropUp] = useState(false);
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | undefined>(
    undefined,
  );
  const [picked, setPicked] = useState(() =>
    [cwd, ...storedWorkspaces().filter((path) => path !== cwd)].slice(0, 10),
  );
  // Projects the workbench already knows about (open tabs + the cwd of every
  // saved session, every agent). Without these the menu only listed folders
  // that had been picked through this very dialog on this browser, so a
  // project you started working in yesterday was simply missing.
  const { knownWorkspaces } = useStore();
  const recent = useMemo(
    () =>
      [...new Set([cwd, ...picked, ...knownWorkspaces])]
        .filter(Boolean)
        .slice(0, 20),
    [cwd, knownWorkspaces, picked],
  );
  // Show the full path only under entries whose folder name is ambiguous
  // (two different "agentdeck" folders), like the VS Code open-recent menu.
  const duplicateLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const path of recent) {
      const label = folderLabel(path);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
  }, [recent]);

  const remember = (path: string) => {
    setPicked((current) => {
      if (current[0] === path) return current;
      const next = [
        path,
        ...current.filter((candidate) => candidate !== path),
      ].slice(0, 10);
      localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    remember(cwd);
  }, [cwd]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!browserOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setBrowserOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [browserOpen]);

  const navigate = async (path?: string) => {
    setLoading(true);
    const result = await api.directories(path);
    setLoading(false);
    setListing(result);
    if (result.ok && result.path) setPathDraft(result.path);
  };

  const choose = async (path: string) => {
    if (path === cwd) {
      setOpen(false);
      setBrowserOpen(false);
      return;
    }
    remember(path);
    setOpen(false);
    setBrowserOpen(false);
    await onPick(path);
  };

  const visibleEntries = useMemo(
    () =>
      (listing?.entries ?? []).filter((entry) => showHidden || !entry.hidden),
    [listing?.entries, showHidden],
  );

  const openBrowser = () => {
    setOpen(false);
    setBrowserOpen(true);
    setPathDraft(cwd);
    void navigate(cwd);
  };

  const toggleMenu = () => {
    if (!open) {
      const rect = rootRef.current?.getBoundingClientRect();
      const below = rect ? window.innerHeight - rect.bottom : 400;
      const above = rect ? rect.top : 400;
      // ~340px fits the heading, a 240px recent list, and the footer.
      const up = below < 340 && above > below;
      setDropUp(up);
      setMenuMaxHeight(Math.max(180, (up ? above : below) - 12));
      // Prefetch the directory listing so "No folder" knows the home path.
      if (!listing) void navigate();
    }
    setOpen(!open);
  };

  useImperativeHandle(ref, () => ({ openBrowser }));

  return (
    <div
      className={`workspace-picker${variant === "chip" ? " workspace-picker--chip" : ""}`}
      ref={rootRef}
      hidden={hideTrigger && !browserOpen ? true : undefined}
    >
      <button
        type="button"
        className="workspace-picker__trigger"
        aria-label="Workspace"
        aria-expanded={open}
        disabled={disabled}
        title={cwd}
        onClick={toggleMenu}
      >
        <IconFolder size={variant === "chip" ? 12 : 15} />
        <span>{folderLabel(cwd)}</span>
        {variant !== "chip" && <IconChevronDown size={13} />}
      </button>

      {open && (
        <div
          className={`workspace-picker__menu${dropUp ? " is-upwards" : ""}`}
          role="menu"
          aria-label="Workspaces"
          style={{ maxHeight: menuMaxHeight }}
        >
          <button
            type="button"
            role="menuitem"
            className="workspace-picker__nofolder"
            disabled={!listing?.home}
            title="Work from your home directory instead of a project folder"
            onClick={() => {
              if (listing?.home) void choose(listing.home);
            }}
          >
            No folder
          </button>
          <div className="workspace-picker__recent">
            <div className="workspace-picker__heading">Recent</div>
            {recent.map((path) => (
              <button
                type="button"
                role="menuitem"
                key={path}
                title={path}
                onClick={() => void choose(path)}
              >
                <IconFolder size={16} />
                <span>
                  {folderLabel(path)}
                  {(duplicateLabels.get(folderLabel(path)) ?? 0) > 1 && (
                    <em>{path}</em>
                  )}
                </span>
                {path === cwd && (
                  <strong aria-label="Current workspace">✓</strong>
                )}
              </button>
            ))}
          </div>
          <div className="workspace-picker__footer">
            {onViewWorkspace && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onViewWorkspace();
                }}
              >
                <IconCode size={16} />
                <span>View workspace</span>
              </button>
            )}
            <button type="button" role="menuitem" onClick={openBrowser}>
              <IconFolder size={16} />
              <span>New folder…</span>
            </button>
            {onIsolate && (
              <button
                type="button"
                role="menuitem"
                title="Give this session its own checkout on its own branch, so other sessions cannot see or overwrite its files"
                onClick={() => {
                  setOpen(false);
                  void onIsolate();
                }}
              >
                <IconCode size={16} />
                <span>Isolate in a worktree…</span>
              </button>
            )}
          </div>
        </div>
      )}

      {browserOpen && (
        <div
          className="directory-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Choose a project directory"
        >
          <button
            type="button"
            className="directory-modal__backdrop"
            aria-label="Cancel directory selection"
            onClick={() => setBrowserOpen(false)}
          />
          <div className="directory-modal__panel">
            <div className="directory-modal__head">
              <div>
                <strong>Choose a project directory</strong>
                <span>
                  {backendLabel(backend)} will use this folder as its workspace.
                </span>
              </div>
              <button
                type="button"
                aria-label="Close directory picker"
                onClick={() => setBrowserOpen(false)}
              >
                ×
              </button>
            </div>
            <form
              className="directory-modal__path"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void navigate(pathDraft);
              }}
            >
              <button
                type="button"
                disabled={!listing?.home || loading}
                onClick={() => void navigate(listing?.home)}
              >
                Home
              </button>
              <button
                type="button"
                disabled={!listing?.parent || loading}
                onClick={() => void navigate(listing?.parent ?? undefined)}
              >
                Up
              </button>
              <input
                aria-label="Directory path"
                value={pathDraft}
                onChange={(event) => setPathDraft(event.target.value)}
              />
              <button type="submit" disabled={loading}>
                Go
              </button>
            </form>
            <div className="directory-modal__options">
              <span>{listing?.path ?? pathDraft}</span>
              <label>
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(event) => setShowHidden(event.target.checked)}
                />{" "}
                Show hidden
              </label>
            </div>
            <div className="directory-modal__list" aria-busy={loading}>
              {loading && (
                <div className="directory-modal__status">Loading folders…</div>
              )}
              {!loading && !listing?.ok && (
                <div className="directory-modal__error" role="alert">
                  {listing?.error ?? "Could not read this directory."}
                </div>
              )}
              {!loading && listing?.ok && visibleEntries.length === 0 && (
                <div className="directory-modal__status">No folders here.</div>
              )}
              {!loading &&
                listing?.ok &&
                visibleEntries.map((entry) => (
                  <button
                    type="button"
                    key={entry.path}
                    title={entry.path}
                    onClick={() => void navigate(entry.path)}
                  >
                    <IconFolder size={17} />
                    <span>{entry.name}</span>
                    <span aria-hidden="true">›</span>
                  </button>
                ))}
            </div>
            <div className="directory-modal__actions">
              <button type="button" onClick={() => setBrowserOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={!listing?.ok || loading || !listing.path}
                onClick={() => void choose(listing?.path ?? "")}
              >
                Use this folder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
