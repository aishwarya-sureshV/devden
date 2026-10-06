// Model picker state for Conversation: options, current model/effort labels,
// the effort track, menu effects and the switching handlers.
import type * as React from "react";
import type { ModelOption } from "./ComposerChrome";
import {
  formatClaudeModelName,
  CLAUDE_DEFAULT_MODEL,
} from "../lib/claudeModels";
import { BACKEND_DEFAULT_EFFORT, type ConversationTab } from "../lib/store";
import { capabilitiesFor } from "../lib/agentCapabilities";
import {
  setModel as setModelImpl,
  pickListedModel as pickListedModelImpl,
  onModelMenuKey as onModelMenuKeyImpl,
  setEffort as setEffortImpl,
  setContext as setContextImpl,
} from "./conversationModel";
import { useMemo, useEffect, useCallback, type KeyboardEvent } from "react";
import { useModelRefresh } from "./useModelRefresh";
import { effortScale } from "../lib/effortStops";
import {
  api,
  cachedCatalog,
  backendLabel,
  type ModelInfo,
  type SessionState,
  type AgentBackend,
} from "../lib/api";
import type { Timeline } from "../lib/timeline";

const EMPTY_LEVELS: string[] = [];
const EMPTY_MODELS: ModelInfo[] = [];

export type UseModelPickerArgs = {
  models: ModelInfo[];
  tab: ConversationTab;
  state: SessionState | null;
  timeline: Timeline;
  setLevels: React.Dispatch<React.SetStateAction<string[]>>;
  setPreferredModel: (
    backend: AgentBackend,
    cwd: string,
    model: ModelInfo | null,
  ) => void;
  refreshUsage: (force?: boolean) => Promise<boolean>;
  pickerBackend: AgentBackend | null;
  pickerModels: Partial<Record<AgentBackend, ModelInfo[]>>;
  modelQuery: string;
  levels: string[];
  pickerLevels: Partial<Record<AgentBackend, string[]>>;
  modelIndex: number;
  setModelMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  pendingModelRef: React.RefObject<ModelInfo | null>;
  pendingBackendRef: React.RefObject<AgentBackend | null>;
  switchBackend: (next: AgentBackend) => Promise<void>;
  modelMenuOpen: boolean;
  setPickerModels: React.Dispatch<
    React.SetStateAction<Partial<Record<AgentBackend, ModelInfo[]>>>
  >;
  setPickerLevels: React.Dispatch<
    React.SetStateAction<Partial<Record<AgentBackend, string[]>>>
  >;
  setModelQuery: React.Dispatch<React.SetStateAction<string>>;
  setModelIndex: React.Dispatch<React.SetStateAction<number>>;
  setAgentNote: React.Dispatch<React.SetStateAction<AgentBackend | null>>;
  modelSearchRef: React.RefObject<HTMLInputElement | null>;
  backendIds: string[];
  setPickerBackend: React.Dispatch<React.SetStateAction<AgentBackend | null>>;
};

