/**
 * App state: manages open conversation tabs, each bound to a Timeline that
 * consumes the shared SSE event stream keyed by sessionKey.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  AGENT_BACKENDS,
  api,
  backendLabel,
  subscribeEvents,
  type AgentEvent,
  type AgentBackend,
  type ModelInfo,
  type ResumeSession,
  type SessionHistoryMessage,
  type SessionMutationResponse,
  type SessionState,
} from "./api";
import { capabilitiesFor } from "./agentCapabilities";
import { persistedTurnLooksSettled, Timeline } from "./timeline";
import { notify } from "./notify";
import { savedSessionTitle } from "./sessionTitle";
import { isAwaitingAnswer } from "./awaitingAnswer";
import type { SkillDraftSeed } from "./skilldraft";
import {
  CLAUDE_DEFAULT_EFFORT,
  CLAUDE_DEFAULT_MODEL,
  claudeModelInfo,
} from "./claudeModels";

export interface ConversationTab {
  key: string;
  label: string;
  cwd: string;
  sessionPath?: string;
  backend: AgentBackend;
  /** Created from New session (as opposed to opening saved history). */
  isFresh: boolean;
  /** Guest tabs (cross-backend review) stay off the grid until opened. */
  guest?: boolean;
  accessMode?: "workspace-write" | "read-only";
  agentMode?: "standard" | "plan" | "routed" | "manual";
  timeline: Timeline;
}

export interface OpenConversationOptions {
  /** When false, the new tab is created without becoming the focused pane. */
  activate?: boolean;
  /** Hidden from split/focus until revealConversation. */
  guest?: boolean;
  /** Skip the sessionPath reuse check. Forks must mint a new tab. */
  forceNew?: boolean;
  accessMode?: "workspace-write" | "read-only";
  agentMode?: "standard" | "plan" | "routed" | "manual";
  /** Explicit model/effort for the new session (battle races pick these per
   *  backend); left undefined they fall back to the preferred/default pick. */
  model?: ModelInfo;
  thinkingLevel?: string;
}

/** How long a "working" conversation may stay silent before the page stops
 *  trusting the feed and asks the server directly. */
const QUIET_MS = 30_000;
const RECONCILE_MS = 10_000;

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...b].every((key) => a.has(key));
}

function timelineIsWorking(timeline: Timeline | undefined): boolean {
  return Boolean(
    timeline && (timeline.status === "working" || timeline.state?.isStreaming),
  );
}

/** Tokens or a foreground tool still moving — as opposed to the empty
 *  "Grok is thinking" placeholder, which is exactly the stuck state. */

interface StoreValue {
  tabs: ConversationTab[];
  activeKey: string;
  active: ConversationTab | undefined;
  workingKeys: ReadonlySet<string>;
  /** Sessions whose last turn ended on a question and are parked on an answer. */
  awaitingKeys: ReadonlySet<string>;
  resumeSessions: ResumeSession[];
  archivedSessions: ResumeSession[];
  openConversation: (
    cwd: string,
    label?: string,
    backend?: AgentBackend,
    options?: OpenConversationOptions,
  ) => string;
  /** Make a guest tab a normal pane and focus it. */
  revealConversation: (key: string) => void;
  openDefaultConversation: () => Promise<string>;
  resumeConversation: (session: ResumeSession) => string;
  openForkedConversation: (args: {
    cwd: string;
    sessionPath: string;
    messages: SessionHistoryMessage[];
    state?: SessionState | null;
    label?: string;
    backend?: AgentBackend;
    accessMode?: "workspace-write" | "read-only";
    agentMode?: "standard" | "plan" | "routed" | "manual";
  }) => string;
  closeConversation: (key: string) => void;
  setActiveKey: (key: string) => void;
  /** Panes on screen right now (App owns the split set); persisted per reload. */
  setVisibleSessionKeys: (keys: string[]) => void;
  setConversationSessionPath: (key: string, path?: string) => void;
  setConversationLabel: (key: string, label: string) => void;
  setConversationWorkspace: (key: string, cwd: string) => void;
  archiveSession: (session: ResumeSession) => Promise<SessionMutationResponse>;
  restoreSession: (session: ResumeSession) => Promise<SessionMutationResponse>;
  deleteSession: (session: ResumeSession) => Promise<SessionMutationResponse>;
  /** Removes a workspace's folder and every session that put it in the sidebar. */
  deleteWorkspace: (
    cwd: string,
    sessions: ResumeSession[],
  ) => Promise<SessionMutationResponse>;
  refreshSessions: () => void;
  /** False until the first session listing lands, so the sidebar's empty
   *  state can tell "you have none" apart from "they haven't arrived yet". */
  sessionsLoaded: boolean;
  /** Backend used for new sessions. Existing tabs keep the backend they opened with. */
  defaultBackend: AgentBackend;
  setDefaultBackend: (backend: AgentBackend) => void;
  /** Every workspace this browser knows about: open tabs + saved sessions of every agent. */
  knownWorkspaces: string[];
  setPreferredModel: (
    backend: AgentBackend,
    cwd: string,
    model: ModelInfo | null,
  ) => void;
  workspaceReveal: { key: string; nonce: number } | null;
  revealWorkspace: (key: string) => void;
  /** A distilled skill draft staged by the SkillDraftCard, waiting for the
   *  Skills view to open it in its editor for review before save. */
  skillDraft: SkillDraftSeed | null;
  setSkillDraft: (draft: SkillDraftSeed | null) => void;
  /** First messages for tabs opened by something other than a person typing
   *  (a board card, a race candidate) — several can be pending at once, so
   *  one keyed map rather than a single slot. Consumed once, then cleared. */
  taskSeeds: Record<string, TaskSeed>;
  seedTask: (key: string, seed: TaskSeed) => void;
  clearTaskSeed: (key: string) => void;
}

/** A composer attachment: uploaded to the server, referenced by path in prompts. */
export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  /** Base64 inline data, image attachments only (models see it in-context). */
  imageData?: string;
};

/** The first message for a seeded tab (board card, race candidate). */
export interface TaskSeed {
  prompt: string;
  attachments?: Attachment[];
}

const StoreContext = createContext<StoreValue | null>(null);
const timelines = new Map<string, Timeline>();
const pageSessionId = crypto.randomUUID();
let counter = 1;

interface PersistedOpenSession {
  cwd: string;
  label: string;
  backend: AgentBackend;
  sessionPath?: string;
  model?: ModelInfo | null;
  thinkingLevel?: string;
  active?: boolean;
  /** This pane was on screen (in the split set) when the page last unloaded. */
  onScreen?: boolean;
}

