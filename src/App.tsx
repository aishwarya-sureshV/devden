import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type FormEvent,
} from "react";
import { StoreProvider, useStore, type ConversationTab } from "./lib/store";
import { AuthError, api, setAuthToken } from "./lib/api";
import { Sidebar } from "./components/Sidebar";
import { UpdateTray } from "./components/UpdateTray";
import { Conversation } from "./components/Conversation";
import {
  ReviewDock,
  reviewTabId,
  type DiffLayout,
  type ReviewTab,
} from "./components/ReviewDock";
import { WorkspaceExplorer } from "./components/WorkspaceExplorer";
import type { ToolFileView } from "./lib/toolCards";
import { WorkbenchPage } from "./components/WorkbenchPage";
import { NotesPage } from "./components/NotesPage";
import { BattlePage } from "./components/BattlePage";
import { FleetPage } from "./components/FleetPage";
import { TerminalPage } from "./components/TerminalPage";
import { FishLogo } from "./components/icons";
import { Onboarding } from "./components/Onboarding";
import { Backdrop } from "./components/Backdrop";
import { AppFooter } from "./components/AppFooter";
import {
  activePhoto,
  cycleBackdrop,
  getAppearance,
  diffTone,
  hasBackdrop,
  highlightVars,
  setAppearance,
  subscribeAppearance,
} from "./lib/appearance";
import type { WorkbenchView } from "./lib/navigation";
import { type SessionDrag } from "./lib/dockLayout";
import { MAX_SPLIT_PANES, sessionPaneLayout } from "./lib/sessionLayout";
import { DockLayout, type DockPanel } from "./components/DockLayout";
import { BoardPanel } from "./components/BoardPanel";
import { TerminalRunsProvider } from "./lib/terminalRuns";
import { applyCodeTheme, codeTheme } from "./lib/codeTheme";
import "./styles/app.css";
import "./styles/conversation.css";
import "./styles/thinkingEmoji.css";
import "./styles/onboarding.css";
import "./styles/workbenchSkin.css";
import "./styles/conversation/workbench-v3.css";
import "./styles/conversation/workbench-polish.css";

/**
 * A dropped connection is invisible in the transcript: the agent's own
 * retries are silent and its "fetch failed" only lands minutes later, so a
 * stalled turn is indistinguishable from a slow one. The browser already
 * knows -- say so immediately.
 */
function OfflineBanner() {
  const online = useSyncExternalStore(
    (onChange) => {
      window.addEventListener("online", onChange);
      window.addEventListener("offline", onChange);
      return () => {
        window.removeEventListener("online", onChange);
        window.removeEventListener("offline", onChange);
      };
    },
    () => navigator.onLine,
    () => true,
  );
  if (online) return null;
  return (
    <div className="offline-banner" role="status">
      No internet connection — the agent is retrying, and anything in flight
      will stall until it is back.
    </div>
  );
}

