// Model, effort, backend and agent-mode switching for Conversation, plus the
// model menu's keyboard handling.
import type * as React from "react";
import {
  api,
  type ModelInfo,
  backendLabel,
  type AgentBackend,
  type SessionState,
} from "../lib/api";
import type { ModelOption } from "./ComposerChrome";
import type { KeyboardEvent } from "react";
import { effortStops } from "../lib/effortStops";
import {
  type AgentMode,
  apiAgentMode,
  type AccessMode,
} from "./conversationHelpers";
import { isUnstartedTab, type ConversationTab } from "../lib/store";
import type { Timeline } from "../lib/timeline";
import type { SessionRoute } from "../lib/route";

export type SetModelCtx = {
  modelOptions: ModelOption[];
  tab: ConversationTab;
  timeline: Timeline;
  models: ModelInfo[];
  setLevels: React.Dispatch<React.SetStateAction<string[]>>;
  setPreferredModel: (
    backend: AgentBackend,
    cwd: string,
    model: ModelInfo | null,
  ) => void;
  refreshUsage: (force?: boolean) => Promise<boolean>;
};

export function setModel(ctx: SetModelCtx, value: string) {
  const {
    modelOptions,
    tab,
    timeline,
    models,
    setLevels,
    setPreferredModel,
    refreshUsage,
  } = ctx;
  const option = modelOptions.find(
    (candidate) => `${candidate.provider}/${candidate.id}` === value,
  );
  if (!option) return;
  void api.setModel(tab.key, option.provider, option.id).then((result) => {
    if (!result.ok) {
      timeline.appendNotice(result.error ?? "Could not set model", "error");
      return;
    }
    // Adopt the new model's catalog levels immediately so the effort
    // slider matches the selected model before the (slower) live
    // thinking-levels refresh below answers.
    const catalog = models.find(
      (candidate) =>
        candidate.provider === option.provider && candidate.id === option.id,
    );
    if (Array.isArray(catalog?.levels) && catalog.levels.length > 0)
      setLevels(catalog.levels);
    if (result.state) {
      timeline.setState(result.state);
      setPreferredModel(tab.backend, tab.cwd, result.state.model);
    } else {
      const model =
        result.data ??
        models.find(
          (candidate) =>
            candidate.provider === option.provider &&
            candidate.id === option.id,
        ) ??
        option;
      if (timeline.state) {
        timeline.setState({ ...timeline.state, model });
        setPreferredModel(tab.backend, tab.cwd, model);
      }
    }
    void api.thinkingLevels(tab.key, tab.backend).then((levelResult) => {
      if (levelResult.ok && Array.isArray(levelResult.levels))
        setLevels(levelResult.levels);
    });
    void refreshUsage(true);
  });
}

export type SetContextCtx = {
  tab: ConversationTab;
  timeline: Timeline;
  /** Catalog default for the model, so `null` (Default) has a value to show. */
  fallbackContext?: number;
};

/**
 * Choose the context window for the session's current model (pi, codex).
 * `null` restores the model's catalog default. The server applies it to the
 * backend (pi: session model budget; codex: thread config
 * override) and answers with fresh state when a live agent restarted.
 */
export function setContext(
  ctx: SetContextCtx,
  provider: string,
  modelId: string,
  contextWindow: number | null,
) {
  const { tab, timeline, fallbackContext } = ctx;
  return api
    .setContext(tab.key, provider, modelId, contextWindow)
    .then((result) => {
      if (!result.ok) {
        timeline.appendNotice(
          result.error ?? "Could not set context window",
          "error",
        );
        return;
      }
      const effective = contextWindow ?? fallbackContext;
      const applied = Boolean(result.state);
      if (result.state) timeline.setState(result.state);
      else if (timeline.state?.model)
        timeline.setState({
          ...timeline.state,
          model: { ...timeline.state.model, ...result.data, contextWindow: result.data?.contextWindow ?? effective },
        });
      timeline.appendNotice(
        contextWindow == null
          ? `Context window reset to ${effective ? `${Math.round(effective / 1000)}k` : "the model default"}${applied ? "" : " (next start)"}.`
          : `Context window set to ${Math.round(contextWindow / 1000)}k${applied ? " — compaction and the context gauge now follow it" : " — applies when the session next starts"}.`,
        "info",
      );
    }).catch(error => {
      timeline.appendNotice(error instanceof Error ? error.message : "Could not set context window", "error");
    });
}

