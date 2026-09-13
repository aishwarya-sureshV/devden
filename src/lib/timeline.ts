/**
 * Timeline model: converts pi RPC events into renderable items, porting
 * AgentDeck's AgentWorkbench semantics (tool cards, rationale, streaming text).
 */
import type {
  AgentEvent,
  BackendLogEntry,
  RunStatus,
  SessionHistoryMessage,
  SessionState,
} from "./api";
import { isSubagentTool } from "./subagents.ts";

export interface UserMessageVersion {
  text: string;
  timestamp: number;
  /** Session file that contains this version's user message and context. */
  sessionFile: string;
  /** The response chain that followed this version (display + rebind data). */
  responseItems: TimelineItem[];
}

export type TimelineItem =
  | {
      id: string;
      kind: "user";
      text: string;
      timestamp: number;
      versions?: UserMessageVersion[];
      versionIndex?: number;
    }
  | {
      id: string;
      kind: "rationale";
      text: string;
      live: boolean;
      timestamp: number;
      // Set when this block was produced by a subagent rather than the main loop.
      parentToolUseId?: string;
    }
  | {
      id: string;
      kind: "assistant";
      text: string;
      live: boolean;
      timestamp: number;
      provider?: string;
      modelId?: string;
      // Set when this block was produced by a subagent rather than the main loop.
      parentToolUseId?: string;
    }
  | {
      id: string;
      kind: "tool";
      name: string;
      args: Record<string, unknown>;
      details: Record<string, unknown>;
      output: string;
      status: "running" | "done" | "error";
      startedAt: number;
      elapsed?: number;
      // ACP tool-call category (e.g. "execute") for backends, like Grok, whose
      // tool names aren't the literal "bash" pi/claude use to flag a live run.
      execKind?: string;
      // Id of the Task tool call that spawned this one, when a subagent made
      // it. Absent for the main loop's own calls.
      parentToolUseId?: string;
    }
  | {
      id: string;
      kind: "notice";
      text: string;
      tone: "info" | "warning" | "error";
      timestamp: number;
      // Set when the notice is about a subagent run, so it renders in that
      // run's panel instead of the main transcript.
      parentToolUseId?: string;
    };

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return asRecord(JSON.parse(raw.slice(start, i + 1)));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function stripApiErrorPrefix(message: string): string {
  const match = message.match(/API error\s*\(status\s+\d+[^)]*\):\s*(.+)/i);
  return (match?.[1] ?? message).replace(/[.,\s]+$/, "").trim();
}

function isGenericAgentError(text: string): boolean {
  return /^(grok turn failed:\s*)?internal error$/i.test(text.trim());
}

/** Pull the human sentence out of a provider log or ACP throw. */
export function readableAgentError(value: unknown): string {
  if (typeof value !== "string") return "";
  const raw = value.trim();
  if (!raw) return "";
  const payload = firstJsonObject(raw);
  if (payload) {
    if (typeof payload.error === "string" && payload.error.trim())
      return payload.error.trim();
    const nested = asRecord(payload.error);
    if (typeof nested.message === "string" && nested.message.trim())
      return stripApiErrorPrefix(nested.message);
    if (typeof payload.message === "string" && payload.message.trim()) {
      const message = stripApiErrorPrefix(payload.message);
      if (message && !isGenericAgentError(message)) return message;
    }
  }
  const named = raw.match(
    /error_message=([^\n]+?)(?:\s+body_preview=|\s+model_id=|$)/i,
  );
  if (named?.[1]?.trim()) return named[1].trim();
  const api = raw.match(/API error\s*\(status\s+\d+[^)]*\):\s*(.+)/i);
  if (api?.[1]) return stripApiErrorPrefix(api[1]);
  if (isGenericAgentError(raw)) return "";
  return raw;
}

function looksLikeProviderApiLog(raw: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T/.test(raw) ||
    /ERROR responses API/i.test(raw) ||
    /error_message=/.test(raw) ||
    /body_preview=/.test(raw)
  );
}

function extractText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const record = asRecord(part);
      return record.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractHistoryText(value: unknown, imageLabel = ""): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const record = asRecord(part);
      if (record.type === "text" && typeof record.text === "string")
        return record.text;
      if (imageLabel && record.type === "image") return imageLabel;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** True when the session file already has a finished assistant reply after
 *  the last user message — the hung-Grok case where ACP never sent
 *  agent_settled but the journal is complete. A turn that still ends on a
 *  user, a tool result, or a tool-call-only assistant is still in flight. */
export function persistedTurnLooksSettled(
  messages: SessionHistoryMessage[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = String(messages[i]?.role ?? "").toLowerCase();
    if (role === "toolresult" || role === "tool") continue;
    if (role !== "assistant") return false;
    return extractHistoryText(messages[i]?.content).trim().length > 0;
  }
  return false;
}