function subscribePrefersDark(onChange: () => void): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function prefersDarkSnapshot(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function Frame() {
  const {
    tabs,
    active,
    activeKey,
    setActiveKey,
    closeConversation,
    resumeSessions, resumeConversation,
    setVisibleSessionKeys,
  } = useStore();
  const [view, setView] = useState<WorkbenchView>("sessions");
  const viewRef = useRef(view);
  viewRef.current = view;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("devden.sidebar") === "collapsed",
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem("devden.sidebar-width"));
    return Number.isFinite(stored) ? Math.min(480, Math.max(200, stored)) : 232;
  });
  const [splitSessions, setSplitSessions] = useState(
    () => localStorage.getItem("devden.session-layout") === "split",
  );
  const [splitSessionKeys, setSplitSessionKeys] = useState<string[]>([]);
  // The split a pane was expanded out of, so Back can put it back.
  const [tabbedSessionKeys, setTabbedSessionKeys] = useState<string[]>([]);
  const [restoreSplit, setRestoreSplit] = useState<string[] | null>(null);
  // Transient toast (pane cap reached); clears itself.
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const show = (event: Event) => setToast((event as CustomEvent<string>).detail);
    window.addEventListener("devden:toast", show);
    return () => window.removeEventListener("devden:toast", show);
  }, []);
  const paneLimitToast = () =>
    setToast(
      `Up to ${MAX_SPLIT_PANES} sessions fit side by side. Close one to open another.`,
    );
  // Narrow screens have no room for a permanent sidebar, so it becomes a
  // drawer. Without this the ≤760px layout hid the sidebar outright and left
  // no way to reach sessions, skills, the terminal or settings from a phone.
  const [navOpen, setNavOpen] = useState(false);
  // Appearance comes from the redesign's settings store: mode feeds the
  // legacy data-ds-dark-theme attribute so both themes stay in sync.
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearance);
  const prefersDark = useSyncExternalStore(
    subscribePrefersDark,
    prefersDarkSnapshot,
    () => false,
  );
  // Photo wallpapers are dark scenes — while one is active the app follows
  // the dark glass skin: light-mode white frosting over them reads as milk.
  // Shader scenes keep the user's light/dark choice (they render both).
  // System follows the OS when the surface itself does not force a theme.
  const background = appearance.background ?? "glass";
  const storedMode =
    appearance.mode === "system"
      ? prefersDark
        ? "dark"
        : "light"
      : appearance.mode;
  const theme =
    background === "white" || background === "cream"
      ? "light"
      : background === "black" || background === "aurora"
        ? "dark"
        : activePhoto(appearance)
          ? "dark"
          : storedMode;
  // Hidden by default. Reasoning streams are long and largely scratch work —
  // shown inline they bury the tool cards and the answer. Settings turns them
  // back on, and that choice sticks.
  const [showThinking, setShowThinking] = useState(
    () => localStorage.getItem("devden.show-thinking") === "on",
  );
  // Terminal shares the movable workbench layout; expanding keeps PTYs mounted.
  const [terminalPane, setTerminalPane] = useState(
    () => localStorage.getItem("devden.terminal-pane") === "open",
  );
  const [terminalExpanded, setTerminalExpanded] = useState(false);

  useEffect(() => {
    document.body.toggleAttribute("data-ds-dark-theme", theme === "dark");
    localStorage.setItem("devden.theme.v2", theme);
  }, [theme]);

  // Code colors: workbenchSkin.css maps --dv-* onto every code highlighter.
  useEffect(() => {
    const colors = appearance.diffColors[diffTone(background)];
    for (const [role, hex] of Object.entries(colors))
      document.body.style.setProperty(`--dv-${role}`, hex);
  }, [appearance.diffColors, background]);

  // Glass activation + pane tuning, driven by the appearance settings.
  useEffect(() => {
    document.body.dataset.bg = background;
    // Black/White/Cream wear the glass skin too (font, composer, bubbles) —
    // workbenchSkin.css swaps its palette and the panes go fully opaque.
    const solid =
      background === "black" ||
      background === "white" ||
      background === "cream";
    document.body.toggleAttribute(
      "data-glass",
      background !== "glass" || hasBackdrop(),
    );
    document.body.style.setProperty("--g-blur", `${appearance.blur}px`);
    document.body.style.setProperty(
      "--g-tint-a",
      solid ? "1" : String(appearance.tint),
    );
    for (const [key, value] of Object.entries(
      highlightVars(appearance.highlight),
    ))
      document.body.style.setProperty(key, value);
  }, [appearance]);

  // ⌘, opens settings; [ and ] cycle backdrop scenes, mockup-style.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setTerminalExpanded(false);
        setView((current) =>
          current === "settings" ? "sessions" : "settings",
        );
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT" ||
          target.isContentEditable)
      )
        return;
      if (event.key === "Escape" && viewRef.current === "settings") {
        event.preventDefault();
        setView("sessions");
        return;
      }
      // [ ] cycles whichever backdrop kind is active: scenes when a scene is
      // on, wallpapers when a photo is on (or from the solid theme).
      if (event.key === "[" || event.key === "]")
        cycleBackdrop(event.key === "]" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => applyCodeTheme(codeTheme()), []);

  useEffect(() => {
    localStorage.setItem("devden.show-thinking", showThinking ? "on" : "off");
  }, [showThinking]);

  const toggleSidebar = () =>
    setSidebarCollapsed((collapsed) => {
      localStorage.setItem(
        "devden.sidebar",
        collapsed ? "expanded" : "collapsed",
      );
      return !collapsed;
    });

  const openTerminalPane = useCallback(() => {
    localStorage.setItem("devden.terminal-pane", "open");
    setTerminalExpanded(false);
    setTerminalPane(true);
    setView("sessions");
  }, []);

  const closeTerminalPane = () => {
    localStorage.setItem("devden.terminal-pane", "closed");
    setTerminalPane(false);
    setTerminalExpanded(false);
  };

  const toggleTerminalPane = () =>
    terminalPane && view === "sessions"
      ? closeTerminalPane()
      : openTerminalPane();

  // Leaving (or re-entering) sessions always un-expands the terminal pane so
  // the sessions nav button never looks dead while the pane is expanded.
  const changeView = (next: WorkbenchView) => {
    setTerminalExpanded(false);
    setView(next);
  };

  const toggleSplitSessions = () => {
    if (splitSessions) {
      focusSession(activeKey);
      return;
    }
    localStorage.setItem("devden.session-layout", "split");
    setSplitSessionKeys(tabs.slice(0, MAX_SPLIT_PANES).map((tab) => tab.key));
    setSplitSessions(true);
  };

  const focusSession = (key: string) => {
    localStorage.setItem("devden.session-layout", "focus");
    if (key) setActiveKey(key);
    setSplitSessions(false);
    setSplitSessionKeys([]);
    setRestoreSplit(null);
  };

  // A pane's expand button: full-size, but remembering the split for Back.
  const expandSession = (key: string) => {
    const keys = visibleTabs.map((tab) => tab.key);
    focusSession(key);
    setRestoreSplit(keys);
  };

  const backToSplit = () => {
    const keys = (restoreSplit ?? []).filter((key) =>
      tabs.some((tab) => tab.key === key),
    );
    setRestoreSplit(null);
    if (keys.length < 2) return;
    localStorage.setItem("devden.session-layout", "split");
    setSplitSessionKeys(keys);
    setSplitSessions(true);
  };

  const splitWithSession = (key: string) => {
    const base = splitSessionKeys.length > 0 ? splitSessionKeys : [activeKey];
    const next = [...new Set([...base, key])].filter(Boolean);
    const grouped = next.filter(key => tabbedSessionKeys.includes(key)).length;
    if (next.length - Math.max(0, grouped - 1) > MAX_SPLIT_PANES) {
      paneLimitToast();
      return;
    }
    localStorage.setItem("devden.session-layout", "split");
    setRestoreSplit(null);
    setSplitSessionKeys(next);
    setSplitSessions(true);
  };

  const visibleTabs = splitSessions
    ? tabs.filter((tab) => {
        if (tab.guest && !splitSessionKeys.includes(tab.key)) return false;
        return (
          splitSessionKeys.length === 0 || splitSessionKeys.includes(tab.key) || tabbedSessionKeys.includes(tab.key)
        );
      })
    : tabs.filter(tab => tab.key === activeKey || tabbedSessionKeys.includes(tab.key));

  const visiblePaneCount = visibleTabs.length - Math.max(0, visibleTabs.filter(tab => tabbedSessionKeys.includes(tab.key)).length - 1);

  // The store persists which panes were on screen so a refresh restores the
  // whole split layout instead of collapsing to the active session.
  const visibleKeyList = visibleTabs.map((tab) => tab.key).join(",");
  useEffect(() => {
    setVisibleSessionKeys([...new Set([...(visibleKeyList ? visibleKeyList.split(",") : []), ...tabbedSessionKeys])]);
  }, [visibleKeyList, tabbedSessionKeys, setVisibleSessionKeys]);

  // Past four panes the grid needs the sidebar's width, so crossing that
  // line collapses it once. Not persisted, and the user can reopen it.
  const crowded = visiblePaneCount > SIDEBAR_PANE_LIMIT;
  useEffect(() => {
    if (crowded) setSidebarCollapsed(true);
  }, [crowded]);

  // Closing a tab leaves its key in splitSessionKeys, and a key with no tab
  // behind it filters visibleTabs down to nothing: every pane renders hidden
  // and the sidebar's "Open" card disappears while a session is still open.
  // Drop keys whose tab is gone.
  useEffect(() => {
    setSplitSessionKeys((keys) => {
      const live = keys.filter((key) => tabs.some((tab) => tab.key === key));
      return live.length === keys.length ? keys : live;
    });
  }, [tabs]);

  const dropSession = (data: SessionDrag, asTab: boolean) => {
    if (!asTab && visiblePaneCount >= MAX_SPLIT_PANES &&
        !("key" in data && visibleTabs.some(tab => tab.key === data.key))) {
      paneLimitToast();
      return null;
    }
    const session = "path" in data ? resumeSessions.find(item => item.path === data.path) : undefined;
    const key = "key" in data ? tabs.find(tab => tab.key === data.key)?.key : session ? resumeConversation(session) : undefined;
    if (!key) return null;
    if (asTab) {
      setSplitSessionKeys(keys => [...new Set([...(keys.length ? keys : [activeKey]), key])].filter(Boolean));
      setSplitSessions(true);
      localStorage.setItem("devden.session-layout", "split");
    } else splitWithSession(key);
    setActiveKey(key);
    changeView("sessions");
    return key;
  };

  const persistSidebarWidth = (width: number) => {
    const next = Math.min(480, Math.max(200, width));
    setSidebarWidth(next);
    localStorage.setItem("devden.sidebar-width", String(next));
    return next;
  };

  const startSidebarResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (sidebarCollapsed) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const onMove = (moveEvent: PointerEvent) => {
      persistSidebarWidth(startWidth + moveEvent.clientX - startX);
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove("is-resizing-sidebar");
    };
    document.body.classList.add("is-resizing-sidebar");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

  const resizeSidebarWithKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    persistSidebarWidth(sidebarWidth + (event.key === "ArrowRight" ? 24 : -24));
  };

  const effCollapsed = sidebarCollapsed;
  const sidebarProps = {
    onToggle: toggleSidebar,
    theme,
    onThemeToggle: () =>
      setAppearance({ mode: theme === "dark" ? "light" : "dark" }),
    view,
    onViewChange: changeView,
    splitSessions,
    onSplitSessionsToggle: toggleSplitSessions,
    onSessionFocus: focusSession,
    onSessionSplit: splitWithSession,
    onPaneLimit: paneLimitToast,
    openTabKeys: visibleTabs.map((tab) => tab.key),
    paneCount: visiblePaneCount,
    terminalOpen: terminalPane && view === "sessions",
    onTerminalToggle: toggleTerminalPane,
    onResizePointerDown: startSidebarResize,
    onResizeKeyDown: resizeSidebarWithKeyboard,
  };

  return (
    <TerminalRunsProvider onNeedOpen={openTerminalPane}>
      <Backdrop />
      <div
        className={`app-frame${navOpen ? " is-nav-open" : ""}${view === "settings" ? " is-settings" : ""}`}
        data-layout={appearance.layout}
        data-tool-density={appearance.toolDensity} data-tool-durations={appearance.toolDurations ? "shown" : "hidden"}
        style={{
          ["--pw-sidebar-width" as string]: `${effCollapsed ? 56 : sidebarWidth}px`,
        }}
        onClickCapture={(event) => {
          // Any click inside the drawer that isn't the resizer means the user
          // picked something; get the drawer out of the way.
          if (!navOpen) return;
          const target = event.target as HTMLElement;
          if (target.closest(".sidebar") && !target.closest(".sidebar-resizer"))
            setNavOpen(false);
        }}
      >
        <OfflineBanner />
        {view !== "settings" && (
          <button
            type="button"
            className="nav-toggle"
            aria-label={navOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={navOpen}
            onClick={() => setNavOpen((open) => !open)}
          >
            {navOpen ? "✕" : "☰"}
          </button>
        )}
        {navOpen && view !== "settings" && (
          <div
            className="nav-scrim"
            role="presentation"
            onClick={() => setNavOpen(false)}
          />
        )}
        {view !== "settings" && (
          <Sidebar
            {...sidebarProps}
            collapsed={effCollapsed}
            onOpenSettings={() => changeView("settings")}
          />
        )}
        <main className="center">
          <div className="center__body">
            {view === "sessions" ? (
              <SessionGrid
                tabs={tabs}
                visibleTabs={visibleTabs}
                paneCount={visiblePaneCount}
                activeKey={activeKey}
                showThinking={showThinking}
                onActivate={setActiveKey}
                onClose={closeConversation}
                onFocus={expandSession}
                onBack={
                  restoreSplit && !splitSessions ? backToSplit : undefined
                }
                onSessionSplit={splitWithSession}
                terminalOpen={terminalPane && view === "sessions"}
                onTerminalToggle={toggleTerminalPane}
                terminalExpanded={terminalExpanded}
                onTerminalExpand={() => setTerminalExpanded(true)}
                onTerminalCollapse={() => setTerminalExpanded(false)}
                onTerminalClose={closeTerminalPane}
                theme={theme}
                onSessionDrop={dropSession}
                onSessionTabsChange={setTabbedSessionKeys}
                focusMode={!splitSessions}
              />
            ) : view === "fleet" ? (
              <FleetPage
                onFocusSession={(key) => {
                  // Focusing alone left Fleet on screen, so the card click looked
                  // dead — the session it selected was behind this view.
                  focusSession(key);
                  setView("sessions");
                }}
              />
            ) : view === "battle" ? (
              <BattlePage
                showThinking={showThinking}
                onFocusSession={(key) => {
                  focusSession(key);
                  setView("sessions");
                }}
              />
            ) : view === "notes" ? (
              <NotesPage />
            ) : (
              <WorkbenchPage
                view={view}
                showThinking={showThinking}
                onShowThinkingChange={setShowThinking}
                sessionKey={activeKey}
                onBack={() => changeView("sessions")}
              />
            )}
          </div>
          {toast && (
            <div className="app-toast" role="status" aria-live="polite">
              {toast}
            </div>
          )}
          <UpdateTray />
        </main>
        {view !== "settings" && <AppFooter />}
      </div>
    </TerminalRunsProvider>
  );
}