// One list for every agent, not one per backend: a split view holding a pi
// session next to a claude one has to come back the same way after a reload.
const OPEN_SESSIONS_KEY = "pi-web.open-sessions.v2";
const BACKENDS = AGENT_BACKENDS;

/**
 * Where a new conversation starts, per agent.
 *
 * Pi and Grok default to thinking on: their models reason well, and the cost
 * is output tokens you are paying for anyway -- left off, the model reasons
 * in the visible reply instead, which is messier for roughly the same spend.
 * Ollama's cloud proxy honours only on/off (its named levels measured
 * statistically identical: minimal averaged 333 reasoning chars, max 304
 * across repeated runs), so "high" there simply means on.
 */
export const BACKEND_DEFAULT_EFFORT: Record<AgentBackend, string> = {
  pi: "high",
  claude: CLAUDE_DEFAULT_EFFORT,
  grok: "high",
  codex: "off",
};

/** Model a new conversation opens on, where the agent has a clear best pick.
 *  A model the user picked themselves in this workspace still wins over these. */
export const BACKEND_DEFAULT_MODEL: Partial<Record<AgentBackend, ModelInfo>> = {
  claude: CLAUDE_DEFAULT_MODEL,
  grok: { provider: "grok-sdk", id: "grok-4.6", name: "Grok 4.6" },
  pi: {
    provider: "ollama",
    id: "glm-5.3-flash:cloud",
    name: "glm 5.3 flash (cloud)",
  },
};

