import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type ChangesResponse,
  type GitChange,
  type GitChangesResponse,
  type GitOp,
  type GitOpOptions,
  type RecordedChange,
} from "../lib/api";
import {
  IconBranch,
  IconChevronDown,
  IconExpand,
  IconRefresh,
  IconRestore,
} from "./icons";
import type { DiffLine, ToolDiff, ToolFileView } from "../lib/toolCards";
import { fmtCount } from "../lib/workbenchLook";
import { fileKind, isSessionPath } from "../lib/turnFold";

/** Cap rendered diff lines so a huge generated file can't freeze the tab. */
const MAX_DIFF_LINES = 2000;

/** Parse a unified diff into the shared diff model. */
export function parseUnifiedDiff(text: string): ToolDiff {
  const rows = text.split("\n").slice(0, MAX_DIFF_LINES);
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let newLineNo = 0;
  for (const raw of rows) {
    if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("Binary files") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode") ||
      raw.startsWith("\\")
    ) {
      lines.push({ kind: "meta", text: raw });
    } else if (raw.startsWith("@@")) {
      const match = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) newLineNo = Number(match[1]);
      lines.push({ kind: "meta", text: raw });
    } else if (raw.startsWith("+")) {
      added += 1;
      lines.push({ kind: "add", text: raw.slice(1), lineNo: newLineNo });
      newLineNo += 1;
    } else if (raw.startsWith("-")) {
      removed += 1;
      lines.push({ kind: "remove", text: raw.slice(1) });
    } else {
      lines.push({ kind: "context", text: raw.slice(1), lineNo: newLineNo });
      newLineNo += 1;
    }
  }
  return { added, removed, lines };
}

/** What git calls the operation behind each in-progress state. */
const STATE_VERB: Record<string, string> = {
  merging: "merge",
  rebasing: "rebase",
  "cherry-picking": "cherry-pick",
  reverting: "revert",
};

/**
 * `git stash list` labels every entry "WIP on <branch>: <sha> <subject>" (or
 * "On <branch>: <message>" when named). The branch is already in the header,
 * so drop the prefix and keep the part that tells the stashes apart.
 */
function stashLabel(label: string, ref: string): string {
  const trimmed = label.replace(/^(?:WIP )?[Oo]n [^:]+:\s*/, "").trim();
  return trimmed || label || ref;
}

/** Human name per op, used for both the busy state and the result line. */
const OP_LABEL: Record<GitOp, string> = {
  push: "Push",
  pull: "Pull",
  "pull-rebase": "Pull (rebase)",
  fetch: "Fetch",
  commit: "Commit",
  "commit-push": "Commit and push",
  stash: "Stash",
  "stash-apply": "Apply stash",
  "stash-pop": "Pop stash",
  "stash-drop": "Drop stash",
  "branch-create": "Create branch",
  "branch-switch": "Switch branch",
  "undo-commit": "Undo last commit",
  continue: "Continue",
  abort: "Abort",
  pr: "Open pull request",
};

/** The folder a workspace path ends in, for the workspace row. */
function folderName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/**
 * `/Users/you/dev/devden` -> `~/dev`. Assumes the usual macOS/Linux home
 * layout, the same assumption the sidebar's workspaceLabel already makes.
 * ponytail: heuristic; pass the server's homedir if odd layouts matter.
 */