/** Opening a pane past this many tucks the sidebar into its rail. */
const SIDEBAR_PANE_LIMIT = 4;

function SessionGrid({
  tabs,
  visibleTabs,
  paneCount,
  activeKey,
  showThinking,
  onActivate,
  onClose,
  onFocus,
  onBack,
  onSessionSplit,
  terminalOpen,
  onTerminalToggle,
  terminalExpanded, onTerminalExpand, onTerminalCollapse, onTerminalClose, theme,
  onSessionDrop, onSessionTabsChange, focusMode,
}: {
  tabs: ConversationTab[];
  visibleTabs: ConversationTab[];
  paneCount: number;
  activeKey: string;
  showThinking: boolean;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onFocus: (key: string) => void;
  onBack?: () => void;
  onSessionSplit: (key: string) => void;
  terminalOpen: boolean;
  onTerminalToggle: () => void;
  terminalExpanded: boolean;
  onTerminalExpand: () => void;
  onTerminalCollapse: () => void;
  onTerminalClose: () => void;
  theme: "light" | "dark";
  onSessionDrop: (data: SessionDrag, asTab: boolean) => string | null;
  onSessionTabsChange: (keys: string[]) => void;
  focusMode: boolean;
}) {
  const split = paneCount > 1;
  const [headerHost, setHeaderHost] = useState<HTMLDivElement | null>(null);
  const [tabHosts, setTabHosts] = useState<Record<string, HTMLDivElement | null>>({});
  const onTabHost = useCallback((key: string, node: HTMLDivElement | null) => {
    setTabHosts(current => current[key] === node ? current : { ...current, [key]: node });
  }, []);
  const focusedKey = visibleTabs.some((tab) => tab.key === activeKey)
    ? activeKey
    : visibleTabs[0]?.key;
  const [reviewTabs, setReviewTabs] = useState<ReviewTab[]>([]);
  const [activeReviewId, setActiveReviewId] = useState<string | null>(null);
  const [diffLayout, setDiffLayout] = useState<DiffLayout>("unified");
  // One movable workspace follows the focused session; its open state persists.
  const [sharedWorkspace, setSharedWorkspace] = useState(
    () => localStorage.getItem("devden.split-workspace") === "1",
  );
  const [workspaceTab, setWorkspaceTab] = useState<"files" | "changes">(() =>
    localStorage.getItem("devden.split-workspace-tab") === "changes"
      ? "changes"
      : "files",
  );
  useEffect(() => {
    localStorage.setItem("devden.split-workspace", sharedWorkspace ? "1" : "0");
  }, [sharedWorkspace]);
  useEffect(() => {
    localStorage.setItem("devden.split-workspace-tab", workspaceTab);
  }, [workspaceTab]);
  const focusedTab = visibleTabs.find((tab) => tab.key === focusedKey);
  const showWorkspace = sharedWorkspace && !!focusedTab?.cwd;
  const [boardOpen, setBoardOpen] = useState(false);
  useEffect(() => {
    const toggle = () => setBoardOpen(open => !open);
    window.addEventListener("devden:toggle-board", toggle);
    return () => window.removeEventListener("devden:toggle-board", toggle);
  }, []);
  const [maximizedPane, setMaximizedPane] = useState<string | null>(null);
  const openSharedWorkspace = useCallback((nextTab?: "files" | "changes") => {
    if (nextTab) setWorkspaceTab(nextTab);
    setSharedWorkspace(true);
  }, []);
  useEffect(() => {
    const keys = new Set(tabs.map((tab) => tab.key));
    setReviewTabs((current) => {
      const next = current.filter((item) => keys.has(item.sessionKey));
      return next.length === current.length ? current : next;
    });
  }, [tabs]);
  const openReview = (tab: ConversationTab, view: ToolFileView) => {
    const id = reviewTabId(tab.key, view.title);
    setReviewTabs((current) =>
      current.some((item) => item.id === id)
        ? current.map((item) =>
            item.id === id
              ? {
                  ...item,
                  view,
                  backend: tab.backend,
                  sessionTitle: tab.label,
                }
              : item,
          )
        : [
            ...current,
            {
              id,
              sessionKey: tab.key,
              backend: tab.backend,
              sessionTitle: tab.label,
              view,
            },
          ],
    );
    setActiveReviewId(id);
  };
  const closeReviewTab = (id: string) => {
    setReviewTabs((current) => current.filter((item) => item.id !== id));
    setActiveReviewId((active) => (active === id ? null : active));
  };
  const activeReview =
    reviewTabs.find((item) => item.id === activeReviewId) ??
    reviewTabs[0] ??
    null;
  const docked = reviewTabs.length > 0;
  const { workingKeys, awaitingKeys, openConversation, openDefaultConversation } = useStore();
  const layout = sessionPaneLayout(paneCount);
  // Layout identities persist while process keys stay unique to each browser page.
  const panels: DockPanel[] = tabs.map((tab) => {
    const visible = visibleTabs.some(item => item.key === tab.key);
    return {
      id: tab.key, layoutId: tab.layoutId ?? tab.key, session: true, title: tab.label || "Chat", hidden: !visible,
      backend: tab.backend, tone: awaitingKeys.has(tab.key) ? "waiting" : workingKeys.has(tab.key) ? "running" : undefined,
      content: <section
        className={`session-pane${tab.key === activeKey ? " is-active" : ""}${activeReview?.sessionKey === tab.key ? " is-reviewing" : ""}`}
        aria-label={`Session ${tab.label}`} onPointerDownCapture={() => onActivate(tab.key)}>
        <Conversation
          tab={tab} showThinking={showThinking} split={split}
          density={split ? layout.density : "full"} sessionCount={paneCount}
          headerHost={headerHost} tabHost={tabHosts[tab.key] ?? null} focused={tab.key === focusedKey} visible={visible}
          onClose={visible && split ? () => onClose(tab.key) : undefined}
          onFocus={visible && split ? () => onFocus(tab.key) : undefined}
          onBack={visible && !split ? onBack : undefined}
          sharedWorkspaceOpen={showWorkspace}
          onSharedWorkspaceToggle={() => setSharedWorkspace(open => !open)}
          onSharedWorkspaceOpen={openSharedWorkspace}
          sharedBoardOpen={boardOpen}
          onSharedBoardToggle={() => setBoardOpen(open => !open)}
          onSessionSplit={onSessionSplit} terminalOpen={terminalOpen} onTerminalToggle={onTerminalToggle}
          reviewTitle={activeReview?.sessionKey === tab.key ? activeReview.view.title : null}
          dockMulti={split} onOpenReview={view => openReview(tab, view)}
        />
      </section>,
    };
  });
  if (!tabs.length) panels.push({ id: "empty", title: "Workspace", content: <EmptyCenter /> });
  if (showWorkspace && focusedTab) panels.push({ id: "workspace", title: "Files & changes", content:
    <WorkspaceExplorer key={focusedTab.cwd} sessionKey={focusedTab.key} root={focusedTab.cwd}
      visible placement={maximizedPane === "workspace" ? "full" : "side"} tab={workspaceTab} onTabChange={setWorkspaceTab}
      onPlacementChange={placement => setMaximizedPane(placement === "full" ? "workspace" : null)}
      onClose={() => { setSharedWorkspace(false); setMaximizedPane(null); }} /> });
  if (docked && activeReview) panels.push({ id: "review", title: "Review", content:
    <ReviewDock tabs={reviewTabs} activeId={activeReview.id} layout={diffLayout} multi={split}
      onLayout={setDiffLayout} onActivate={setActiveReviewId} onCloseTab={closeReviewTab}
      onCloseDiff={() => { setReviewTabs([]); setActiveReviewId(null); }} /> });
  if (boardOpen && focusedTab?.cwd) panels.push({ id: "board", title: "Board", content:
    <BoardPanel key={focusedTab.cwd} cwd={focusedTab.cwd} sessionPath={focusedTab.sessionPath} onClose={() => setBoardOpen(false)} /> });
  if (terminalOpen) panels.push({ id: "terminal", title: "Terminal", content:
    <TerminalPage cwd={focusedTab?.cwd} theme={theme} pane expanded={terminalExpanded}
      onExpand={onTerminalExpand} onCollapse={onTerminalCollapse} onClose={onTerminalClose} /> });
  return <div className="workbench-split">
    <DockLayout onTabHost={onTabHost} onNewSession={() => { if (focusedTab?.cwd) openConversation(focusedTab.cwd, undefined, focusedTab.backend, { forceNew: true }); else void openDefaultConversation(); }} toolbar={!terminalExpanded ? <div className="session-toolbar" ref={setHeaderHost} /> : null} panels={panels} storageKey="devden.dock-layout" maximized={terminalExpanded ? "terminal" : showWorkspace ? maximizedPane : null}
      className={`session-grid${split ? " is-split" : ""}`}
      activeSession={activeKey} onSessionActivate={onActivate} onSessionDrop={onSessionDrop}
      onSessionTabsChange={onSessionTabsChange} onSessionClose={onClose} focusMode={focusMode} />
  </div>;
}

