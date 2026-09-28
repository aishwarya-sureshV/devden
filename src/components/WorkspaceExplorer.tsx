import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  api,
  type GitChange,
  type WorkspaceEntry,
  type WorkspaceFileResponse,
} from "../lib/api";
import { highlightCode } from "../lib/highlight";
import { langFromPath } from "../lib/toolCards";
import type { EditorNavigation } from "./CodeEditor";
import {
  EditorPalette,
  type PaletteMode,
  type PaletteResult,
} from "./EditorPalette";
import { CopyButton } from "./CopyButton";
import { RichText } from "./RichText";
import {
  IconCode,
  IconExpand,
  IconFile,
  IconFolder,
  IconPanel,
  IconRefresh,
  IconSearch,
} from "./icons";

export type WorkspacePlacement = "side" | "full";

// CodeMirror is the heaviest thing this app can load, and most sessions never
// open a file. Keep it out of the entry chunk.
const CodeEditor = lazy(() =>
  import("./CodeEditor").then((module) => ({ default: module.CodeEditor })),
);

/** Folder tints from the workbench design; unlisted folders hash into FOLDER_PALETTE. */
const FOLDER_COLORS: Record<string, string> = {
  ".claude": "var(--ic-orange)",
  commands: "var(--ic-blue)",
  prompts: "var(--ic-purple)",
  bin: "#ff7a8a",
  dist: "#9aa4b8",
  electron: "#5fd49a",
  node_modules: "#7a7884",
  packaging: "#c3a6ff",
  public: "#6aa8ff",
  scripts: "#f0c84a",
  docs: "var(--ic-blue)",
  server: "#ff9f6a",
  src: "#4fd1c5",
  components: "#6ad4e0",
  lib: "#e8b84a",
  styles: "var(--ic-purple)",
  test: "var(--ic-teal)",
  tests: "var(--ic-teal)",
};

const FOLDER_PALETTE = [
  "#ff7a8a", "#ff9f6a", "#f0c84a", "#86e6b0", "#5fd49a", "#4fd1c5",
  "#6ad4e0", "#6aa8ff", "#9cc4ff", "#c3a6ff", "#ff9cc4", "#e8b84a",
];

/** Stable per-name color: the same folder is always the same tint. */
function folderColor(name: string): string {
  const known = FOLDER_COLORS[name];
  if (known) return known;
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return FOLDER_PALETTE[Math.abs(hash) % FOLDER_PALETTE.length];
}

function FolderGlyph({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
      <path
        d="M1.5 4.2A1.4 1.4 0 0 1 2.9 2.8h3.2l1.6 1.5h5.4a1.4 1.4 0 0 1 1.4 1.4v6.6a1.4 1.4 0 0 1-1.4 1.4H2.9a1.4 1.4 0 0 1-1.4-1.4z"
        fill={color}
        fillOpacity="0.28"
        stroke={color}
        strokeWidth="1.1"
      />
    </svg>
  );
}

// Glyph + color per extension. \uFE0E forces text (not emoji) presentation.
const EXT_BADGE: Record<string, [string, string]> = {
  js: ["JS", "#f0db4f"], mjs: ["JS", "#f0db4f"], cjs: ["JS", "#f0db4f"],
  json: ["{}", "#f5c77e"], jsonc: ["{}", "#f5c77e"],
  yaml: ["≡", "#ff9f6a"], yml: ["≡", "#ff9f6a"], toml: ["≡", "#ff9f6a"],
  md: ["M↓", "#9cc4ff"], mdx: ["M↓", "#9cc4ff"], txt: ["≣", "#a6a4b1"],
  css: ["#", "#c3a6ff"], scss: ["#", "#c3a6ff"], less: ["#", "#c3a6ff"],
  html: ["<>", "#ff8a65"], xml: ["<>", "#ff8a65"], vue: ["V", "#5fd49a"],
  py: ["Py", "#6aa8ff"], rb: ["Rb", "#ff7a8a"], go: ["Go", "#6ad4e0"],
  rs: ["Rs", "#ff9f6a"], swift: ["Sw", "#ff8a50"], java: ["Jv", "#ff9f6a"],
  kt: ["Kt", "#c3a6ff"], c: ["C", "#9cc4ff"], h: ["H", "#9cc4ff"],
  cpp: ["C+", "#9cc4ff"], cs: ["C#", "#c3a6ff"], php: ["P", "#c3a6ff"],
  sh: ["$", "#86e6b0"], zsh: ["$", "#86e6b0"], bash: ["$", "#86e6b0"],
  sql: ["⛁\uFE0E", "#f5c77e"], db: ["⛁\uFE0E", "#f5c77e"],
  png: ["▣", "#ff9cc4"], jpg: ["▣", "#ff9cc4"], jpeg: ["▣", "#ff9cc4"],
  gif: ["▣", "#ff9cc4"], webp: ["▣", "#ff9cc4"], ico: ["▣", "#ff9cc4"],
  svg: ["◇", "#ffb86a"], pdf: ["▤", "#ff7a8a"],
  mp4: ["▶\uFE0E", "#ff9cc4"], mov: ["▶\uFE0E", "#ff9cc4"], mp3: ["♪", "#ff9cc4"],
  zip: ["▦", "#a6a4b1"], gz: ["▦", "#a6a4b1"], lock: ["⊟", "#7a7884"],
  log: ["≣", "#7a7884"], env: ["⚙\uFE0E", "#86e6b0"],
};