export type PickListedModelCtx = {
  setModelMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  browseBackend: AgentBackend;
  tab: ConversationTab;
  pendingModelRef: React.RefObject<ModelInfo | null>;
  pendingBackendRef: React.RefObject<AgentBackend | null>;
  setModel: (value: string) => void;
  setPreferredModel: (
    backend: AgentBackend,
    cwd: string,
    model: ModelInfo | null,
  ) => void;
  switchBackend: (next: AgentBackend) => Promise<void>;
};

export function pickListedModel(ctx: PickListedModelCtx, option: ModelOption) {
  const {
    setModelMenuOpen,
    browseBackend,
    tab,
    pendingModelRef,
    pendingBackendRef,
    setModel,
    setPreferredModel,
    switchBackend,
  } = ctx;
  setModelMenuOpen(false);
  const model: ModelInfo = {
    provider: option.provider,
    id: option.id,
    name: option.label,
  };
  if (browseBackend === tab.backend) {
    pendingModelRef.current = null;
    pendingBackendRef.current = null;
    setModel(`${option.provider}/${option.id}`);
    return;
  }
  pendingModelRef.current = model;
  pendingBackendRef.current = browseBackend;
  setPreferredModel(browseBackend, tab.cwd, model);
  void switchBackend(browseBackend);
}

export type OnModelMenuKeyCtx = {
  browseBackend: AgentBackend;
  tab: ConversationTab;
  levels: string[];
  effort: string;
  setEffort: (level: string) => void;
  visibleOptions: ModelOption[];
  setModelIndex: React.Dispatch<React.SetStateAction<number>>;
  modelIndex: number;
  pickListedModel: (option: ModelOption) => void;
  setModelMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  backendIds: string[];
  setPickerBackend: React.Dispatch<React.SetStateAction<AgentBackend | null>>;
  setModelQuery: React.Dispatch<React.SetStateAction<string>>;
};

export function onModelMenuKey(
  ctx: OnModelMenuKeyCtx,
  event: KeyboardEvent<HTMLDivElement>,
) {
  const {
    browseBackend,
    tab,
    levels,
    effort,
    setEffort,
    visibleOptions,
    setModelIndex,
    modelIndex,
    pickListedModel,
    setModelMenuOpen,
    backendIds,
    setPickerBackend,
    setModelQuery,
  } = ctx;
  if (
    event.altKey &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight")
  ) {
    event.preventDefault();
    if (browseBackend !== tab.backend) return;
    const track = effortStops(levels, effort);
    const index = Math.max(0, track.indexOf(effort));
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = track[Math.max(0, Math.min(track.length - 1, index + delta))];
    if (next && next !== effort) setEffort(next);
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const count = visibleOptions.length;
    if (count === 0) return;
    setModelIndex((index) =>
      event.key === "ArrowDown"
        ? (index + 1) % count
        : (index - 1 + count) % count,
    );
  } else if (event.key === "Enter") {
    event.preventDefault();
    const option = visibleOptions[modelIndex];
    if (option) pickListedModel(option);
  } else if (event.key === "Escape") {
    setModelMenuOpen(false);
  } else if (event.key === "Tab") {
    event.preventDefault();
    const index = backendIds.indexOf(browseBackend);
    const next =
      backendIds[
        (index + (event.shiftKey ? -1 : 1) + backendIds.length) %
          backendIds.length
      ];
    if (next) {
      setPickerBackend(next);
      setModelQuery("");
      setModelIndex(0);
    }
  }
}

export type SetEffortCtx = {
  tab: ConversationTab;
  timeline: Timeline;
};

export function setEffort(ctx: SetEffortCtx, level: string) {
  const { tab, timeline } = ctx;
  void api.setThinking(tab.key, level).then((result) => {
    if (!result.ok) {
      timeline.appendNotice(
        result.error ?? "Could not set thinking level",
        "error",
      );
      return;
    }
    if (result.state) timeline.setState(result.state);
    else if (timeline.state)
      timeline.setState({ ...timeline.state, thinkingLevel: level });
  });
}