function homeRelative(path: string): string {
  const parent = path.split("/").filter(Boolean).slice(0, -1).join("/");
  const home = parent.match(/^(?:Users|home)\/[^/]+(?:\/(.*))?$/);
  return home ? (home[1] ? `~/${home[1]}` : "~") : parent;
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Last git snapshot per folder. Switching sessions remounts the panel; it
 * paints this at once and revalidates, instead of sitting blank for the
 * whole git round trip.
 */
const lastSnapshot = new Map<string, GitChangesResponse>();

/** Changes bucketed by folder, folders in path order, files in git's order. */
function groupByDir(changes: GitChange[]): [string, GitChange[]][] {
  const groups = new Map<string, GitChange[]>();
  for (const change of changes) {
    const cut = change.path.lastIndexOf("/");
    const dir = cut < 0 ? "" : change.path.slice(0, cut);
    const list = groups.get(dir);
    if (list) list.push(change);
    else groups.set(dir, [change]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

const sumAdd = (list: GitChange[]) =>
  list.reduce((sum, change) => sum + change.additions, 0);
const sumDel = (list: GitChange[]) =>
  list.reduce((sum, change) => sum + change.deletions, 0);

type Scope = "turn" | "session" | "tree";

/**
 * Changes dock above the composer. One line at rest; open, it lists changes
 * grouped by folder, scoped to the latest turn by default (Session and
 * Working tree one click away). It stands in for the latest turn's inline
 * receipt (see `.turn-files--latest`), so only one changes pill shows.
 * A file opens in the review pane — never inline. Git lives behind the branch
 * chip (sync, switch/create, stash) and the Commit split button (commit,
 * commit + push, PR). Renders nothing outside a git repo.
 */
export function ChangesPanel({
  sessionKey,
  cwd,
  streaming,
  compact = false,
  sessionPaths = [],
  sessionPath,
  onWorkspaceClick,
  onAskAgent,
  onLeaveWorktree,
  onOpenChanges,
  onOpenDiff,
  actions,
}: {
  sessionKey: string;
  cwd?: string;
  streaming: boolean;
  /** Narrow split panes: short scope labels; branch chip only when open. */
  compact?: boolean;
  /** Files this session's tools wrote: the "Session" scope's fallback for
   *  conversations from before change recording existed. */
  sessionPaths?: readonly string[];
  /** The session file, so recorded changes survive a reload's new key. */
  sessionPath?: string;
  /** Opens the workspace folder browser (from the branch menu). */
  onWorkspaceClick?: () => void;
  /** Drops a prompt in the composer; the user still presses send. */
  onAskAgent?: (prompt: string) => void;
  /** Opens the workspace explorer on its Changes tab. */
  onOpenChanges?: () => void;
  /** Shows one file's diff in the review pane. */
  onOpenDiff?: (view: ToolFileView) => void;
  /** Actions on the diff (Review), placed after the stats, before the view
   *  icons. Still rendered when the card itself is hidden. */
  actions?: React.ReactNode;
  /** Deleting the worktree this session lives in leaves its cwd gone, so the
   *  parent has to move the tab back to the main checkout. */
  onLeaveWorktree?: (mainPath: string) => void;
}) {
  const [restoreHost, setRestoreHost] = useState<Element | null>(null);
  useEffect(() => {
    setRestoreHost(document.getElementById(`dock-${sessionKey}`)?.querySelector(".composer__tools") ?? null);
  }, [sessionKey]);
  const [data, setData] = useState<GitChangesResponse | null>(
    () => lastSnapshot.get(cwd || "") ?? null,
  );
  const [dismissed, setDismissed] = useState(false);
  // Always collapsed: the card stays a one-line pill until clicked.
  const [collapsed, setCollapsed] = useState(true);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem("devden.changes-collapsed", next ? "1" : "0");
      } catch {
        /* storage unavailable; choice lasts this mount only */
      }
      return next;
    });
  }, []);
  const [scope, setScope] = useState<Scope>("tree");
  // Recorded per-turn / per-session views (server/changes.js).
  const [recorded, setRecorded] = useState<{
    turn?: ChangesResponse;
    session?: ChangesResponse;
  }>({});
  const [closedDirs, setClosedDirs] = useState<ReadonlySet<string>>(new Set());
  const [opening, setOpening] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  // Only one secondary op runs at a time; this is which.
  const [busyOp, setBusyOp] = useState<GitOp | null>(null);
  // Failures render inline in the card they came from; successes are said
  // by the receipt header.
  const [feedback, setFeedback] = useState<{
    ok: boolean;
    title: string;
    output?: string;
  } | null>(null);
  const [menu, setMenu] = useState<"branch" | "commit" | null>(null);
  const [branchQuery, setBranchQuery] = useState("");
  // Stays on screen after a successful commit/push (which empties the change
  // list) so the outcome is visible in-app instead of only on GitHub.
  const [pushed, setPushed] = useState<{
    branch?: string;
    output?: string;
    files: number;
    remote: boolean;
  } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // Files the user unchecked. Persisted per repo so the exclusion survives
  // pushes AND future turns' change boxes until the user re-includes them.
  const excludedKey = `devden.changes-excluded:${cwd || "default"}`;
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const saveExcluded = useCallback(
    (next: ReadonlySet<string>) => {
      try {
        localStorage.setItem(excludedKey, JSON.stringify([...next]));
      } catch {
        /* storage unavailable; exclusion lasts this session only */
      }
    },
    [excludedKey],
  );
  useEffect(() => {
    try {
      const raw = localStorage.getItem(excludedKey);
      setExcluded(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setExcluded(new Set());
    }
  }, [excludedKey]);
  const toggleExcluded = useCallback(
    (path: string) => {
      setExcluded((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        saveExcluded(next);
        return next;
      });
    },
    [saveExcluded],
  );
  const wasStreaming = useRef(streaming);
  const fetchToken = useRef(0);
  const [worktree, setWorktree] = useState<{
    branch: string;
    main: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    const token = ++fetchToken.current;
    // Independent of git: a failure here leaves the git view working.
    void Promise.all([
      api.changes(sessionKey, "turn", sessionPath),
      api.changes(sessionKey, "session", sessionPath),
    ])
      .then(([turn, session]) => {
        if (token === fetchToken.current) setRecorded({ turn, session });
      })
      .catch(() => {});
    try {
      const result = await api.gitChanges(sessionKey, cwd || "");
      lastSnapshot.set(cwd || "", result);
      if (token === fetchToken.current) {
        setData(result);
        // Prune exclusions whose files left the working tree (committed
        // elsewhere, reverted); the rest stay unchecked across turns.
        const paths = new Set((result.changes ?? []).map((c) => c.path));
        setExcluded((current) => {
          const next = new Set([...current].filter((p) => paths.has(p)));
          if (next.size === current.size) return current;
          saveExcluded(next);
          return next;
        });
      }
      // Is this session isolated? Only the main checkout's path differs, so
      // one call answers both "are we in a worktree" and "where is home".
      const trees = await api.worktrees(sessionKey, cwd || "");
      if (token === fetchToken.current) {
        const here = trees.worktrees?.find(
          (tree) => tree.path === trees.current,
        );
        setWorktree(
          here && !here.main
            ? {
                branch: here.branch,
                main: trees.worktrees?.find((tree) => tree.main)?.path ?? "",
              }
            : null,
        );
      }
    } catch {
      /* offline or unauthed; keep the previous snapshot */
    }
  }, [sessionKey, cwd, sessionPath]);

  // Same panel, new folder: show that folder's last snapshot, not this one's.
  useEffect(() => {
    setData(lastSnapshot.get(cwd || "") ?? null);
  }, [cwd]);

  // Initial load + explicit reloads (e.g. after a push).
  useEffect(() => {
    void refresh();
  }, [refresh, reloadToken]);

  // A turn that just finished (streaming -> idle) re-reads the working tree
  // and un-dismisses the card so fresh changes surface again.
  useEffect(() => {
    const was = wasStreaming.current;
    wasStreaming.current = streaming;
    if (was && !streaming) {
      setDismissed(false);
      setPushed(null);
      setFeedback(null);
      setReloadToken((token) => token + 1);
    }
  }, [streaming]);

  // The push receipt is a transient confirmation, not a fixture: clear it
  // after 20s so the composer area returns to rest.
  useEffect(() => {
    if (!pushed) return;
    const timer = window.setTimeout(() => setPushed(null), 20_000);
    return () => window.clearTimeout(timer);
  }, [pushed]);

  // Popover hygiene: a click outside any menu, or Escape, closes it.
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target as Element).closest?.(".changes__menu-wrap"))
        setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);

  const absPath = (path: string) =>
    cwd ? `${cwd.replace(/\/$/, "")}/${path}` : path;

  // The diff goes to the review pane, where it has room and line numbers.
  const openDiff = async (path: string, change?: GitChange) => {
    if (!onOpenDiff || opening) return;
    if (change && "diff" in change) {
      const entry = change as RecordedChange;
      if (entry.skipped)
        setFeedback({ ok: false, title: `${path} is too large to keep a diff of.` });
      else onOpenDiff({ title: absPath(path), diff: parseUnifiedDiff(entry.diff) });
      return;
    }
    setOpening(path);
    try {
      const result = await api.gitFileDiff(sessionKey, cwd || "", path);
      if (result.ok)
        onOpenDiff({
          title: absPath(path),
          diff: parseUnifiedDiff(result.diff ?? ""),
        });
      else
        setFeedback({
          ok: false,
          title: `Could not load the diff of ${path}.`,
          output: result.error,
        });
    } catch (error) {
      setFeedback({
        ok: false,
        title: `Could not load the diff of ${path}.`,
        output: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpening(null);
    }
  };

  // Discard = revert hunk 0 until none remain. Uncommitted work has no
  // reflog, so this is the one action that always asks first.
  const discardFile = async (path: string) => {
    if (busy) return;
    if (
      !window.confirm(`Discard every change to ${path}? This can't be undone.`)
    )
      return;
    setBusyOp("abort");
    try {
      for (let guard = 0; guard < 500; guard += 1) {
        const result = await api.revertHunk(sessionKey, cwd || "", path, 0);
        if (!result.ok) {
          setFeedback({
            ok: false,
            title: result.error ?? `Could not discard ${path}.`,
          });
          break;
        }
        if (!result.data?.remaining) break;
      }
    } finally {
      setBusyOp(null);
      setReloadToken((token) => token + 1);
    }
  };

  // `remote` false commits without pushing — the same staging path, minus the
  // network step, for work that is not ready to leave the machine.
  const commit = async (remote: boolean) => {
    if (pushBusy || busyOp) return;
    setMenu(null);
    const paths = included.map((change) => change.path);
    if (paths.length === 0) {
      setFeedback({
        ok: false,
        title: "No files selected — re-include a file first.",
      });
      return;
    }
    setPushBusy(true);
    try {
      const result = await api.gitCommitPush(
        sessionKey,
        cwd || "",
        message.trim() || "Update from devden",
        paths,
        remote,
      );
      if (result.ok) {
        setFeedback(null);
        setPushed({
          branch: data?.branch,
          output: result.output,
          files: paths.length,
          remote,
        });
        setMessage("");
        setReloadToken((token) => token + 1);
      } else {
        setFeedback({
          ok: false,
          title: remote ? "Push failed." : "Commit failed.",
          output: result.error,
        });
      }
    } catch (error) {
      setFeedback({
        ok: false,
        title: remote ? "Push failed." : "Commit failed.",
        output: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPushBusy(false);
    }
  };

  // Every secondary git op goes through here: one in flight at a time, one
  // result line, and a refresh so the header counters follow the repo.
  const runGit = async (op: GitOp, options?: GitOpOptions) => {
    setMenu(null);
    setBusyOp(op);
    try {
      const result = await api.gitRun(sessionKey, cwd || "", op, options);
      setFeedback(
        result.ok
          ? null
          : {
              ok: false,
              title: `${OP_LABEL[op]} failed.`,
              output: result.error ?? result.output,
            },
      );
      if (result.ok) setReloadToken((token) => token + 1);
      return result.ok;
    } catch (error) {
      setFeedback({
        ok: false,
        title: `${OP_LABEL[op]} failed.`,
        output: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setBusyOp(null);
    }
  };

  /**
   * Delete the checkout this session is sitting in. The tab has to move back
   * to the main tree first -- its cwd is about to stop existing.
   */
  const discardWorktree = async () => {
    if (!worktree?.main || busy) return;
    setMenu(null);
    setBusyOp("abort");
    try {
      let result = await api.removeWorktree(sessionKey, cwd || "", cwd || "");
      if (!result.ok && result.dirty) {
        const sure = window.confirm(
          `${worktree.branch} has uncommitted changes.\n\nDelete the worktree and lose them?`,
        );
        if (!sure) {
          setBusyOp(null);
          return;
        }
        result = await api.removeWorktree(
          sessionKey,
          cwd || "",
          cwd || "",
          true,
        );
      }
      if (!result.ok) {
        setFeedback({
          ok: false,
          title: "Could not delete the worktree.",
          output: result.error,
        });
        return;
      }
      onLeaveWorktree?.(worktree.main);
    } finally {
      setBusyOp(null);
    }
  };

  const changes = data?.changes ?? [];
  const sessionChanges = cwd
    ? changes.filter((change) => isSessionPath(change.path, sessionPaths, cwd))
    : [];
  // Recorded views know whose change is whose and outlive a commit; the
  // path filter is only for conversations recorded before that existed.
  const recordedSession = recorded.session?.files ?? [];
  const lists: Record<Scope, GitChange[]> = {
    turn: recorded.turn?.files ?? [],
    session: recordedSession.length ? recordedSession : sessionChanges,
    tree: changes,
  };
  const activeScope = scope;
  const shown = lists[activeScope];
  const sessionFiles = new Set(lists.session.map(file => file.path));
  const extraFileCount = changes.filter(change => !sessionFiles.has(change.path)).length;

  // Commit and discard act on the working tree, so a recorded row that has
  // since been committed (or reverted) is listed but not selectable.
  const dirty = new Set(changes.map((change) => change.path));
  const totalAdd = sumAdd(shown);
  const totalDel = sumDel(shown);
  const stashes = data?.stashes ?? [];
  const branches = data?.branches ?? [];
  const ahead = data?.ahead ?? 0;
  const behind = data?.behind ?? 0;
  const unpublished = data?.upstream === false;
  const connected = Boolean(data?.connected);
  const remoteBranches = data?.remoteBranches ?? [];
  const conflicts = data?.conflicts ?? [];
  // "Not clean" is the gate, not the conflict count: a merge stays in progress
  // after the last file is resolved, right up until it is concluded.
  const inProgress = Boolean(data?.state && data.state !== "clean");
  const verb = STATE_VERB[data?.state ?? ""] ?? "operation";
  const busy = pushBusy || busyOp !== null;
  const included = shown.filter(
    (change) => !excluded.has(change.path) && dirty.has(change.path),
  );
  // A partial selection stashes exactly what is shown and checked; all of it
  // stashes the tree, which is what "stash" means everywhere else.
  const stashPaths =
    included.length && included.length < changes.length
      ? included.map((change) => change.path)
      : undefined;

  // One button for the round trip: rebase onto upstream (the server
  // autostashes), then push whatever is local-only.
  const sync = async () => {
    if (behind > 0 && !(await runGit("pull-rebase"))) return;
    if (ahead > 0 || unpublished) await runGit("push");
  };
  const syncLabel = unpublished
    ? "Publish branch"
    : ahead && behind
      ? `Sync — pull ${behind}, push ${ahead}`
      : behind
        ? `Pull ${behind}`
        : ahead
          ? `Push ${ahead}`
          : "Up to date";

  const query = branchQuery.trim();
  const matches = (name: string) =>
    !query || name.toLowerCase().includes(query.toLowerCase());
  const localList = branches
    .filter((name) => name !== data?.branch && matches(name))
    .slice(0, query ? 8 : 5);
  const remoteList = remoteBranches.filter(matches).slice(0, query ? 6 : 3);
  const canCreate =
    query &&
    query !== data?.branch &&
    !branches.includes(query) &&
    !remoteBranches.includes(query);
  const pickBranch = () => {
    if (!query) return;
    setBranchQuery("");
    if (canCreate) void runGit("branch-create", { branch: query });
    else if (localList[0] ?? remoteList[0])
      void runGit("branch-switch", { branch: localList[0] ?? remoteList[0] });
  };

  const branchChip = (
    <div
      className="changes__menu-wrap"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="cdock__branch"
        aria-haspopup="menu"
        aria-expanded={menu === "branch"}
        disabled={busy}
        onClick={() => setMenu((open) => (open === "branch" ? null : "branch"))}
        title={
          worktree
            ? "Isolated worktree — other sessions cannot see these files"
            : "Branch, sync and stash"
        }
      >
        <IconBranch size={13} />
        {worktree && <span className="cdock__wt">worktree</span>}
        <span className="cdock__branch-name">
          {busyOp ? `${OP_LABEL[busyOp]}…` : data?.branch}
        </span>
        {!busyOp && (ahead > 0 || behind > 0) && (
          <span className="cdock__drift">
            {ahead > 0 && `↑${ahead}`}
            {ahead > 0 && behind > 0 && " "}
            {behind > 0 && `↓${behind}`}
          </span>
        )}
        <IconChevronDown size={11} />
      </button>
      {menu === "branch" && (
        <div className="changes__menu cdock__pop" role="menu">
          <input
            type="text"
            className="cdock__search"
            value={branchQuery}
            placeholder="Find or create a branch…"
            aria-label="Find or create a branch"
            autoFocus
            onChange={(event) => setBranchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                pickBranch();
              }
            }}
          />
          {!query && onWorkspaceClick && cwd && (
            <button
              type="button"
              role="menuitem"
              className="cdock__workspace"
              title={`${cwd} — change workspace`}
              onClick={() => {
                setMenu(null);
                onWorkspaceClick();
              }}
            >
              <span>
                <b>{folderName(cwd)}</b> {homeRelative(cwd)}
              </span>
              <span>change folder</span>
            </button>
          )}
          {!query && (
            <div className="cdock__sync">
              <div className="cdock__sync-row">
                <strong>{data?.branch}</strong>
                <span>
                  {unpublished
                    ? "not on the remote yet"
                    : connected
                      ? "vs upstream"
                      : "no remote"}
                </span>
                <span className="cdock__drift">
                  {behind > 0 && `↓${behind} `}
                  {ahead > 0 && `↑${ahead}`}
                </span>
              </div>
              <div className="cdock__sync-row">
                <button
                  type="button"
                  className="changes__push cdock__sync-go"
                  disabled={
                    !connected ||
                    inProgress ||
                    (!unpublished && !ahead && !behind)
                  }
                  onClick={() => void sync()}
                >
                  {syncLabel}
                </button>
                <button
                  type="button"
                  className="cdock__icon"
                  aria-label="Fetch from remote"
                  title="Fetch from remote"
                  disabled={!connected}
                  onClick={() => void runGit("fetch")}
                >
                  <IconRefresh size={13} />
                </button>
              </div>
              {/* Only for commits the remote has not seen: a soft reset there
                  can never leave the branch needing a force-push. */}
              {ahead > 0 && !inProgress && (
                <button
                  type="button"
                  className="cdock__link"
                  onClick={() => void runGit("undo-commit")}
                >
                  Undo last commit — keeps the changes
                </button>
              )}
            </div>
          )}
          {canCreate && (
            <button type="button" role="menuitem" onClick={pickBranch}>
              Create <b className="cdock__mono">{query}</b>
              <span>new branch</span>
            </button>
          )}
          {(localList.length > 0 || remoteList.length > 0) && (
            <p className="changes__menu-head">{query ? "Branches" : "Recent"}</p>
          )}
          {localList.map((name) => (
            <button
              key={name}
              type="button"
              role="menuitem"
              onClick={() => void runGit("branch-switch", { branch: name })}
            >
              <span className="cdock__mono">{name}</span>
              <span>switch</span>
            </button>
          ))}
          {remoteList.map((name) => (
            <button
              key={`remote:${name}`}
              type="button"
              role="menuitem"
              onClick={() => void runGit("branch-switch", { branch: name })}
            >
              <span className="cdock__mono">{name}</span>
              <span>from remote</span>
            </button>
          ))}
          {stashes.length > 0 && !query && (
            <>
              <p className="changes__menu-head">Stashed · {stashes.length}</p>
              {stashes.map((stash) => (
                <div key={stash.ref} className="changes__stash">
                  <span className="changes__stash-label" title={stash.label}>
                    {stashLabel(stash.label, stash.ref)}
                  </span>
                  <span className="changes__stash-acts">
                    <span className="changes__stash-age">{stash.age}</span>
                    <button
                      type="button"
                      title="Apply and remove this stash"
                      onClick={() =>
                        void runGit("stash-pop", { ref: stash.ref })
                      }
                    >
                      Pop
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      title="Delete this stash for good"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Drop ${stash.ref}? Its changes are gone for good.`,
                          )
                        )
                          void runGit("stash-drop", { ref: stash.ref });
                      }}
                    >
                      Drop
                    </button>
                  </span>
                </div>
              ))}
            </>
          )}
          {!query && (changes.length > 0 || worktree) && (
            <div className="cdock__pop-foot">
              <span>
                {changes.length
                  ? `${plural(changes.length, "uncommitted change")} travel with you`
                  : `Worktree · ${worktree?.branch}`}
              </span>
              {changes.length > 0 && (
                <button
                  type="button"
                  disabled={inProgress}
                  onClick={() =>
                    void runGit("stash", {
                      ...(message.trim() ? { message: message.trim() } : {}),
                      ...(stashPaths ? { files: stashPaths } : {}),
                    })
                  }
                >
                  {stashPaths ? `Stash ${stashPaths.length}` : "Stash"}
                </button>
              )}
              {worktree && (
                <button
                  type="button"
                  disabled={!worktree.main}
                  title="Delete this worktree and go back to the main checkout"
                  onClick={() => void discardWorktree()}
                >
                  Delete worktree
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );

  // While a merge/rebase is unfinished this replaces the commit footer: the
  // three things you can actually do, and no path to committing markers.
  const conflictBar = inProgress && (
    <div className="changes__conflict">
      <p className="changes__conflict-text">
        <strong>
          {conflicts.length > 0
            ? `Conflict in ${plural(conflicts.length, "file")}`
            : `${verb[0].toUpperCase()}${verb.slice(1)} in progress`}
        </strong>{" "}
        {conflicts.length > 0
          ? `— fix the markers, then continue the ${verb}. Committing is blocked until then.`
          : "— finish it or abort it before committing."}
      </p>
      <div className="changes__conflict-acts">
        {onAskAgent && conflicts.length > 0 && (
          <button
            type="button"
            className="changes__conflict-ask"
            onClick={() =>
              onAskAgent(
                `Resolve the git ${verb} conflict in: ${conflicts.join(", ")}. Edit each file to remove the conflict markers, keeping the right combination of both sides. Don't commit — I'll finish the ${verb} from the UI.`,
              )
            }
          >
            Ask the agent to resolve
          </button>
        )}
        <button
          type="button"
          className="changes__conflict-continue"
          disabled={busy}
          onClick={() => void runGit("continue")}
          title={`Stage the resolved files and finish the ${verb}`}
        >
          {busyOp === "continue" ? "Continuing…" : `Continue ${verb}`}
        </button>
        <button
          type="button"
          className="changes__conflict-abort"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                `Abort the ${verb}? The repo goes back to where it was before it started.`,
              )
            )
              void runGit("abort");
          }}
        >
          {busyOp === "abort" ? "Aborting…" : `Abort ${verb}`}
        </button>
      </div>
    </div>
  );

  const failure = feedback && !feedback.ok && (
    <div className="changes__error" role="alert">
      <strong>{feedback.title}</strong>
      {feedback.output && <pre>{feedback.output.trim().slice(0, 800)}</pre>}
    </div>
  );

  const dismiss = (
    <button
      type="button"
      className="changes__dismiss"
      aria-label="Dismiss changes"
      title="Dismiss"
      onClick={() => setDismissed(true)}
    >
      ×
    </button>
  );

  // Dismissing the card must not swallow a git error the user has not read.
  if (!data?.repo || dismissed)
    return (
      <>
        {failure}
        {dismissed && restoreHost && createPortal(<button type="button" className="delta-restore" onClick={() => setDismissed(false)}>Delta +{fmtCount(totalAdd)} −{fmtCount(totalDel)}</button>, restoreHost)}
        {actions}
      </>
    );

  // Dense panes already show the folder in the header, so a clean tree stays quiet.
  if (changes.length === 0 && lists.session.length === 0 && compact && !pushed && !inProgress)
    return (
      <>
        {failure}
        {actions}
      </>
    );

  // Nothing to commit: a one-line repo bar keeps the branch menu reachable,
  // and local-only commits get the one button that matters next — Push.
  if (changes.length === 0 && lists.session.length === 0) {
    return (
      <section
        className={`changes cdock changes--clean${pushed ? " changes--pushed" : ""}${
          inProgress ? " changes--conflict" : ""
        }`}
        aria-label={pushed ? "Committed" : "Repository"}
      >
        <header className="changes__head cdock__head">
          {pushed && (
            <span className="changes__check" aria-hidden>
              ✓
            </span>
          )}
          <strong>
            {pushed
              ? pushed.remote
                ? "Pushed to GitHub"
                : "Committed locally"
              : "No changes"}
          </strong>
          {pushed && (
            <span className="changes__meta">
              {plural(pushed.files, "file")}
            </span>
          )}
          <span className="cdock__spacer" />
          {branchChip}
          {(ahead > 0 || unpublished) && connected && !inProgress && (
            <button
              type="button"
              className="changes__push"
              disabled={busy}
              onClick={() => void runGit("push")}
            >
              {busyOp === "push"
                ? "Pushing…"
                : unpublished
                  ? "Publish branch"
                  : `Push ↑${ahead}`}
            </button>
          )}
          {worktree && !inProgress && (
            <button
              type="button"
              className="changes__expand cdock__text-btn"
              disabled={busy}
              onClick={() => void runGit("pr")}
            >
              Open PR
            </button>
          )}
          {actions}
          {dismiss}
        </header>
        {pushed?.output && (
          <pre className="changes__output">{pushed.output.slice(0, 800)}</pre>
        )}
        {conflictBar}
        {failure}
      </section>
    );
  }

  // Clicking anywhere on the header (except a real control) toggles the card.
  const headerClick = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest("button, input, [role=menu]"))
      return;
    toggleCollapsed();
  };
  const groups = groupByDir(shown);
  const grouped = false;

  const row = (change: GitChange) => {
    const name = change.path.split("/").at(-1);
    const dir = change.path.slice(0, change.path.lastIndexOf("/") + 1);
    const total = change.additions + change.deletions || 1;
    const isExcluded = excluded.has(change.path);
    const entry = "diff" in change ? (change as RecordedChange) : null;
    const inTree = dirty.has(change.path);
    return (
      <li
        key={change.path}
        className={`cdock__row${isExcluded ? " is-excluded" : ""}${
          opening === change.path ? " is-loading" : ""
        }`}
      >
        <input
          type="checkbox"
          className="cdock__check"
          checked={!isExcluded && inTree}
          onChange={() => toggleExcluded(change.path)}
          aria-label={`Include ${change.path} in the commit`}
          title={
            !inTree
              ? "No uncommitted changes left in this file"
              : isExcluded
                ? "Not in the commit"
                : "In the commit"
          }
          disabled={busy || !inTree}
        />
        <button
          type="button"
          className="cdock__file"
          title={change.path}
          onClick={() => void openDiff(change.path, change)}
        >
          <span className="fbadge" data-kind={fileKind(change.path)}>
            {fileKind(change.path)}
          </span>
          <span className={`delta-status is-${change.status}`}>{change.status === "added" ? "A" : change.status === "deleted" ? "D" : "M"}</span><span className="cdock__name">{name}</span><small className="delta-dir">{dir}</small>
          {change.status !== "modified" && (
            <span className={`cdock__tag is-${change.status}`}>
              {change.status === "added"
                ? "new"
                : change.status === "deleted"
                  ? "deleted"
                  : "conflict"}
            </span>
          )}
          {entry?.shared && (
            <span
              className="cdock__tag is-shared"
              title="Another session in this checkout also changed this file — the diff may include its edits."
            >
              shared
            </span>
          )}
          {entry && !entry.shared && !entry.exact && (
            <span
              className="cdock__tag is-shared"
              title="Something else changed this file between this session's turns — the diff may include those edits."
            >
              mixed
            </span>
          )}
          {entry?.source === "command" && (
            <span
              className="cdock__tag is-command"
              title="Changed by a shell command, not an edit tool."
            >
              cmd
            </span>
          )}
          {entry?.drift && (
            <span
              className="cdock__tag is-drift"
              title="The file has changed again since — the diff shows it as this view left it."
            >
              edited since
            </span>
          )}
          <span className="cdock__stat">
            <b title={change.additions.toLocaleString()}>+{fmtCount(change.additions)}</b>
            <i title={change.deletions.toLocaleString()}>−{fmtCount(change.deletions)}</i>
          </span>
          <span className="cdock__bar" aria-hidden>
            <span style={{ flexGrow: change.additions / total }} />
            <span style={{ flexGrow: change.deletions / total }} />
          </span>
        </button>
        {change.status === "modified" && !entry && (
          <button
            type="button"
            className="cdock__icon cdock__discard"
            aria-label={`Discard changes to ${change.path}`}
            title="Discard changes"
            disabled={busy}
            onClick={() => void discardFile(change.path)}
          >
            <IconRestore size={13} />
          </button>
        )}
      </li>
    );
  };

  return (
    <section
      className={`changes cdock${inProgress ? " changes--conflict" : ""}${
        collapsed ? " changes--collapsed" : ""
      }${compact ? " changes--dense" : ""}`}
      aria-label="Code changes"
      data-scope={activeScope}
    >
      <header className="changes__head cdock__head" onClick={headerClick}>
        <button
          type="button"
          className="cdock__title"
          aria-expanded={!collapsed}
          onClick={toggleCollapsed}
        >
          <span
            className={`changes__pill-chevron${collapsed ? " is-closed" : ""}`}
            aria-hidden
          >
            <IconChevronDown size={13} />
          </span>
          <strong>Delta</strong>
          <span className="cdock__count">{plural(shown.length, "file")}</span>
        </button>
        {(
          <div className="cdock__seg" role="tablist" aria-label="Scope">
            <button type="button" role="tab" aria-selected={activeScope === "session"} onClick={() => setScope("session")}><span className="delta-session-label">Session</span><span className="delta-this-label">This</span> <span>{lists.session.length}</span></button>
            <button
              type="button"
              role="tab"
              aria-selected={activeScope === "tree"}
              onClick={() => setScope("tree")}
            >
              All <span>{changes.length}</span>
            </button>
          </div>
        )}
        <span className="delta-ratio" aria-hidden="true"><i style={{ flex: totalAdd || 0 }} /><i style={{ flex: totalDel || 0 }} /></span>
        <span className="changes__diffstat">
          <b title={totalAdd.toLocaleString()}>+{fmtCount(totalAdd)}</b>
          <i title={totalDel.toLocaleString()}>−{fmtCount(totalDel)}</i>
        </span>
        <span className="cdock__spacer" />

        {onOpenChanges && (
          <button
            type="button"
            className="changes__expand"
            aria-label="Open changes in workspace"
            title="Open changes in workspace"
            onClick={(event) => {
              event.stopPropagation();
              onOpenChanges();
            }}
          >
            <IconExpand size={13} />
          </button>
        )}
        {dismiss}
      </header>
      {!collapsed && (
        <ul className="cdock__files">
          {grouped
            ? groups.map(([dir, list]) => {
                const open = !closedDirs.has(dir);
                return (
                  <li key={dir || "."} className="cdock__group">
                    <button
                      type="button"
                      className="cdock__dir"
                      aria-expanded={open}
                      onClick={() =>
                        setClosedDirs((current) => {
                          const next = new Set(current);
                          if (open) next.add(dir);
                          else next.delete(dir);
                          return next;
                        })
                      }
                    >
                      <span
                        className={`changes__pill-chevron${open ? "" : " is-closed"}`}
                        aria-hidden
                      >
                        <IconChevronDown size={11} />
                      </span>
                      <span className="cdock__mono">{dir ? `${dir}/` : "./"}</span>
                      <span className="cdock__dim">{plural(list.length, "file")}</span>
                      <span className="cdock__spacer" />
                      <span className="cdock__stat">
                        <b>+{sumAdd(list).toLocaleString()}</b>
                        <i>−{sumDel(list).toLocaleString()}</i>
                      </span>
                    </button>
                    {open && <ul>{list.map(row)}</ul>}
                  </li>
                );
              })
            : shown.map(row)}
          {activeScope === "tree" && extraFileCount > 0 && <li className="delta-more">{extraFileCount} more files in {folderName(cwd || "workspace")}</li>}
        </ul>
      )}
      {!collapsed && conflictBar}
      {!collapsed && !inProgress && (
        <footer className="changes__foot cdock__foot">
          {branchChip}
          {actions}
          <input
            type="text"
            className="changes__commit-input"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                void commit(false);
            }}
            placeholder="Commit message (optional)"
            aria-label="Commit message"
            disabled={busy}
          />
          <div
            className="changes__menu-wrap cdock__split"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="changes__push"
              onClick={() => void commit(false)}
              disabled={busy || included.length === 0}
              title={included.length === 0 ? "No files selected" : "⌘↵"}
            >
              {pushBusy ? "Committing…" : `Commit ${plural(included.length, "file")}`}
            </button>
            <button
              type="button"
              className="changes__push cdock__caret"
              aria-label="More commit options"
              aria-haspopup="menu"
              aria-expanded={menu === "commit"}
              disabled={busy}
              onClick={() =>
                setMenu((open) => (open === "commit" ? null : "commit"))
              }
            >
              <IconChevronDown size={12} />
            </button>
            {menu === "commit" && (
              <div className="changes__menu cdock__pop is-up" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  disabled={included.length === 0 || !connected}
                  onClick={() => void commit(true)}
                >
                  Commit &amp; push <span>to GitHub</span>
                </button>
              </div>
            )}
          </div>
        </footer>
      )}
      {failure}
    </section>
  );
}