/** Colored file marks from the redesign; `.ts` rules match the mock exactly. */
function fileBadge(name: string): { glyph: string; bg: string; fg: string } {
  const mk = (glyph: string, fg: string) => ({
    glyph,
    fg,
    bg: `color-mix(in srgb, ${fg} 18%, transparent)`,
  });
  const lower = name.toLowerCase();
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)) return mk("⚗\uFE0E", "#d4c2ff");
  if (/\.[jt]sx$/.test(lower)) return mk("⚛\uFE0E", "#8fe6ef");
  if (lower === "package-lock.json" || lower.endsWith(".lock")) return mk("⊟", "#7a7884");
  if (lower.startsWith(".env") || lower.startsWith(".git") || lower.endsWith("rc"))
    return mk("⚙\uFE0E", "#a6a4b1");
  if (lower === "dockerfile") return mk("◳", "#6aa8ff");
  if (lower === "license") return mk("§", "#a6a4b1");
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (ext === "ts" || ext === "mts" || ext === "cts") {
    if (/shader|theme|appearance|highlight/.test(lower)) return mk("✦\uFE0E", "#ff9cc4");
    if (/api|board|session/.test(lower)) return mk("◆", "#9cc4ff");
    return mk("●", "#f0c84a");
  }
  const hit = EXT_BADGE[ext];
  return hit ? mk(hit[0], hit[1]) : mk("·", "#7a7884");
}

/** Render leading `---` frontmatter as a yaml block instead of stray rules. */
function frontmatterAsYaml(text: string) {
  return text.replace(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/, "```yaml\n$1\n```\n");
}

const GIT_LETTER: Record<GitChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  conflicted: "C",
};

/** Badge for a tree row: the file's own status, or M on any changed ancestor. */
function gitBadge(git: ReadonlyMap<string, string>, path: string) {
  const own = git.get(path);
  if (own) return own;
  const prefix = `${path}/`;
  for (const key of git.keys()) if (key.startsWith(prefix)) return "M";
  return "";
}

const EMPTY_GIT: ReadonlyMap<string, string> = new Map();

const HEAVY_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "DerivedData",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".turbo",
  ".cache",
  "Pods",
]);

type Clip = { mode: "cut" | "copy"; entry: WorkspaceEntry };
type MenuState = { x: number; y: number; entry: WorkspaceEntry };

