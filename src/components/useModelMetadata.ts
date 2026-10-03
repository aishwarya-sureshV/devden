// Model and slash-command metadata for Conversation: fetch per backend, guard
// against stale responses, reload when the backend changes.
import type * as React from "react";
import { useCallback, useEffect, useRef } from "react";
import { useModelRefresh } from "./useModelRefresh";
import {
  api,
  type RunStatus,
  type ModelInfo,
  type SessionState,
  type AgentBackend,
} from "../lib/api";
import type { ConversationTab } from "../lib/store";

export type UseModelMetadataArgs = {
  modelMetadataLoadedRef: React.RefObject<boolean>;
  modelMetadataRequestRef: React.RefObject<Promise<void> | null>;
  status: RunStatus;
  metadataGenRef: React.RefObject<number>;
  tab: ConversationTab;
  setModels: React.Dispatch<React.SetStateAction<ModelInfo[]>>;
  setLevels: React.Dispatch<React.SetStateAction<string[]>>;
  state: SessionState | null;
  metadataBackendRef: React.RefObject<AgentBackend>;
  visible: boolean;
};

export function useModelMetadata({
  modelMetadataLoadedRef,
  modelMetadataRequestRef,
  status,
  metadataGenRef,
  tab,
  setModels,
  setLevels,
  state,
  metadataBackendRef,
  visible,
}: UseModelMetadataArgs) {
  const loadedAt = useRef(0);
  const loadModelMetadata = useCallback(() => {
    if (
      (modelMetadataLoadedRef.current && Date.now() - loadedAt.current < 5 * 60_000) ||
      modelMetadataRequestRef.current ||
      status === "starting" ||
      status === "stopped"
    )
      return;
    const gen = metadataGenRef.current;
    const request = Promise.all([
      api.models(tab.key, tab.backend),
      api.thinkingLevels(tab.key, tab.backend),
    ])
      .then(([modelResult, levelResult]) => {
        // The tab's backend changed while this was in flight: drop the old
        // backend's catalogs instead of showing them as the new one's.
        if (gen !== metadataGenRef.current) return;
        if (
          modelResult.ok &&
          Array.isArray(modelResult.models) &&
          modelResult.models.length > 0
        )
          setModels(modelResult.models);
        if (
          levelResult.ok &&
          Array.isArray(levelResult.levels) &&
          levelResult.levels.length > 0
        )
          // The selected model's own catalog levels win (per-model, like
          // synara); the session's live answer is the fallback for models
          // without catalog metadata.
          setLevels(levelResult.levels);
        if (modelResult.ok && Array.isArray(modelResult.models)) {
          const active = modelResult.models.find(
            (candidate) =>
              candidate.provider === state?.model?.provider &&
              candidate.id === state?.model?.id,
          );
          if (Array.isArray(active?.levels) && active.levels.length > 0)
            setLevels(active.levels);
        }
        if (modelResult.ok && levelResult.ok) {
          modelMetadataLoadedRef.current = true;
          loadedAt.current = Date.now();
        }
      })
      .catch(() => {}) // retain the visible catalog and retry next time
      .finally(() => {
        if (gen === metadataGenRef.current) modelMetadataRequestRef.current = null;
      });
    modelMetadataRequestRef.current = request;
  }, [status, tab.backend, tab.key, state?.model]);

  useModelRefresh(() => {
    modelMetadataLoadedRef.current = false;
    loadModelMetadata();
  }, visible);

  // Backend switched under this tab (the sidebar picker retargets unstarted
  // tabs): drop the old backend's model/effort lists and clear the guards
  // BEFORE the warm effect below runs in this same commit — it would bail on
  // the loaded-once flag otherwise and keep showing e.g. Sonnet under grok.
  useEffect(() => {
    if (metadataBackendRef.current === tab.backend) return;
    metadataBackendRef.current = tab.backend;
    metadataGenRef.current += 1;
    modelMetadataLoadedRef.current = false;
    // Free the slot: an in-flight fetch for the old backend is still
    // tracked, and its response is dropped by the generation stamp above.
    modelMetadataRequestRef.current = null;
    setModels([]);
    setLevels([]);
  }, [tab.backend]);

  // Warm the model list as soon as the session is usable. The server caches
  // catalogs per backend, so this is one cheap request that turns the model
  // dropdown from a multi-second spinner into an instant open.
  useEffect(() => {
    if (!visible || status === "starting" || status === "stopped") return;
    loadModelMetadata();
  }, [loadModelMetadata, status, visible]);

  return {
    loadModelMetadata,
  };
}
