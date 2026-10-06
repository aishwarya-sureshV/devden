// Turn sending for Conversation: send, edit-and-resend, version switching,
// resume after a usage limit. Each takes the component's current values as ctx.
import type * as React from "react";
import type { Attachment, ConversationTab } from "../lib/store";
import {
  api,
  AuthError,
  backendLabel,
  type SessionState,
  type AgentBackend,
  type ModelInfo,
  type UsageWindow,
} from "../lib/api";
import {
  isUsageShortcut,
  apiAgentMode,
  type AgentMode,
} from "./conversationHelpers";
import {
  timelineToMarkdown,
  exportFilename,
  handoffPrompt,
} from "../lib/exportSession";
import { compactTokens, type ContextUsage } from "../lib/sessionMetrics";
import type { TimelineItem, Timeline, MessageUsage } from "../lib/timeline";
import {
  type DiffLine,
  getToolDiff,
  type ToolFileView,
} from "../lib/toolCards";
import { DISTILL_SKILL_PROMPT } from "../lib/skilldraft";
import { isAskMessage } from "../lib/askBlock";
import {
  isModelIdentityQuestion,
  runtimeModelAnswer,
} from "../lib/modelIdentity";
import {
  type LimitTurn,
} from "../lib/usageLimit";
import type { AgentCapabilities } from "../lib/agentCapabilities";
import type { SessionRoute } from "../lib/route";
import type { AccessMode } from "./conversationHelpers";

export type SendCtx = {
  accessMode: AccessMode;
  awaitingRoute: boolean;
  attachments: Attachment[];
  sendLockRef: React.RefObject<boolean>;
  lastSendRef: React.RefObject<{ text: string; at: number }>;
  editingMessageId: string | null;
  timeline: Timeline;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setEditingMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  resendEdited: (itemId: string, text: string) => Promise<void>;
  tab: ConversationTab;
  setConversationSessionPath: (key: string, path?: string | undefined) => void;
  refreshSessions: () => void;
  caps: AgentCapabilities;
  compacting: boolean;
  setCompacting: React.Dispatch<React.SetStateAction<boolean>>;
  state: SessionState | null;
  refreshUsage: (force?: boolean) => Promise<boolean>;
  displayTitle: string;
  context: ContextUsage;
  setViewer: React.Dispatch<React.SetStateAction<ToolFileView | null>>;
  forkOutput: (item: {
    id: string;
    kind: "assistant";
    text: string;
    live: boolean;
    timestamp: number;
    provider?: string | undefined;
    modelId?: string | undefined;
    usage?: MessageUsage | undefined;
    parentToolUseId?: string | undefined;
  }) => Promise<void>;
  setRemoteQr: React.Dispatch<
    React.SetStateAction<{ qrDataUrl: string; connectUrl: string } | null>
  >;
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  stickToBottom: React.RefObject<boolean>;
  streaming: boolean;
  canSteer: boolean;
  steerOnceRef: React.RefObject<boolean>;
  lastAssistantId: string | undefined;
  visibleItems: TimelineItem[];
  pendingBackendRef: React.RefObject<AgentBackend | null>;
  pendingModelRef: React.RefObject<ModelInfo | null>;
  pendingHandoffRef: React.RefObject<{
    path: string;
    from: AgentBackend;
  } | null>;
  agentMode: AgentMode;
  transcriptBackendRef: React.RefObject<AgentBackend>;
  route: SessionRoute;
};

