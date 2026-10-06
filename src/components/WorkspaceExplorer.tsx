import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  api,
  type GitChange,
  type GitChangesResponse,
  type WorkspaceEntry,
  type WorkspaceFileResponse,
} from "../lib/api";
import { highlightCode } from "../lib/highlight";
import { langFromPath, type ToolDiff } from "../lib/toolCards";
import type { EditorNavigation } from "./CodeEditor";
import {
  EditorPalette,
  type PaletteMode,
  type PaletteResult,
} from "./EditorPalette";
import { CopyButton } from "./CopyButton";
import { ExplorerGit } from "./ExplorerGit";
import { DiffView } from "./DiffView";
import { parseUnifiedDiff } from "./ChangesPanel";
import { WorkbenchIcon } from "./WorkbenchIcon";
import { MaterialIcon } from "./MaterialIcon";
import { fmtCount } from "../lib/workbenchLook";
import { RichText } from "./RichText";
import {
  IconBranch,
  IconCode,
  IconExpand,
  IconFile,
  IconFolder,
  IconPanel,
  IconRefresh,
  IconSearch,
} from "./icons";

export type WorkspacePlacement = "side" | "full";

const gitCache = new Map<string, GitChangesResponse>();

// CodeMirror is the heaviest thing this app can load, and most sessions never
// open a file. Keep it out of the entry chunk.
const CodeEditor = lazy(() =>
  import("./CodeEditor").then((module) => ({ default: module.CodeEditor })),
);

// Glyph + color per extension. \uFE0E forces text (not emoji) presentation.
const EXT_BADGE: Record<string, [string, string]> = {
  js: ["JS", "#f0db4f"],
  mjs: ["JS", "#f0db4f"],
  cjs: ["JS", "#f0db4f"],
  json: ["{}", "#f5c77e"],
  jsonc: ["{}", "#f5c77e"],
  yaml: ["≡", "#ff9f6a"],
  yml: ["≡", "#ff9f6a"],
  toml: ["≡", "#ff9f6a"],
  md: ["M↓", "#9cc4ff"],
  mdx: ["M↓", "#9cc4ff"],
  txt: ["≣", "#a6a4b1"],
  css: ["#", "#c3a6ff"],
  scss: ["#", "#c3a6ff"],
  less: ["#", "#c3a6ff"],
  html: ["<>", "#ff8a65"],
  xml: ["<>", "#ff8a65"],
  vue: ["V", "#5fd49a"],
  py: ["Py", "#6aa8ff"],
  rb: ["Rb", "#ff7a8a"],
  go: ["Go", "#6ad4e0"],
  rs: ["Rs", "#ff9f6a"],
  swift: ["Sw", "#ff8a50"],
  java: ["Jv", "#ff9f6a"],
  kt: ["Kt", "#c3a6ff"],
  c: ["C", "#9cc4ff"],
  h: ["H", "#9cc4ff"],
  cpp: ["C+", "#9cc4ff"],
  cs: ["C#", "#c3a6ff"],
  php: ["P", "#c3a6ff"],
  sh: ["$", "#86e6b0"],
  zsh: ["$", "#86e6b0"],
  bash: ["$", "#86e6b0"],
  sql: ["⛁\uFE0E", "#f5c77e"],
  db: ["⛁\uFE0E", "#f5c77e"],
  png: ["▣", "#ff9cc4"],
  jpg: ["▣", "#ff9cc4"],
  jpeg: ["▣", "#ff9cc4"],
  gif: ["▣", "#ff9cc4"],
  webp: ["▣", "#ff9cc4"],
  ico: ["▣", "#ff9cc4"],
  svg: ["◇", "#ffb86a"],
  pdf: ["▤", "#ff7a8a"],
  mp4: ["▶\uFE0E", "#ff9cc4"],
  mov: ["▶\uFE0E", "#ff9cc4"],
  mp3: ["♪", "#ff9cc4"],
  zip: ["▦", "#a6a4b1"],
  gz: ["▦", "#a6a4b1"],
  lock: ["⊟", "#7a7884"],
  log: ["≣", "#7a7884"],
  env: ["⚙\uFE0E", "#86e6b0"],
};