function readOpenSessions(): PersistedOpenSession[] {
  try {
    const value = JSON.parse(localStorage.getItem(OPEN_SESSIONS_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return dedupeOpenSessions(
      value.filter(
        (entry): entry is PersistedOpenSession =>
          entry &&
          typeof entry === "object" &&
          typeof entry.cwd === "string" &&
          typeof entry.label === "string" &&
          BACKENDS.includes(entry.backend),
      ),
    );
  } catch {
    return [];
  }
}

/** One tab per saved session file, and at most one path-less (fresh) tab
 *  per backend+cwd. Split restore used to reopen the same conversation
 *  twice when persist wrote a fresh tab and the session it later bound to. */
function dedupeOpenSessions(
  sessions: PersistedOpenSession[],
): PersistedOpenSession[] {
  const byPath = new Map<string, PersistedOpenSession>();
  const pathless: PersistedOpenSession[] = [];
  const seenFresh = new Set<string>();
  for (const session of sessions) {
    if (session.sessionPath) {
      byPath.set(session.sessionPath, session);
      continue;
    }
    const freshKey = `${session.backend}:${session.cwd}`;
    if (seenFresh.has(freshKey)) continue;
    seenFresh.add(freshKey);
    pathless.push(session);
  }
  return [...byPath.values(), ...pathless];
}

/** The v1 per-backend snapshots, merged once so an upgrade keeps open tabs. */
function readLegacyOpenSessions(): PersistedOpenSession[] {
  return BACKENDS.flatMap((backend) => {
    try {
      const value = JSON.parse(
        localStorage.getItem(`pi-web.open-sessions.v1.${backend}`) ?? "[]",
      );
      return Array.isArray(value)
        ? value.filter(
            (entry): entry is PersistedOpenSession =>
              entry &&
              typeof entry === "object" &&
              typeof entry.cwd === "string" &&
              typeof entry.label === "string" &&
              entry.backend === backend,
          )
        : [];
    } catch {
      return [];
    }
  });
}

function modelPreferenceKey(backend: AgentBackend, cwd: string): string {
  return `${backend}:${cwd}`;
}

function timelineFor(key: string): Timeline {
  let timeline = timelines.get(key);
  if (!timeline) {
    timeline = new Timeline(key);
    timelines.set(key, timeline);
  }
  return timeline;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<ConversationTab[]>([]);
  const [activeKey, setActiveKey] = useState("");
  const [workingKeys, setWorkingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [awaitingKeys, setAwaitingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [resumeSessions, setResumeSessions] = useState<ResumeSession[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<ResumeSession[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [workspaceReveal, setWorkspaceReveal] = useState<{
    key: string;
    nonce: number;
  } | null>(null);
  const [skillDraft, setSkillDraft] = useState<SkillDraftSeed | null>(null);
  const [taskSeeds, setTaskSeeds] = useState<Record<string, TaskSeed>>({});
  const defaultCwd = useRef("");
  // The backend NEW sessions use. It is no longer the identity of the whole
  // page: switching it used to reload with ?backend=, which is what made
  // running a pi session and a claude session side by side impossible.
  const initialBackend = ((): AgentBackend => {
    const requested =
      new URLSearchParams(window.location.search).get("backend") ??
      localStorage.getItem("pi-web.backend");
    return requested === "claude" ||
      requested === "grok" ||
      requested === "codex"
      ? requested
      : "pi";
  })();
  const [defaultBackend, setDefaultBackendState] =
    useState<AgentBackend>(initialBackend);
  const defaultBackendRef = useRef<AgentBackend>(initialBackend);
  const setDefaultBackend = useCallback((backend: AgentBackend) => {
    defaultBackendRef.current = backend;
    setDefaultBackendState(backend);
    try {
      localStorage.setItem("pi-web.backend", backend);
    } catch {
      /* private mode; the choice lasts this session only */
    }
  }, []);
  const didOpenInitialSession = useRef(false);
  const didRenderRestoredSessions = useRef(false);
  /** Bumped when the page becomes visible, so the snapshot persist effect
   *  re-runs after hidden-page writes were skipped. */
  const [visibleTick, setVisibleTick] = useState(0);
  const tabsRef = useRef<ConversationTab[]>([]);
  const firstStreamConnect = useRef(true);
  /** Per key, when this page last heard anything about it. */
  const lastEventAt = useRef(new Map<string, number>());
  const preferredModels = useRef(new Map<string, ModelInfo>());
  /** Keys of the panes on screen, fed by App (it owns the split set). Held in
   *  state, not a ref, so the persisted snapshot picks the change up: toggling
   *  the split layout leaves `tabs` and `activeKey` alone. */
  const [visibleSessionKeys, setVisibleKeys] = useState<string[]>([]);
  const setVisibleSessionKeys = useCallback((keys: string[]) => {
    setVisibleKeys((current) =>
      current.length === keys.length &&
      current.every((key, index) => key === keys[index])
        ? current
        : keys,
    );
  }, []);
  const persistedOpenSessions = useRef(
    (() => {
      const stored = readOpenSessions();
      return stored.length > 0 ? stored : readLegacyOpenSessions();
    })(),
  );

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    // Server-side lease: the page renews a lease for every open conversation
    // and the server reaps agents whose page stopped heartbeating (tab closed,
    // browser quit). This is the single owner of process lifetime across
    // refreshes — the old pagehide beacon raced the server's adoptLiveAgent
    // and killed the very process a refresh was supposed to rebind. A refresh
    // never stops the agent now: the new page's /start adopts the live process.
    const sendHeartbeat = () => {
      const keys = tabsRef.current.map((tab) => tab.key);
      if (keys.length === 0) return;
      void api.heartbeat(keys).catch(() => {});
    };
    sendHeartbeat();
    const timer = window.setInterval(sendHeartbeat, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") sendHeartbeat();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setVisibleTick((t) => t + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const refreshSessions = useCallback(() => {
    // Every agent's sessions, not just the current one: the sidebar shows
    // them together and each carries its own backend, so opening one always
    // resumes it on the agent that wrote it.
    void Promise.all([
      api.sessions("recent", "all"),
      api.sessions("archived", "all"),
    ])
      .then(([recent, archived]) => {
        if (recent.ok) setResumeSessions(recent.sessions);
        if (archived.ok) setArchivedSessions(archived.sessions);
      })
      .catch(() => {
        /* keep whatever is already listed */
      })
      // Also on failure: a sidebar stuck on "Loading…" forever is worse than
      // one that says it found nothing.
      .finally(() => setSessionsLoaded(true));
  }, []);

  const restoreLiveTurn = useCallback((key: string, timeline: Timeline) => {
    void api.backendLog(key).then((result) => {
      if (!result.ok || !Array.isArray(result.entries)) return;
      const outcome = timeline.replayLiveTurn(result.entries);
      if (outcome === "live") return;
      // "settled" means the run finished while the log was in flight;
      // "none" means the log was too torn to replay. Either way the tail of
      // the turn is missing from what was hydrated a moment ago — including,
      // when the run ended on a question, the question itself, which left the
      // session looking like it had simply stopped. The session file has it.
      const sessionFile = timeline.state?.sessionFile;
      if (!sessionFile) return;
      void api.sessionMessages(sessionFile).then((refreshed) => {
        if (!refreshed.ok || !Array.isArray(refreshed.messages)) return;
        const state = timeline.state;
        if (!state) return;
        // A new turn may have started in the meantime (the user sent another
        // prompt); re-reading the file would drop its live items.
        if (timeline.status === "working" && outcome === "none") return;
        timeline.hydrate(refreshed.messages, { ...state, isStreaming: false });
      });
    });
  }, []);

  useEffect(() => {
    refreshSessions();
    const unsubscribe = subscribeEvents(
      (event: AgentEvent) => {
        const key = event.sessionKey;
        if (!key) return;
        lastEventAt.current.set(key, Date.now());
        const timeline = timelines.get(key);
        // Guarded: a throw here used to skip everything below it for that
        // event -- the settled notification and the session refresh included.
        // The running/awaiting badges are no longer computed here at all;
        // they are derived from the timelines (see below).
        try {
          timeline?.handle(event);
        } catch (error) {
          console.error("[pi-web] timeline event failed", event.type, error);
        }
        if (event.type === "agent_settled") {
          notify(
            "Turn finished",
            `${timeline?.state?.sessionName || "A session"} is done.`,
            `done:${key}`,
          );
        }
        if (
          event.type === "agent_start" ||
          event.type === "agent_settled" ||
          event.type === "session_title_set"
        )
          refreshSessions();
      },
      (status) => {
        // Self-heal after a stream drop (server restart, network blip): a
        // mid-turn "working" flag can otherwise stick forever, because the
        // completion event is lost with the connection. On re-connect, ask
        // the server for each open session's true state and correct the
        // timeline. The first connect is skipped — tabs hydrate themselves
        // on mount and an optimistic pending run must not be clobbered.
        if (status !== "connected") return;
        if (firstStreamConnect.current) {
          firstStreamConnect.current = false;
          return;
        }
        for (const tab of tabsRef.current) {
          const timeline = timelines.get(tab.key);
          if (!timeline) continue;
          const sessionPath = tab.sessionPath ?? timeline.state?.sessionFile;
          // A restarted server has never heard of this tab's key, and it
          // resumes an interrupted turn under a key of its own. Adopting by
          // session file is what re-binds this tab to that run — without it
          // the page sits on a dead "working" flag while the agent is
          // actually working again, and only a reload would find it.
          const correctFromServer = () =>
            api.sessionState(tab.key, tab.backend).then((result) => {
              if (!result.state) {
                timeline.clearPendingRun();
                return;
              }
              timeline.setState(result.state);
              // Correcting the flag is not enough: everything the agent did
              // while the stream was down is missing from the transcript,
              // which is what made a slept-through turn look frozen until
              // the page was reloaded. The server's log has those events.
              if (result.state.isStreaming) restoreLiveTurn(tab.key, timeline);
            });
          const reattach = sessionPath
            ? api
                .start(
                  tab.key,
                  tab.cwd,
                  tab.backend,
                  undefined,
                  sessionPath,
                  undefined,
                  true,
                )
                .then((adopted) => {
                  if (!adopted.ok || !adopted.state?.isStreaming)
                    return correctFromServer();
                  timeline.setState(adopted.state);
                  restoreLiveTurn(tab.key, timeline);
                })
            : correctFromServer();
          void reattach.catch(() => {
            /* server unreachable again; next reconnect retries */
          });
        }
      },
    );
    return unsubscribe;
  }, [refreshSessions, restoreLiveTurn]);

  // The event feed is push-only and the page never asks anything on its own,
  // so a turn whose ending never arrives spins forever: the composer stays on
  // "thinking", the sidebar stays amber, and only a manual refresh -- which
  // rebuilds from the session file instead of the feed -- clears it. Seen with
  // an update lost mid-flight, an agent that died without a last word, and a
  // backend wedged after its output was already on screen. The catch-up that
  // already exists runs only on a visible stream drop, which none of those is.
  //
  // So: when a conversation claims to be working and this page has heard
  // nothing about it for QUIET_MS, ask the server what is actually true. A
  // genuinely long tool call answers "still streaming" and costs one request
  // per quiet window; a turn that ended gets its tail replayed and settles.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      for (const tab of tabsRef.current) {
        const timeline = timelines.get(tab.key);
        if (!timeline || !timelineIsWorking(timeline)) continue;
        const heard = lastEventAt.current.get(tab.key);
        // First quiet observation only seeds the clock: a turn that has not
        // streamed anything yet has not gone quiet, it has not started.
        if (heard === undefined || now - heard < QUIET_MS) {
          if (heard === undefined) lastEventAt.current.set(tab.key, now);
          continue;
        }
        // Count the ask itself as activity, so a still-working turn is asked
        // about once per quiet window rather than on every tick.
        lastEventAt.current.set(tab.key, now);
        void api
          .sessionState(tab.key, tab.backend)
          .then((result) => {
            if (!result.state) {
              timeline.clearPendingRun();
              return;
            }
            if (result.state.isStreaming) {
              // The process still claims a live turn. Grok often has the
              // reply on disk already (ACP prompt hung after it journaled
              // turn_completed under its own `_x.ai/session/update` method,
              // which the ACP client never dispatches). If the session file
              // already holds that finished reply, take it the way a refresh
              // would.
              //
              // This used to bail whenever the timeline still showed live
              // text or a running tool — which is precisely the shape of the
              // bug it was meant to catch, so the stall only ever cleared on
              // a manual refresh. persistedTurnLooksSettled is the authority
              // and it is already safe: it reads the *file*, and a genuinely
              // in-flight turn has its user message journaled last, so the
              // predicate stays false until the assistant reply lands.
              const sessionFile =
                result.state.sessionFile ?? timeline.state?.sessionFile;
              if (!sessionFile) return;
              void api.sessionMessages(sessionFile).then((refreshed) => {
                if (!refreshed.ok || !Array.isArray(refreshed.messages)) return;
                if (!timelineIsWorking(timeline)) return;
                if (!persistedTurnLooksSettled(refreshed.messages)) return;
                const state = timeline.state;
                if (!state) return;
                timeline.hydrate(refreshed.messages, {
                  ...state,
                  isStreaming: false,
                });
              });
              return;
            }
            // It ended without this page hearing it, so the transcript is
            // missing the end *and* whatever came before it.
            timeline.setState(result.state);
            restoreLiveTurn(tab.key, timeline);
          })
          .catch(() => {
            /* server unreachable; the next tick asks again */
          });
      }
    }, RECONCILE_MS);
    return () => window.clearInterval(timer);
  }, [restoreLiveTurn]);

  // The generated title reaches the UI two ways: the session_title_set event
  // (live) and the saved session list (a reload, where that event belonged to
  // the previous page's session key). Feed the saved title into the timeline
  // so both paths land on the same sticky value instead of leaving a
  // refreshed tab on its prompt-derived — or cwd-derived — fallback.
  useEffect(() => {
    if (resumeSessions.length === 0) return;
    const savedByPath = new Map(
      resumeSessions.map((session) => [session.path, session]),
    );
    for (const tab of tabsRef.current) {
      const path = tab.sessionPath ?? tab.timeline.state?.sessionFile;
      const saved = path ? savedByPath.get(path) : undefined;
      if (!saved?.name) continue;
      // sessions.js falls back to `name || firstPrompt`; only a name that is
      // genuinely stored on the session is a real title.
      if (saved.name.trim() === (saved.firstPrompt ?? "").trim()) continue;
      tab.timeline.applySessionName(saved.name);
    }
  }, [resumeSessions]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshSessions();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const timer = window.setInterval(refreshWhenVisible, 30_000);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(timer);
    };
  }, [refreshSessions]);

  useEffect(() => {
    const recompute = () => {
      const working = new Set<string>();
      const awaiting = new Set<string>();
      // A tab whose session file arrived on the timeline but never reached
      // React state. The persisted snapshot reads
      // `tab.sessionPath ?? tab.timeline.state?.sessionFile`, but its effect
      // only re-runs when `tabs` identity changes — and a timeline is a
      // mutable object outside React state, so a lazily-started tab that
      // learned its path from an SSE `state` event (rather than the /prompt
      // reply, which is guarded and skipped once the timeline already knows)
      // left `tab.sessionPath` undefined forever. That tab persisted as
      // *path-less*, so the next load restored it through openConversation()
      // as a brand-new empty tab while the same conversation also came back
      // under its real path — one session, two tabs, and another one each
      // reload. dedupeOpenSessions cannot catch that pair: at dedupe time
      // one side has no path to match on.
      const bind: Array<[string, string]> = [];
      for (const tab of tabsRef.current) {
        const isWorking = timelineIsWorking(tab.timeline);
        if (isWorking) working.add(tab.key);
        if (isAwaitingAnswer(tab.timeline.items, isWorking))
          awaiting.add(tab.key);
        const file = tab.timeline.state?.sessionFile;
        if (file && tab.sessionPath !== file) bind.push([tab.key, file]);
      }
      if (bind.length > 0) {
        const paths = new Map(bind);
        setTabs((current) => {
          const next = current.map((tab) => {
            const file = paths.get(tab.key);
            return file && tab.sessionPath !== file
              ? { ...tab, sessionPath: file }
              : tab;
          });
          // Same-reference return is React's bail-out; without it the
          // subscription re-fires and this loops.
          if (next.every((tab, i) => tab === current[i])) return current;
          tabsRef.current = next;
          return next;
        });
      }
      setWorkingKeys((current) =>
        sameKeys(current, working) ? current : working,
      );
      setAwaitingKeys((current) =>
        sameKeys(current, awaiting) ? current : awaiting,
      );
    };
    recompute();
    // Timeline subscriptions, not the SSE stream: sending a prompt answers the
    // question locally and emits no server event, and the badge has to clear
    // right then rather than when the backend next says something. Running is
    // derived the same way, because a session that was already mid-turn when
    // the page loaded (hydrate/setState/adoption all set isStreaming without
    // an event of their own) otherwise had no dot until its next chunk -- and
    // a session parked in a long silent tool call has no next chunk.
    const unsubscribes = tabs.map((tab) => tab.timeline.subscribe(recompute));
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [tabs]);

  const createConversationTab = useCallback(
    (
      cwd: string,
      label?: string,
      sessionPath?: string,
      backend = defaultBackendRef.current,
      options?: OpenConversationOptions,
    ): ConversationTab => {
      // Include a page-scoped UUID so separate browser windows never bind to the
      // same Pi RPC process (each page's local counter otherwise starts at 1).
      if (sessionPath && !options?.forceNew) {
        const existing = tabsRef.current.find(
          (tab) =>
            tab.sessionPath === sessionPath ||
            tab.timeline.state?.sessionFile === sessionPath,
        );
        if (existing) {
          if (options?.activate !== false) setActiveKey(existing.key);
          return existing;
        }
      }
      const key = `conv-${pageSessionId}-${counter++}`;
      const tab: ConversationTab = {
        key,
        label: label ?? cwd.split("/").filter(Boolean).at(-1) ?? cwd,
        cwd,
        sessionPath,
        backend,
        isFresh: sessionPath === undefined,
        guest: options?.guest === true,
        accessMode: options?.accessMode,
        agentMode: options?.agentMode,
        timeline: timelineFor(key),
      };
      // Keep the ref in sync immediately. This prevents two quick clicks on
      // "New session" from racing the React state update and creating twins.
      tabsRef.current = [...tabsRef.current, tab];
      setTabs(tabsRef.current);
      if (options?.activate !== false) setActiveKey(key);
      return tab;
    },
    [],
  );

  const openConversation = useCallback(
    (
      cwd: string,
      label?: string,
      backend = defaultBackendRef.current,
      options?: OpenConversationOptions,
    ): string => {
      const freshTab = options?.guest
        ? undefined
        : tabsRef.current.find(
            (candidate) =>
              candidate.backend === backend &&
              candidate.cwd === cwd &&
              candidate.isFresh &&
              !candidate.guest &&
              !candidate.timeline.items.some(
                (item) =>
                  item.kind === "user" ||
                  item.kind === "assistant" ||
                  item.kind === "tool",
              ),
          );
      if (freshTab) {
        if (options?.activate !== false) setActiveKey(freshTab.key);
        return freshTab.key;
      }
      const tab = createConversationTab(
        cwd,
        label,
        undefined,
        backend,
        options,
      );
      const preferredModel =
        options?.model === undefined
          ? (preferredModels.current.get(modelPreferenceKey(backend, cwd)) ??
            BACKEND_DEFAULT_MODEL[backend])
          : options.model;
      const effort = options?.thinkingLevel ?? BACKEND_DEFAULT_EFFORT[backend];
      tab.timeline.setState({
        model: preferredModel ?? null,
        thinkingLevel: effort,
        isStreaming: false,
        sessionId: "",
        messageCount: 0,
        pendingMessageCount: 0,
      });
      // Guest reviews start on the first prompt, in read-only, so a warm
      // spawn here would open a writable agent before the review contract
      // is applied.
      if (options?.guest) return tab.key;
      // Lazy backends stay unspawned even for fresh conversations: starting
      // the agent just to show an empty composer costs a process spawn per
      // workbench visit and can write a ghost "Untitled session" file. The
      // prompt route starts the agent on the first message.
      // Grok still warms the ACP child (spawn + initialize, no session file)
      // so the first hello is not paying cold-start on top of the model.
      if (capabilitiesFor(backend).lazyStart) {
        if (capabilitiesFor(backend).warmStart) {
          void api
            .start(
              tab.key,
              cwd,
              backend,
              preferredModel,
              undefined,
              effort,
              false,
              true,
            )
            .catch(() => {});
        }
        return tab.key;
      }
      void api
        .start(
          tab.key,
          cwd,
          backend,
          preferredModel,
          undefined,
          options?.thinkingLevel ??
            (backend === "claude" ? CLAUDE_DEFAULT_EFFORT : undefined),
        )
        .then((result) => {
          if (result.ok && result.state) tab.timeline.setState(result.state);
          else if (!result.ok)
            tab.timeline.appendNotice(
              result.error ?? `${backendLabel(backend)} could not be started`,
              "error",
            );
        });
      return tab.key;
    },
    [createConversationTab],
  );

  const openDefaultConversation = useCallback(async (): Promise<string> => {
    let cwd = defaultCwd.current;
    if (!cwd) {
      const requestedCwd = new URLSearchParams(window.location.search)
        .get("cwd")
        ?.trim();
      if (requestedCwd) {
        cwd = requestedCwd;
      } else {
        // The workbench can land here while the API server is restarting
        // (e.g. immediately after switching backends reloads the page). Retry
        // instead of throwing and leaving no conversation open at all.
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try {
            const result = await api.health();
            cwd = result.cwd || ".";
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 750));
          }
        }
      }
      defaultCwd.current = cwd || ".";
    }
    if (!cwd) return "";
    return openConversation(cwd);
  }, [openConversation]);

  /**
   * A reload during an executing turn loses everything streamed since the
   * turn began: the session file only records completed turns, so the
   * in-flight user message, partial assistant text, running tool cards, and
   * todo snapshots vanish. The server's runtime event log holds every event
   * of the live run — replaying it reconstructs the transcript and merges
   * with events that keep arriving over SSE. If the run settled while the
   * log was being fetched, its messages are persisted by then, so the
   * session file is re-read instead.
   */
  const resumeConversation = useCallback(
    (session: ResumeSession): string => {
      const existing = tabsRef.current.find(
        (tab) =>
          tab.sessionPath === session.path ||
          tab.timeline.state?.sessionFile === session.path,
      );
      if (existing) {
        setActiveKey(existing.key);
        // A tab opened under an older build (or during a backend hiccup) may
        // have resolved to an empty timeline and cached that. Re-fetch the
        // history instead of showing the ghost forever.
        if (
          existing.timeline.items.length === 0 &&
          (existing.sessionPath ?? existing.timeline.state?.sessionFile)
        ) {
          const existingKey = existing.key;
          const existingPath =
            existing.sessionPath ?? existing.timeline.state!.sessionFile!;
          void api.sessionMessages(existingPath).then((result) => {
            if (
              !result.ok ||
              !Array.isArray(result.messages) ||
              result.messages.length === 0
            )
              return;
            if (
              tabsRef.current.some(
                (candidate) =>
                  candidate.key === existingKey &&
                  candidate.timeline.items.length === 0,
              )
            ) {
              existing.timeline.hydrate(result.messages, {
                ...(existing.timeline.state ?? {
                  model: null,
                  thinkingLevel: "off",
                  isStreaming: false,
                  sessionId: "",
                  messageCount: 0,
                  pendingMessageCount: 0,
                }),
                isStreaming: false,
              });
            }
          });
        }
        return existing.key;
      }

      const tab = createConversationTab(
        session.cwd,
        savedSessionTitle(session.name, session.firstPrompt),
        session.path,
        session.backend ?? "pi",
      );
      const timeline = tab.timeline;
      const restoredModel = session.lastModel
        ? tab.backend === "claude"
          ? claudeModelInfo(session.lastModel)
          : session.lastModelProvider
            ? { provider: session.lastModelProvider, id: session.lastModel }
            : undefined
        : undefined;
      const placeholderState = {
        model: restoredModel ?? null,
        thinkingLevel:
          session.lastEffort || BACKEND_DEFAULT_EFFORT[tab.backend],
        isStreaming: false,
        sessionId: "",
        sessionFile: session.path,
        messageCount: 0,
        pendingMessageCount: 0,
      };
      timeline.setState(placeholderState);
      // The transcript is read straight from disk; no agent process starts
      // until the first message is sent (the prompt route starts it on demand
      // with this session's context). Spawning the backend just to display
      // saved history made every session click feel like a round-trip.
      void api.sessionMessages(session.path).then((result) => {
        if (
          !result.ok ||
          !Array.isArray(result.messages) ||
          result.messages.length === 0
        ) {
          // Say so instead of leaving the empty hero up: a log that reads back
          // as nothing looked exactly like a click that did nothing at all.
          if (timeline.items.length === 0)
            timeline.appendNotice(
              result.ok
                ? "No readable turns in this session's log."
                : (result.error ?? "This session's log could not be read."),
              "error",
            );
          return;
        }
        // Never let a from-disk hydration clobber a live run: if a
        // mid-turn reload adopted the streaming agent, this late-arriving
        // read is stale by definition.
        if (timeline.state?.isStreaming) return;
        timeline.hydrate(result.messages, {
          ...(timeline.state ?? placeholderState),
          isStreaming: false,
        });
      });
      if (capabilitiesFor(tab.backend).lazyStart) {
        // Lazy backends stay unspawned for viewing — the transcript above
        // comes straight off disk. A live process running this session (page
        // refreshed mid-turn) is adopted, never spawned, so an in-flight run
        // re-attaches without paying the spawn cost on every session click.
        void api
          .start(
            tab.key,
            session.cwd,
            tab.backend,
            undefined,
            session.path,
            undefined,
            true,
          )
          .then((adopted) => {
            if (!adopted.ok || !adopted.state?.isStreaming) return;
            // Order matters: mark streaming first (guards the generic
            // hydration above), then persisted history, then the replayed
            // live run on top of it.
            timeline.setState(adopted.state);
            void api.sessionMessages(session.path).then((persisted) => {
              if (
                persisted.ok &&
                Array.isArray(persisted.messages) &&
                persisted.messages.length > 0 &&
                adopted.state
              ) {
                timeline.hydrate(persisted.messages, adopted.state);
              }
              void restoreLiveTurn(tab.key, timeline);
            });
          });
        return tab.key;
      }
      void api
        .start(
          tab.key,
          session.cwd,
          tab.backend,
          restoredModel ?? undefined,
          session.path,
          tab.backend === "claude" ? session.lastEffort : undefined,
        )
        .then(async (startResult) => {
          if (!startResult.ok) {
            timeline.appendNotice(
              startResult.error ??
                `${backendLabel(tab.backend)} could not be started`,
              "error",
            );
            return;
          }
          if (startResult.state) {
            // Keep isStreaming as reported: the process may genuinely be
            // mid-run (e.g. the page was refreshed while the agent was
            // streaming) and the UI must show that run as active.
            const resumedState = startResult.state;
            if (
              Array.isArray(startResult.messages) &&
              startResult.messages.length > 0
            ) {
              timeline.hydrate(startResult.messages, resumedState);
            } else {
              timeline.setState(resumedState);
            }
            setTabs((current) =>
              current.map((candidate) =>
                candidate.key === tab.key
                  ? {
                      ...candidate,
                      sessionPath:
                        startResult.state?.sessionFile ?? session.path,
                    }
                  : candidate,
              ),
            );
            refreshSessions();
            if (resumedState.isStreaming) {
              // A refresh that adopted a live process must never fall through
              // to the resume branch below: switch_session aborts a running
              // turn ("request was aborted"), which is exactly the state the
              // reload was supposed to preserve. Restore it in place instead —
              // persisted history first (adopting returns state only), then
              // the in-flight turn, which exists solely in the server's
              // runtime log: partial text, tool cards, and todos.
              if (
                !Array.isArray(startResult.messages) ||
                startResult.messages.length === 0
              ) {
                const persisted = await api.sessionMessages(session.path);
                if (
                  persisted.ok &&
                  Array.isArray(persisted.messages) &&
                  persisted.messages.length > 0
                ) {
                  timeline.hydrate(persisted.messages, resumedState);
                }
              }
              void restoreLiveTurn(tab.key, timeline);
              return;
            }
            if (timeline.items.length > 0) return;
          }
          const result = await api.resume(tab.key, session.path);
          if (result.ok && result.state && Array.isArray(result.messages)) {
            // Same as above: a still-running turn stays visibly running
            // instead of being flattened (and aborted) on restore.
            timeline.hydrate(result.messages, result.state);
            setTabs((current) =>
              current.map((candidate) =>
                candidate.key === tab.key
                  ? {
                      ...candidate,
                      sessionPath: result.state?.sessionFile ?? session.path,
                    }
                  : candidate,
              ),
            );
            refreshSessions();
            if (result.state.isStreaming)
              void restoreLiveTurn(tab.key, timeline);
          } else {
            timeline.reset(startResult.state ?? null);
            timeline.appendNotice(
              result.error ??
                `Could not resume the ${backendLabel(tab.backend)} session`,
              "error",
            );
            void api.stop(tab.key);
          }
        })
        .catch((error) => {
          timeline.reset(null);
          timeline.appendNotice(
            `Could not resume the ${backendLabel(tab.backend)} session: ${String(error?.message ?? error)}`,
            "error",
          );
          void api.stop(tab.key);
        });
      return tab.key;
    },
    [createConversationTab, refreshSessions, restoreLiveTurn],
  );

  // A forked branch becomes its own conversation: seeded instantly with the
  // transcript up to the fork point, then started against the branch file.
  const openForkedConversation = useCallback(
    ({
      cwd,
      sessionPath,
      messages,
      state,
      label,
      backend,
      accessMode,
      agentMode,
    }: {
      cwd: string;
      sessionPath: string;
      messages: SessionHistoryMessage[];
      state?: SessionState | null;
      label?: string;
      backend?: AgentBackend;
      accessMode?: "workspace-write" | "read-only";
      agentMode?: "standard" | "plan" | "routed" | "manual";
    }): string => {
      const forkBackend = backend ?? defaultBackendRef.current;
      const tab = createConversationTab(
        cwd,
        label ?? `${cwd.split("/").filter(Boolean).at(-1) ?? cwd} · fork`,
        sessionPath,
        forkBackend,
        { forceNew: true, accessMode, agentMode },
      );
      const timeline = tab.timeline;
      timeline.setState({
        ...(state ?? {
          model: null,
          thinkingLevel: BACKEND_DEFAULT_EFFORT[forkBackend],
          sessionId: "",
          messageCount: 0,
          pendingMessageCount: 0,
        }),
        sessionFile: state?.sessionFile ?? sessionPath,
        isStreaming: false,
      });
      if (Array.isArray(messages) && messages.length > 0 && timeline.state) {
        timeline.hydrate(messages, timeline.state);
      } else if (sessionPath) {
        // Grok ACP fork can return an empty messages array while the
        // journal still has the source turns (or after we copy them).
        void api.sessionMessages(sessionPath).then((result) => {
          if (timeline.items.length > 0) return;
          if (
            result.ok &&
            Array.isArray(result.messages) &&
            result.messages.length > 0 &&
            timeline.state
          ) {
            timeline.hydrate(result.messages, timeline.state);
            return;
          }
          timeline.appendNotice(
            result.ok
              ? "No readable turns in this session's log."
              : (result.error ?? "This session's log could not be read."),
            "error",
          );
        });
      }
      void api
        .start(
          tab.key,
          cwd,
          forkBackend,
          state?.model ?? undefined,
          sessionPath,
          state?.thinkingLevel,
          undefined,
          undefined,
          true,
          accessMode,
          agentMode,
        )
        .then((startResult) => {
          if (!startResult.ok) {
            timeline.appendNotice(
              startResult.error ?? "The forked session could not be started",
              "error",
            );
            return;
          }
          if (startResult.state) {
            const resumedState = startResult.state.isStreaming
              ? { ...startResult.state, isStreaming: false }
              : startResult.state;
            if (
              Array.isArray(startResult.messages) &&
              startResult.messages.length > 0
            ) {
              // Grok's loadSession replays the whole copied journal. If the
              // fork already seeded a shorter cut, keep that cut.
              const incoming = startResult.messages;
              const seeded = Array.isArray(messages) ? messages : [];
              timeline.hydrate(
                seeded.length > 0 && incoming.length > seeded.length
                  ? seeded
                  : incoming,
                resumedState,
              );
            } else {
              timeline.setState(resumedState);
            }
            setTabs((current) =>
              current.map((candidate) =>
                candidate.key === tab.key
                  ? {
                      ...candidate,
                      sessionPath:
                        startResult.state?.sessionFile ?? sessionPath,
                    }
                  : candidate,
              ),
            );
            refreshSessions();
          }
        })
        .catch((error) => {
          timeline.appendNotice(
            `Could not start the forked session: ${String(error?.message ?? error)}`,
            "error",
          );
        });
      return tab.key;
    },
    [createConversationTab, refreshSessions],
  );

  useEffect(() => {
    if (didOpenInitialSession.current) return;
    didOpenInitialSession.current = true;

    // Only the pane that was on screen comes back, split view included.
    // Split restore used to reopen every persisted entry, so a workbench
    // left with six panes spawned or adopted six agents on every load and
    // looked like tabs opening themselves. The rest are saved sessions with
    // files on disk: the sidebar already lists them, one click away.
    // The split *layout* preference is untouched (App.tsx still reads it) —
    // panes opened during the session tile as before.
    const stored = dedupeOpenSessions(persistedOpenSessions.current);
    // Every pane that was on screen comes back, split view included: reopening
    // just the active one silently dropped a three-pane workbench down to one
    // session on every refresh. Background tabs (opened earlier, then pushed
    // out of the split set) stay closed — the sidebar still lists them, so a
    // reload cannot spawn panes the user had already put away.
    const onScreen = stored.filter((session) => session.onScreen);
    const fallback = [
      stored.find((session) => session.active) ?? stored.at(-1),
    ];
    const sessionsToRestore = (
      onScreen.length > 0 ? onScreen : fallback
    ).filter(Boolean) as PersistedOpenSession[];
    if (sessionsToRestore.length === 0) {
      void openDefaultConversation();
      return;
    }

    let activeRestoredKey = "";
    for (const session of sessionsToRestore) {
      const key = session.sessionPath
        ? resumeConversation({
            path: session.sessionPath,
            name: session.label,
            cwd: session.cwd,
            createdAt: 0,
            modifiedAt: 0,
            messageCount: 0,
            backend: session.backend,
            lastModel: session.model?.id,
            lastModelProvider: session.model?.provider,
            lastEffort: session.thinkingLevel,
          })
        : openConversation(session.cwd, session.label, session.backend);
      if (session.active) activeRestoredKey = key;
    }
    if (activeRestoredKey) setActiveKey(activeRestoredKey);
  }, [openConversation, openDefaultConversation, resumeConversation]);

  useEffect(() => {
    if (!didOpenInitialSession.current) return;
    // Do not let the provider's first empty render erase the snapshot that the
    // restoration effect above still needs to consume.
    if (!didRenderRestoredSessions.current) {
      if (tabs.length === 0) return;
      didRenderRestoredSessions.current = true;
    }
    // A second browser tab of the workbench keeps rewriting this snapshot from
    // its own (stale) tab state — SSE-driven rebinds call setTabs even when the
    // page is hidden — so a refresh in the active tab restored conversations
    // the user had closed hours ago. Only the visible page may write; the
    // stale tab's writes stop the moment it loses visibility, and whichever
    // page the user is actually looking at owns the snapshot.
    if (document.visibilityState !== "visible") return;
    const snapshot: PersistedOpenSession[] = dedupeOpenSessions(
      tabs
        .filter((tab) => !tab.guest)
        .map((tab) => ({
          cwd: tab.cwd,
          label: tab.label,
          backend: tab.backend,
          sessionPath: tab.sessionPath ?? tab.timeline.state?.sessionFile,
          model: tab.timeline.state?.model,
          thinkingLevel: tab.timeline.state?.thinkingLevel,
          active: tab.key === activeKey,
          onScreen: visibleSessionKeys.includes(tab.key),
        })),
    );
    localStorage.setItem(OPEN_SESSIONS_KEY, JSON.stringify(snapshot));
  }, [activeKey, tabs, visibleSessionKeys, visibleTick]);
  // While hidden, the guard above skips writes, so a state change made in a
  // hidden page (an SSE rebind) leaves the snapshot stale. Bumping a dep on
  // refocus re-runs the effect so the first visible render catches up.

  const revealConversation = useCallback((key: string) => {
    setTabs((current) => {
      const next = current.map((tab) =>
        tab.key === key && tab.guest ? { ...tab, guest: false } : tab,
      );
      tabsRef.current = next;
      return next;
    });
    setActiveKey(key);
  }, []);

  const closeConversation = useCallback((key: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.key !== key);
      tabsRef.current = next;
      setActiveKey((active) =>
        active === key ? (next.at(-1)?.key ?? "") : active,
      );
      return next;
    });
    timelines.delete(key);
    void api.stop(key);
  }, []);

  const archiveSession = useCallback(
    async (session: ResumeSession): Promise<SessionMutationResponse> => {
      const result = await api.archiveSession(session.path);
      if (result.ok) refreshSessions();
      return result;
    },
    [refreshSessions],
  );

  const restoreSession = useCallback(
    async (session: ResumeSession): Promise<SessionMutationResponse> => {
      const result = await api.restoreSession(session.path);
      if (result.ok) refreshSessions();
      return result;
    },
    [refreshSessions],
  );

  const deleteSession = useCallback(
    async (session: ResumeSession): Promise<SessionMutationResponse> => {
      const matchingTabs = tabs.filter(
        (tab) =>
          tab.sessionPath === session.path ||
          tab.timeline.state?.sessionFile === session.path,
      );
      await Promise.all(matchingTabs.map((tab) => api.stop(tab.key)));
      const result = await api.deleteSession(session.path);
      if (!result.ok) return result;

      const removedKeys = new Set(matchingTabs.map((tab) => tab.key));
      setTabs((current) => {
        const next = current.filter((tab) => !removedKeys.has(tab.key));
        setActiveKey((currentActive) =>
          removedKeys.has(currentActive)
            ? (next.at(-1)?.key ?? "")
            : currentActive,
        );
        return next;
      });
      for (const tab of matchingTabs) timelines.delete(tab.key);
      setWorkingKeys((current) => {
        let changed = false;
        const next = new Set(current);
        for (const key of removedKeys) {
          if (next.delete(key)) changed = true;
        }
        return changed ? next : current;
      });
      refreshSessions();
      return result;
    },
    [refreshSessions, tabs],
  );

  /**
   * Removes a whole workspace: the folder on disk, then the saved sessions
   * that are the only reason it appears in the sidebar. A group whose folder
   * is already gone still has sessions to clear, which is why the folder
   * delete is idempotent server-side.
   *
   * Sessions are deleted in one pass rather than by looping deleteSession(),
   * which refreshes the listing on every call -- a workspace can hold a
   * hundred of them.
   */
  const deleteWorkspace = useCallback(
    async (
      cwd: string,
      sessions: ResumeSession[],
    ): Promise<SessionMutationResponse> => {
      const folder = await api.workspaceDelete(cwd);
      if (!folder.ok) return { ok: false, error: folder.error };

      const matchingTabs = tabs.filter((tab) => tab.cwd === cwd);
      await Promise.all(matchingTabs.map((tab) => api.stop(tab.key)));
      let firstFailure: string | undefined;
      for (const session of sessions) {
        const removed = await api.deleteSession(session.path);
        if (!removed.ok && !firstFailure)
          firstFailure = removed.error ?? session.path;
      }

      const removedKeys = new Set(matchingTabs.map((tab) => tab.key));
      setTabs((current) => {
        const next = current.filter((tab) => !removedKeys.has(tab.key));
        setActiveKey((currentActive) =>
          removedKeys.has(currentActive)
            ? (next.at(-1)?.key ?? "")
            : currentActive,
        );
        return next;
      });
      for (const tab of matchingTabs) timelines.delete(tab.key);
      setWorkingKeys((current) => {
        let changed = false;
        const next = new Set(current);
        for (const key of removedKeys) {
          if (next.delete(key)) changed = true;
        }
        return changed ? next : current;
      });
      refreshSessions();
      return firstFailure
        ? {
            ok: false,
            error: `Some sessions could not be deleted: ${firstFailure}`,
          }
        : { ok: true };
    },
    [refreshSessions, tabs],
  );

  const active = useMemo(
    () => tabs.find((tab) => tab.key === activeKey),
    [tabs, activeKey],
  );

  const setConversationSessionPath = useCallback(
    (key: string, path?: string) => {
      setTabs((current) =>
        current.map((tab) =>
          tab.key === key && (tab.sessionPath !== path || path === undefined)
            ? {
                ...tab,
                sessionPath: path,
                ...(path === undefined
                  ? {
                      label:
                        tab.cwd.split("/").filter(Boolean).at(-1) ?? tab.cwd,
                    }
                  : {}),
              }
            : tab,
        ),
      );
    },
    [],
  );

  const setConversationLabel = useCallback((key: string, label: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.key === key && tab.label !== label ? { ...tab, label } : tab,
      ),
    );
  }, []);

  const setConversationWorkspace = useCallback((key: string, cwd: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.key === key
          ? {
              ...tab,
              cwd,
              label: cwd.split("/").filter(Boolean).at(-1) ?? cwd,
            }
          : tab,
      ),
    );
  }, []);

  const revealWorkspace = useCallback((key: string) => {
    setWorkspaceReveal({ key, nonce: Date.now() });
  }, []);
  const setPreferredModel = useCallback(
    (backend: AgentBackend, cwd: string, model: ModelInfo | null) => {
      const key = modelPreferenceKey(backend, cwd);
      if (model) preferredModels.current.set(key, model);
      else preferredModels.current.delete(key);
    },
    [],
  );

  // Every project the workbench has actually seen — open tabs first, then the
  // cwd of every saved session of every agent. This is what makes a project
  // you started working in yesterday show up in the workspace picker without
  // anyone having to register it.
  const knownWorkspaces = useMemo(() => {
    const seen: string[] = [];
    for (const cwd of [
      ...tabs.map((tab) => tab.cwd),
      ...resumeSessions.map((session) => session.cwd),
      ...archivedSessions.map((session) => session.cwd),
    ]) {
      if (cwd && !seen.includes(cwd)) seen.push(cwd);
    }
    return seen;
  }, [archivedSessions, resumeSessions, tabs]);

  const value: StoreValue = {
    tabs,
    activeKey,
    active,
    workingKeys,
    awaitingKeys,
    resumeSessions,
    archivedSessions,
    openConversation,
    openDefaultConversation,
    resumeConversation,
    openForkedConversation,
    revealConversation,
    closeConversation,
    setActiveKey,
    setConversationSessionPath,
    setConversationLabel,
    setConversationWorkspace,
    archiveSession,
    restoreSession,
    deleteSession,
    deleteWorkspace,
    refreshSessions,
    sessionsLoaded,
    defaultBackend,
    setDefaultBackend,
    knownWorkspaces,
    setPreferredModel,
    workspaceReveal,
    revealWorkspace,
    skillDraft,
    setSkillDraft,
    taskSeeds,
    seedTask: useCallback((key: string, seed: TaskSeed) => {
      setTaskSeeds((current) => ({ ...current, [key]: seed }));
    }, []),
    clearTaskSeed: useCallback((key: string) => {
      setTaskSeeds((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    }, []),
    setVisibleSessionKeys,
  };

  return (
    <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
  );
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used under StoreProvider");
  return ctx;
}

/**
 * Re-render whenever the timeline changes.
 *
 * useSyncExternalStore, not useEffect+subscribe: a hydrate can finish
 * between first paint and the effect, and Grok session clicks only hydrate
 * from disk (no later start() to notify again). A missed notify leaves the
 * empty hero up forever.
 */
export function useTimeline(timeline: Timeline | undefined) {
  const subscribe = useCallback(
    (onChange: () => void) =>
      timeline ? timeline.subscribe(onChange) : () => {},
    [timeline],
  );
  const getSnapshot = useCallback(
    () => (timeline ? timeline.revision : 0),
    [timeline],
  );
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return timeline;
}