function folderLabel(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function relativePath(root: string, path: string): string {
  if (path === root) return folderLabel(root);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

function formatSize(bytes: number | undefined): string | null {
  if (bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function visibleEntries(
  entries: WorkspaceEntry[],
  query: string,
  listings: Record<string, WorkspaceEntry[]>,
  showHidden: boolean,
): WorkspaceEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (!showHidden && entry.hidden) return false;
    if (!needle) return true;
    if (entry.name.toLowerCase().includes(needle)) return true;
    if (entry.type !== "directory") return false;
    const children = listings[entry.path];
    if (!children) return true;
    return visibleEntries(children, query, listings, showHidden).length > 0;
  });
}

function ExplorerPanel({
  root,
  visible = true,
  placement,
  onPlacementChange,
  onClose,
  onAddToChat,
  worktreePicker,
  git = EMPTY_GIT,
}: {
  git?: ReadonlyMap<string, string>;
  root: string;
  visible?: boolean;
  placement: WorkspacePlacement;
  onPlacementChange: (placement: WorkspacePlacement) => void;
  onClose: () => void;
  onAddToChat?: (path: string) => void;
  worktreePicker?: ReactNode;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set([root]),
  );
  const [listings, setListings] = useState<Record<string, WorkspaceEntry[]>>(
    {},
  );
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<WorkspaceFileResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [mdPreview, setMdPreview] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [truncatedRoots, setTruncatedRoots] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [apps, setApps] = useState<{ id: string; label: string }[]>([
    { id: "default", label: "Default App" },
  ]);
  const [notice, setNotice] = useState<string | null>(null);
  const [palette, setPalette] = useState<{
    mode: PaletteMode;
    results?: PaletteResult[];
    title?: string;
  } | null>(null);
  const [navigation, setNavigation] = useState<EditorNavigation | null>(null);
  const [panelWidth, setPanelWidth] = useState(() => {
    // Number(null) is 0, so an unset key must not pass as a stored width.
    // Unset → the mock's split: editor + tree slightly wider than the chat.
    const stored = Number(localStorage.getItem("devden.workspace-width"));
    const max = Math.round(window.innerWidth * 0.82);
    return stored > 0
      ? Math.min(max, Math.max(520, stored))
      : Math.max(520, Math.round(window.innerWidth * 0.5));
  });
  const [treeWidth, setTreeWidth] = useState(() => {
    const stored = Number(localStorage.getItem("devden.workspace-tree-width"));
    return Number.isFinite(stored) ? Math.min(420, Math.max(168, stored)) : 228;
  });

  const dirty = Boolean(
    file?.ok && file.content !== undefined && draft !== file.content,
  );

  const loadListing = async (path: string) => {
    setLoadingPaths((current) => new Set(current).add(path));
    const result = await api.workspace(path);
    setLoadingPaths((current) => {
      const next = new Set(current);
      next.delete(path);
      return next;
    });
    if (!result.ok || !result.entries) {
      setErrors((current) => ({
        ...current,
        [path]: result.error ?? "Could not read this folder.",
      }));
      return;
    }
    setErrors((current) => {
      if (!current[path]) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
    setListings((current) => ({ ...current, [path]: result.entries ?? [] }));
    setTruncatedRoots((current) => {
      const next = new Set(current);
      if (result.truncated) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const refreshTree = async (paths = expanded) => {
    await Promise.all([...paths].map((path) => loadListing(path)));
  };

  useEffect(() => {
    void loadListing(root);
  }, [root]);
  useEffect(() => {
    void api.workspaceApps().then((result) => {
      if (result.ok) setApps(result.apps);
    });
  }, []);

  useEffect(() => {
    // The panel keeps its hooks running while hidden (it renders null), so the
    // shortcuts have to be gated explicitly or ⌘P would swallow Print app-wide.
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "p" &&
        !event.altKey
      ) {
        event.preventDefault();
        setPalette({ mode: "files" });
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        setPalette({ mode: "grep" });
        return;
      }
      if (event.key !== "Escape") return;
      // Unwind one layer at a time; Escape only closes the explorer once
      // nothing is stacked on top of it.
      if (palette) {
        setPalette(null);
        return;
      }
      if (menu) {
        setMenu(null);
        return;
      }
      if (renaming) {
        setRenaming(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, onClose, palette, renaming, visible]);

  const toggleDirectory = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!listings[path]) void loadListing(path);
      }
      return next;
    });
  };

  const openFile = async (
    path: string,
    jumpTo?: { line: number; column?: number },
  ) => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setSelected(path);
    setMenu(null);
    setFileLoading(true);
    setSaveError(null);
    const result = await api.workspaceFile(path);
    setFileLoading(false);
    setFile(result);
    setDraft(result.content ?? "");
    // The token is what makes a second jump to the same line register.
    setNavigation(jumpTo ? { ...jumpTo, token: Date.now() } : null);
  };

  const pickResult = (result: PaletteResult) => {
    setPalette(null);
    const jumpTo =
      result.line === undefined
        ? undefined
        : { line: result.line, column: result.column };
    if (result.path === selected && jumpTo)
      setNavigation({ ...jumpTo, token: Date.now() });
    else void openFile(result.path, jumpTo);
  };

  /**
   * Cmd-click / F12 on a symbol. One hit jumps straight there; several open the
   * palette to choose from, because a grep cannot tell same-named symbols apart.
   */
  const jumpToDefinition = async (symbol: string) => {
    const result = await api.workspaceDefinition(root, symbol);
    const matches = result.ok ? (result.matches ?? []) : [];
    if (!matches.length) {
      showNotice(result.error ?? `No definition found for ${symbol}.`);
      return;
    }
    if (matches.length === 1) {
      pickResult(matches[0]);
      return;
    }
    setPalette({
      mode: "results",
      results: matches,
      title: `${matches.length} definitions of ${symbol}`,
    });
  };

  const saveFile = async () => {
    if (!file?.path || file.content === undefined) return;
    setSaving(true);
    setSaveError(null);
    const result = await api.workspaceSave(file.path, draft);
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error ?? "Could not save this file.");
      return;
    }
    setFile((current) =>
      current
        ? {
            ...current,
            content: draft,
            size: result.size ?? draft.length,
            truncated: false,
          }
        : current,
    );
  };

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(
      () => setNotice((current) => (current === message ? null : current)),
      2400,
    );
  };

  const runAction = async (
    label: string,
    work: () => Promise<{ ok: boolean; error?: string; path?: string }>,
  ) => {
    setMenu(null);
    const result = await work();
    if (!result.ok) {
      showNotice(result.error ?? `Could not ${label}.`);
      return result;
    }
    await refreshTree();
    return result;
  };

  const pasteInto = async (directory: string) => {
    if (!clip) return;
    const result = await runAction(clip.mode === "cut" ? "move" : "copy", () =>
      clip.mode === "cut"
        ? api.workspaceMove(clip.entry.path, directory)
        : api.workspaceCopy(clip.entry.path, directory),
    );
    if (result.ok && clip.mode === "cut") setClip(null);
  };

  const renameEntry = async (path: string, name: string) => {
    setRenaming(null);
    const next = name.trim();
    if (!next || next === folderLabel(path)) return;
    const result = await runAction("rename", () =>
      api.workspaceRename(path, next),
    );
    if (result.ok && result.path && selected === path) {
      setSelected(result.path);
      if (file?.path === path) void openFile(result.path);
    }
  };

  const deleteEntry = async (entry: WorkspaceEntry) => {
    const confirmed = window.confirm(
      `Delete “${entry.name}”? This cannot be undone.`,
    );
    if (!confirmed) return;
    const result = await runAction("delete", () =>
      api.workspaceDelete(entry.path),
    );
    if (
      result.ok &&
      (selected === entry.path || selected?.startsWith(`${entry.path}/`))
    ) {
      setSelected(null);
      setFile(null);
      setDraft("");
    }
  };

  const persistPanelWidth = (width: number) => {
    const next = Math.min(
      Math.max(width, 520),
      Math.round(window.innerWidth * 0.82),
    );
    setPanelWidth(next);
    localStorage.setItem("devden.workspace-width", String(next));
    return next;
  };

  const persistTreeWidth = (width: number) => {
    const next = Math.min(420, Math.max(168, width));
    setTreeWidth(next);
    localStorage.setItem("devden.workspace-tree-width", String(next));
    return next;
  };

  const startPanelResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = panelWidth;
    const onMove = (moveEvent: PointerEvent) =>
      persistPanelWidth(startWidth + startX - moveEvent.clientX);
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove("is-resizing-workspace");
    };
    document.body.classList.add("is-resizing-workspace");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

  const resizePanelWithKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    persistPanelWidth(panelWidth + (event.key === "ArrowLeft" ? 32 : -32));
  };

  const startTreeResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = treeWidth;
    const onMove = (moveEvent: PointerEvent) =>
      persistTreeWidth(startWidth + moveEvent.clientX - startX);
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

  const openMenu = (
    event: { clientX: number; clientY: number; preventDefault: () => void },
    entry: WorkspaceEntry,
  ) => {
    event.preventDefault();
    setSelected(entry.path);
    const width = 248;
    const height = 420;
    setMenu({
      entry,
      x: Math.min(event.clientX, window.innerWidth - width - 8),
      y: Math.min(event.clientY, window.innerHeight - height - 8),
    });
  };

  const rootEntries = listings[root] ?? [];
  const shownRoot = useMemo(
    () => visibleEntries(rootEntries, query, listings, showHidden),
    [listings, query, rootEntries, showHidden],
  );
  const language = file?.path ? langFromPath(file.path) : undefined;
  const sizeLabel = formatSize(file?.size);
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(file?.name ?? "");
  const canEdit = Boolean(
    file?.ok && file.content !== undefined && !file.binary && !file.truncated,
  );

  if (!visible) return null;

  return (
    <aside
      className={`workspace-explorer is-${placement}`}
      aria-label="Workspace source"
      style={
        placement === "side"
          ? { width: panelWidth, flexBasis: panelWidth }
          : undefined
      }
    >
      {placement === "side" && (
        <button
          type="button"
          className="workspace-explorer__resize"
          aria-label="Resize workspace"
          title="Drag to resize workspace"
          onPointerDown={startPanelResize}
          onKeyDown={resizePanelWithKeyboard}
        />
      )}
      <div className="workspace-explorer__body">
        <div
          className="workspace-explorer__tree"
          style={{ width: treeWidth, flexBasis: treeWidth }}
        >
          <div className="workspace-explorer__search">
            <IconSearch size={12} />
            <input
              type="search"
              value={query}
              placeholder="Filter files"
              aria-label="Filter workspace files"
              onChange={(event) => setQuery(event.target.value)}
            />
            <label className="workspace-explorer__hidden">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(event) => setShowHidden(event.target.checked)}
              />
              hidden
            </label>
          </div>
          <div
            className="workspace-explorer__list"
            aria-busy={loadingPaths.has(root)}
          >
            {loadingPaths.has(root) && !listings[root] && (
              <div className="workspace-explorer__status">Reading project…</div>
            )}
            {errors[root] && (
              <div className="workspace-explorer__error" role="alert">
                {errors[root]}
              </div>
            )}
            {!loadingPaths.has(root) &&
              !errors[root] &&
              shownRoot.length === 0 && (
                <div className="workspace-explorer__status">
                  {query ? "No matching files." : "This folder is empty."}
                </div>
              )}
            {shownRoot.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                query={query}
                showHidden={showHidden}
                expanded={expanded}
                listings={listings}
                loadingPaths={loadingPaths}
                errors={errors}
                truncatedRoots={truncatedRoots}
                selected={selected}
                renaming={renaming}
                onToggle={toggleDirectory}
                onOpenFile={openFile}
                onMenu={openMenu}
                onRename={renameEntry}
                onCancelRename={() => setRenaming(null)}
                git={git}
              />
            ))}
            {truncatedRoots.has(root) && (
              <div className="workspace-explorer__status">
                Showing the first 2,000 entries.
              </div>
            )}
          </div>
          <button
            type="button"
            className="workspace-explorer__tree-resize"
            aria-label="Resize file tree"
            title="Drag to resize file tree"
            onPointerDown={startTreeResize}
          />
        </div>

        <section className="workspace-explorer__editor" aria-label="Source">
          {!selected && (
            <div className="workspace-explorer__placeholder">
              <IconCode size={22} />
              <strong>Browse the project</strong>
              <p>
                Open a file to edit it, or double-click for Finder-style
                actions.
              </p>
              <p>
                ⌘P go to file · ⇧⌘F find in project · ⌘-click a symbol for its
                definition
              </p>
            </div>
          )}
          {selected && fileLoading && !file && (
            <div className="workspace-explorer__status">Opening file…</div>
          )}
          {selected && file && !file.ok && (
            <div className="workspace-explorer__error" role="alert">
              {file.error ?? "Could not open this file."}
            </div>
          )}
          {selected && file?.ok && file.binary && (
            <div className="workspace-explorer__placeholder">
              <IconFile size={22} />
              <strong>{file.name}</strong>
              <p>
                This file is binary, so it isn’t shown as source.
                {sizeLabel ? ` ${sizeLabel}.` : ""}
              </p>
            </div>
          )}
          {selected && file?.ok && file.content !== undefined && (
            <>
              <div className="workspace-explorer__file-head">
                <div
                  className="workspace-explorer__tab"
                  title={file.path ?? selected}
                >
                  <i
                    style={{ background: fileBadge(file.name ?? "").fg }}
                    aria-hidden
                  />
                  <strong>{file.name}</strong>
                  {dirty && <span aria-label="unsaved">●</span>}
                </div>
                {isMarkdown && (
                  <button
                    type="button"
                    className="workspace-explorer__save is-ready"
                    aria-pressed={mdPreview}
                    onClick={() => setMdPreview((on) => !on)}
                  >
                    {mdPreview ? "Edit" : "Preview"}
                  </button>
                )}
                {canEdit && (
                  <button
                    type="button"
                    className={`workspace-explorer__save${dirty ? " is-ready" : ""}`}
                    disabled={!dirty || saving}
                    onClick={() => void saveFile()}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                )}
                <CopyButton
                  text={draft || file.content}
                  label="Copy file"
                  className="workspace-explorer__copy"
                  iconOnly
                />
              </div>
              {file.truncated && (
                <div className="workspace-explorer__notice">
                  Showing the first 1 MB of this file. Editing is disabled.
                </div>
              )}
              {saveError && (
                <div className="workspace-explorer__error" role="alert">
                  {saveError}
                </div>
              )}
              {isMarkdown && mdPreview ? (
                <div className="workspace-explorer__code workspace-explorer__md">
                  <RichText text={frontmatterAsYaml(draft || file.content)} />
                </div>
              ) : canEdit ? (
                <Suspense
                  fallback={
                    <div className="workspace-explorer__status">
                      Loading editor…
                    </div>
                  }
                >
                  <CodeEditor
                    path={file.path ?? selected}
                    value={draft}
                    navigation={navigation}
                    onChange={setDraft}
                    onSave={() => void saveFile()}
                    onDefinition={(symbol) => void jumpToDefinition(symbol)}
                  />
                </Suspense>
              ) : (
                <div className="workspace-explorer__code">
                  <pre>
                    <code>{highlightCode(file.content, language)}</code>
                  </pre>
                </div>
              )}
              <footer className="workspace-explorer__statusbar">
                <span>{relativePath(root, file.path ?? selected)}</span>
                <span className="workspace-explorer__statusbar-end">
                  {[
                    sizeLabel,
                    file.truncated && "truncated",
                    dirty && "unsaved",
                    language,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </footer>
            </>
          )}
        </section>
      </div>

      {notice && (
        <div className="workspace-explorer__toast" role="status">
          {notice}
        </div>
      )}

      {palette && (
        <EditorPalette
          root={root}
          mode={palette.mode}
          results={palette.results}
          title={palette.title}
          onPick={pickResult}
          onClose={() => setPalette(null)}
        />
      )}

      {menu && (
        <FileMenu
          menu={menu}
          root={root}
          apps={apps}
          clip={clip}
          onClose={() => setMenu(null)}
          onOpenToSide={() => {
            onPlacementChange("side");
            if (menu.entry.type === "file") void openFile(menu.entry.path);
            else toggleDirectory(menu.entry.path);
            setMenu(null);
          }}
          onOpenWith={(app) => {
            void runAction("open", () =>
              api.workspaceOpen(menu.entry.path, app),
            );
          }}
          onReveal={() => {
            void runAction("reveal", () =>
              api.workspaceReveal(menu.entry.path),
            );
          }}
          onTerminal={() => {
            void runAction("open Terminal", () =>
              api.workspaceTerminal(menu.entry.path),
            );
          }}
          onAddToChat={() => {
            onAddToChat?.(menu.entry.path);
            setMenu(null);
          }}
          onCut={() => {
            setClip({ mode: "cut", entry: menu.entry });
            setMenu(null);
          }}
          onCopy={() => {
            setClip({ mode: "copy", entry: menu.entry });
            setMenu(null);
          }}
          onPaste={() => {
            const directory =
              menu.entry.type === "directory"
                ? menu.entry.path
                : parentPath(menu.entry.path);
            void pasteInto(directory);
          }}
          onCopyPath={() => {
            void navigator.clipboard?.writeText(menu.entry.path);
            setMenu(null);
            showNotice("Copied path");
          }}
          onCopyRelative={() => {
            void navigator.clipboard?.writeText(
              relativePath(root, menu.entry.path),
            );
            setMenu(null);
            showNotice("Copied relative path");
          }}
          onRename={() => {
            setRenaming(menu.entry.path);
            setMenu(null);
          }}
          onDelete={() => {
            void deleteEntry(menu.entry);
          }}
        />
      )}
    </aside>
  );
}