/** Colored file marks from the redesign; `.ts` rules match the mock exactly. */
function fileBadge(name: string): { glyph: string; bg: string; fg: string } {
  const mk = (glyph: string, fg: string) => ({
    glyph,
    fg,
    bg: `color-mix(in srgb, ${fg} 18%, transparent)`,
  });
  const lower = name.toLowerCase();
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(lower))
    return mk("⚗\uFE0E", "#d4c2ff");
  if (/\.[jt]sx$/.test(lower)) return mk("⚛\uFE0E", "#8fe6ef");
  if (lower === "package-lock.json" || lower.endsWith(".lock"))
    return mk("⊟", "#7a7884");
  if (
    lower.startsWith(".env") ||
    lower.startsWith(".git") ||
    lower.endsWith("rc")
  )
    return mk("⚙\uFE0E", "#a6a4b1");
  if (lower === "dockerfile") return mk("◳", "#6aa8ff");
  if (lower === "license") return mk("§", "#a6a4b1");
  const ext = lower.includes(".")
    ? lower.slice(lower.lastIndexOf(".") + 1)
    : "";
  if (ext === "ts" || ext === "mts" || ext === "cts") {
    if (/shader|theme|appearance|highlight/.test(lower))
      return mk("✦\uFE0E", "#ff9cc4");
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
): WorkspaceEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (!needle) return true;
    if (entry.name.toLowerCase().includes(needle)) return true;
    if (entry.type !== "directory") return false;
    const children = listings[entry.path];
    if (!children) return true;
    return visibleEntries(children, query, listings).length > 0;
  });
}

type ExplorerTab = "files" | "changes";