export async function send(
  ctx: SendCtx,
  raw: string,
  seedAttachments?: Attachment[],
  opts?: { answersAsk?: boolean },
) {
  const {
    accessMode,
    awaitingRoute,
    attachments,
    sendLockRef,
    lastSendRef,
    editingMessageId,
    timeline,
    setDraft,
    setEditingMessageId,
    resendEdited,
    tab,
    setConversationSessionPath,
    refreshSessions,
    caps,
    compacting,
    setCompacting,
    state,
    refreshUsage,
    displayTitle,
    context,
    setViewer,
    forkOutput,
    setRemoteQr,
    setAttachments,
    stickToBottom,
    streaming,
    canSteer,
    steerOnceRef,
    lastAssistantId,
    visibleItems,
    pendingBackendRef,
    pendingModelRef,
    pendingHandoffRef,
    agentMode,
    transcriptBackendRef,
    route,
  } = ctx;
  if (awaitingRoute) return;
  const message = raw.trim();
  if (!message && attachments.length === 0 && !seedAttachments?.length) return;
  // Enter in the textarea and the form submit can fire in the same tick,
  // and a key-repeat Enter re-sends the same draft. Either path used to
  // POST /prompt then immediately /queue the same text, so the first
  // prompt appeared queued with no second message from the user.
  const now = Date.now();
  if (
    sendLockRef.current ||
    (message &&
      message === lastSendRef.current.text &&
      now - lastSendRef.current.at < 400)
  )
    return;
  sendLockRef.current = true;
  if (message) lastSendRef.current = { text: message, at: now };
  try {
    // Edited-message resend: the composer is attached to an existing user
    // message; resend it over the rewound context instead of appending a turn.
    if (editingMessageId !== null) {
      if (attachments.length > 0) {
        timeline.appendNotice(
          "Remove attachments to resend an edited message.",
          "warning",
        );
        return;
      }
      const itemId = editingMessageId;
      setDraft("");
      setEditingMessageId(null);
      if (!message) return;
      await resendEdited(itemId, message);
      return;
    }
    if (
      attachments.length === 0 &&
      (message === "/new" || message === "/clear")
    ) {
      const result = await api.newSession(tab.key);
      if (result.ok && result.state && Array.isArray(result.messages)) {
        timeline.hydrate(result.messages, result.state);
        setConversationSessionPath(tab.key, undefined);
      } else if (!result.ok) {
        timeline.appendNotice(
          result.error ??
            `Could not create a new ${backendLabel(tab.backend)} session`,
          "error",
        );
      }
      refreshSessions();
      setDraft("");
      return;
    }
    if (attachments.length === 0 && message === "/compact") {
      setDraft("");
      if (!caps.compact) {
        timeline.appendNotice(
          "This agent cannot compact a conversation.",
          "info",
        );
        return;
      }
      if (compacting) return;
      setCompacting(true);
      // No transcript notice here: the compacting strip above the composer is
      // the single live status, and a second message in the transcript read
      // as a duplicate with the Changes panel sandwiched between them.
      const result = await api.compact(tab.key, undefined, {
        cwd: tab.cwd,
        sessionPath: tab.sessionPath ?? state?.sessionFile ?? undefined,
        model: state?.model ?? undefined,
        thinkingLevel: state?.thinkingLevel ?? undefined,
      });
      setCompacting(false);
      if (result.ok) {
        // Compact rewrites the backend log the model will see. Hydrating
        // with that rewritten history is what made the original turns
        // disappear from the transcript.
        if (result.state) timeline.setState(result.state);
        // The backend's compaction event appends the single transcript
        // notice (with counts + an expandable summary) — adding one here
        // read as a duplicate pill.
      } else
        timeline.appendNotice(
          result.error ?? "Could not compact the conversation",
          "unsupported" in result && result.unsupported ? "info" : "error",
        );
      return;
    }
    if (attachments.length === 0 && isUsageShortcut(message)) {
      setDraft("");
      if (!(await refreshUsage(true)))
        timeline.appendNotice("Could not retrieve usage", "error");
      return;
    }
    if (
      attachments.length === 0 &&
      (message === "/usage" || message === "/cost")
    ) {
      setDraft("");
      const retrieved = await refreshUsage(true);
      timeline.appendNotice(
        retrieved
          ? "Usage refreshed — current windows are shown in the composer status bar."
          : "Could not retrieve usage",
        retrieved ? "info" : "error",
      );
      return;
    }
    if (message === "/export") {
      setDraft("");
      const markdown = timelineToMarkdown(timeline.items, {
        title: displayTitle,
        backend: backendLabel(tab.backend),
        model: state?.model?.name ?? state?.model?.id,
        cwd: tab.cwd,
      });
      const name = exportFilename(displayTitle);
      const url = URL.createObjectURL(
        new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoked on the next tick so the download has taken the handle.
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      timeline.appendNotice(`Exported this conversation to ${name}.`, "info");
      return;
    }
    if (message === "/context") {
      setDraft("");
      const userTurns = timeline.items.filter(
        (item) => item.kind === "user",
      ).length;
      const toolCalls = timeline.items.filter(
        (item) => item.kind === "tool",
      ).length;
      // Prefer the backend's own accounting. A capable backend that has
      // not answered yet has no honest number to print.
      if (caps.contextUsage && !context.exact) {
        timeline.appendNotice(
          "Context usage isn't in yet. It shows up once the model reports the window.",
          "info",
        );
        return;
      }
      const usage = context;
      const qualifier = usage.exact ? "" : "~";
      const breakdown = (usage.categories ?? [])
        .slice(0, 5)
        .map((entry) => `${entry.name} ${compactTokens(entry.tokens)}`)
        .join(", ");
      timeline.appendNotice(
        `Context use: ${qualifier}${compactTokens(usage.estimatedTokens)} of ${compactTokens(usage.contextWindow)} tokens (${usage.percent}%) — ${userTurns} user turns, ${toolCalls} tool calls${breakdown ? `. Largest: ${breakdown}` : ", plus the system prompt and tool definitions"}.${usage.autoCompactAt ? ` Auto-compacts at ${compactTokens(usage.autoCompactAt)}.` : ""} /compact summarizes older history for the model without clearing this transcript; /clear starts fresh.`,
        "info",
      );
      return;
    }
    if (message === "/diff") {
      setDraft("");
      const changes = timeline.items.filter(
        (item): item is Extract<TimelineItem, { kind: "tool" }> =>
          item.kind === "tool" &&
          ["edit", "write"].includes(item.name.toLowerCase()),
      );
      const lines: DiffLine[] = [];
      const files = new Set<string>();
      for (const item of changes) {
        const diff = getToolDiff(item);
        if (!diff) continue;
        const path = String(
          item.args.path ?? item.args.file_path ?? "(unknown)",
        );
        if (!files.has(path)) {
          files.add(path);
          lines.push({
            kind: "meta",
            text: `── ${path}${item.name.toLowerCase() === "write" ? "  (new file)" : ""}`,
          });
        }
        lines.push(...diff.lines);
      }
      if (lines.length === 0) {
        timeline.appendNotice("No file changes in this session yet.", "info");
        return;
      }
      setViewer({
        title: `Session diff · ${files.size} file${files.size === 1 ? "" : "s"} · ${changes.length} change${changes.length === 1 ? "" : "s"}`,
        diff: {
          added: lines.filter((line) => line.kind === "add").length,
          removed: lines.filter((line) => line.kind === "remove").length,
          lines,
        },
      });
      return;
    }
    if (message === "/fork" || /^\/fork\s+\d+$/.test(message)) {
      if (!caps.fork) {
        timeline.appendNotice("This agent cannot fork a conversation.", "info");
        return;
      }
      setDraft("");
      const arg = Number(message.slice(5).trim() || "1");
      const position = Number.isFinite(arg) && arg >= 1 ? Math.floor(arg) : 1;
      const assistants = timeline.items.filter(
        (item): item is Extract<TimelineItem, { kind: "assistant" }> =>
          item.kind === "assistant" && !item.live,
      );
      if (assistants.length === 0) {
        timeline.appendNotice(
          "Nothing to fork yet — send a message first.",
          "warning",
        );
        return;
      }
      if (position > assistants.length) {
        timeline.appendNotice(
          `There are only ${assistants.length} ${assistants.length === 1 ? "reply" : "replies"} to fork.`,
          "warning",
        );
        return;
      }
      const target = assistants.at(-position);
      if (!target) return;
      await forkOutput(target);
      return;
    }
    if (message === "/remote" || message.startsWith("/remote ")) {
      const arg = message.slice("/remote".length).trim();
      setDraft("");
      if (arg === "off") {
        const result = await api.remoteStop();
        timeline.appendNotice(
          result.ok ? "Remote tunnel closed." : "No remote tunnel was running.",
          "info",
        );
        return;
      }
      timeline.appendNotice(
        "Opening a secure tunnel — first run downloads cloudflared (~35 MB); later runs take a few seconds…",
        "info",
      );
      const result = await api.remoteStart();
      if (!result.ok || !result.connectUrl || !result.qrDataUrl) {
        timeline.appendNotice(
          result.error ?? "Could not start the remote tunnel.",
          "error",
        );
        return;
      }
      setRemoteQr({
        qrDataUrl: result.qrDataUrl,
        connectUrl: result.connectUrl,
      });
      return;
    }
    if (message === "/push" || message === "/pull") {
      const op = message.slice(1) as "push" | "pull";
      setDraft("");
      timeline.appendNotice(`Running git ${op} in ${tab.cwd}…`, "info");
      const result = await api.gitRun(tab.key, tab.cwd, op);
      if (result.ok) {
        const output = (result.output ?? "").trim();
        timeline.appendNotice(
          output ? `git ${op}:\n${output}` : `git ${op} finished.`,
          "info",
        );
      } else {
        timeline.appendNotice(result.error ?? `git ${op} failed`, "error");
      }
      return;
    }
    const pickedAttachments = seedAttachments ?? attachments;
    // An image attachment is already inline in the `images` payload below.
    // Listing its path under "inspect the attached file(s)" made agents Read
    // it a second time, so the same picture entered context twice and was
    // re-billed as fresh input on every later turn. The path stays -- it is the only
    // way to act on the file itself -- but it says it has already been seen.
    const attachmentLines = pickedAttachments.map((attachment) =>
      attachment.imageData
        ? `- ${attachment.name} (already attached inline — open this path only to edit the file, never to view it): ${attachment.path}`
        : `- ${attachment.name}: ${attachment.path}`,
    );
    // /skill sends the distill prompt to the agent itself — its own
    // history is the input, nothing to attach or re-read. The transcript
    // keeps the short "/skill" bubble instead of the canned prompt.
    let outboundMessage = [
      (message === "/skill" ? DISTILL_SKILL_PROMPT : message) ||
        "Please inspect the attached file(s).",
      attachmentLines.length
        ? `Attached files:\n${attachmentLines.join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    // Pictures show as thumbnails in the bubble; only other files are named.
    const namedFiles = pickedAttachments.filter((a) => !a.imageData);
    const displayMessage = [
      message || (namedFiles.length ? "Attached file(s)" : ""),
      namedFiles.length
        ? `Attachments: ${namedFiles.map((attachment) => attachment.name).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const images = pickedAttachments
      .filter((attachment) => attachment.imageData)
      .map((attachment) => ({
        type: "image" as const,
        data: attachment.imageData!,
        mimeType: attachment.mimeType,
      }));
    setDraft("");
    setAttachments([]);
    stickToBottom.current = true;
    // Mid-turn, Enter always queues. Cmd/Ctrl+Enter (and Steer now on the
    // queue chip) splice into the running turn on agents that support it.
    // An unsettled ask (the newest settled reply is an unanswered ask card)
    // holds the floor the same way: a prompt typed before the answer must
    // queue behind it, not replace the pending question. The ask card's
    // own submit (answersAsk) is the answer and goes straight through.
    const willSteer = Boolean(streaming) && canSteer && steerOnceRef.current;
    steerOnceRef.current = false;
    const lastReply = lastAssistantId
      ? visibleItems.find(
          (item): item is Extract<TimelineItem, { kind: "assistant" }> =>
            item.id === lastAssistantId && item.kind === "assistant",
        )
      : undefined;
    const askPending = !streaming && isAskMessage(lastReply?.text);
    const willQueue =
      !opts?.answersAsk && (Boolean(streaming) || askPending) && !willSteer;
    // A queued follow-up must not land in the transcript yet: it used to
    // sit in the middle of the still-printing turn, then its reply arrived
    // after the handover. The queue chip is the affordance until the
    // previous turn settles; message_start then appends the bubble.
    if (!willQueue)
      timeline.appendUser(
        displayMessage,
        images.map((image) => `data:${image.mimeType};base64,${image.data}`),
      );
    // Optimistic pending-run state: the RPC prompt response only arrives when
    // the whole turn completes, and agent_start can lag (a stalled model call
    // once left the UI silent for 225s). Show "working" immediately so the
    // user always knows the request was sent — and has a stop affordance.
    // A queued follow-up is not a run yet, so it must not flip the composer.
    if (!willQueue) timeline.markPendingRun();

    // A model's natural-language self-identification is not authoritative:
    // aliases and provider prompts can make Luna claim to be Kimi. For this
    // narrow question, answer from the session state that Pi reports instead.
    if (
      pickedAttachments.length === 0 &&
      state?.model &&
      isModelIdentityQuestion(message)
    ) {
      timeline.clearPendingRun();
      timeline.appendAssistant(runtimeModelAnswer(state.model));
      return;
    }

    const promptBackend = pendingBackendRef.current ?? tab.backend;
    const promptModel = pendingModelRef.current ?? state?.model ?? undefined;
    if (!willQueue) {
      pendingModelRef.current = null;
      pendingBackendRef.current = null;
    }
    const pendingHandoff = willQueue ? null : pendingHandoffRef.current;
    // A handoff belongs on the message only when it actually lands on a
    // backend other than the one that produced the transcript. Switching
    // away and back (e.g. pi→claude→pi) must not hand the transcript off.
    const handoff =
      pendingHandoff && pendingHandoff.from !== promptBackend
        ? handoffPrompt(pendingHandoff.path, backendLabel(pendingHandoff.from))
        : null;
    if (!willQueue) pendingHandoffRef.current = null;
    if (handoff) {
      outboundMessage = `${handoff}\n\n---\n\n${outboundMessage}`;
    }
    const promptOptions = {
      images,
      cwd: tab.cwd,
      backend: promptBackend,
      accessMode,
      agentMode: apiAgentMode(agentMode),
      sessionPath: tab.sessionPath ?? state?.sessionFile ?? undefined,
      model: promptModel,
      thinkingLevel: state?.thinkingLevel ?? undefined,
    };
    // Drop the same-tick lock before awaiting the turn so a follow-up can
    // queue; the 400ms same-text debounce still rejects the duplicate Enter.
    sendLockRef.current = false;
    // prompt() is the only one of the three that can hand back a session path.
    let result: {
      ok: boolean;
      error?: string;
      sessionPath?: string;
      data?: { queued?: boolean };
    } = await (streaming
      ? willSteer
        ? api.steer(tab.key, outboundMessage, images)
        : api.enqueue(tab.key, outboundMessage, images)
      : api.prompt(tab.key, outboundMessage, {
          ...promptOptions,
          answersAsk: opts?.answersAsk,
        })
    // Server down/restarting: fetch rejects or a proxy 502 isn't JSON. Fold it
    // into the failure branch so the spinner clears and the text comes back.
    ).catch((error: unknown) => {
      if (error instanceof AuthError) throw error; // App shows the lock screen
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Could not reach the DevDen server: ${reason}` };
    });
    // Laptop sleep / lease sweep can kill grok stdio while the tab still
    // thinks a turn is in flight and therefore enqueues. Restart on the
    // prompt path with the session file instead of failing closed.
    if (
      !result.ok &&
      /session is not running/i.test(String(result.error ?? ""))
    ) {
      result = await api
        .prompt(tab.key, outboundMessage, promptOptions)
        .catch((error: unknown) => {
          if (error instanceof AuthError) throw error;
          return { ok: false, error: String(error) };
        });
    }
    if (result.ok) {
      // The transcript's producing backend is now whichever agent took this
      // message, so a later switch-away-and-back compares against the real
      // source rather than the picker's intermediate selections.
      transcriptBackendRef.current = promptBackend;
      if (willQueue && !result.data?.queued) {
        // enqueue sends immediately when the agent went idle between click
        // and the POST; show the bubble the queue path skipped.
        timeline.appendUser(displayMessage);
        timeline.markPendingRun();
      } else if (!willQueue && result.data?.queued) {
        // The tab thought the agent was idle and the server disagreed (a
        // desynced `streaming` flag), so /prompt queued instead of starting.
        // Drop the optimistic run or the composer spins on a turn that is
        // still sitting in the queue — the exact "it queued my first message
        // by itself" shape, seen from the other side.
        timeline.clearPendingRun();
      }
      if (result.sessionPath && !(tab.sessionPath ?? state?.sessionFile)) {
        // A lazily-started session (pi and grok both start on the first message)
        // only reveals its file through the agent's own state, and no event
        // carries it -- so this reply is where the tab finally learns it. Until
        // it does, the sidebar cannot match this session's saved row to the tab
        // and shows no open marker against it.
        setConversationSessionPath(tab.key, result.sessionPath);
      }
      if (agentMode === "routed") {
        void api.putRoute(
          tab.key,
          route,
          result.sessionPath ?? tab.sessionPath ?? state?.sessionFile,
        );
      }
    } else {
      setAttachments(pickedAttachments);
      // Give the typed text back unless the user already started a new one.
      setDraft((current) => current || message);
      if (pendingHandoff) pendingHandoffRef.current = pendingHandoff;
      if (!willQueue) timeline.clearPendingRun();
      timeline.appendNotice(result.error ?? "prompt failed", "error");
    }
  } finally {
    sendLockRef.current = false;
  }
}

export type ResendEditedCtx = {
  timeline: Timeline;
  streaming: boolean;
  state: SessionState | null;
  tab: ConversationTab;
  setConversationSessionPath: (key: string, path?: string | undefined) => void;
  stickToBottom: React.RefObject<boolean>;
};

// Edit + resend: rewind the backend to just before the chosen message (the
// server branches the session file there), record the edit as the newest
// version of that message, then send the new prompt over the trimmed context.
export async function resendEdited(
  ctx: ResendEditedCtx,
  itemId: string,
  text: string,
) {
  const {
    timeline,
    streaming,
    state,
    tab,
    setConversationSessionPath,
    stickToBottom,
  } = ctx;
  const item = timeline.items.find((candidate) => candidate.id === itemId);
  if (!item || item.kind !== "user" || streaming) return;
  const versions = item.versions;
  const currentVersion = versions?.[item.versionIndex ?? 0];
  const fromSessionFile =
    currentVersion?.sessionFile ?? state?.sessionFile ?? "";
  const result = await api.truncate(
    tab.key,
    currentVersion?.timestamp ?? item.timestamp,
    fromSessionFile || undefined,
  );
  if (!result.ok || !result.state) {
    timeline.appendNotice(
      result.error ?? "Could not rewind the conversation for editing",
      "error",
    );
    return;
  }
  timeline.editUserMessage(
    itemId,
    text,
    fromSessionFile,
    result.state.sessionFile ?? fromSessionFile,
  );
  setConversationSessionPath(tab.key, result.state.sessionFile);
  stickToBottom.current = true;
  // cwd/session matter only if the agent died since the rewind: a lazy
  // restart must land in this project, not the server's own directory.
  const sent = await api.prompt(tab.key, text, {
    images: [],
    cwd: tab.cwd,
    backend: tab.backend,
    sessionPath: result.state.sessionFile ?? (fromSessionFile || undefined),
  });
  if (!sent.ok) {
    timeline.appendNotice(sent.error ?? "prompt failed", "error");
  }
}

export type SelectUserVersionCtx = {
  streaming: boolean;
  editingMessageId: string | null;
  tab: ConversationTab;
  timeline: Timeline;
  setConversationSessionPath: (key: string, path?: string | undefined) => void;
};

// Claude-Code-style ‹ › navigation: rebind the backend to the session file
// that contains the chosen version, rewound to just before its prompt.
export async function selectUserVersion(
  ctx: SelectUserVersionCtx,
  item: Extract<TimelineItem, { kind: "user" }>,
  targetIndex: number,
) {
  const {
    streaming,
    editingMessageId,
    tab,
    timeline,
    setConversationSessionPath,
  } = ctx;
  if (streaming || editingMessageId !== null) return;
  const target = item.versions?.[targetIndex];
  if (!target || targetIndex === (item.versionIndex ?? 0)) return;
  const result = await api.truncate(
    tab.key,
    target.timestamp,
    target.sessionFile || undefined,
  );
  if (!result.ok || !result.state) {
    timeline.appendNotice(
      result.error ?? "Could not switch to that version",
      "error",
    );
    return;
  }
  timeline.setUserVersion(
    item.id,
    targetIndex,
    result.state.sessionFile ?? target.sessionFile,
  );
  setConversationSessionPath(tab.key, result.state.sessionFile);
}

export type ResumeFromLimitCtx = {
  accessMode: AccessMode;
  limitTurn: LimitTurn | undefined;
  streaming: boolean;
  limitWindow: UsageWindow | undefined;
  timeline: Timeline;
  tab: ConversationTab;
  state: SessionState | null;
  agentMode: AgentMode;
};

/**
 * Sends a harness nudge rather than the user's text again: the agent still
 * holds its session, so all it is missing is the fact that the last turn
 * never finished. Nothing is appended to the transcript — the nudge is not
 * the user talking.
 */
export async function resumeFromLimit(ctx: ResumeFromLimitCtx) {
  const {
    accessMode,
    limitTurn,
    streaming,
    timeline,
    tab,
    state,
    agentMode,
  } = ctx;
  if (!limitTurn || streaming) return;
  // What a user would type: the agent's own session already holds the
  // interrupted request, so no harness text is needed.
  const prompt = "continue";
  timeline.appendNotice("Resuming the interrupted turn…", "info");
  timeline.markPendingRun();
  const result: {
    ok: boolean;
    error?: string;
    data?: { queued?: boolean };
  } = await api.prompt(tab.key, prompt, {
    cwd: tab.cwd,
    backend: tab.backend,
    sessionPath: tab.sessionPath ?? state?.sessionFile ?? undefined,
    model: state?.model ?? undefined,
    thinkingLevel: state?.thinkingLevel ?? undefined,
    accessMode,
    agentMode: apiAgentMode(agentMode),
  });
  if (!result.ok) {
    timeline.clearPendingRun();
    timeline.appendNotice(
      result.error ?? "Could not resume the interrupted turn",
      "error",
    );
  } else if (result.data?.queued) timeline.clearPendingRun();
}