function TreeNode({
  entry,
  depth,
  query,
  showHidden,
  expanded,
  listings,
  loadingPaths,
  errors,
  truncatedRoots,
  selected,
  renaming,
  onToggle,
  onOpenFile,
  onMenu,
  onRename,
  onCancelRename,
  git,
}: {
  git: ReadonlyMap<string, string>;
  entry: WorkspaceEntry;
  depth: number;
  query: string;
  showHidden: boolean;
  expanded: ReadonlySet<string>;
  listings: Record<string, WorkspaceEntry[]>;
  loadingPaths: ReadonlySet<string>;
  errors: Record<string, string>;
  truncatedRoots: ReadonlySet<string>;
  selected: string | null;
  renaming: string | null;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onMenu: (
    event: { clientX: number; clientY: number; preventDefault: () => void },
    entry: WorkspaceEntry,
  ) => void;
  onRename: (path: string, name: string) => void;
  onCancelRename: () => void;
}) {
  const isDirectory = entry.type === "directory";
  const isOpen = isDirectory && expanded.has(entry.path);
  const badge = gitBadge(git, entry.path);
  const mark = isDirectory ? null : fileBadge(entry.name);
  const children = isOpen
    ? visibleEntries(listings[entry.path] ?? [], query, listings, showHidden)
    : [];
  const heavy = isDirectory && HEAVY_DIRS.has(entry.name);
  const isRenaming = renaming === entry.path;
  const pad = 4 + depth * 8;

  return (
    <>
      {isRenaming ? (
        <form
          className="workspace-tree__rename"
          style={{ paddingLeft: pad }}
          onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get("name");
            onRename(entry.path, String(value ?? ""));
          }}
        >
          {isDirectory ? <IconFolder size={14} /> : <IconFile size={14} />}
          <input
            name="name"
            defaultValue={entry.name}
            aria-label={`Rename ${entry.name}`}
            autoFocus
            onBlur={(event) => onRename(entry.path, event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCancelRename();
              }
            }}
          />
        </form>
      ) : (
        <button
          type="button"
          className={`workspace-tree__item${selected === entry.path ? " is-active" : ""}${heavy ? " is-heavy" : ""}${badge ? ` is-git-${badge}` : ""}`}
          style={{ paddingLeft: pad }}
          title={entry.path}
          aria-expanded={isDirectory ? isOpen : undefined}
          onClick={() =>
            isDirectory ? onToggle(entry.path) : onOpenFile(entry.path)
          }
          onDoubleClick={(event) => onMenu(event, entry)}
          onContextMenu={(event) => onMenu(event, entry)}
        >
          {isDirectory ? (
            <span
              className={`workspace-tree__chevron${isOpen ? "" : " is-collapsed"}`}
            >
              ⌄
            </span>
          ) : (
            <span className="workspace-tree__file-gap" />
          )}
          {isDirectory ? (
            <span className="workspace-tree__folder">
              <FolderGlyph
                color={folderColor(entry.name)}
              />
            </span>
          ) : (
            <span
              className={`workspace-tree__badge${mark && mark.glyph.length > 1 && !mark.glyph.endsWith("\uFE0E") ? " is-text" : ""}`}
              style={{
                background: mark?.bg,
                color: mark?.fg,
              }}
            >
              {mark?.glyph}
            </span>
          )}
          <span className="workspace-tree__name">{entry.name}</span>
          {badge && (
            <span className={`workspace-tree__git is-${badge}`}>{badge}</span>
          )}
        </button>
      )}
      {isOpen && loadingPaths.has(entry.path) && !listings[entry.path] && (
        <div
          className="workspace-explorer__status"
          style={{ paddingLeft: pad + 16 }}
        >
          Loading…
        </div>
      )}
      {isOpen && errors[entry.path] && (
        <div
          className="workspace-explorer__error"
          style={{ paddingLeft: pad + 16 }}
        >
          {errors[entry.path]}
        </div>
      )}
      {isOpen &&
        children.map((child) => (
          <TreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            query={query}
            showHidden={showHidden}
            expanded={expanded}
            listings={listings}
            loadingPaths={loadingPaths}
            errors={errors}
            truncatedRoots={truncatedRoots}
            selected={selected}
            renaming={renaming}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
            onMenu={onMenu}
            onRename={onRename}
            onCancelRename={onCancelRename}
            git={git}
          />
        ))}
      {isOpen && truncatedRoots.has(entry.path) && (
        <div
          className="workspace-explorer__status"
          style={{ paddingLeft: pad + 16 }}
        >
          Folder truncated.
        </div>
      )}
    </>
  );
}