function EmptyCenter() {
  return (
    <div className="conversation">
      <div className="hero">
        <div className="hero__glow" />
        <div className="hero__stack">
          <div className="hero__headline">
            <span className="hero__fish">
              <FishLogo size={34} />
            </span>
            <span className="hero__title">Onwards & Upwards</span>
            <span className="hero__badge">Preview</span>
          </div>
          <div className="hero__opening">Opening your workspace…</div>
        </div>
      </div>
    </div>
  );
}

function SetupGate() {
  const { setup } = useStore();
  if (setup === "checking") {
    return (
      <div className="setup">
        <p className="setup-wait">Checking this machine…</p>
      </div>
    );
  }
  if (setup === "needed") return <Onboarding />;
  return <Frame />;
}

export function App() {
  return (
    <AuthGate>
      <StoreProvider>
        <SetupGate />
      </StoreProvider>
    </AuthGate>
  );
}

/**
 * Token gate: when the server has DEVDEN_TOKEN set, every API call 401s until
 * the user enters the token. The token is exchanged for an HttpOnly cookie
 * (same-origin) and a one-time ticket (cross-origin EventSource/WebSocket),
 * then stored locally so later requests carry the Authorization header.
 */
function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "authed" | "denied">(
    "checking",
  );
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .authStatus()
      .then(() => {
        if (!cancelled) setState("authed");
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof AuthError) setState("denied");
        else setState("authed"); // server unreachable; let the app surface it
      });
    // A token rotation or expiry mid-session re-locks the UI instead of
    // failing silently per-request.
    const onUnhandled = (event: PromiseRejectionEvent) => {
      if (event.reason instanceof AuthError) setState("denied");
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    return () => {
      cancelled = true;
      window.removeEventListener("unhandledrejection", onUnhandled);
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const result = await api.auth(token.trim());
      if (!result.ok) {
        setError("Invalid token.");
        return;
      }
      setAuthToken(token.trim());
      setState("authed");
    } catch {
      setError("Could not reach the server.");
    }
  };

  if (state === "checking") {
    return (
      <div className="auth-gate">
        <div className="auth-gate__card">Checking…</div>
      </div>
    );
  }
  if (state === "denied") {
    return (
      <div className="auth-gate">
        <form className="auth-gate__card" onSubmit={submit}>
          <h1>devden is locked</h1>
          <p>
            The server requires a token. Enter the value of DEVDEN_TOKEN to
            continue.
          </p>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="DEVDEN_TOKEN"
            autoFocus
          />
          <button type="submit">Unlock</button>
          {error && <p className="auth-gate__error">{error}</p>}
        </form>
      </div>
    );
  }
  return <>{children}</>;
}