export type SwitchAgentModeCtx = {
  agentMode: AgentMode;
  hasItems: boolean;
  switchAgentMode: (nextMode: AgentMode, silent?: boolean) => Promise<void>;
  configureSession: (
    nextAccess: AccessMode,
    nextMode: AgentMode,
    nextCwd?: string,
  ) => Promise<void>;
  accessMode: AccessMode;
  setAgentMode: React.Dispatch<React.SetStateAction<AgentMode>>;
  persistRoute: (next: SessionRoute) => void;
  route: SessionRoute;
  setRoutePicking: React.Dispatch<React.SetStateAction<boolean>>;
  setOpenRoleId: React.Dispatch<React.SetStateAction<string | null>>;
  configuring: boolean;
  streaming: boolean;
  timeline: Timeline;
  state: SessionState | null;
  setConfiguring: React.Dispatch<React.SetStateAction<boolean>>;
  tab: ConversationTab;
  setConversationSessionPath: (key: string, path?: string | undefined) => void;
};

// Plan/auto can be switched mid-conversation: the backend restarts the agent
// against the same session file (plan mode = different system prompt + tool
// allowlist, which only apply at spawn time), so the transcript is reloaded
// from the persisted session afterwards.
export async function switchAgentMode(
  ctx: SwitchAgentModeCtx,
  nextMode: AgentMode,
  silent = false,
) {
  const {
    agentMode,
    hasItems,
    switchAgentMode,
    configureSession,
    accessMode,
    setAgentMode,
    persistRoute,
    route,
    setRoutePicking,
    setOpenRoleId,
    configuring,
    streaming,
    timeline,
    state,
    setConfiguring,
    tab,
    setConversationSessionPath,
  } = ctx;
  // Prosecutor mode runs the executor fully automatic: nobody is there to
  // approve its edits between rounds. The composer's ProsecutorSetup arms it.
  if (nextMode === "prosecutor") {
    if (agentMode === "routed") persistRoute({ ...route, enabled: false });
    if (agentMode === "plan" || agentMode === "manual" || agentMode === "auto-edit") {
      if (hasItems) await switchAgentMode("standard", true);
      else await configureSession(accessMode, "standard");
    }
    setAgentMode("prosecutor");
    return;
  }
  if (agentMode === "prosecutor") void api.putProsecutor(tab.key, null);
  if (nextMode === "routed") {
    if (agentMode === "plan") {
      if (hasItems) await switchAgentMode("standard", true);
      else await configureSession(accessMode, "standard");
    }
    setAgentMode("routed");
    persistRoute({ ...route, enabled: true });
    setRoutePicking(!route.template);
    return;
  }
  if (agentMode === "routed") {
    persistRoute({ ...route, enabled: false });
    setOpenRoleId(null);
    setRoutePicking(false);
  }
  if (configuring || nextMode === agentMode) return;
  if (!hasItems) {
    void configureSession(accessMode, nextMode);
    return;
  }
  if (streaming) {
    timeline.appendNotice(
      "Wait for the current response to finish before switching mode.",
      "warning",
    );
    return;
  }
  const sessionFile = state?.sessionFile;
  if (!sessionFile) {
    timeline.appendNotice(
      "Agent mode can only be changed before the first message.",
      "warning",
    );
    return;
  }
  setConfiguring(true);
  const result = await api.configure(
    tab.key,
    tab.cwd,
    accessMode,
    apiAgentMode(nextMode),
    state?.model,
    state?.thinkingLevel,
    sessionFile,
    tab.backend,
  );
  setConfiguring(false);
  if (!result.ok || !result.state) {
    timeline.appendNotice(
      result.error ?? "Could not switch agent mode",
      "error",
    );
    return;
  }
  if (Array.isArray(result.messages))
    timeline.hydrate(result.messages, result.state);
  else timeline.reset(result.state);
  setAgentMode(nextMode);
  setConversationSessionPath(tab.key, sessionFile);
  if (!silent) {
    timeline.appendNotice(
      nextMode === "plan"
        ? "Plan mode is on — read and plan, change nothing."
        : nextMode === "manual"
          ? "Ask mode is on — the agent asks before every edit and command."
          : nextMode === "auto-edit"
            ? "Auto-edit is on — edits apply, commands still ask."
            : "Full auto is on.",
      "info",
    );
  }
}

