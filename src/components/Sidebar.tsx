import { useAnchoredPopover } from "../lib/anchoredPopover";
import { SESSION_DRAG_TYPE, startSessionDrag } from "../lib/dockLayout";
import { AppUpdateFooter } from "./AppUpdateFooter";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useStore } from "../lib/store";
import { createPortal } from "react-dom";
import {
  api,
  backendLabel,
  backendMark,
  type AgentBackend,
  type ResumeSession,
  type SessionSearchResult,
} from "../lib/api";
import { pickerBackendIds } from "../lib/agentAvailability.ts";
import type { WorkbenchView } from "../lib/navigation";
import { formatRelativeTime } from "../lib/time";
import { formatClaudeModelName, isClaudeModel } from "../lib/claudeModels";
import { savedSessionTitle } from "../lib/sessionTitle";
import { textAwaitsAnswer } from "../lib/awaitingAnswer";
import {
  formatSessionModelName,
  sessionDisplayModel,
  sessionFilterCatalog,
  sessionMatchesFilters,
  sessionMetaLine,
} from "../lib/sessionModels";
import { BACKEND_DEFAULT_MODEL, type ConversationTab } from "../lib/store";
import { MAX_SPLIT_PANES } from "../lib/sessionLayout";
import {
  FishLogo,
  IconArchive,
  IconChevronDown,
  IconCode,
  IconCube,
  IconDots,
  IconExtension,
  IconFilter,
  IconFolder,
  IconMoon,
  IconNewChat,
  IconOpenTab,
  IconPanel,
  IconKanban,
  IconPencil,
  IconRestore,
  IconSearch,
  IconSettings,
  IconSun,
  IconTrash,
  IconPlus,
  IconTerminal,
  BackendLogo,
  ModelName,
} from "./icons";

function workspaceLabel(cwd: string): string {
  if (/^\/Users\/[^/]+\/?$/.test(cwd)) return "Home";
  return cwd.split("/").filter(Boolean).at(-1) || cwd || "Other";
}

const FILTERS_KEY = "devden.session-filters";
const LEGACY_MODEL_FILTER_KEY = "devden.session-model-filter";
// Sidebar folders show the last 12h of sessions inline; older ones hide
// behind a "Show N older sessions" toggle.
const RECENT_WINDOW_MS = 12 * 60 * 60 * 1000;

function loadSessionFilters(): { backends: AgentBackend[]; models: string[] } {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        backends?: unknown;
        models?: unknown;
      };
      const backends = Array.isArray(parsed.backends)
        ? parsed.backends.filter(
            (value): value is AgentBackend =>
              typeof value === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(value),
          )
        : [];
      const models = Array.isArray(parsed.models)
        ? parsed.models.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      return { backends, models };
    }
    const legacy = localStorage.getItem(LEGACY_MODEL_FILTER_KEY) || "";
    return { backends: [], models: legacy ? [legacy] : [] };
  } catch {
    return { backends: [], models: [] };
  }
}

function persistSessionFilters(next: {
  backends: AgentBackend[];
  models: string[];
}) {
  localStorage.setItem(FILTERS_KEY, JSON.stringify(next));
  if (next.models.length === 1 && next.backends.length === 0)
    localStorage.setItem(LEGACY_MODEL_FILTER_KEY, next.models[0]!);
  else localStorage.removeItem(LEGACY_MODEL_FILTER_KEY);
}

function backendModelLine(
  backend: AgentBackend,
  tabs: ConversationTab[],
  sessions: ResumeSession[],
): string {
  // One model id, labelled for this backend. Claude reports Claude models
  // only, so a session that recorded a foreign id (a proxied or experimental
  // run) must not become the row's model.
  const label = (raw: string | undefined): string | null => {
    const value = String(raw ?? "").trim();
    if (!value) return null;
    const id = value.includes("/")
      ? value.slice(value.lastIndexOf("/") + 1)
      : value;
    if (backend === "claude")
      return isClaudeModel(id) ? formatClaudeModelName(id) : null;
    return formatSessionModelName(id);
  };
  const live = [...tabs]
    .reverse()
    .find((tab) => tab.backend === backend && tab.timeline.state?.model);
  const model = live?.timeline.state?.model;
  const fromTab = label(model?.id || model?.name);
  if (fromTab) return fromTab;
  for (const session of sessions) {
    if (session.backend !== backend) continue;
    const fromSession = label(sessionDisplayModel(session));
    if (fromSession) return fromSession;
  }
  return label(BACKEND_DEFAULT_MODEL[backend]?.id) ?? "";
}