function ExplorerPanel({
  root,
  visible = true,
  placement,
  tab,
  sessionKey,
  onTabChange,
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
  /** Which side of the tree pane is showing: the file tree or the branch's
   *  changed files. Owned by the parent so the changes card's expand button
   *  can switch it remotely. */
  tab: ExplorerTab;
  /** The session whose git state the Changes tab diffs against its base. */
  sessionKey?: string;
  onTabChange: (tab: ExplorerTab) => void;
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
    const raw = localStorage.getItem("devden.workspace-tree-width");
    const stored = raw === null ? NaN : Number(raw);
    return Number.isFinite(stored) ? Math.min(420, Math.max(236, stored)) : 248;
  });
  const [treeCollapsed, setTreeCollapsed] = useState(() => localStorage.getItem("devden.workspace-tree-collapsed") === "1");
  const toggleTree = () => setTreeCollapsed(value => {
    try { localStorage.setItem("devden.workspace-tree-collapsed", value ? "0" : "1"); } catch { /* lasts this mount */ }
    return !value;
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
      // nothing is stacked on top of it. An open popover (Appearance) closes
      // itself on this same Escape, after listeners run.
      if (document.querySelector(":popover-open")) return;
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

  // Switching away from the Changes tab closes its open diff so the editor
  // pane goes back to showing the selected file (or the placeholder).
  const switchTab = (next: ExplorerTab) => {
    if (next === "files") setOpenChangePath(null);
    onTabChange(next);
  };

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
    setOpenChangePath(null);
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
    const next = Math.min(420, Math.max(236, width));
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
    () => visibleEntries(rootEntries, query, listings),
    [listings, query, rootEntries],
  );

  const [filterOpen, setFilterOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [baseChanges, setBaseChanges] = useState<GitChange[] | null>(null);
  const [gitInfo, setGitInfo] = useState<GitChangesResponse | null>(null);
  const [gitReload, setGitReload] = useState(0);
  const [changeDiffs, setChangeDiffs] = useState<
    Record<string, ToolDiff | undefined>
  >({});

  // Files this branch changed since its base (main). `base=1` widens the
  // numstat from the dirty tree to the whole worktree branch.
  useEffect(() => {
    if (!sessionKey) return;
    let alive = true;
    // Git changes are per repo, not per session: switching sessions shows the
    // last result at once and refreshes quietly instead of reloading.
    const cached = gitCache.get(root);
    if (cached) { setBaseChanges(cached.changes ?? []); setBranch(cached.branch ?? null); setGitInfo(cached); }
    else if (gitReload === 0) setBaseChanges(null);
    api
      .gitChanges(sessionKey, root, true)
      .then((result) => {
        gitCache.set(root, result);
        if (alive) { setBaseChanges(result.changes ?? []); setBranch(result.branch ?? null); setGitInfo(result); }
      })
      .catch(() => {
        if (alive) setBaseChanges([]);
      });
    return () => {
      alive = false;
    };
  }, [tab, sessionKey, root, gitReload]);

  // Clicking a changed file shows its diff (vs the same base) in the editor
  // pane instead of the current file content.
  const [openChangePath, setOpenChangePath] = useState<string | null>(null);
  // Docked explorer always opens as tree | viewer (blank until a file is
  // picked), so it asks for room for both up front.
  const hasOpen = Boolean(selected || openChangePath);
  // The explorer is open, so a file is likely next: fetch CodeMirror while
  // idle instead of on the first click (after a deploy its chunk is cold).
  useEffect(() => {
    const warm = () => void import("./CodeEditor");
    const id = window.requestIdleCallback ? window.requestIdleCallback(warm, { timeout: 1500 }) : window.setTimeout(warm, 300);
    return () => (window.cancelIdleCallback ? window.cancelIdleCallback(id) : window.clearTimeout(id));
  }, []);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("devden:side-pane-width", { detail: (treeCollapsed ? 40 : treeWidth) + 560 }));
  }, [treeCollapsed]); // eslint-disable-line react-hooks/exhaustive-deps

  const openChange = async (path: string) => {
    setOpenChangePath(path);
    setSelected(null);
    setFile(null);
    setDraft("");
    if (!sessionKey || changeDiffs[path] !== undefined) return;
    try {
      const result = await api.gitFileDiff(sessionKey, root, path, true);
      setChangeDiffs((current) => ({
        ...current,
        [path]: result.ok ? parseUnifiedDiff(result.diff ?? "") : undefined,
      }));
    } catch {
      setChangeDiffs((current) => ({ ...current, [path]: undefined }));
    }
  };
  const language = file?.path ? langFromPath(file.path) : undefined;
  const sizeLabel = formatSize(file?.size);
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(file?.name ?? "");
  const canEdit = Boolean(
    file?.ok && file.content !== undefined && !file.binary && !file.truncated,
  );

  if (!visible) return null;

  return (
    <aside
      className={`workspace-explorer is-${placement}${hasOpen ? " has-open" : ""}${treeCollapsed ? " is-tree-collapsed" : ""}`}
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
          style={{ width: treeWidth, flexBasis: treeWidth, "--tree-w": `${treeWidth}px` } as CSSProperties}
        >
          <div className="workspace-explorer__search">
            <button type="button" className="workspace-explorer__filter-toggle" aria-label="Toggle file filter" aria-expanded={filterOpen} onClick={() => setFilterOpen(value => !value)}><IconSearch size={13} /></button>
            <div className="workspace-explorer__tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "files"}
                className={`workspace-explorer__tab${tab === "files" ? " is-active" : ""}`}
                onClick={() => switchTab("files")}
              >
                Files
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "changes"}
                className={`workspace-explorer__tab${tab === "changes" ? " is-active" : ""}`}
                onClick={() => switchTab("changes")}
              >
                Changes
                {baseChanges?.length ? (
                  <span className="workspace-explorer__tab-count">
                    {baseChanges.length}
                  </span>
                ) : null}
              </button>
            </div>
            <button type="button" className="workspace-explorer__collapse" aria-label={treeCollapsed ? "Show file tree" : "Hide file tree"} title={treeCollapsed ? "Show file tree" : "Hide file tree"} aria-expanded={!treeCollapsed} onClick={toggleTree}><IconPanel size={14} /></button>
          </div>
          {treeCollapsed && (
            <nav className="workspace-explorer__rail" aria-label="Explorer views">
              <button type="button" aria-label="Files" title="Files" aria-pressed={tab === "files"} onClick={() => { switchTab("files"); toggleTree(); }}><IconFolder size={15} /></button>
              <button type="button" aria-label="Changes" title={`Changes${baseChanges?.length ? ` (${baseChanges.length})` : ""}`} aria-pressed={tab === "changes"} onClick={() => { switchTab("changes"); toggleTree(); }}>
                <IconBranch size={15} />
                {baseChanges?.length ? <span className="workspace-explorer__rail-count">{baseChanges.length > 99 ? "99+" : baseChanges.length}</span> : null}
              </button>
              <button type="button" aria-label="Search files" title="Search files" onClick={() => { setFilterOpen(true); toggleTree(); }}><IconSearch size={14} /></button>
            </nav>
          )}
          {filterOpen && <div className="workspace-explorer__filter"><input type="search" value={query} placeholder={tab === "files" ? "Filter files" : "Filter changes"} aria-label={tab === "files" ? "Filter files" : "Filter changes"} onChange={event => setQuery(event.target.value)} />{tab === "files" && <label><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} /> Hidden files</label>}</div>}
          {tab === "changes" && baseChanges && <div className="workspace-change-summary"><span><b>+{fmtCount(baseChanges.reduce((n, f) => n + f.additions, 0))}</b> <i>−{fmtCount(baseChanges.reduce((n, f) => n + f.deletions, 0))}</i></span><small>{root.split("/").at(-1)} {branch && `⎇ ${branch}`}</small></div>}
          <div
            className="workspace-explorer__list"
            aria-busy={
              tab === "changes" ? baseChanges === null : loadingPaths.has(root)
            }
          >
            {tab === "changes" ? (
              baseChanges === null ? (
                <div className="workspace-explorer__status">
                  Reading changes…
                </div>
              ) : baseChanges.length === 0 ? (
                <div className="workspace-explorer__status">
                  No changes against the main branch.
                </div>
              ) : (
                <ExplorerGit
                  sessionKey={sessionKey ?? ""}
                  root={root}
                  info={gitInfo}
                  changes={baseChanges.filter(change => change.path.toLowerCase().includes(query.toLowerCase()))}
                  activePath={openChangePath}
                  onOpen={(path) => void openChange(path)}
                  onReload={() => setGitReload((n) => n + 1)}
                />
              )
            ) : (
              <>
                {loadingPaths.has(root) && !listings[root] && (
                  <div className="workspace-explorer__status">
                    Reading project…
                  </div>
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
                {shownRoot.filter(entry => showHidden || !entry.name.startsWith(".")).map((entry) => (
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
              </>
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
          {openChangePath &&
            (changeDiffs[openChangePath] ? (
              <>
              <div className="workspace-explorer__file-head">
                <div className="workspace-explorer__tab" title={openChangePath}>
                  <i style={{ background: fileBadge(openChangePath.split("/").at(-1) ?? "").fg }} aria-hidden />
                  <strong>{openChangePath.split("/").at(-1)}</strong>
                  <small>{openChangePath.slice(0, openChangePath.lastIndexOf("/") + 1)}</small>
                </div>
              </div>
              <div className="workspace-explorer__code workspace-explorer__diff">
                <DiffView
                  diff={changeDiffs[openChangePath]!}
                  path={`${root.replace(/\/$/, "")}/${openChangePath}`}
                />
              </div>
              </>
            ) : (
              <div className="workspace-explorer__status">Loading diff…</div>
            ))}
          {!selected && !openChangePath && (
            <div className="workspace-explorer__placeholder">
              <IconCode size={22} />
              <strong>Nothing open yet</strong>
              <p>
                Pick a file from the tree to read or edit it here. In Changes,
                a file opens as its diff.
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
  const children = isOpen
    ? visibleEntries(listings[entry.path] ?? [], query, listings).filter(child => showHidden || !child.name.startsWith("."))
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
              <WorkbenchIcon kind="folders" name={entry.name} />
            </span>
          ) : (
            <span className="workspace-tree__folder">
              <MaterialIcon name={entry.name} />
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
      sessionKey={sessionKey}
      worktreePicker={picker}
      git={git}
    />
  );
}