function FileMenu({
  menu,
  root,
  apps,
  clip,
  onClose,
  onOpenToSide,
  onOpenWith,
  onReveal,
  onTerminal,
  onAddToChat,
  onCut,
  onCopy,
  onPaste,
  onCopyPath,
  onCopyRelative,
  onRename,
  onDelete,
}: {
  menu: MenuState;
  root: string;
  apps: { id: string; label: string }[];
  clip: Clip | null;
  onClose: () => void;
  onOpenToSide: () => void;
  onOpenWith: (app: string) => void;
  onReveal: () => void;
  onTerminal: () => void;
  onAddToChat: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onCopyPath: () => void;
  onCopyRelative: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [openWith, setOpenWith] = useState(false);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".workspace-menu"))
        onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  return (
    <div
      className="workspace-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button type="button" role="menuitem" onClick={onOpenToSide}>
        Open to the Side
      </button>
      <div className={`workspace-menu__sub${openWith ? " is-open" : ""}`}>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          onClick={() => setOpenWith((open) => !open)}
        >
          Open With… <span>›</span>
        </button>
        {openWith && (
          <div className="workspace-menu workspace-menu--nested" role="menu">
            {apps.map((app) => (
              <button
                type="button"
                role="menuitem"
                key={app.id}
                onClick={() => onOpenWith(app.id)}
              >
                {app.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" role="menuitem" onClick={onReveal}>
        Reveal in Finder
      </button>
      <button type="button" role="menuitem" onClick={onTerminal}>
        Open in Integrated Terminal
      </button>
      <div className="workspace-menu__rule" />
      <button type="button" role="menuitem" onClick={onAddToChat}>
        Add File to Chat
      </button>
      <div className="workspace-menu__rule" />
      <button type="button" role="menuitem" onClick={onCut}>
        Cut
      </button>
      <button type="button" role="menuitem" onClick={onCopy}>
        Copy
      </button>
      <button type="button" role="menuitem" disabled={!clip} onClick={onPaste}>
        Paste
      </button>
      <button type="button" role="menuitem" onClick={onCopyPath}>
        Copy Path
      </button>
      <button type="button" role="menuitem" onClick={onCopyRelative}>
        Copy Relative Path
      </button>
      <div className="workspace-menu__rule" />
      <button type="button" role="menuitem" onClick={onRename}>
        Rename…
      </button>
      <button
        type="button"
        role="menuitem"
        className="is-danger"
        onClick={onDelete}
      >
        Delete
      </button>
      <div className="workspace-menu__hint">
        {relativePath(root, menu.entry.path)}
      </div>
    </div>
  );
}

type WorktreeInfo = { path: string; branch: string; main: boolean };

/** Wrapper: a worktree dropdown in the header re-roots the source tree.
 *  Session state (open file, selection) resets per switch via the key. */
export function WorkspaceExplorer(
  props: ComponentProps<typeof ExplorerPanel> & { sessionKey?: string },
) {
  const { sessionKey, root, ...rest } = props;
  const [viewRoot, setViewRoot] = useState(root);
  const [trees, setTrees] = useState<WorktreeInfo[]>([]);

  useEffect(() => {
    setViewRoot(root);
  }, [root]);

  useEffect(() => {
    let alive = true;
    api
      .worktrees(sessionKey || "workspace", root)
      .then((result) => {
        if (alive && result.worktrees) setTrees(result.worktrees);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionKey, root]);

  // ponytail: fetched once per root; the refresh button doesn't re-poll git.
  // Porcelain paths are repo-relative, so a root below the repo top misses.
  const [git, setGit] = useState<ReadonlyMap<string, string>>(EMPTY_GIT);
  useEffect(() => {
    let alive = true;
    api
      .gitChanges(sessionKey || "workspace", viewRoot)
      .then((result) => {
        if (!alive || !result.changes) return;
        setGit(
          new Map(
            result.changes.map((change) => [
              `${viewRoot}/${change.path}`,
              GIT_LETTER[change.status],
            ]),
          ),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionKey, viewRoot]);

  const picker =
    trees.length > 1 ? (
      <select
        className="workspace-explorer__worktree"
        value={viewRoot}
        title={viewRoot}
        onChange={(event) => setViewRoot(event.target.value)}
      >
        {trees.map((tree) => (
          <option key={tree.path} value={tree.path}>
            {tree.main ? "main" : tree.branch || "detached"}
          </option>
        ))}
      </select>
    ) : null;

  return (
    <ExplorerPanel
      key={viewRoot}
      {...rest}
      root={viewRoot}
      worktreePicker={picker}
      git={git}
    />
  );
}