export function useModelPicker({
  models,
  tab,
  state,
  timeline,
  setLevels,
  setPreferredModel,
  refreshUsage,
  pickerBackend,
  pickerModels,
  modelQuery,
  levels,
  pickerLevels,
  modelIndex,
  setModelMenuOpen,
  pendingModelRef,
  pendingBackendRef,
  switchBackend,
  modelMenuOpen,
  setPickerModels,
  setPickerLevels,
  setModelQuery,
  setModelIndex,
  setAgentNote,
  modelSearchRef,
  backendIds,
  setPickerBackend,
}: UseModelPickerArgs) {
  const modelOptions: ModelOption[] = models.map((m) => ({
    provider: m.provider,
    id: m.id,
    label:
      tab.backend === "claude" || m.provider === "anthropic"
        ? formatClaudeModelName(m.name ?? m.id)
        : (m.name ?? m.id),
  }));
  const activeModel =
    state?.model ??
    (tab.backend === "claude" && tab.isFresh ? CLAUDE_DEFAULT_MODEL : null);
  const currentModel = activeModel
    ? `${activeModel.provider}/${activeModel.id}`
    : "";
  const currentModelLabel =
    modelOptions.find(
      (option) => `${option.provider}/${option.id}` === currentModel,
    )?.label ??
    (tab.backend === "claude" && activeModel
      ? formatClaudeModelName(activeModel.name ?? activeModel.id)
      : activeModel?.name) ??
    activeModel?.id ??
    "model…";
  const effort =
    state?.thinkingLevel ??
    (tab.isFresh ? BACKEND_DEFAULT_EFFORT[tab.backend] : "off");

  const setModel = (value: string) =>
    setModelImpl(
      {
        modelOptions,
        tab,
        timeline,
        models,
        setLevels,
        setPreferredModel,
        refreshUsage,
      },
      value,
    );

  const browseBackend = pickerBackend ?? tab.backend;
  const browseModels =
    browseBackend === tab.backend
      ? models
      : (pickerModels[browseBackend] ?? EMPTY_MODELS);
  const visibleOptions = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    const ids = query ? backendIds as AgentBackend[] : [browseBackend];
    return ids.flatMap(id => {
      const catalog = id === tab.backend ? models : pickerModels[id] ?? EMPTY_MODELS;
      return catalog.map(model => ({
        provider: model.provider, id: model.id, backend: id,
        label: id === "claude" || model.provider === "anthropic"
          ? formatClaudeModelName(model.name ?? model.id) : model.name ?? model.id,
        context: model.contextWindow, levels: model.levels,
      })).filter(option => !query || `${backendLabel(id)} ${option.label} ${option.provider}/${option.id}`.toLowerCase().includes(query));
    });
  }, [browseBackend, backendIds, tab.backend, models, pickerModels, modelQuery]);

  // One ladder for the backend, the union of every model's levels. Hovering
  // a row used to swap the ladder and re-pack the stops, so the knob jumped
  // while the fill was still easing. The union does not move; supportedLevels
  // is what the row under the pointer can actually select.
  const backendLevels =
    browseBackend === tab.backend
      ? levels
      : (pickerLevels[browseBackend] ?? EMPTY_LEVELS);
  const trackLevels = useMemo(() => {
    const ladders = browseModels.flatMap((model) =>
      model.levels?.length ? [model.levels] : [],
    );
    return effortScale(ladders.length ? ladders : [backendLevels], effort);
  }, [browseModels, backendLevels, effort]);
  const hoveredLevels = visibleOptions[modelIndex]?.levels;
  const supportedLevels = hoveredLevels?.length ? hoveredLevels : trackLevels;

  const pickListedModel = (option: ModelOption) =>
    pickListedModelImpl(
      {
        setModelMenuOpen,
        browseBackend: option.backend ?? browseBackend,
        tab,
        pendingModelRef,
        pendingBackendRef,
        setModel,
        setPreferredModel,
        switchBackend,
      },
      option,
    );

  const loadBrowseModels = useCallback(() => {
    if (!modelMenuOpen || !pickerBackend || pickerBackend === tab.backend)
      return;
    // The server shares and expires catalogs. Keep the displayed list while
    // rechecking on every browse instead of caching forever in this tab.
    void api.models(tab.key, pickerBackend).then((result) => {
      if (!result.ok || !Array.isArray(result.models)) return;
      setPickerModels((prev) => ({ ...prev, [pickerBackend]: result.models }));
    }).catch(() => {});
    void api.thinkingLevels(tab.key, pickerBackend).then((result) => {
      if (!result.ok || !Array.isArray(result.levels) || !result.levels.length) return;
      setPickerLevels((prev) => ({ ...prev, [pickerBackend]: result.levels }));
    }).catch(() => {});
  }, [modelMenuOpen, pickerBackend, tab.backend, tab.key]);
  useEffect(loadBrowseModels, [loadBrowseModels]);
  useModelRefresh(loadBrowseModels, modelMenuOpen);

  // Fill every other agent's catalog as soon as this session is on screen.
  // Pi's list is a process spawn; waiting until the click is what left the
  // menu on "Loading models…". A later browse still rechecks.
  const backendKey = backendIds.join("\0");
  useEffect(() => {
    let cancelled = false;
    for (const backend of backendKey.split("\0")) {
      if (!backend || backend === tab.backend) continue;
      const id = backend as AgentBackend;
      // Last known catalog first (instant, survives deploys); live replaces it.
      const seededModels = cachedCatalog("models", id);
      const seededLevels = cachedCatalog("levels", id);
      if (seededModels) setPickerModels(prev => prev[id]?.length ? prev : { ...prev, [id]: seededModels });
      if (seededLevels) setPickerLevels(prev => prev[id]?.length ? prev : { ...prev, [id]: seededLevels });
      void api
        .models(tab.key, id)
        .then((result) => {
          if (cancelled || !result.ok || !result.models?.length) return;
          setPickerModels((prev) => ({ ...prev, [id]: result.models }));
        })
        .catch(() => {});
      void api
        .thinkingLevels(tab.key, id)
        .then((result) => {
          if (cancelled || !result.ok || !result.levels?.length) return;
          setPickerLevels((prev) => ({ ...prev, [id]: result.levels }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [backendKey, setPickerLevels, setPickerModels, tab.backend, tab.key]);

  // Fresh menu state on every open; keyboard focus lands in the search box.
  useEffect(() => {
    if (!modelMenuOpen) return;
    setModelQuery("");
    // Start the keyboard highlight on the session's model (mock parity), so
    // the effort track opens on its ladder and arrows walk from it.
    const start = modelOptions.findIndex(
      (option) => `${option.provider}/${option.id}` === currentModel,
    );
    setModelIndex(start >= 0 ? start : 0);
    setAgentNote(null);
    const input = modelSearchRef.current;
    if (input) input.focus();
    // deps: [modelMenuOpen, tab.backend] only — re-running on catalog
    // arrivals would reset a query the user is typing mid-menu.
  }, [modelMenuOpen, tab.backend]);

  const onModelMenuKey = (event: KeyboardEvent<HTMLDivElement>) =>
    onModelMenuKeyImpl(
      {
        browseBackend,
        tab,
        levels: supportedLevels,
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
      },
      event,
    );

  const setEffort = (level: string) => setEffortImpl({ tab, timeline }, level);

  // Context-window chooser: only backends that can actually take the value
  // (pi via its session model, codex via thread config), and only while browsing
  // the session's own backend — the pick applies to the session's model.
  const contextCapable =
    capabilitiesFor(tab.backend).setContextWindow &&
    browseBackend === tab.backend;
  const activeEntry = useMemo(
    () =>
      models.find(
        (candidate) =>
          candidate.provider === activeModel?.provider &&
          candidate.id === activeModel?.id,
      ),
    [models, activeModel?.provider, activeModel?.id],
  );
  const contextChoices = useMemo<number[] | null>(() => {
    if (!contextCapable || !activeEntry?.contextWindow) return null;
    return [...new Set([
      activeEntry.contextWindow,
      ...(activeEntry.contextWindowOptions ?? []),
      ...(activeEntry.maxContextWindow ? [activeEntry.maxContextWindow] : []),
    ])].filter(value => Number.isSafeInteger(value) && value > 0 && value <= (activeEntry.maxContextWindow ?? activeEntry.contextWindow!));
  }, [contextCapable, activeEntry]);
  const currentContext =
    activeModel?.contextWindow ?? activeEntry?.contextWindow;
  const onContext = (tokens: number | null) => {
    if (!activeModel) return;
    return setContextImpl(
      { tab, timeline, fallbackContext: activeEntry?.contextWindow },
      activeModel.provider,
      activeModel.id,
      tokens,
    );
  };

  return {
    browseBackend,
    currentModelLabel,
    effort,
    trackLevels,
    supportedLevels,
    visibleOptions,
    currentModel,
    pickListedModel,
    setEffort,
    onModelMenuKey,
    contextChoices,
    currentContext,
    defaultContext: activeEntry?.contextWindow,
    onContext,
  };
}
