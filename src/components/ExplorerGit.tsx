import { useMemo, useState } from "react";
import {
  api,
  type GitChange,
  type GitChangesResponse,
  type GitOp,
  type GitOpOptions,
} from "../lib/api";
import { fmtCount } from "../lib/workbenchLook";
import {
  IconBranch,
  IconChevronDown,
  IconDownload,
  IconHistory,
  IconRefresh,
  IconTrash,
  IconUpload,
} from "./icons";

const LETTER: Record<GitChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  conflicted: "C",
};

interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  files: GitChange[];
  additions: number;
  deletions: number;
  count: number;
}

/** Nest changed paths by folder; a folder with one subfolder and no files
 *  folds into it ("src/components"), like VS Code's compact folders. */
export function groupChanges(changes: readonly GitChange[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], files: [], additions: 0, deletions: 0, count: 0 };
  for (const change of changes) {
    const parts = change.path.split("/");
    parts.pop();
    let node = root;
    const chain = [node];
    for (const part of parts) {
      const path = node.path ? `${node.path}/${part}` : part;
      let next = node.folders.find((folder) => folder.path === path);
      if (!next) {
        next = { name: part, path, folders: [], files: [], additions: 0, deletions: 0, count: 0 };
        node.folders.push(next);
      }
      node = next;
      chain.push(node);
    }
    node.files.push(change);
    for (const folder of chain) {
      folder.additions += change.additions;
      folder.deletions += change.deletions;
      folder.count += 1;
    }
  }
  const compact = (folder: Folder): Folder => {
    let node = folder;
    while (node.files.length === 0 && node.folders.length === 1) {
      const only = node.folders[0]!;
      node = { ...only, name: `${node.name}/${only.name}` };
    }
    return { ...node, folders: node.folders.map(compact).sort((a, b) => a.name.localeCompare(b.name)) };
  };
  return { ...root, folders: root.folders.map(compact).sort((a, b) => a.name.localeCompare(b.name)) };
}

/**
 * The explorer's Changes tab: branch + sync bar, commit box, the change list
 * grouped into collapsible folders, and recent commits.
 */