export function Sidebar({
  collapsed,
  onToggle,
  theme,
  onThemeToggle,
  view,
  onViewChange,
  splitSessions,
  onSplitSessionsToggle,
  onSessionFocus,
  onSessionSplit,
  onPaneLimit,
  openTabKeys,
  paneCount = openTabKeys.length,
  terminalOpen = false,
  onTerminalToggle,
  onResizePointerDown,
  onResizeKeyDown,
}: {
  collapsed: boolean;
  onToggle: () => void;
  theme: "light" | "dark";
  onThemeToggle: () => void;
  view: WorkbenchView;
  onViewChange: (view: WorkbenchView) => void;
  splitSessions: boolean;
  onSplitSessionsToggle: () => void;
  onSessionFocus: (key: string) => void;
  onSessionSplit: (key: string) => void;
  /** A split button was used with the grid already full. */
  onPaneLimit: () => void;
  openTabKeys: string[];
  paneCount?: number;
  terminalOpen?: boolean;
  onTerminalToggle?: () => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  /** Opens the redesign's settings modal from the footer button. */
  onOpenSettings?: () => void;
}) {
  const [sessionView, setSessionView] = useState<"recent" | "archived">(
    "recent",
  );
  const [appliedFilters, setAppliedFilters] = useState<{
    backends: AgentBackend[];
    models: string[];
  }>(() => loadSessionFilters());
  const [draftBackends, setDraftBackends] = useState<Set<AgentBackend>>(
    () => new Set(loadSessionFilters().backends),
  );
  const [draftModels, setDraftModels] = useState<Set<string>>(
    () => new Set(loadSessionFilters().models),
  );
  const [filterQuery, setFilterQuery] = useState("");
  const [expandedFilterAgent, setExpandedFilterAgent] =
    useState<AgentBackend | null>(null);
  // Full-text search across saved transcripts, not just their titles.
  const [transcriptQuery, setTranscriptQuery] = useState("");
  const [transcriptHits, setTranscriptHits] = useState<SessionSearchResult[]>(
    [],
  );
  const [transcriptSearching, setTranscriptSearching] = useState(false);
  // Collapsed by default: search and filters open from icons in the header.
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [openSessionMenu, setOpenSessionMenu] = useState<string | null>(null);

  const [openWorkspaceMenu, setOpenWorkspaceMenu] = useState<string | null>(
    null,
  );
  const [backendMenuOpen, setBackendMenuOpen] = useState(false);
  // Debounced: reading transcripts is far heavier than filtering titles, so
  // it waits for a pause in typing rather than firing per keystroke.
  useEffect(() => {
    const query = transcriptQuery.trim();
    if (query.length < 2) {
      setTranscriptHits([]);
      setTranscriptSearching(false);
      return;
    }
    let cancelled = false;
    setTranscriptSearching(true);
    const timer = window.setTimeout(() => {
      void api
        .searchSessions(query, "all")
        .then((result) => {
          if (cancelled) return;
          setTranscriptHits(result.ok ? (result.results ?? []) : []);
          setTranscriptSearching(false);
        })
        .catch(() => {
          if (cancelled) return;
          setTranscriptHits([]);
          setTranscriptSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [transcriptQuery]);

  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<
    ReadonlySet<string>
  >(new Set());
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const initializedWorkspaceGroups = useRef(false);
  const {
    tabs,
    activeKey,
    workingKeys,
    awaitingKeys,
    setActiveKey,
    closeConversation,
    openDefaultConversation,
    openConversation,
    resumeConversation,
    revealWorkspace,
    resumeSessions,
    archivedSessions,
    sessionsLoaded,
    archiveSession,
    restoreSession,
    deleteSession,
    deleteWorkspace,
    defaultBackend,
    setDefaultBackend,
    backendCatalog,
  } = useStore();
  const backendIds = pickerBackendIds(backendCatalog);
  // The agent a NEW session starts on. Saved sessions always reopen on the
  // agent that wrote them, so the sidebar lists every backend at once.
  const currentBackend: AgentBackend = defaultBackend;

  const openTabs = openTabKeys.flatMap((key) => {
    const tab = tabs.find((candidate) => candidate.key === key);
    return tab ? [tab] : [];
  });
  const runningPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const tab of tabs) {
      if (!workingKeys.has(tab.key)) continue;
      const path = tab.sessionPath ?? tab.timeline.state?.sessionFile;
      if (path) paths.add(path);
    }
    return paths;
  }, [tabs, workingKeys]);
  const savedSessions =
    sessionView === "archived" ? archivedSessions : resumeSessions;
  const filterCatalog = useMemo(
    () => sessionFilterCatalog(savedSessions),
    [savedSessions, backendCatalog],
  );
  const backendFilter = useMemo(
    () =>
      appliedFilters.backends.length > 0
        ? new Set(appliedFilters.backends)
        : null,
    [appliedFilters.backends],
  );
  const modelFilterSet = useMemo(
    () => new Set(appliedFilters.models),
    [appliedFilters.models],
  );
  const filtersActive =
    appliedFilters.backends.length > 0 || appliedFilters.models.length > 0;
  const visibleSessions = useMemo(() => {
    const matched = savedSessions.filter((session) =>
      sessionMatchesFilters(session, backendFilter, modelFilterSet),
    );
    return filtersActive ? matched : matched.slice(0, 200);
  }, [backendFilter, filtersActive, modelFilterSet, savedSessions]);
  // A session that was working and stopped while you never opened it keeps
  // an amber dot: "finished, and you missed it". Cleared from view by the
  // !isOpen check on the dot; entries live as strings for the page's life.
  const [finishedUnread, setFinishedUnread] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const prevRunningPaths = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const nowRunning = new Set(runningPaths);
    for (const session of visibleSessions)
      if (session.isStreaming) nowRunning.add(session.path);
    const finished = [...prevRunningPaths.current].filter(
      (path) => !nowRunning.has(path),
    );
    prevRunningPaths.current = nowRunning;
    if (finished.length === 0) return;
    setFinishedUnread((current) => new Set([...current, ...finished]));
  }, [runningPaths, visibleSessions]);
  const draftMatchCount = useMemo(() => {
    const backends = draftBackends.size > 0 ? draftBackends : null;
    return savedSessions.filter((session) =>
      sessionMatchesFilters(session, backends, draftModels),
    ).length;
  }, [draftBackends, draftModels, savedSessions]);
  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, typeof visibleSessions>();
    for (const session of visibleSessions) {
      const key = session.cwd || "Other";
      groups.set(key, [...(groups.get(key) ?? []), session]);
    }
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    return [...groups.entries()].map(([cwd, sessions]) => ({
      cwd,
      label: workspaceLabel(cwd),
      sessions,
      recent: sessions.filter((session) => session.modifiedAt >= cutoff),
      older: sessions.filter((session) => session.modifiedAt < cutoff),
    }));
  }, [visibleSessions]);

  useEffect(() => {
    if (initializedWorkspaceGroups.current || workspaceGroups.length === 0)
      return;
    initializedWorkspaceGroups.current = true;
    const openWorkspaces = new Set(tabs.map((tab) => tab.cwd));
    // Also keep groups with recent activity open: a session run from a
    // workspace with no open tab (e.g. Home) otherwise vanished behind a
    // collapsed header right after it finished.
    const recentCutoff = Date.now() - 3 * 60 * 60 * 1000;
    setCollapsedWorkspaces(
      new Set(
        workspaceGroups
          .filter((group) => !openWorkspaces.has(group.cwd))
          .filter((group) =>
            group.sessions.every(
              (session) => session.modifiedAt < recentCutoff,
            ),
          )
          .map((group) => group.cwd),
      ),
    );
  }, [tabs, workspaceGroups]);

  useEffect(() => {
    if (!openSessionMenu && !openWorkspaceMenu && !backendMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        !target.closest(".sidebar__floating-menu")
      ) {
        setOpenSessionMenu(null);
        setOpenWorkspaceMenu(null);
        setBackendMenuOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenSessionMenu(null);
        setOpenWorkspaceMenu(null);
        setBackendMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openSessionMenu, openWorkspaceMenu, backendMenuOpen]);

  // A full split grid: every open-beside button reads disabled and, if
  // clicked anyway, explains why instead of spawning a hidden session.
  const splitFull = splitSessions && paneCount >= MAX_SPLIT_PANES;
  const guardSplit = (run: () => void) => () =>
    splitFull ? onPaneLimit() : run();

  const startFresh = async (cwd?: string) => {
    if (collapsed && splitFull) {
      onPaneLimit();
      return;
    }
    onViewChange("sessions");
    const key = cwd ? openConversation(cwd) : await openDefaultConversation();
    // The rail's + is the only way in while a crowded split keeps the
    // sidebar shut, so there it adds a pane instead of leaving the split.
    if (collapsed && splitSessions) onSessionSplit(key);
    else onSessionFocus(key);
  };

  // No page reload: reloading with ?backend= threw away every open session,
  // which is exactly what stopped a pi session and a claude session from
  // being open at the same time.
  const switchBackend = (next: AgentBackend) => {
    setBackendMenuOpen(false);
    if (next === currentBackend) return;
    // Row click only picks the agent NEW sessions start on — it must not
    // spawn a surprise session pane mid-conversation. Opening another
    // agent's session is the + button's job (openBeside).
    setDefaultBackend(next);
  };

  // Same workspace, a second agent: the current pane keeps running and the
  // new session tiles beside it. Default backend is unchanged so New session
  // still opens on the agent this pane started with.
  const openBeside = (backend: AgentBackend) => {
    setBackendMenuOpen(false);
    const cwd = tabs.find((tab) => tab.key === activeKey)?.cwd;
    if (!cwd) {
      switchBackend(backend);
      return;
    }
    const key = openConversation(cwd, undefined, backend);
    onSessionSplit(key);
    onViewChange("sessions");
  };


  const handleArchive = async (session: (typeof savedSessions)[number]) => {
    setOpenSessionMenu(null);
    const result = await archiveSession(session);
    if (!result.ok)
      window.alert(result.error ?? "The session could not be archived.");
  };

  const handleRestore = async (session: (typeof savedSessions)[number]) => {
    setOpenSessionMenu(null);
    const result = await restoreSession(session);
    if (!result.ok)
      window.alert(result.error ?? "The session could not be restored.");
  };

  const handleDelete = async (session: (typeof savedSessions)[number]) => {
    setOpenSessionMenu(null);
    const confirmed = window.confirm(
      `Permanently delete “${session.name}”?\n\nThis removes the saved ${backendLabel(session.backend)} session and cannot be undone.`,
    );
    if (!confirmed) return;
    const result = await deleteSession(session);
    if (!result.ok)
      window.alert(result.error ?? "The session could not be deleted.");
  };

  // Deletes the workspace's folder itself, not just its sessions, so the
  // confirm names the path and says plainly that it is unrecoverable.
  // ponytail: the listing reads the agent's session store and never checks
  // that a session's cwd still exists, so the now-empty group stays visible
  // until its sessions are deleted too. Prune missing cwds server-side if
  // that ghost group becomes a nuisance.
  const handleDeleteWorkspace = async (cwd: string, label: string) => {
    setOpenWorkspaceMenu(null);
    // The sessions are the only reason the group is in the sidebar, so they go
    // with the folder -- otherwise a deleted workspace leaves a ghost group
    // that nothing can clear.
    const sessions = savedSessions.filter((session) => session.cwd === cwd);
    const confirmed = window.confirm(
      `Permanently delete “${label}”?\n\nThis deletes ${cwd} and everything inside it from disk, and removes its ${sessions.length} saved session${sessions.length === 1 ? "" : "s"}. It cannot be undone.`,
    );
    if (!confirmed) return;
    const result = await deleteWorkspace(cwd, sessions);
    if (!result.ok)
      window.alert(result.error ?? "The workspace could not be deleted.");
  };

  const toggleWorkspace = (cwd: string) => {
    setCollapsedWorkspaces((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  };

  const toggleGroupOlder = (cwd: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  };

  const openFilters = () => {
    setDraftBackends(new Set(appliedFilters.backends));
    setDraftModels(new Set(appliedFilters.models));
    setFilterQuery("");
    setFiltersOpen(true);
    setSearchOpen(false);
  };

  const applyFilters = () => {
    const next = {
      backends: [...draftBackends],
      models: [...draftModels],
    };
    setAppliedFilters(next);
    persistSessionFilters(next);
    setFiltersOpen(false);
  };

  const resetFilters = () => {
    setDraftBackends(new Set());
    setDraftModels(new Set());
    const next = { backends: [] as AgentBackend[], models: [] as string[] };
    setAppliedFilters(next);
    persistSessionFilters(next);
  };

  const toggleDraftBackend = (backend: AgentBackend) => {
    setDraftBackends((current) => {
      const next = new Set(current);
      if (next.has(backend)) {
        next.delete(backend);
        const ids =
          filterCatalog
            .find((group) => group.backend === backend)
            ?.models.map((model) => model.id) ?? [];
        setDraftModels((models) => {
          const copy = new Set(models);
          for (const id of ids) copy.delete(id);
          return copy;
        });
      } else next.add(backend);
      return next;
    });
  };

  const toggleDraftModel = (backend: AgentBackend, id: string) => {
    setDraftModels((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setDraftBackends((current) => {
      if (current.has(backend)) return current;
      const next = new Set(current);
      next.add(backend);
      return next;
    });
  };

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k")
        return;
      if (event.altKey || event.shiftKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return;
      event.preventDefault();
      setSearchOpen(true);
      setFiltersOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const chooseView = (next: WorkbenchView) => {
    onViewChange(next);
    setOpenSessionMenu(null);
    setOpenWorkspaceMenu(null);
  };

  const openSearchHit = (hit: SessionSearchResult) => {
    const key = resumeConversation({
      path: hit.path,
      name: hit.name,
      cwd: hit.cwd,
      createdAt: hit.modifiedAt,
      modifiedAt: hit.modifiedAt,
      messageCount: hit.messageCount,
      backend: hit.backend,
    });
    onSessionFocus(key);
    chooseView("sessions");
  };

  const focusSavedSession = (session: (typeof savedSessions)[number]) => {
    const key = resumeConversation(session);
    onSessionFocus(key);
    chooseView("sessions");
  };

  const splitSavedSession = (session: (typeof savedSessions)[number]) => {
    const key = resumeConversation(session);
    onSessionSplit(key);
    chooseView("sessions");
  };

  return (
    <aside className={`sidebar${collapsed ? " is-collapsed" : ""}`}>
      <div className="sidebar__brand-row">
        {!collapsed && (
          <div className="sidebar__backend-menu sidebar__floating-menu">
            <button
              type="button"
              className="sidebar__backend-trigger"
              aria-haspopup="menu"
              aria-expanded={backendMenuOpen}
              aria-label={`New sessions start on ${backendLabel(currentBackend)}. Choose the agent for new sessions.`}
              title={`New sessions start on ${backendLabel(currentBackend)}. Sessions already open keep their own agent.`}
              onClick={() => {
                setOpenSessionMenu(null);
                setOpenWorkspaceMenu(null);
                setBackendMenuOpen((open) => !open);
              }}
            >
              <span className="sidebar__backend-copy">
                <em>
                  {backendModelLine(
                    currentBackend,
                    tabs,
                    sessionView === "archived"
                      ? archivedSessions
                      : resumeSessions,
                  )}
                </em>
              </span>
              <span
                className="sidebar__live-dot"
                title="Reachable"
                aria-hidden
              />
              <IconChevronDown size={12} />
            </button>
            {backendMenuOpen && (
              <div
                className="sidebar__session-popover sidebar__backend-popover"
                role="menu"
              >
                <div className="sidebar__backend-heading">backend</div>
                {backendIds.map((backend) => {
                  const mark = backendMark(backend);
                  const active = currentBackend === backend;
                  return (
                    <div
                      key={backend}
                      className={`sidebar__backend-row${active ? " is-active" : ""}`}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className={active ? "is-active" : undefined}
                        onClick={() => switchBackend(backend)}
                      >
                        <span
                          className="sidebar__backend-logo sidebar__backend-logo--sm"
                          style={{ color: mark.color }}
                          aria-hidden
                        >
                          <BackendLogo backend={backend} size={18} />
                        </span>
                        <span className="sidebar__backend-option">
                          <strong>{backendLabel(backend).toLowerCase()}</strong>
                          <em>
                            {backendModelLine(backend, tabs, resumeSessions)}
                          </em>
                        </span>
                        <span className="sidebar__live-dot" aria-hidden />
                        {active ? (
                          <span className="sidebar__tick">✓</span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        className="sidebar__backend-beside"
                        aria-label={`Open a ${backendLabel(backend)} session beside this one`}
                        title={`Open a ${backendLabel(backend)} session beside this one`}
                        aria-disabled={splitFull || undefined}
                        data-limit={splitFull ? "" : undefined}
                        onClick={(event) => {
                          event.stopPropagation();
                          guardSplit(() => openBeside(backend))();
                        }}
                      >
                        <IconPlus size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {!collapsed && (
          <button
            type="button"
            className="sidebar__icon-btn"
            onClick={() =>
              window.open(window.location.href, "_blank", "noopener")
            }
            aria-label="New window"
            title="New window"
          >
            <IconNewChat size={14} />
          </button>
        )}
        <button
          type="button"
          className="sidebar__icon-btn sidebar__toggle"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed && (
            <span className="sidebar__rail-fish">
              <FishLogo size={24} />
            </span>
          )}
          <span className="sidebar__panel-icon">
            <IconPanel size={collapsed ? 18 : 16} />
          </span>
        </button>
      </div>

      {collapsed ? (
        <div className="sidebar__new-row">
          <button
            type="button"
            className="sidebar__new"
            onClick={() => startFresh()}
            aria-label="New session"
            aria-disabled={splitFull || undefined}
            data-limit={splitFull ? "" : undefined}
            title="New session"
          >
            <IconPlus size={18} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="sidebar__new-session"
          onClick={() => startFresh()}
        >
          <IconPlus size={13} />
          <span>New session</span>
          <kbd>⌘N</kbd>
        </button>
      )}

      <nav className="sidebar__nav" aria-label="Workbench">
        {onTerminalToggle && (
          <SidebarNavButton
            collapsed={collapsed}
            active={terminalOpen}
            pressed={terminalOpen}
            label="Terminal"
            onClick={onTerminalToggle}
            icon={<IconTerminal size={collapsed ? 18 : 15} />}
          />
        )}
        <SidebarNavButton
          collapsed={collapsed}
          active={false}
          label="Board"
          onClick={() => {
            chooseView("sessions");
            window.dispatchEvent(new Event("devden:toggle-board"));
          }}
          icon={<IconKanban size={collapsed ? 18 : 15} />}
        />
        <SidebarNavButton
          collapsed={collapsed}
          active={view === "notes"}
          label="Notes"
          onClick={() => chooseView("notes")}
          icon={<IconPencil size={collapsed ? 18 : 15} />}
        />
        <SidebarNavButton
          collapsed={collapsed}
          active={view === "skills"}
          label="Skills"
          onClick={() => chooseView("skills")}
          icon={<IconCube size={collapsed ? 18 : 15} />}
        />
        <SidebarNavButton
          collapsed={collapsed}
          active={view === "extensions"}
          label="Extensions"
          onClick={() => chooseView("extensions")}
          icon={<IconExtension size={collapsed ? 18 : 15} />}
        />
        <SidebarNavButton
          collapsed={collapsed}
          active={view === "settings"}
          label="Settings"
          onClick={() => chooseView("settings")}
          icon={<IconSettings size={collapsed ? 18 : 15} />}
        />
      </nav>

      {!collapsed && (
        <div className="sidebar__section">
          <div className="sidebar__saved-head">
            <div
              className="sidebar__saved-tabs"
              role="tablist"
              aria-label="Sessions and fleet"
            >
              <button
                type="button"
                role="tab"
                aria-selected={view !== "fleet"}
                className={view === "fleet" ? undefined : "is-active"}
                onClick={() => chooseView("sessions")}
              >
                Sessions
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "fleet"}
                className={view === "fleet" ? "is-active" : undefined}
                onClick={() => chooseView("fleet")}
              >
                Fleet
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "battle"}
                className={view === "battle" ? "is-active" : undefined}
                onClick={() => chooseView("battle")}
              >
                Battle
              </button>
            </div>
            {filtersOpen && (
              <>
                <div
                  className="sidebar__backdrop"
                  onClick={() => setFiltersOpen(false)}
                />
                <div
                  className="sidebar__filters"
                  role="dialog"
                  aria-label="Session filters"
                >
                  <div className="sidebar__filter-sorts">
                    {(["recent", "archived"] as const).map((value) => (
                      <button
                        type="button"
                        key={value}
                        className={
                          sessionView === value ? "is-active" : undefined
                        }
                        onClick={() => {
                          setSessionView(value);
                          setOpenSessionMenu(null);
                        }}
                      >
                        {value === "recent" ? "Recent" : "Archived"}
                      </button>
                    ))}
                  </div>
                  <label className="sidebar__filter-search">
                    <IconSearch size={12} />
                    <input
                      type="search"
                      value={filterQuery}
                      onChange={(event) => setFilterQuery(event.target.value)}
                      placeholder="Filter agents & models"
                      aria-label="Filter agents and models"
                    />
                  </label>
                  <div className="sidebar__filter-agents">
                    {filterCatalog
                      .filter((group) => {
                        const query = filterQuery.trim().toLowerCase();
                        if (!query) return true;
                        if (
                          backendLabel(group.backend)
                            .toLowerCase()
                            .includes(query)
                        )
                          return true;
                        return group.models.some(
                          (model) =>
                            model.label.toLowerCase().includes(query) ||
                            model.id.toLowerCase().includes(query),
                        );
                      })
                      .map((group) => {
                        const mark = backendMark(group.backend);
                        const on = draftBackends.has(group.backend);
                        const expanded = expandedFilterAgent === group.backend;
                        const visibleModels = group.models.filter((model) => {
                          const query = filterQuery.trim().toLowerCase();
                          if (!query) return true;
                          return (
                            model.label.toLowerCase().includes(query) ||
                            model.id.toLowerCase().includes(query)
                          );
                        });
                        return (
                          <div
                            key={group.backend}
                            className="sidebar__filter-agent"
                          >
                            <div
                              className={`sidebar__filter-agent-row${expanded ? " is-expanded" : ""}`}
                            >
                              <button
                                type="button"
                                className={`sidebar__filter-check${on ? " is-on" : ""}`}
                                aria-pressed={on}
                                aria-label={`${on ? "Hide" : "Show"} ${backendLabel(group.backend)} sessions`}
                                onClick={() =>
                                  toggleDraftBackend(group.backend)
                                }
                              >
                                {on ? "✓" : ""}
                              </button>
                              <span
                                className="sidebar__agent-mark"
                                style={{ color: mark.color }}
                                aria-hidden
                              >
                                <BackendLogo
                                  backend={group.backend}
                                  size={13}
                                />
                              </span>
                              <button
                                type="button"
                                className="sidebar__filter-agent-name"
                                onClick={() =>
                                  setExpandedFilterAgent((current) =>
                                    current === group.backend
                                      ? null
                                      : group.backend,
                                  )
                                }
                              >
                                {backendLabel(group.backend)}
                              </button>
                              <span className="sidebar__filter-count">
                                {group.count}
                              </span>
                              <button
                                type="button"
                                className="sidebar__filter-chev"
                                aria-expanded={expanded}
                                aria-label={`${expanded ? "Collapse" : "Expand"} ${backendLabel(group.backend)} models`}
                                onClick={() =>
                                  setExpandedFilterAgent((current) =>
                                    current === group.backend
                                      ? null
                                      : group.backend,
                                  )
                                }
                              >
                                {expanded ? "⌃" : "⌄"}
                              </button>
                            </div>
                            {expanded &&
                              visibleModels.map((model) => {
                                const selected = draftModels.has(model.id);
                                return (
                                  <button
                                    type="button"
                                    key={model.id}
                                    className="sidebar__filter-model"
                                    onClick={() =>
                                      toggleDraftModel(group.backend, model.id)
                                    }
                                  >
                                    <span
                                      className={`sidebar__filter-check${selected ? " is-on" : ""}`}
                                    >
                                      {selected ? "✓" : ""}
                                    </span>
                                    <span>
                                      <ModelName
                                        name={
                                          /:cloud$/i.test(model.id)
                                            ? `${model.label} ☁`
                                            : model.label
                                        }
                                      />
                                    </span>
                                    <em>{model.count}</em>
                                  </button>
                                );
                              })}
                          </div>
                        );
                      })}
                  </div>
                  <div className="sidebar__filter-foot">
                    <span>
                      <strong>{draftMatchCount}</strong> of{" "}
                      {savedSessions.length} sessions
                    </span>
                    <button type="button" onClick={resetFilters}>
                      Reset
                    </button>
                    <button
                      type="button"
                      className="sidebar__filter-apply"
                      onClick={applyFilters}
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </>
            )}
            <div className="sidebar__saved-tools">
              <button
                type="button"
                className={`sidebar__tool-btn${searchOpen ? " is-active" : ""}`}
                aria-label="Search transcripts"
                aria-expanded={searchOpen}
                title="Search transcripts  ⌘K"
                onClick={() => {
                  setSearchOpen(true);
                  setFiltersOpen(false);
                }}
              >
                <IconSearch size={13} />
              </button>
              <button
                type="button"
                className={`sidebar__tool-btn${
                  filtersOpen || filtersActive || sessionView !== "recent"
                    ? " is-active"
                    : ""
                }`}
                aria-label="Session filters"
                aria-expanded={filtersOpen}
                title="Filters"
                onClick={() =>
                  filtersOpen ? setFiltersOpen(false) : openFilters()
                }
              >
                <IconFilter size={13} />
              </button>
            </div>
          </div>
          {searchOpen &&
            createPortal(
              <div
                className="sidebar__search-modal"
                role="dialog"
                aria-label="Search transcripts"
                onClick={() => setSearchOpen(false)}
              >
                <div
                  className="sidebar__search-panel"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="sidebar__search-bar">
                    <IconSearch size={14} />
                    <input
                      autoFocus
                      type="search"
                      aria-label="Search session transcripts"
                      placeholder="Search transcripts"
                      value={transcriptQuery}
                      onChange={(event) =>
                        setTranscriptQuery(event.target.value)
                      }
                    />
                    <button
                      type="button"
                      className="sidebar__search-close"
                      aria-label="Close search"
                      onClick={() => {
                        setSearchOpen(false);
                        setTranscriptQuery("");
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <div className="sidebar__search-results">
                    {transcriptSearching && (
                      <p className="sidebar__search-note">Searching…</p>
                    )}
                    {!transcriptSearching &&
                      transcriptQuery.trim().length >= 2 &&
                      transcriptHits.length === 0 && (
                        <p className="sidebar__search-note">
                          No transcripts match.
                        </p>
                      )}
                    {transcriptQuery.trim().length < 2 && (
                      <p className="sidebar__search-note">
                        Type at least 2 characters to search transcripts.
                      </p>
                    )}
                    {transcriptHits.map((hit) => (
                      <button
                        key={hit.path}
                        type="button"
                        className="sidebar__search-hit"
                        onClick={() => {
                          openSearchHit(hit);
                          setSearchOpen(false);
                          setTranscriptQuery("");
                        }}
                      >
                        <strong>{hit.name || "Untitled session"}</strong>
                        {hit.snippets.slice(0, 2).map((snippet, index) => (
                          <span key={index}>
                            <em>{snippet.role}</em> {snippet.text}
                          </span>
                        ))}
                      </button>
                    ))}
                  </div>
                </div>
              </div>,
              document.body,
            )}

          {workspaceGroups.map((group) => {
            const groupCollapsed =
              !filtersActive && collapsedWorkspaces.has(group.cwd);
            const groupOlderOpen = expandedGroups.has(group.cwd);
            return (
              <section className="sidebar__workspace" key={group.cwd}>
                <div className="sidebar__workspace-head">
                  <button
                    type="button"
                    className="sidebar__workspace-toggle"
                    aria-expanded={!groupCollapsed}
                    onClick={() => toggleWorkspace(group.cwd)}
                    title={group.cwd}
                  >
                    <span
                      className={`sidebar__workspace-chevron${groupCollapsed ? " is-collapsed" : ""}`}
                    >
                      ⌄
                    </span>
                    <IconFolder size={15} />
                    <span>{group.label}</span>
                    <em>{group.sessions.length}</em>
                  </button>
                  <div className="sidebar__workspace-menu sidebar__floating-menu">
                    <button
                      type="button"
                      className="sidebar__workspace-actions"
                      aria-label={`Actions for workspace ${group.label}`}
                      aria-expanded={openWorkspaceMenu === group.cwd}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenSessionMenu(null);
                        setOpenWorkspaceMenu((current) =>
                          current === group.cwd ? null : group.cwd,
                        );
                      }}
                    >
                      <IconDots />
                    </button>
                    {openWorkspaceMenu === group.cwd && (
                      <div className="sidebar__session-popover sidebar__workspace-popover">
                        <button
                          type="button"
                          onClick={() => {
                            setOpenWorkspaceMenu(null);
                            startFresh(group.cwd);
                          }}
                        >
                          <IconNewChat /> New session
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setOpenWorkspaceMenu(null);
                            const matching = tabs.find(
                              (tab) => tab.cwd === group.cwd,
                            );
                            const key =
                              matching?.key ?? openConversation(group.cwd);
                            revealWorkspace(key);
                            onSessionFocus(key);
                            chooseView("sessions");
                          }}
                        >
                          <IconCode /> View
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setOpenWorkspaceMenu(null);
                            toggleWorkspace(group.cwd);
                          }}
                        >
                          <IconFolder />{" "}
                          {groupCollapsed ? "Expand" : "Collapse"}
                        </button>
                        <button
                          type="button"
                          className="is-danger"
                          onClick={() =>
                            handleDeleteWorkspace(group.cwd, group.label)
                          }
                        >
                          <IconTrash /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {!groupCollapsed &&
                  (groupOlderOpen ? group.sessions : group.recent).map(
                    (session) => {
                      const matchingTab = tabs.find(
                        (tab) =>
                          tab.sessionPath === session.path ||
                          tab.timeline.state?.sessionFile === session.path,
                      );
                      // `tabs` keeps every conversation opened since page
                      // load, including ones long gone from the screen — in
                      // focus mode `visibleTabs` is just the active one. Judging
                      // "open" from `tabs` gave an open-dot to every session you
                      // had ever clicked, for the life of the page, while the
                      // Open card above listed a single row. The dot now agrees
                      // with that card. Running/awaiting still read the live
                      // timeline off `matchingTab` (and `runningPaths` covers
                      // every tab), so a background session that is genuinely
                      // working still blinks.
                      const isOpen = openTabs.some(
                        (tab) => tab.key === matchingTab?.key,
                      );
                      // Only the focused pane's session gets the grey box;
                      // other open sessions stay marked by title weight.
                      const isFocused = matchingTab?.key === activeKey;
                      const isRunning = Boolean(
                        (matchingTab && workingKeys.has(matchingTab.key)) ||
                          runningPaths.has(session.path) ||
                          session.isStreaming,
                      );
                      // An open session is judged from its live timeline; a
                      // closed one from the tail the server sent, so a session
                      // parked on a question is visible before you open it.
                      const isAwaiting = matchingTab
                        ? !isRunning && awaitingKeys.has(matchingTab.key)
                        : textAwaitsAnswer(session.lastAssistantText);
                      // The list's stored name only appears once the turn
                      // settles and set_session_name persists it; the open
                      // tab's timeline already carries the live generated
                      // title (session_title_set lands seconds after the
                      // first prompt). Prefer it so the panel and the
                      // conversation header agree during that window.
                      const liveName =
                        matchingTab?.timeline.state?.sessionName?.trim();
                      const title = savedSessionTitle(
                        liveName || session.name,
                        session.firstPrompt,
                      );
                      const mark = backendMark(session.backend);
                      return (
                        <div className="sidebar__saved-row" key={session.path}>
                          <button
                            type="button"
                            className={`sidebar__item sidebar__item--saved${isOpen ? " is-active-session" : ""}${isFocused ? " is-focused" : ""}${isRunning ? " is-running" : ""}${isAwaiting ? " is-awaiting" : ""}`}
                            aria-label={
                              isRunning
                                ? `${title}, running`
                                : isAwaiting
                                  ? `${title}, waiting for your answer`
                                  : undefined
                            }
                            title={session.path}
                            draggable
                            onPointerDown={event => startSessionDrag(event, { path: session.path })}
                            onDragStart={event => {
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData(SESSION_DRAG_TYPE, JSON.stringify({ path: session.path }));
                            }}
                            onClick={() => focusSavedSession(session)}
                          >
                            <span className="sidebar__status" aria-hidden>
                              {isRunning ? (
                                <span
                                  className="sidebar__run-dot"
                                  title="Working"
                                />
                              ) : isAwaiting ? (
                                <span
                                  className="sidebar__await-dot"
                                  title="Waiting for your answer"
                                />
                              ) : !isOpen && finishedUnread.has(session.path) ? (
                                <span
                                  className="sidebar__done-dot"
                                  title="Finished while you were away"
                                />
                              ) : isOpen ? (
                                <span
                                  className="sidebar__open-dot"
                                  title="Open"
                                />
                              ) : null}
                            </span>
                            <span className="sidebar__item-stack">
                              <span className="sidebar__item-label">
                                {title}
                              </span>
                              <span className="sidebar__item-sub">
                                <span
                                  className="sidebar__agent-mark"
                                  style={{ color: mark.color }}
                                >
                                  <BackendLogo
                                    backend={session.backend}
                                    size={12}
                                  />
                                </span>
                                <span className="sidebar__item-sub-text">
                                  {sessionMetaLine(session)}
                                </span>
                              </span>
                            </span>
                            <span className="sidebar__item-time">
                              {formatRelativeTime(session.modifiedAt)}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="sidebar__saved-split"
                            aria-label={`Open ${title} in a new tab`}
                            aria-disabled={splitFull || undefined}
                            data-limit={splitFull ? "" : undefined}
                            onClick={guardSplit(() =>
                              splitSavedSession(session),
                            )}
                          >
                            <IconOpenTab size={12} />
                          </button>
                          <SessionRowMenu
                            open={openSessionMenu === session.path}
                            title={title}
                            onToggle={() => {
                              setOpenWorkspaceMenu(null);
                              setOpenSessionMenu((current) =>
                                current === session.path
                                  ? null
                                  : session.path,
                              );
                            }}
                          >
                            {sessionView === "recent" ? (
                              <button
                                type="button"
                                onClick={() => void handleArchive(session)}
                              >
                                <IconArchive /> Archive
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => void handleRestore(session)}
                              >
                                <IconRestore /> Restore
                              </button>
                            )}
                            <button
                              type="button"
                              className="is-danger"
                              onClick={() => void handleDelete(session)}
                            >
                              <IconTrash /> Delete permanently
                            </button>
                          </SessionRowMenu>
                        </div>
                      );
                    },
                  )}
                {!groupCollapsed && group.older.length > 0 && (
                  <button
                    type="button"
                    className="sidebar__older-toggle"
                    aria-expanded={groupOlderOpen}
                    onClick={() => toggleGroupOlder(group.cwd)}
                  >
                    {groupOlderOpen
                      ? `Hide ${group.older.length} older sessions`
                      : `Show ${group.older.length} older sessions`}
                  </button>
                )}
              </section>
            );
          })}

          {visibleSessions.length === 0 && (
            <div className="sidebar__empty">
              {/* Before the first listing lands the list is empty for the
                  boring reason, and saying "no saved sessions" there told
                  people with hundreds of them that they had none. */}
              {sessionsLoaded
                ? filtersActive
                  ? "No sessions match these filters."
                  : sessionView === "archived"
                    ? "No archived sessions."
                    : "No saved sessions yet."
                : "Loading sessions…"}
            </div>
          )}
        </div>
      )}

      {!collapsed && (
        <button
          type="button"
          className="sidebar-resizer"
          aria-label="Resize sidebar"
          title="Drag to resize sidebar"
          onPointerDown={onResizePointerDown}
          onKeyDown={onResizeKeyDown}
        />
      )}
      <div className="sidebar__footer-row">
        <AppUpdateFooter collapsed={collapsed} />
        <button
          type="button"
          className="sidebar__footer sidebar__footer--icon"
          onClick={onThemeToggle}
          aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
          title={theme === "dark" ? "Use light theme" : "Use dark theme"}
        >
          {theme === "dark" ? <IconSun /> : <IconMoon />}
        </button>
      </div>
    </aside>
  );
}

function SessionRowMenu({
  open,
  title,
  onToggle,
  children,
}: {
  open: boolean;
  title: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useAnchoredPopover<HTMLDivElement>(open, "end", {
    anchor: anchorRef,
    prefer: "below",
  });
  return (
    <div
      className="sidebar__session-menu sidebar__floating-menu"
      ref={anchorRef}
    >
      <button
        type="button"
        className="sidebar__session-trigger"
        aria-label={`Actions for ${title}`}
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        <IconDots />
      </button>
      {open && (
        <div ref={popoverRef} className="sidebar__session-popover" role="menu">
          {children}
        </div>
      )}
    </div>
  );
}

function SidebarNavButton({
  collapsed,
  active,
  label,
  icon,
  live = false,
  pressed,
  onClick,
}: {
  collapsed: boolean;
  active: boolean;
  label: string;
  icon: ReactNode;
  live?: boolean;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`sidebar__nav-item${active ? " is-active" : ""}`}
      aria-current={pressed === undefined && active ? "page" : undefined}
      aria-pressed={pressed}
      aria-label={live ? `${label}, session running` : label}
      onClick={onClick}
    >
      {icon}
      {!collapsed && <span>{label}</span>}
      {live && (
        <span
          className="sidebar__run-dot"
          title="A session is running"
          aria-hidden="true"
        />
      )}
    </button>
  );
}