function lastUserTextOf(items: TimelineItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "user") return item.text;
  }
  return undefined;
}

/** Composer footer vs the path list the agent actually receives. */
function userMessageStem(text: string): string {
  return text
    .replace(/\n\nAttached files:\n[\s\S]*$/, "")
    .replace(/\n\nAttachments: [^\n]*$/, "")
    .trimEnd();
}

/**
 * Optimistic appendUser already put a bubble in; grok/codex then echo the
 * outbound prompt (path-expanded when files were attached). Skip that echo
 * only while the composer bubble is still the last item — a queued
 * follow-up arrives after the previous turn has printed, so it must show.
 */
function isEchoedUserMessage(items: TimelineItem[], text: string): boolean {
  const lastUserText = lastUserTextOf(items);
  if (!lastUserText) return false;
  if (lastUserText === text) return true;
  const last = items.at(-1);
  if (last?.kind !== "user") return false;
  const stem = userMessageStem(lastUserText);
  return stem.length > 0 && stem === userMessageStem(text);
}

function historyTimestamp(message: SessionHistoryMessage): number {
  return typeof message.timestamp === "number" ? message.timestamp : Date.now();
}

function parentToolUseIdOf(value: unknown): string | undefined {
  const record = asRecord(value);
  const id = record.parentToolUseId ?? record.parent_tool_use_id;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * Server notices carry an optional tone; anything unrecognised is ambient.
 */
function noticeTone(value: unknown): "info" | "warning" | "error" {
  if (value === "error" || value === "warning") return value;
  return "info";
}

export class Timeline {
  items: TimelineItem[] = [];
  backendLog: BackendLogEntry[] = [];
  status: RunStatus = "stopped";
  state: SessionState | null = null;
  cycle = 0;
  /**
   * The generated session title, kept outside `state` on purpose. It arrives
   * as its own background event and every later `state` event from the
   * backend would otherwise clobber it back to the prompt-derived fallback
   * (pi only reports the name it knew when the process started), making the
   * label flicker between the two.
   */
  private sessionName: string | undefined;
  private listeners = new Set<() => void>();
  /**
   * Notices published after a run settled, captured during replay so hydrate()
   * can put them back. They exist only in the server's runtime log, and the
   * session file the caller re-reads never carries them.
   */
  private trailingNotices: {
    text: string;
    tone: "info" | "warning" | "error";
  }[] = [];
  /** Pending in-flight text streams, applied as whole chunks (no per-char cursor). */
  private streams = new Map<
    string,
    {
      id: string;
      kind: "rationale" | "assistant";
      pending: string;
      finalText?: string;
      parentToolUseId?: string;
    }
  >();

  readonly key: string;
  /**
   * Monotonic stamp for useSyncExternalStore. hydrate() can finish before a
   * useEffect subscribe runs; without a snapshot that changes, Grok session
   * clicks (disk-only hydrate, no later start()) stay on the empty hero.
   */
  revision = 0;

  // Written out rather than a parameter property so `node --test` can load
  // this module directly (strip-only TypeScript rejects those).
  constructor(key: string) {
    this.key = key;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Pending coalesced notify frame, if one is scheduled. */
  private frame?: number;

  /**
   * Claude streams partial messages token by token, and every delta used to
   * re-render the whole conversation synchronously — the visible stutter and
   * flicker while a reply types itself. State is applied immediately; only
   * the render is coalesced to one per animation frame.
   */
  private notify() {
    this.revision += 1;
    if (typeof requestAnimationFrame !== "function") {
      this.emit();
      return;
    }
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.emit();
    });
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private updateItems(updater: (current: TimelineItem[]) => TimelineItem[]) {
    this.items = updater(this.items);
    this.notify();
  }

  appendNotice(
    text: string,
    tone: "info" | "warning" | "error",
    parentToolUseId?: string,
  ) {
    if (!text) return;
    this.updateItems((current) => {
      const last = current.at(-1);
      if (last?.kind === "notice" && last.text === text && last.tone === tone)
        return current;
      return [
        ...current,
        {
          id: crypto.randomUUID(),
          kind: "notice",
          text,
          tone,
          timestamp: Date.now(),
          ...(parentToolUseId ? { parentToolUseId } : {}),
        },
      ];
    });
  }

  appendUser(text: string) {
    this.updateItems((current) => [
      ...current,
      { id: crypto.randomUUID(), kind: "user", text, timestamp: Date.now() },
    ]);
  }

  /**
   * Edit + resend: stash the response chain that follows a user message into
   * the message's version history, replace the prompt text, and trim the
   * transcript at that point. The backend is expected to be rewound already
   * (truncate) so the next prompt lands on the trimmed context.
   */
  editUserMessage(
    id: string,
    text: string,
    fromSessionFile: string,
    toSessionFile: string,
  ) {
    const index = this.items.findIndex((item) => item.id === id);
    const item = this.items[index];
    if (!item || item.kind !== "user") return;
    const suffixEnd = this.items.findIndex(
      (candidate, position) => position > index && candidate.kind === "user",
    );
    const responseItems = this.items.slice(
      index + 1,
      suffixEnd === -1 ? this.items.length : suffixEnd,
    );
    const versions = (
      item.versions ?? [
        {
          text: item.text,
          timestamp: item.timestamp,
          sessionFile: fromSessionFile,
          responseItems: [],
        },
      ]
    ).map((version, position) =>
      position === (item.versionIndex ?? 0)
        ? { ...version, responseItems }
        : version,
    );
    versions.push({
      text,
      timestamp: Date.now(),
      sessionFile: toSessionFile,
      responseItems: [],
    });
    this.items = [
      ...this.items.slice(0, index),
      {
        ...item,
        text,
        timestamp: Date.now(),
        versions,
        versionIndex: versions.length - 1,
      },
    ];
    this.cycle += 1;
    this.notify();
  }

  /**
   * Show another version of an edited message. The response chain currently on
   * screen is stashed into its version; the target version's stored response
   * items are spliced back in. Rebinding the backend itself happens in the
   * caller (truncate + switch), since it needs the session response.
   */
  setUserVersion(id: string, index: number, sessionFile: string) {
    const itemIndex = this.items.findIndex((item) => item.id === id);
    const item = this.items[itemIndex];
    if (!item || item.kind !== "user" || !item.versions) return;
    const versionIndex = item.versionIndex ?? 0;
    if (index === versionIndex || index < 0 || index >= item.versions.length)
      return;
    const suffixEnd = this.items.findIndex(
      (candidate, position) =>
        position > itemIndex && candidate.kind === "user",
    );
    const suffix = this.items.slice(
      itemIndex + 1,
      suffixEnd === -1 ? this.items.length : suffixEnd,
    );
    const versions = item.versions.map((version, position) => {
      if (position === versionIndex)
        return { ...version, responseItems: suffix };
      if (position === index) return { ...version, sessionFile };
      return version;
    });
    this.items = [
      ...this.items.slice(0, itemIndex),
      { ...item, versions, versionIndex: index },
      ...versions[index].responseItems,
    ];
    this.notify();
  }

  appendAssistant(text: string) {
    if (!text) return;
    this.updateItems((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        kind: "assistant",
        text,
        live: false,
        timestamp: Date.now(),
      },
    ]);
  }

  private appendBackendEvent(event: AgentEvent) {
    if (event.type === "__hello") return;
    const id =
      typeof event.__logId === "string" ? event.__logId : crypto.randomUUID();
    if (this.backendLog.some((entry) => entry.id === id)) return;
    const timestamp =
      typeof event.__loggedAt === "number" ? event.__loggedAt : Date.now();
    const source =
      typeof event.__logSource === "string" ? event.__logSource : "agent";
    const payload = Object.fromEntries(
      Object.entries(event).filter(([key]) => !key.startsWith("__")),
    );
    this.backendLog = [
      ...this.backendLog,
      {
        id,
        timestamp,
        source,
        type: event.type,
        payload,
      },
    ];
    this.notify();
  }

  hydrateBackendLog(entries: BackendLogEntry[]) {
    const byId = new Map(this.backendLog.map((entry) => [entry.id, entry]));
    for (const entry of entries) {
      if (!entry || typeof entry.id !== "string" || byId.has(entry.id))
        continue;
      byId.set(entry.id, {
        id: entry.id,
        timestamp: Number(entry.timestamp) || Date.now(),
        source: String(entry.source || "agent"),
        type: String(entry.type || "unknown"),
        payload: asRecord(entry.payload),
      });
    }
    this.backendLog = [...byId.values()].sort(
      (left, right) => left.timestamp - right.timestamp,
    );
    this.notify();
  }

  /**
   * Rebuild the in-flight turn from the server's runtime event log after a
   * reload. hydrate() only sees the session file, which records completed
   * turns — everything streamed since (partial text, running tool cards,
   * todo snapshots) exists only in the server-side log. Entries are fed
   * through the same handle() path live events use, so reconstructed items
   * merge seamlessly with events that keep arriving over SSE: deltas unify
   * by stream key (claude tags one explicitly; pi/grok fall back to the same
   * cycle default), and entries already received live are skipped by log id.
   *
   * Returns "live" if the current run was reconstructed, "settled" if the
   * run finished while the log was being fetched (the caller should re-read
   * the session file instead — the messages are persisted by now), or
   * "none" when no safe replay window exists.
   */
  replayLiveTurn(entries: BackendLogEntry[]): "live" | "settled" | "none" {
    this.trailingNotices = [];
    if (!Array.isArray(entries) || entries.length === 0) return "none";
    const agentEntries = entries.filter((entry) => {
      if (!entry || typeof entry.id !== "string") return false;
      if (entry.source !== "server") return true;
      // Deploy-resume banners are published as server notices just before
      // the follow-up turn. Dropping every server event hid them on reload.
      return String(asRecord(entry.payload).type ?? "") === "notice";
    });
    if (agentEntries.length === 0) return "none";

    // The current run is everything after the last completed run's
    // agent_end. A grok resume also replays its history through the log as
    // complete agent_start…agent_end turns, so those are correctly excluded.
    let windowStart = 0;
    for (let index = 0; index < agentEntries.length; index += 1) {
      if (String(agentEntries[index]?.payload?.type ?? "") === "agent_end") {
        windowStart = index + 1;
      }
    }
    // Between the last agent_end and the live turn sit pre-run bookkeeping
    // events (__status, trailing state, command responses) that the carried
    // log keeps. The run itself begins at its agent_start — start there, or
    // every adopted mid-run reload would read as a torn buffer and refuse
    // to replay.
    let lastStart = -1;
    for (let index = windowStart; index < agentEntries.length; index += 1) {
      if (String(agentEntries[index]?.payload?.type ?? "") === "agent_start") {
        lastStart = index;
      }
    }
    if (lastStart >= windowStart) windowStart = lastStart;
    // A deploy-resume publishes its "picking this conversation back up"
    // notice just before agent_start. Starting the window at agent_start
    // dropped that banner, so a refresh looked like the agent had started
    // thinking on its own.
    while (windowStart > 0) {
      const previous = String(
        agentEntries[windowStart - 1]?.payload?.type ?? "",
      );
      if (previous !== "notice") break;
      windowStart -= 1;
    }
    const window = agentEntries.slice(windowStart);
    // The run completed before the log was fetched: its messages are in the
    // session file now, so the caller re-reads them instead of replaying.
    if (window.length === 0) return "settled";
    // A log with no agent_end and not opening at a run boundary is a torn
    // ring buffer (truncated mid-run) — replaying it would duplicate
    // persisted turns, so degrade to showing the saved history.
    if (
      windowStart === 0 &&
      !["agent_start", "turn_start", "message_start", "notice"].includes(
        String(window[0]?.payload?.type ?? ""),
      )
    ) {
      return "none";
    }
    // grok emits agent_settled after agent_end; pi/claude may have trailing
    // state events post-completion. Any end-of-run marker inside the window
    // means the run settled during the fetch.
    let settledAt = -1;
    for (let index = 0; index < window.length; index += 1) {
      if (
        ["agent_end", "agent_settled"].includes(
          String(window[index]?.payload?.type ?? ""),
        )
      )
        settledAt = index;
    }
    if (settledAt >= 0) {
      // The cache-miss summary is published after the turn settles, so it sits
      // at the bottom of the final output -- which also puts it outside every
      // window above, since those start after the last agent_end. The caller
      // re-reads the session file and a notice is not in it, so hold these for
      // hydrate() rather than dropping them on every refresh.
      this.trailingNotices = window.slice(settledAt + 1).flatMap((entry) => {
        const payload = asRecord(entry.payload);
        if (payload.type !== "notice") return [];
        const text = String(payload.message ?? "");
        return text ? [{ text, tone: noticeTone(payload.tone) }] : [];
      });
      return "settled";
    }

    const seenLive = new Set(this.backendLog.map((entry) => entry.id));
    for (const entry of window) {
      // Events that already arrived over SSE after the reload were applied
      // live; replaying them would duplicate their items.
      if (seenLive.has(entry.id)) continue;
      const payload = asRecord(entry.payload);
      const type = String(payload.type ?? "");
      // Keep this.cycle aligned with post-reload live events (which arrive
      // without a turn_start): deltas must map to the same item ids.
      if (type === "turn_start") continue;
      if (
        type === "message_start" &&
        asRecord(payload.message).role === "user"
      ) {
        const message = asRecord(payload.message);
        const text = extractHistoryText(message.content, "[Image attachment]");
        if (!text) continue;
        // The in-flight turn's user message was never persisted, so it can't
        // be in the hydrated items — dedupe only guards the tiny race where
        // it already arrived live between SSE connect and this replay.
        if (isEchoedUserMessage(this.items, text)) continue;
        this.appendUser(text);
        continue;
      }
      this.handle({
        ...payload,
        sessionKey: this.key,
        __logId: entry.id,
        __loggedAt: entry.timestamp,
        __logSource: entry.source,
      } as unknown as AgentEvent);
    }
    this.markPendingRun();
    return "live";
  }

  reset(state: SessionState | null = this.state) {
    this.items = [];
    this.streams.clear();
    this.cycle = 0;
    this.state = state ? this.withSessionName(state) : state;
    this.status = state?.isStreaming ? "working" : "ready";
    this.notify();
  }

  hydrate(messages: SessionHistoryMessage[], state: SessionState) {
    const items: TimelineItem[] = [];
    const tools = new Map<string, number>();

    for (
      let messageIndex = 0;
      messageIndex < messages.length;
      messageIndex += 1
    ) {
      const message = messages[messageIndex];
      const role = String(message.role ?? "");
      const timestamp = historyTimestamp(message);
      if (role === "user") {
        const text = extractHistoryText(message.content, "[Image attachment]");
        if (text)
          items.push({
            id: `history-user-${messageIndex}`,
            kind: "user",
            text,
            timestamp,
          });
        continue;
      }

      if (role === "assistant") {
        const error = readableAgentError(message.errorMessage);
        if (error) {
          items.push({
            id: `history-error-${messageIndex}`,
            kind: "notice",
            text: error,
            tone: "error",
            timestamp,
          });
        }
        const provider =
          typeof message.provider === "string" ? message.provider : undefined;
        const modelId =
          typeof message.model === "string" ? message.model : undefined;
        const parentToolUseId = parentToolUseIdOf(message);
        if (!Array.isArray(message.content)) continue;
        for (
          let contentIndex = 0;
          contentIndex < message.content.length;
          contentIndex += 1
        ) {
          const content = asRecord(message.content[contentIndex]);
          const type = String(content.type ?? "");
          if (type === "thinking") {
            const text =
              typeof content.thinking === "string" ? content.thinking : "";
            if (text)
              items.push({
                id: `history-rationale-${messageIndex}-${contentIndex}`,
                kind: "rationale",
                text,
                live: false,
                timestamp,
                ...(parentToolUseId ? { parentToolUseId } : {}),
              });
          } else if (type === "text") {
            const text = typeof content.text === "string" ? content.text : "";
            if (text)
              items.push({
                id: `history-assistant-${messageIndex}-${contentIndex}`,
                kind: "assistant",
                text,
                live: false,
                timestamp,
                provider,
                modelId,
                ...(parentToolUseId ? { parentToolUseId } : {}),
              });
          } else if (type === "toolCall") {
            const id = String(
              content.id ?? `history-tool-${messageIndex}-${contentIndex}`,
            );
            const nestedParent = parentToolUseIdOf(content) ?? parentToolUseId;
            const tool: TimelineItem = {
              id,
              kind: "tool",
              name: String(content.name ?? "tool"),
              args: asRecord(content.arguments),
              details: {},
              output: "",
              status: "running",
              startedAt: timestamp,
              ...(nestedParent ? { parentToolUseId: nestedParent } : {}),
            };
            tools.set(id, items.length);
            items.push(tool);
          }
        }
        continue;
      }

      if (role === "toolResult") {
        const id = String(message.toolCallId ?? "");
        const output = extractHistoryText(message.content, "[Image output]");
        const found = tools.get(id);
        if (found === undefined) {
          items.push({
            id: id || `history-tool-result-${messageIndex}`,
            kind: "tool",
            name: String(message.toolName ?? "tool"),
            args: {},
            details: asRecord(message.details),
            output,
            status: message.isError ? "error" : "done",
            startedAt: timestamp,
            elapsed: 0,
          });
        } else {
          const tool = items[found];
          if (tool?.kind === "tool") {
            items[found] = {
              ...tool,
              // Claude's tool results carry no tool name (toolUseResult has
              // no `name`), so `??` let an empty string erase the name set by
              // the tool_use block -- every call then grouped as a generic
              // "N tool calls" chip and edit cards lost their diffs.
              name: String(message.toolName || tool.name),
              details: asRecord(message.details),
              output,
              status: message.isError ? "error" : "done",
              elapsed: Math.max(0, timestamp - tool.startedAt),
            };
          }
        }
      }
    }

    this.items = items;
    this.streams.clear();
    this.cycle = 0;
    this.state = this.withSessionName(state);
    this.status = state.isStreaming ? "working" : "ready";
    // History is a finished transcript. A toolCall without a matching
    // toolResult means the turn died mid-command (backend restart, lost
    // stream) — if left as "running" it hydrates as a zombie that shows an
    // ever-growing "running … esc to interrupt" pill on every restore.
    this.items = this.items.map((item) =>
      item.kind === "tool" && item.status === "running"
        ? {
            ...item,
            status: "error" as const,
            output: item.output || "(interrupted — no result was recorded)",
          }
        : item,
    );
    // Notices exist only in the server's runtime log, so rebuilding from the
    // session file drops them. A settled run's trailing asides were captured
    // during replay; put them back or a refresh loses the turn's summary.
    const trailing = this.trailingNotices;
    this.trailingNotices = [];
    for (const notice of trailing) this.appendNotice(notice.text, notice.tone);
    this.notify();
  }

  /**
   * Adopt a title that was resolved outside the event stream (the saved
   * session list, which the sidebar refreshes on its own schedule). Keeps a
   * reload showing the generated title even if the SSE event that first
   * announced it belonged to the previous page's session key.
   */
  applySessionName(name: string) {
    const title = name.trim();
    if (!title || title === this.sessionName) return;
    this.sessionName = title;
    if (this.state) this.state = { ...this.state, sessionName: title };
    this.notify();
  }

  /** Re-applies the sticky generated title over any state the backend reports. */
  private withSessionName(state: SessionState): SessionState {
    if (!this.sessionName) {
      if (state.sessionName) this.sessionName = state.sessionName;
      return state;
    }
    return state.sessionName === this.sessionName
      ? state
      : { ...state, sessionName: this.sessionName };
  }

  setState(state: SessionState) {
    this.state = this.withSessionName(state);
    this.status = state.isStreaming ? "working" : "ready";
    this.notify();
  }

  /**
   * Optimistic "the request was sent" state, set the instant the user sends
   * — the RPC prompt response only resolves when the whole turn completes,
   * and a stalled model call left the UI silent with no stop affordance.
   * Cleared by the next real agent_settled/state event, or explicitly when
   * the prompt fails.
   */
  markPendingRun() {
    this.status = "working";
    if (this.state) this.state = { ...this.state, isStreaming: true };
    this.notify();
  }

  clearPendingRun() {
    this.status = "ready";
    if (this.state) this.state = { ...this.state, isStreaming: false };
    this.notify();
  }

  private upsertStream(
    id: string,
    kind: "rationale" | "assistant",
    text: string,
    final?: string,
    parentToolUseId?: string,
  ) {
    const existing = this.streams.get(id);
    if (existing) {
      // A delta after text_end is out-of-order/spurious; once finalText is set
      // the stream is done, so ignore it rather than clobber the final text.
      if (existing.finalText === undefined) existing.pending += text;
      if (final !== undefined) existing.finalText = final;
      if (parentToolUseId) existing.parentToolUseId = parentToolUseId;
    } else {
      this.streams.set(id, {
        id,
        kind,
        pending: text,
        finalText: final,
        parentToolUseId,
      });
    }
    this.flushStreams();
  }

  /** Apply all pending stream text immediately (whole deltas, not char-by-char). */
  private flushStreams() {
    if (this.streams.size === 0) return;
    const patches = [...this.streams.values()];
    // Only clear streams that have finished producing output for this flush.
    this.streams.clear();
    this.updateItems((current) => {
      let next = current;
      for (const patch of patches) {
        const done =
          patch.finalText !== undefined && patch.pending.length === 0;
        const text =
          patch.finalText !== undefined && patch.pending.length === 0
            ? patch.finalText
            : patch.pending;
        if (!text) continue;
        const found = next.findIndex((item) => item.id === patch.id);
        if (found === -1) {
          next = [
            ...next,
            {
              id: patch.id,
              kind: patch.kind,
              text,
              live: !done,
              timestamp: Date.now(),
              ...(patch.parentToolUseId
                ? { parentToolUseId: patch.parentToolUseId }
                : {}),
            },
          ];
        } else {
          next = next.map((item, index) =>
            index === found &&
            (item.kind === "rationale" || item.kind === "assistant")
              ? {
                  ...item,
                  text:
                    patch.finalText !== undefined && patch.pending.length === 0
                      ? patch.finalText
                      : `${item.text}${patch.pending}`,
                  live: !done,
                  // The tag can arrive on a later delta than the one that
                  // created the block; without this a subagent's narration
                  // stayed untagged and leaked into the main transcript.
                  ...(patch.parentToolUseId
                    ? { parentToolUseId: patch.parentToolUseId }
                    : {}),
                }
              : item,
          );
        }
      }
      return next;
    });
  }

  /**
   * Bring the transcript back to a consistent resting state.
   *
   * Everything here exists because a turn can end without the events that
   * normally close it out: a tool whose tool_execution_end was lost when the
   * stream dropped keeps its "running … esc to interrupt" pill, a text block
   * whose terminating chunk never arrived keeps `live: true` (seen on the
   * Claude backend, which hides the model tag and locks the reply's ask card),
   * and `isStreaming` left true from markPendingRun keeps the composer
   * spinning. None of those can still be true once the agent is at rest.
   */
  private settle() {
    if (this.state) this.state = { ...this.state, isStreaming: false };
    this.updateItems((current) =>
      current.some(
        (item) =>
          (item.kind === "tool" && item.status === "running") ||
          ((item.kind === "assistant" || item.kind === "rationale") &&
            item.live),
      )
        ? current.map((item) => {
            if (item.kind === "tool" && item.status === "running") {
              // A Grok spawn_subagent returns immediately and keeps working in
              // a child session; do not treat that (or its nested calls) as a
              // dropped tool when the parent turn settles.
              if (item.parentToolUseId || isSubagentTool(item.name))
                return item;
              return {
                ...item,
                status: "error" as const,
                output:
                  item.output ||
                  "(interrupted — result lost when the backend stream dropped)",
                elapsed: Date.now() - item.startedAt,
              };
            }
            if (
              (item.kind === "assistant" || item.kind === "rationale") &&
              item.live
            )
              return { ...item, live: false };
            return item;
          })
        : current,
    );
  }

  handle(event: AgentEvent) {
    this.appendBackendEvent(event);
    if (event.type === "__status") {
      const status = (event.status as RunStatus) ?? "ready";
      this.status = status;
      if (event.error) this.appendNotice(String(event.error), "error");
      // A backend that stopped or errored is not going to answer. Without
      // this the composer spins forever on a dead process: __status set the
      // status but left isStreaming true from markPendingRun, and a clean
      // exit carries no error, so the turn failed in total silence.
      if (status === "stopped" || status === "error") {
        const wasRunning = this.state?.isStreaming === true;
        this.settle();
        if (wasRunning && !event.error)
          this.appendNotice(
            "The backend stopped before answering. Send the message again to restart it.",
            "error",
          );
      }
      this.notify();
      return;
    }
    if (event.type === "stderr") {
      const raw = String(event.message ?? "");
      const clean = readableAgentError(raw);
      if (looksLikeProviderApiLog(raw)) {
        if (clean) this.appendNotice(clean, "error");
        return;
      }
      this.appendNotice(clean || raw, "warning");
      return;
    }
    // Server- and adapter-sent notices (a cwd that vanished, an auto-resumed
    // turn). These were emitted long before anything rendered them.
    if (event.type === "notice") {
      const raw = String(event.message ?? "");
      const clean = readableAgentError(raw);
      if (isGenericAgentError(raw)) {
        const last = this.items.at(-1);
        if (last?.kind === "notice" && last.tone === "error") return;
        this.appendNotice(clean || raw, noticeTone(event.tone));
        return;
      }
      this.appendNotice(
        clean || raw,
        noticeTone(event.tone),
        typeof event.parentToolUseId === "string"
          ? event.parentToolUseId
          : undefined,
      );
      return;
    }
    if (event.type === "subagent_start") {
      // No notice: the subagent's calls carry parentToolUseId and render
      // nested inside the Task card that spawned them.
      return;
    }
    if (
      event.type === "system" &&
      String(event.subtype ?? "")
        .toLowerCase()
        .includes("hook")
    ) {
      // Hook lifecycle is harness plumbing, not conversation. It stays in the
      // Backend log (appendBackendEvent above) and out of the chat.
      return;
    }
    if (event.type === "turn_start") {
      this.cycle += 1;
      return;
    }

    if (event.type === "message_start") {
      const message = asRecord(event.message);
      if (String(message.role ?? "") !== "user") return;
      const text = extractHistoryText(message.content, "[Image attachment]");
      if (!text) return;
      // Optimistic appendUser on send already put this bubble in; a queued
      // follow-up has no optimistic bubble and must appear only now, when
      // the previous turn has actually finished printing.
      if (isEchoedUserMessage(this.items, text)) return;
      this.appendUser(text);
      return;
    }

    if (event.type === "agent_start") {
      this.status = "working";
      if (this.state) this.state = { ...this.state, isStreaming: true };
      this.notify();
      return;
    }

    if (event.type === "message_update") {
      const update = asRecord(event.assistantMessageEvent);
      const contentIndex =
        typeof update.contentIndex === "number" ? update.contentIndex : 0;
      const updateType = String(update.type ?? "");
      const delta = typeof update.delta === "string" ? update.delta : "";
      const content = typeof update.content === "string" ? update.content : "";
      const streamKey =
        typeof event.streamKey === "string"
          ? event.streamKey
          : String(this.cycle);
      const parentToolUseId = parentToolUseIdOf(event);
      if (updateType === "thinking_delta") {
        this.upsertStream(
          `rationale-${streamKey}-${contentIndex}`,
          "rationale",
          delta,
          undefined,
          parentToolUseId,
        );
      } else if (updateType === "thinking_end") {
        this.upsertStream(
          `rationale-${streamKey}-${contentIndex}`,
          "rationale",
          "",
          content,
          parentToolUseId,
        );
      } else if (updateType === "text_delta") {
        this.upsertStream(
          `assistant-${streamKey}-${contentIndex}`,
          "assistant",
          delta,
          undefined,
          parentToolUseId,
        );
      } else if (updateType === "text_end") {
        this.upsertStream(
          `assistant-${streamKey}-${contentIndex}`,
          "assistant",
          "",
          content,
          parentToolUseId,
        );
      }
      return;
    }

    if (event.type === "message_end") {
      const message = asRecord(event.message);
      if (String(message.role ?? "") !== "assistant") return;
      const error = readableAgentError(message.errorMessage);
      if (error) {
        this.appendNotice(error, "error");
        return;
      }
      // Authoritative final text: if deltas were suppressed (retries / exhausted
      // accounts), message_end still carries the whole assistant message.
      const finalText = extractText(message.content);
      const finalTimestamp = historyTimestamp(message);
      const streamKey =
        typeof event.streamKey === "string"
          ? event.streamKey
          : String(this.cycle);
      // Ground truth for "which model actually answered": the RPC layer tags
      // every assistant message with the model that produced it, independent
      // of what the model's own text claims (self-identification is unreliable).
      const provider =
        typeof message.provider === "string" ? message.provider : undefined;
      const modelId =
        typeof message.model === "string" ? message.model : undefined;
      const parentToolUseId =
        parentToolUseIdOf(event) ?? parentToolUseIdOf(message);
      if (finalText) {
        // Deltas may have already rendered this exact text at any content index
        // this cycle; only fall back to message_end when nothing matches.
        const already = this.items.some(
          (item) =>
            item.kind === "assistant" &&
            item.id.startsWith(`assistant-${streamKey}-`) &&
            item.text.trim() === finalText.trim(),
        );
        if (!already)
          this.upsertStream(
            `assistant-${streamKey}-0`,
            "assistant",
            "",
            finalText,
            parentToolUseId,
          );
        this.updateItems((current) =>
          current.map((item) =>
            item.kind === "assistant" &&
            item.id.startsWith(`assistant-${streamKey}-`)
              ? {
                  ...item,
                  timestamp: finalTimestamp,
                  provider,
                  modelId,
                  ...(parentToolUseId ? { parentToolUseId } : {}),
                }
              : item,
          ),
        );
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      const id = String(event.toolCallId ?? crypto.randomUUID());
      const name = String(event.toolName ?? "tool");
      const args = asRecord(event.args);
      const execKind =
        typeof event.execKind === "string" ? event.execKind : undefined;
      const parentToolUseId = parentToolUseIdOf(event);
      this.updateItems((current) => {
        const existing = current.findIndex(
          (item) => item.kind === "tool" && item.id === id,
        );
        if (existing === -1) {
          return [
            ...current,
            {
              id,
              kind: "tool",
              name,
              args,
              details: {},
              output: "",
              status: "running" as const,
              startedAt: Date.now(),
              ...(execKind ? { execKind } : {}),
              ...(parentToolUseId ? { parentToolUseId } : {}),
            },
          ];
        }
        const item = current[existing];
        if (item?.kind !== "tool") return current;
        // A stream_event can mint the card with an empty input; the
        // completed assistant message then repeats the start with args
        // (and, for nested calls, the parent id). Merge rather than ignore.
        return current.map((candidate, index) => {
          if (index !== existing) return candidate;
          return {
            ...item,
            ...(name && name !== "tool" ? { name } : {}),
            ...(Object.keys(args).length
              ? { args: { ...item.args, ...args } }
              : {}),
            ...(parentToolUseId && !item.parentToolUseId
              ? { parentToolUseId }
              : {}),
          };
        });
      });
      return;
    }

    if (
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
    ) {
      const id = String(event.toolCallId ?? "");
      const result = asRecord(
        event.type === "tool_execution_end"
          ? event.result
          : event.partialResult,
      );
      const output = extractText(result.content);
      this.updateItems((current) =>
        current.map((item) =>
          item.kind === "tool" && item.id === id
            ? {
                ...item,
                details: asRecord(result.details),
                output: output || item.output,
                status:
                  event.type === "tool_execution_end"
                    ? event.isError
                      ? "error"
                      : "done"
                    : "running",
                elapsed:
                  event.type === "tool_execution_end"
                    ? Date.now() - item.startedAt
                    : undefined,
              }
            : item,
        ),
      );
      return;
    }

    if (event.type === "agent_settled") {
      this.status = "ready";
      this.settle();
      this.notify();
      return;
    }

    if (event.type === "state") {
      this.setState(event.state as SessionState);
      return;
    }

    if (event.type === "session_title_set") {
      const title = typeof event.title === "string" ? event.title.trim() : "";
      if (!title || title === this.sessionName) return;
      // Remember it even when no state has arrived yet: the title is
      // generated in the background and can land before the first state
      // event, and dropping it there left the label on its fallback.
      this.sessionName = title;
      if (this.state) this.state = { ...this.state, sessionName: title };
      this.notify();
      return;
    }
  }
}