export function ExplorerGit({
  sessionKey,
  root,
  info,
  changes,
  activePath,
  onOpen,
  onReload,
}: {
  sessionKey: string;
  root: string;
  info: GitChangesResponse | null;
  changes: readonly GitChange[];
  activePath: string | null;
  onOpen: (path: string) => void;
  onReload: () => void;
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [unstaged, setUnstaged] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const tree = useMemo(() => groupChanges(changes), [changes]);
  const staged = changes.filter((change) => !unstaged.has(change.path));

  const run = async (op: GitOp, options?: GitOpOptions, label: string = op) => {
    if (busy) return false;
    setBusy(label);
    setFeedback(null);
    try {
      const result = await api.gitRun(sessionKey, root, op, options);
      setFeedback(result.ok ? { ok: true, text: `${label} done` } : { ok: false, text: result.error ?? `${label} failed` });
      return result.ok;
    } catch (error) {
      setFeedback({ ok: false, text: error instanceof Error ? error.message : `${label} failed` });
      return false;
    } finally {
      setBusy(null);
      onReload();
    }
  };

  const commit = async (push: boolean) => {
    const text = message.trim();
    if (!text || staged.length === 0) return;
    const files = unstaged.size ? staged.map((change) => change.path) : undefined;
    if (await run(push ? "commit-push" : "commit", { message: text, files }, push ? "Commit & push" : "Commit")) {
      setMessage("");
      setUnstaged(new Set());
    }
  };

  const discard = async (path: string) => {
    if (busy || !window.confirm(`Discard every change to ${path}? This can't be undone.`)) return;
    setBusy("discard");
    try {
      for (let guard = 0; guard < 500; guard += 1) {
        const result = await api.revertHunk(sessionKey, root, path, 0);
        if (!result.ok) {
          setFeedback({ ok: false, text: result.error ?? `Could not discard ${path}` });
          break;
        }
        if (!result.data?.remaining) break;
      }
    } finally {
      setBusy(null);
      onReload();
    }
  };

  const toggle = <T,>(set: ReadonlySet<T>, value: T) => {
    const next = new Set(set);
    if (!next.delete(value)) next.add(value);
    return next;
  };
  const toggleFolder = (folder: Folder) => {
    const paths = changesUnder(folder).map((change) => change.path);
    const allOn = paths.every((path) => !unstaged.has(path));
    const next = new Set(unstaged);
    for (const path of paths) allOn ? next.add(path) : next.delete(path);
    setUnstaged(next);
  };

  const renderFolder = (folder: Folder, depth: number): React.ReactNode => {
    const open = !closed.has(folder.path);
    const under = changesUnder(folder);
    const on = under.filter((change) => !unstaged.has(change.path)).length;
    return (
      <div key={folder.path} className="egit-folder" role="group">
        <div className="egit-row egit-row--folder" style={{ paddingLeft: 2 + depth * 10 }}>
          <input type="checkbox" aria-label={`Stage ${folder.name}`} checked={on === under.length} ref={(el) => { if (el) el.indeterminate = on > 0 && on < under.length; }} onChange={() => toggleFolder(folder)} />
          <button type="button" className="egit-row__main" aria-expanded={open} onClick={() => setClosed(toggle(closed, folder.path))}>
            <span className={`egit-chevron${open ? " is-open" : ""}`}><IconChevronDown size={11} /></span>
            <span className="egit-row__name">{folder.name}</span>
            <span className="egit-row__count">{folder.count}</span>
          </button>
          <span className="egit-stats">{folder.additions > 0 && <b>+{fmtCount(folder.additions)}</b>}{folder.deletions > 0 && <i>−{fmtCount(folder.deletions)}</i>}</span>
        </div>
        {open && (
          <>
            {folder.folders.map((child) => renderFolder(child, depth + 1))}
            {folder.files.map((change) => renderFile(change, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const renderFile = (change: GitChange, depth: number) => (
    <div key={change.path} className={`egit-row egit-row--file${activePath === change.path ? " is-active" : ""}`} style={{ paddingLeft: 2 + depth * 10 }} title={change.path}>
      <input type="checkbox" aria-label={`Stage ${change.path}`} checked={!unstaged.has(change.path)} onChange={() => setUnstaged(toggle(unstaged, change.path))} />
      <button type="button" className="egit-row__main" onClick={() => onOpen(change.path)}>
        <span className={`egit-status is-${change.status}`}>{LETTER[change.status]}</span>
        <span className="egit-row__name">{change.path.split("/").at(-1)}</span>
      </button>
      <button type="button" className="egit-row__discard" aria-label={`Discard ${change.path}`} title="Discard changes" onClick={() => void discard(change.path)}><IconTrash size={12} /></button>
      <span className="egit-stats">{change.additions > 0 && <b>+{fmtCount(change.additions)}</b>}{change.deletions > 0 && <i>−{fmtCount(change.deletions)}</i>}</span>
    </div>
  );

  const branches = [...(info?.branches ?? []), ...(info?.remoteBranches ?? [])];
  const branch = info?.branch ?? "";
  const ahead = info?.ahead ?? 0;
  const behind = info?.behind ?? 0;

  return (
    <div className="egit" aria-busy={Boolean(busy)}>
      <div className="egit-bar">
        <label className="egit-branch" title="Switch branch">
          <IconBranch size={13} />
          <select value={branch} disabled={Boolean(busy)} onChange={(event) => {
            const value = event.target.value;
            if (value === "__new") {
              const name = window.prompt("New branch name")?.trim();
              if (name) void run("branch-create", { branch: name }, "Create branch");
            } else if (value !== branch) void run("branch-switch", { branch: value }, "Switch branch");
          }}>
            {!branches.includes(branch) && branch && <option value={branch}>{branch}</option>}
            {branches.map((name) => <option key={name} value={name}>{name}</option>)}
            <option value="__new">+ New branch…</option>
          </select>
        </label>
        <span className="egit-bar__spacer" />
        <button type="button" className="egit-icon" title="Fetch" aria-label="Fetch" disabled={Boolean(busy)} onClick={() => void run("fetch", undefined, "Fetch")}><IconRefresh size={13} /></button>
        <button type="button" className="egit-icon" title={`Pull${behind ? ` (${behind} behind)` : ""}`} aria-label="Pull" disabled={Boolean(busy) || !info?.connected} onClick={() => void run("pull", undefined, "Pull")}><IconDownload size={13} />{behind > 0 && <small>{behind}</small>}</button>
        <button type="button" className="egit-icon" title={`Push${ahead ? ` (${ahead} ahead)` : ""}`} aria-label="Push" disabled={Boolean(busy) || !info?.connected} onClick={() => void run("push", undefined, "Push")}><IconUpload size={13} />{ahead > 0 && <small>{ahead}</small>}</button>
      </div>

      <div className="egit-commit">
        <textarea
          rows={2}
          value={message}
          placeholder={`Message (${staged.length} of ${changes.length} staged)`}
          aria-label="Commit message"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void commit(false);
            }
          }}
        />
        <div className="egit-commit__actions">
          <button type="button" className="egit-primary" disabled={Boolean(busy) || !message.trim() || staged.length === 0} onClick={() => void commit(false)} title="Commit staged files (⌘↩)">{busy === "Commit" ? "Committing…" : "Commit"}</button>
          <button type="button" className="egit-secondary" disabled={Boolean(busy) || !message.trim() || staged.length === 0 || !info?.connected} onClick={() => void commit(true)}>{busy === "Commit & push" ? "Pushing…" : "Commit & Push"}</button>
          <button type="button" className="egit-secondary" disabled={Boolean(busy) || changes.length === 0} title="Stash all changes" onClick={() => void run("stash", undefined, "Stash")}>Stash</button>
        </div>
        {feedback && <div className={`egit-feedback${feedback.ok ? "" : " is-error"}`} role={feedback.ok ? "status" : "alert"}>{feedback.text}</div>}
      </div>

      <div className="egit-list">
        {tree.folders.map((folder) => renderFolder(folder, 0))}
        {tree.files.map((change) => renderFile(change, 0))}
      </div>

      {(info?.stashes?.length ?? 0) > 0 && (
        <div className="egit-section">
          <div className="egit-section__head">Stashes</div>
          {info!.stashes!.map((stash) => (
            <div key={stash.ref} className="egit-log-row">
              <span className="egit-log-row__subject">{stash.label}</span>
              <button type="button" className="egit-link" disabled={Boolean(busy)} onClick={() => void run("stash-pop", { ref: stash.ref }, "Pop stash")}>Pop</button>
            </div>
          ))}
        </div>
      )}

      {(info?.log?.length ?? 0) > 0 && (
        <div className="egit-section">
          <button type="button" className="egit-section__head" aria-expanded={historyOpen} onClick={() => setHistoryOpen((value) => !value)}>
            <span className={`egit-chevron${historyOpen ? " is-open" : ""}`}><IconChevronDown size={11} /></span>
            <IconHistory size={12} /> Recent commits
          </button>
          {historyOpen && info!.log!.map((entry, index) => (
            <div key={entry.hash} className="egit-log-row" title={entry.subject}>
              <code>{entry.hash}</code>
              <span className="egit-log-row__subject">{entry.subject}</span>
              <small>{entry.age}</small>
              {index === 0 && ahead > 0 && <button type="button" className="egit-link" disabled={Boolean(busy)} title="Undo this unpushed commit, keeping its changes" onClick={() => void run("undo-commit", undefined, "Undo commit")}>Undo</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function changesUnder(folder: Folder): GitChange[] {
  return [...folder.files, ...folder.folders.flatMap(changesUnder)];
}
