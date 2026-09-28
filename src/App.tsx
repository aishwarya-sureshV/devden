import {
  useCallback,
  useEffect,
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
import { Conversation } from "./components/Conversation";
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
  hasBackdrop,
  highlightVars,
  setAppearance,
  subscribeAppearance,
} from "./lib/appearance";
import type { WorkbenchView } from "./lib/navigation";
import { sessionPaneLayout } from "./lib/sessionLayout";
import { TerminalRunsProvider } from "./lib/terminalRuns";
import { applyCodeTheme, codeTheme } from "./lib/codeTheme";
import "./styles/app.css";
import "./styles/conversation.css";
import "./styles/onboarding.css";

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

function Frame() {
  const {
    tabs,
    active,
    activeKey,
    setActiveKey,
    closeConversation,
    setVisibleSessionKeys,
  } = useStore();
  const [view, setView] = useState<WorkbenchView>("sessions");
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
  // Narrow screens have no room for a permanent sidebar, so it becomes a
  // drawer. Without this the ≤760px layout hid the sidebar outright and left
  // no way to reach sessions, skills, the terminal or settings from a phone.
  const [navOpen, setNavOpen] = useState(false);
  // Appearance comes from the redesign's settings store: mode feeds the
  // legacy data-ds-dark-theme attribute so both themes stay in sync.
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearance);
  // Photo wallpapers are dark scenes — while one is active the app follows
  // the dark glass skin: light-mode white frosting over them reads as milk.
  // Shader scenes keep the user's light/dark choice (they render both).
  const theme = activePhoto(appearance) ? "dark" : appearance.mode;
  // Hidden by default. Reasoning streams are long and largely scratch work —
  // shown inline they bury the tool cards and the answer. Settings turns them
  // back on, and that choice sticks.
  const [showThinking, setShowThinking] = useState(
    () => localStorage.getItem("devden.show-thinking") === "on",
  );
  // Terminal lives in a right-docked pane next to the conversation; the
  // expand button swaps it to a full-width view without unmounting the PTYs.
  const [terminalPane, setTerminalPane] = useState(
    () => localStorage.getItem("devden.terminal-pane") === "open",
  );
  const [terminalExpanded, setTerminalExpanded] = useState(false);
  const [terminalWidth, setTerminalWidth] = useState(() => {
    const stored = Number(localStorage.getItem("devden.terminal-width"));
    return Number.isFinite(stored) && stored > 0
      ? Math.min(760, Math.max(280, stored))
      : 420;
  });

  useEffect(() => {
    document.body.toggleAttribute("data-ds-dark-theme", theme === "dark");
    localStorage.setItem("devden.theme.v2", theme);
  }, [theme]);

  // Glass activation + pane tuning, driven by the appearance settings.
  useEffect(() => {
    document.body.toggleAttribute("data-glass", hasBackdrop());
    document.body.style.setProperty("--g-blur", `${appearance.blur}px`);
    document.body.style.setProperty("--g-tint-a", String(appearance.tint));
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

  const startTerminalResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = terminalWidth;
    const onMove = (moveEvent: PointerEvent) => {
      // Left edge drag: moving left widens the pane.
      const next = Math.min(
        760,
        Math.max(280, startWidth + (startX - moveEvent.clientX)),
      );
      setTerminalWidth(next);
      localStorage.setItem("devden.terminal-width", String(next));
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove("is-resizing-sessions");
    };
    document.body.classList.add("is-resizing-sessions");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

  const toggleSplitSessions = () => {
    if (splitSessions) {
      focusSession(activeKey);
      return;
    }
    localStorage.setItem("devden.session-layout", "split");
    setSplitSessionKeys(tabs.map((tab) => tab.key));
    setSplitSessions(true);
  };

  const focusSession = (key: string) => {
    localStorage.setItem("devden.session-layout", "focus");
    if (key) setActiveKey(key);
    setSplitSessions(false);
    setSplitSessionKeys([]);
  };

  const splitWithSession = (key: string) => {
    localStorage.setItem("devden.session-layout", "split");
    setSplitSessionKeys((current) => {
      const base = current.length > 0 ? current : [activeKey];
      return [...new Set([...base, key])].filter(Boolean);
    });
    setSplitSessions(true);
  };

  const visibleTabs = splitSessions
    ? tabs.filter((tab) => {
        if (tab.guest && !splitSessionKeys.includes(tab.key)) return false;
        return (
          splitSessionKeys.length === 0 || splitSessionKeys.includes(tab.key)
        );
      })
    : active
      ? [active]
      : [];

  // The store persists which panes were on screen so a refresh restores the
  // whole split layout instead of collapsing to the active session.
  const visibleKeyList = visibleTabs.map((tab) => tab.key).join(",");
  useEffect(() => {
    setVisibleSessionKeys(visibleKeyList ? visibleKeyList.split(",") : []);
  }, [visibleKeyList, setVisibleSessionKeys]);

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
    openTabKeys: visibleTabs.map((tab) => tab.key),
    terminalOpen: terminalPane && view === "sessions",
    onTerminalToggle: toggleTerminalPane,
    onResizePointerDown: startSidebarResize,
    onResizeKeyDown: resizeSidebarWithKeyboard,
  };

  return (
    <TerminalRunsProvider onNeedOpen={openTerminalPane}>
      <Backdrop />
      <div
        className={`app-frame${navOpen ? " is-nav-open" : ""}`}
        data-layout={appearance.layout}
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
        <button
          type="button"
          className="nav-toggle"
          aria-label={navOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={navOpen}
          onClick={() => setNavOpen((open) => !open)}
        >
          {navOpen ? "✕" : "☰"}
        </button>
        {navOpen && (
          <div
            className="nav-scrim"
            role="presentation"
            onClick={() => setNavOpen(false)}
          />
        )}
        <Sidebar
          {...sidebarProps}
          collapsed={effCollapsed}
          onOpenSettings={() => changeView("settings")}
        />
        <main className="center">
          <div
            className={`center__body${terminalPane && terminalExpanded ? " is-hidden" : ""}`}
          >
            {view === "sessions" ? (
              <>
                {tabs.length > 0 ? (
                  <SessionGrid
                    tabs={tabs}
                    visibleTabs={visibleTabs}
                    activeKey={activeKey}
                    showThinking={showThinking}
                    onActivate={setActiveKey}
                    onClose={closeConversation}
                    onSessionSplit={splitWithSession}
                    terminalOpen={terminalPane && view === "sessions"}
                    onTerminalToggle={toggleTerminalPane}
                  />
                ) : (
                  <EmptyCenter />
                )}
              </>
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
                theme={theme}
                onThemeChange={(mode) => setAppearance({ mode })}
                showThinking={showThinking}
                onShowThinkingChange={setShowThinking}
                sessionKey={activeKey}
              />
            )}
          </div>
          {terminalPane && view === "sessions" && !terminalExpanded && (
            <button
              type="button"
              className="terminal-pane-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize terminal pane"
              title="Drag to resize terminal"
              onPointerDown={startTerminalResize}
            />
          )}
          {terminalPane && view === "sessions" && (
            <aside
              className={`terminal-pane${terminalExpanded ? " is-expanded" : ""}`}
              aria-label="Terminal pane"
              style={
                terminalExpanded ? undefined : { width: `${terminalWidth}px` }
              }
            >
              <TerminalPage
                cwd={active?.cwd}
                theme={theme}
                pane
                expanded={terminalExpanded}
                onExpand={() => setTerminalExpanded(true)}
                onCollapse={() => setTerminalExpanded(false)}
                onClose={closeTerminalPane}
              />
            </aside>
          )}
        </main>
        <AppFooter />
      </div>
    </TerminalRunsProvider>
  );
}

function SessionGrid({
  tabs,
  visibleTabs,
  activeKey,
  showThinking,
  onActivate,
  onClose,
  onSessionSplit,
  terminalOpen,
  onTerminalToggle,
}: {
  tabs: ConversationTab[];
  visibleTabs: ConversationTab[];
  activeKey: string;
  showThinking: boolean;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onSessionSplit: (key: string) => void;
  terminalOpen: boolean;
  onTerminalToggle: () => void;
}) {
  const split = visibleTabs.length > 1;
  const layout = sessionPaneLayout(visibleTabs.length);
  // Four panes tile 2×2. Three panes are two on top and one underneath
  // that spans both. Other counts keep the tiler.
  const twoByTwo = split && visibleTabs.length === 4;
  const threeStack = split && visibleTabs.length === 3;
  return (
    <div
      className={`session-grid${split ? " is-split" : ""}`}
      data-density={split ? layout.density : "full"}
      style={
        split
          ? {
              gridTemplateColumns:
                threeStack || twoByTwo
                  ? "repeat(2, minmax(0, 1fr))"
                  : `repeat(${layout.track}, minmax(0, 1fr))`,
              ...(threeStack || twoByTwo
                ? { gridTemplateRows: "repeat(2, minmax(0, 1fr))" }
                : {}),
            }
          : undefined
      }
    >
      {tabs.map((tab) => {
        const visibleIndex = visibleTabs.findIndex(
          (visible) => visible.key === tab.key,
        );
        const visible = visibleIndex >= 0;
        return (
          <div
            key={tab.key}
            className={`session-pane-slot${visible ? "" : " is-background"}`}
            hidden={!visible}
            aria-hidden={!visible}
            style={
              visible && split
                ? threeStack
                  ? visibleIndex === 2
                    ? { gridColumn: "1 / -1" }
                    : undefined
                  : { gridColumn: `span ${layout.spans[visibleIndex]}` }
                : undefined
            }
          >
            <section
              className={`session-pane${tab.key === activeKey ? " is-active" : ""}`}
              aria-label={`Session ${tab.label}`}
              onPointerDownCapture={() => onActivate(tab.key)}
            >
              <Conversation
                tab={tab}
                showThinking={showThinking}
                split={split}
                density={split ? layout.density : "full"}
                onClose={visible && split ? () => onClose(tab.key) : undefined}
                onSessionSplit={onSessionSplit}
                terminalOpen={terminalOpen}
                onTerminalToggle={onTerminalToggle}
              />
            </section>
          </div>
        );
      })}
    </div>
  );
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