export type ConfigureSessionCtx = {
  tab: ConversationTab;
  hasItems: boolean;
  timeline: Timeline;
  setConversationWorkspace: (key: string, cwd: string) => void;
  openWorkspace: (nextTab?: "files" | "changes" | undefined) => void;
  setAgentMode: React.Dispatch<React.SetStateAction<AgentMode>>;
  persistRoute: (next: SessionRoute) => void;
  route: SessionRoute;
  setRoutePicking: React.Dispatch<React.SetStateAction<boolean>>;
  setConfiguring: React.Dispatch<React.SetStateAction<boolean>>;
  state: SessionState | null;
  setAccessMode: React.Dispatch<React.SetStateAction<AccessMode>>;
};

export async function configureSession(
  ctx: ConfigureSessionCtx,
  nextAccess: AccessMode,
  nextMode: AgentMode,
  nextCwd = ctx.tab.cwd,
) {
  const {
    tab,
    hasItems,
    timeline,
    setConversationWorkspace,
    openWorkspace,
    setAgentMode,
    persistRoute,
    route,
    setRoutePicking,
    setConfiguring,
    state,
    setAccessMode,
  } = ctx;
  const switchingFolder = nextCwd !== tab.cwd;
  if (hasItems && !switchingFolder) {
    timeline.appendNotice(
      "Access and agent mode can only be changed before the first message.",
      "warning",
    );
    return;
  }
  if (hasItems && switchingFolder) {
    setConversationWorkspace(tab.key, nextCwd);
    openWorkspace();
    return;
  }
  if (nextMode === "routed" && !switchingFolder) {
    setAgentMode("routed");
    persistRoute({ ...route, enabled: true });
    setRoutePicking(!route.template);
    return;
  }
  setConfiguring(true);
  const result = await api.configure(
    tab.key,
    nextCwd,
    nextAccess,
    apiAgentMode(nextMode),
    state?.model,
    state?.thinkingLevel,
    undefined,
    tab.backend,
  );
  setConfiguring(false);
  if (!result.ok || !result.state) {
    timeline.appendNotice(
      result.error ??
        `Could not reconfigure the ${backendLabel(tab.backend)} session`,
      "error",
    );
    return;
  }
  setAccessMode(nextAccess);
  setAgentMode(nextMode === "routed" ? "routed" : nextMode);
  timeline.reset(result.state);
  if (nextCwd !== tab.cwd) setConversationWorkspace(tab.key, nextCwd);
}

export type SwitchBackendCtx = {
  setModelMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  tab: ConversationTab;
  streaming: boolean;
  configuring: boolean;
  setDefaultBackend: (backend: AgentBackend) => void;
  transcriptBackendRef: React.RefObject<AgentBackend>;
  usageSinceRef: React.RefObject<number>;
  saveTranscript: () => Promise<string | null>;
  setConversationBackend: (key: string, backend: AgentBackend) => void;
  pendingHandoffRef: React.RefObject<{
    path: string;
    from: AgentBackend;
  } | null>;
  timeline: Timeline;
};

export async function switchBackend(ctx: SwitchBackendCtx, next: AgentBackend) {
  const {
    setModelMenuOpen,
    tab,
    streaming,
    configuring,
    setDefaultBackend,
    transcriptBackendRef,
    usageSinceRef,
    saveTranscript,
    setConversationBackend,
    pendingHandoffRef,
    timeline,
  } = ctx;
  setModelMenuOpen(false);
  if (next === tab.backend || streaming || configuring) return;
  if (isUnstartedTab(tab)) {
    setDefaultBackend(next);
    return;
  }
  const from = transcriptBackendRef.current;
  // Switching back before a prompt means the transcript is still `from`.
  usageSinceRef.current = next === from ? 0 : Date.now();
  // Save now rather than trust the last write: the brief must point at a
  // file that holds every turn so far.
  const path = await saveTranscript();
  // Free the old agent's process; the new one starts on the next prompt.
  await api.stop(tab.key);
  setConversationBackend(tab.key, next);
  pendingHandoffRef.current = path ? { path, from } : null;
  timeline.appendNotice(
    next === from
      ? `Switched back to ${backendLabel(from)}.`
      : `Switched from ${backendLabel(from)} to ${backendLabel(next)}. Your next message hands it this conversation's transcript.`,
    "info",
  );
}
