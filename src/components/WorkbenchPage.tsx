import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  api,
  type McpServerInfo,
  type AgentSettings,
  type PiCatalogResponse,
} from "../lib/api";
import type { WorkbenchView } from "../lib/navigation";
import {
  IconCube,
  IconExtension,
  IconRefresh,
  IconSearch,
} from "./icons";
import {
  notificationPermission,
  notificationsEnabled,
  notify,
  requestNotifications,
  setNotificationsEnabled,
} from "../lib/notify";
import { useStore } from "../lib/store";
import { SettingsAgents } from "./SettingsAgents";
import { SettingsAppearance } from "./SettingsAppearance";

const EMPTY_CATALOG: PiCatalogResponse = {
  ok: true,
  skills: [],
  extensions: [],
  settings: {},
};

export function WorkbenchPage({
  view,
  showThinking,
  onShowThinkingChange,
  sessionKey,
  onBack,
}: {
  view: Exclude<WorkbenchView, "sessions" | "fleet" | "notes">;
  showThinking: boolean;
  onShowThinkingChange: (show: boolean) => void;
  /** Active conversation, if any — MCP status comes from its running agent. */
  sessionKey?: string;
  onBack?: () => void;
}) {
  const { tabs, skillDraft } = useStore();
  const [skillBackend, setSkillBackend] = useState<"pi" | "codex">(() => skillDraft?.backend ?? (tabs.find((tab) => tab.key === sessionKey)?.backend === "codex" ? "codex" : "pi"));
  const [catalog, setCatalog] = useState<PiCatalogResponse>(EMPTY_CATALOG);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const refresh = () => {
    setLoading(true);
    void api.catalog(view === "skills" ? skillBackend : "pi").then((result) => {
      setCatalog(result);
      setLoading(false);
    });
  };

  useEffect(refresh, [skillBackend, view]);
  useEffect(() => { if (skillDraft?.backend) setSkillBackend(skillDraft.backend); }, [skillDraft?.backend]);
  useEffect(() => setQuery(""), [view]);

  const normalizedQuery = query.trim().toLowerCase();
  const skills = useMemo(
    () =>
      catalog.skills.filter(
        (item) =>
          !normalizedQuery ||
          `${item.name} ${item.description}`
            .toLowerCase()
            .includes(normalizedQuery),
      ),
    [catalog.skills, normalizedQuery],
  );
  const extensions = useMemo(
    () =>
      catalog.extensions.filter(
        (item) =>
          !normalizedQuery ||
          `${item.name} ${item.description} ${item.spec}`
            .toLowerCase()
            .includes(normalizedQuery),
      ),
    [catalog.extensions, normalizedQuery],
  );

  const title = view === "skills" ? "Skills" : "Extensions";
  const description =
    view === "skills"
      ? `Specialized instructions available to your local ${skillBackend === "codex" ? "Codex" : "Pi"} agent.`
      : "Packages and local extensions loaded by Pi.";

  if (view === "settings") {
    return (
      <SettingsShell
        catalog={catalog}
        showThinking={showThinking}
        onShowThinkingChange={onShowThinkingChange}
        sessionKey={sessionKey}
        onBack={onBack}
      />
    );
  }

  return (
    <div className="resource-page">
      <header className="resource-page__header">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <button
          type="button"
          className="resource-page__refresh"
          onClick={refresh}
          disabled={loading}
        >
          <IconRefresh /> Refresh
        </button>
      </header>

      {!catalog.ok && (
        <div className="resource-page__error" role="alert">
          {catalog.error ?? "Pi resources could not be loaded."}
        </div>
      )}

      {view === "skills" && (
        <label>Agent <select aria-label="Skill agent" value={skillBackend} onChange={(event) => setSkillBackend(event.target.value as "pi" | "codex")}><option value="pi">Pi</option><option value="codex">Codex</option></select></label>
      )}
      <label className="resource-page__search">
        <IconSearch />
        <input
          type="search"
          aria-label={`Search ${title.toLowerCase()}`}
          placeholder={`Search ${title.toLowerCase()}`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="resource-page__content" aria-busy={loading}>
        {loading && (
          <div className="resource-page__empty">
            Loading {title.toLowerCase()}…
          </div>
        )}
        {!loading && view === "skills" && (
          <SkillsView
            key={skillBackend}
            backend={skillBackend}
            skills={skills}
            query={normalizedQuery}
            onChanged={refresh}
          />
        )}
        {!loading && view === "extensions" && (
          <ResourceList
            items={extensions.map((extension) => ({
              key: `${extension.source}:${extension.path}`,
              icon: <IconExtension size={18} />,
              title: extension.name,
              description: extension.description,
              badge: [extension.source, extension.version]
                .filter(Boolean)
                .join(" · "),
              metadata: extension.spec,
            }))}
            empty={
              normalizedQuery
                ? "No extensions match this search."
                : "No Pi extensions are installed."
            }
          />
        )}
      </div>
    </div>
  );
}

/**
 * Opt-in for the two notifications the workbench sends. Kept behind an
 * explicit toggle: the browser only grants the permission from a real click,
 * and an agent that pings you unasked is worse than one that stays quiet.
 */
function NotificationsCard() {
  const [permission, setPermission] = useState(() => notificationPermission());
  const [enabled, setEnabled] = useState(() => notificationsEnabled());

  const unsupported = permission === "unsupported";
  const blocked = permission === "denied";

  const toggle = async () => {
    if (enabled) {
      setNotificationsEnabled(false);
      setEnabled(false);
      return;
    }
    const granted = await requestNotifications();
    setPermission(notificationPermission());
    setEnabled(granted);
    if (granted) {
      notify(
        "Notifications on",
        "This is what an alert looks like.",
        "devden-test",
        { force: true },
      );
    }
  };

  return (
    <section className="settings-block">
      <div className="settings-block__label">Alerts</div>
      <div className="settings-group">
        <div className="settings-field">
          <div className="settings-field__text">
            <strong>Notifications</strong>
            <span>
              Ping this device when an agent needs permission or finishes a
              turn.
            </span>
          </div>
          {unsupported || blocked ? null : (
            <div className="seg-control seg-control--inline" role="group" aria-label="Notifications">
              <button
                type="button"
                className={enabled ? "" : "is-active"}
                aria-pressed={!enabled}
                onClick={() => {
                  if (enabled) void toggle();
                }}
              >
                Off
              </button>
              <button
                type="button"
                className={enabled ? "is-active" : ""}
                aria-pressed={enabled}
                onClick={() => {
                  if (!enabled) void toggle();
                }}
              >
                On
              </button>
            </div>
          )}
        </div>
        {unsupported ? (
          <p className="settings-note">This browser does not support notifications.</p>
        ) : blocked ? (
          <p className="settings-note">
            Notifications are blocked for this site. Allow them in your
            browser&apos;s site settings, then reload.
          </p>
        ) : enabled ? (
          <p className="settings-note">
            Sent only while this page is open and in the background.
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * MCP servers as the running agent sees them — which is the only view that
 * distinguishes "configured" from "actually connected". Needs a live session,
 * so it says so rather than showing an empty list that looks like "none".
 */
function McpCard({ sessionKey }: { sessionKey?: string }) {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!sessionKey) {
      setServers(null);
      setError("");
      return;
    }
    let cancelled = false;
    void api
      .mcpServers(sessionKey)
      .then((result) => {
        if (cancelled) return;
        if (result.ok && result.data) {
          setServers(result.data.servers);
          setError("");
        } else {
          setServers(null);
          setError(result.error ?? "MCP status unavailable.");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setServers(null);
          setError("MCP status unavailable.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  return (
    <section className="settings-block">
      <div className="settings-block__label">Servers</div>
      <div className="settings-group">
        <div className="settings-field">
          <div className="settings-field__text">
            <strong>MCP servers</strong>
            <span>
              Model Context Protocol servers available to the current session.
            </span>
          </div>
        </div>
        {sessionKey ? (
          error ? (
            <p className="settings-note">{error}</p>
          ) : servers === null ? (
            <p className="settings-note">Loading…</p>
          ) : servers.length === 0 ? (
            <p className="settings-note">
              No MCP servers configured. Add one with <code>claude mcp add</code>.
            </p>
          ) : (
            <dl className="settings-kv-list">
              {servers.map((server) => (
                <div className="settings-kv" key={server.name}>
                  <dt>{server.name}</dt>
                  <dd>
                    {server.status}
                    {server.scope ? ` · ${server.scope}` : ""}
                    {server.toolCount === null
                      ? ""
                      : ` · ${server.toolCount} tools`}
                    {server.error ? ` — ${server.error}` : ""}
                  </dd>
                </div>
              ))}
            </dl>
          )
        ) : (
          <p className="settings-note">Open a session to see its MCP servers.</p>
        )}
      </div>
    </section>
  );
}

type SkillDraft = { name: string; description: string; body: string };
const EMPTY_DRAFT: SkillDraft = { name: "", description: "", body: "" };

/**
 * Skills, with authoring. A skill is a directory holding a SKILL.md, so
 * creating one is writing that file; the server slugs the name and re-checks
 * it against the skills root before any write.
 */
function SkillsView({
  backend,
  skills,
  query,
  onChanged,
}: {
  backend: "pi" | "codex";
  skills: PiCatalogResponse["skills"];
  query: string;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A skill distilled in a conversation (/skill) waits in the store until
  // the user opens Skills; consuming it here is the review gate — the user
  // edits and saves, or discards. Never auto-overwrite an open editor.
  const { skillDraft, setSkillDraft } = useStore();
  useEffect(() => {
    if (!skillDraft || draft || (skillDraft.backend ?? "pi") !== backend) return;
    setDraft(skillDraft);
    setSkillDraft(null);
  }, [skillDraft, draft, setSkillDraft, backend]);

  const startNew = () => {
    setEditingName(null);
    setError("");
    setDraft({ ...EMPTY_DRAFT });
  };

  const startEdit = async (name: string, description: string) => {
    setError("");
    setBusy(true);
    try {
      const result = await api.readSkill(name, backend);
      if (!result.ok) { setError(result.error ?? "Could not read the skill."); return; }
      // Strip the frontmatter: it is regenerated from the fields on save, so
      // editing it by hand here would silently lose the change.
      const body = (result.source ?? "").replace(/^---\n[\s\S]*?\n---\n*/, "");
      setEditingName(name);
      setDraft({ name, description, body });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.writeSkill({ ...draft, backend });
      if (!result.ok) {
        setError(result.error ?? "Could not save the skill.");
        return;
      }
      setDraft(null);
      setEditingName(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await api.deleteSkill(name, backend);
      if (!result.ok) {
        setError(result.error ?? "Could not delete the skill.");
        return;
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="skills-view">
      <div className="skills-view__bar">
        <button
          type="button"
          className="skills-view__new"
          onClick={startNew}
          disabled={busy}
        >
          New skill
        </button>
        {error && <span className="skills-view__error">{error}</span>}
      </div>

      {draft && (
        <section className="settings-card">
          <div className="settings-card__heading">
            <IconCube />
            <div>
              <strong>
                {editingName ? `Edit ${editingName}` : "New skill"}
              </strong>
              <span>Saved to your local Pi skills as a SKILL.md file.</span>
            </div>
          </div>
          <label className="skills-view__field">
            <span>Name</span>
            <input
              value={draft.name}
              disabled={editingName !== null}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
              placeholder="Release checklist"
            />
          </label>
          <label className="skills-view__field">
            <span>Description</span>
            <input
              value={draft.description}
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
              placeholder="When to use this skill"
            />
          </label>
          <label className="skills-view__field">
            <span>Instructions</span>
            <textarea
              rows={10}
              value={draft.body}
              onChange={(event) =>
                setDraft({ ...draft, body: event.target.value })
              }
              placeholder="What the agent should do when this skill applies."
            />
          </label>
          <div className="skills-view__actions">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !draft.name.trim()}
            >
              {busy ? "Saving…" : "Save skill"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setEditingName(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {skills.length === 0 ? (
        <div className="resource-page__empty">
          {query
            ? "No skills match this search."
            : "No local Pi skills are installed."}
        </div>
      ) : (
        <div className="resource-grid">
          {skills.map((skill) => (
            <article key={skill.path} className="resource-card">
              <div className="resource-card__icon">
                <IconCube size={18} />
              </div>
              <div className="resource-card__body">
                <div className="resource-card__title">
                  <strong>{skill.name}</strong>
                  <div className="skills-view__row-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void startEdit(skill.name, skill.description)
                      }
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(skill.name)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <p>{skill.description}</p>
                <code title={skill.path}>{skill.path}</code>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function ResourceList({
  items,
  empty,
}: {
  items: Array<{
    key: string;
    icon: ReactNode;
    title: string;
    description: string;
    badge?: string;
    metadata: string;
  }>;
  empty: string;
}) {
  if (items.length === 0)
    return <div className="resource-page__empty">{empty}</div>;
  return (
    <div className="resource-grid">
      {items.map((item) => (
        <article className="resource-card" key={item.key}>
          <span className="resource-card__icon">{item.icon}</span>
          <div className="resource-card__body">
            <div className="resource-card__title">
              <strong>{item.title}</strong>
              {item.badge && <span>{item.badge}</span>}
            </div>
            <p>{item.description}</p>
            <code title={item.metadata}>{item.metadata}</code>
          </div>
        </article>
      ))}
    </div>
  );
}

const SETTINGS_TABS = [
  ["◐", "Appearance", "Theme, backdrop and color"],
  ["π", "Agents", "Defaults for new sessions"],
  ["⬡", "MCP", "Connected tool servers"],
  ["◔", "Notifications", "Alerts from running agents"],
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number][1];

function SettingsShell({
  catalog,
  showThinking,
  onShowThinkingChange,
  sessionKey,
  onBack,
}: {
  catalog: PiCatalogResponse;
  showThinking: boolean;
  onShowThinkingChange: (show: boolean) => void;
  sessionKey?: string;
  onBack?: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("Appearance");
  const current = SETTINGS_TABS.find((item) => item[1] === tab) ?? SETTINGS_TABS[0];
  return (
    <div className="settings-shell">
      <aside className="settings-nav">
        <div className="settings-nav__lights">
          <span className="sidebar__traffic" aria-hidden="true">
            <i className="is-close" />
            <i className="is-min" />
            <i className="is-max" />
          </span>
        </div>
        <button type="button" className="settings-nav__back" onClick={onBack}>
          <span aria-hidden="true">‹</span>
          Back to workbench
          <kbd>esc</kbd>
        </button>
        <div className="settings-nav__label">Settings</div>
        <div className="settings-nav__list" role="tablist" aria-label="Settings sections">
          {SETTINGS_TABS.map(([icon, name]) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              className={tab === name ? "is-active" : ""}
              onClick={() => setTab(name)}
            >
              <span aria-hidden="true">{icon}</span>
              {name}
            </button>
          ))}
        </div>
        <div className="settings-nav__foot">Changes save as you go</div>
      </aside>
      <div className="settings-main">
        <header className="settings-main__bar">
          <strong>{current[1]}</strong>
          <span>{current[2]}</span>
        </header>
        {!catalog.ok && (
          <div className="resource-page__error" role="alert">
            {catalog.error ?? "Pi resources could not be loaded."}
          </div>
        )}
        <div className="settings-main__scroll">
          <div className="settings-main__column">
            {tab === "Appearance" && (
              <SettingsAppearance
                showThinking={showThinking}
                onShowThinkingChange={onShowThinkingChange}
              />
            )}
            {tab === "Agents" && (
              <>
                <PiDefaults catalog={catalog} />
                <SettingsAgents />
                {sessionKey && <AgentConfigCard sessionKey={sessionKey} />}
              </>
            )}
            {tab === "MCP" && <McpCard sessionKey={sessionKey} />}
            {tab === "Notifications" && <NotificationsCard />}
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentConfigCard({ sessionKey }: { sessionKey: string }) {
  const { tabs } = useStore();
  const backend = tabs.find((tab) => tab.key === sessionKey)?.backend;
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setSettings(null);
    if (backend !== "codex" && backend !== "claude") return;
    let cancelled = false;
    void api.settings(sessionKey).then((result) => {
      if (cancelled) return;
      setSettings(result.data ?? null);
      setError(result.ok ? "" : result.error ?? "Could not read agent settings");
    });
    return () => { cancelled = true; };
  }, [sessionKey, backend]);
  if (backend !== "codex" && backend !== "claude") return null;
  return <section className="settings-block"><div className="settings-block__head"><span className="settings-block__label">{backend} effective settings</span></div>{error && <p role="alert">{error}</p>}{settings ? <details><summary>Configuration and sources</summary><pre>{JSON.stringify(settings.effective, null, 2)}</pre>{settings.sources.map((source, index) => <details key={index}><summary>{source.source}</summary><pre>{JSON.stringify(source.settings, null, 2)}</pre></details>)}</details> : !error && <p>Loading…</p>}</section>;
}

function PiDefaults({ catalog }: { catalog: PiCatalogResponse }) {
  const settings = catalog.settings;
  const [opening, setOpening] = useState(false);
  const rows = [
    ["Default provider", settings.defaultProvider || "Not set"],
    ["Default model", settings.defaultModel || "Not set"],
    ["Default effort", settings.defaultThinkingLevel || "off"],
    ["Terminal theme", settings.theme || "Default"],
    ["Installed terminal themes", String(settings.themeCount ?? 0)],
    ["Thinking blocks", settings.hideThinkingBlock ? "Hidden" : "Visible"],
    ["Startup", settings.quietStartup ? "Quiet" : "Standard"],
  ];
  const path = settings.path ?? "";
  const shown = path.includes(".pi/agent/settings.json")
    ? "~/.pi/agent/settings.json"
    : path || "~/.pi/agent/settings.json";
  return (
    <section className="settings-block">
      <div className="settings-block__head">
        <span className="settings-block__label">Pi defaults</span>
        <span className="settings-block__aside">Read from your local Pi settings</span>
      </div>
      <div className="settings-group">
        <dl className="settings-kv-list">
          {rows.map(([label, value]) => (
            <div className="settings-kv" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="settings-group__bar">
          <span className="settings-group__path" title={path || shown}>
            {shown}
          </span>
          <button
            type="button"
            className="settings-open"
            disabled={!path || opening}
            onClick={() => {
              setOpening(true);
              void api.openPiSettings().finally(() => setOpening(false));
            }}
          >
            Open in editor
          </button>
        </div>
      </div>
    </section>
  );
}
