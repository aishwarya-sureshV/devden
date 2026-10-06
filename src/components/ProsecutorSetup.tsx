import { useEffect, useState } from "react";
import {
  AGENT_BACKENDS,
  api,
  backendLabel,
  backendMark,
  type AgentBackend,
  type ModelInfo,
} from "../lib/api";
import { useStore } from "../lib/store";
import { BackendLogo } from "./icons";

type ProsecutorChoice = {
  backend: AgentBackend;
  modelId: string;
  modelName: string;
  provider: string;
};

// Last pick is a per-browser default, not session state: the server holds
// the armed case, and this component re-arms it whenever it is shown.
const STORAGE_KEY = "devden.prosecutor";

function loadChoice(): ProsecutorChoice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ProsecutorChoice) : null;
  } catch {
    return null;
  }
}

function saveChoice(choice: ProsecutorChoice) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    /* private window: the pick just isn't remembered */
  }
}

/** Composer panel for prosecutor mode: the executor is whatever the model
 *  picker has selected (shown locked); the prosecutor is chosen here. */
export function ProsecutorSetup({
  sessionKey,
  executorBackend,
  executorModel,
}: {
  sessionKey: string;
  executorBackend: AgentBackend;
  executorModel: string;
}) {
  const { backendCatalog } = useStore();
  const backendIds = backendCatalog.length
    ? backendCatalog.map((item) => item.id)
    : [...AGENT_BACKENDS];
  // Default to a different backend than the executor: a model is a weak
  // adversary against its own blind spots.
  const [choice, setChoice] = useState<ProsecutorChoice>(
    () =>
      loadChoice() ?? {
        backend:
          backendIds.find((id) => id !== executorBackend) ?? executorBackend,
        modelId: "",
        modelName: "",
        provider: "",
      },
  );
  const [models, setModels] = useState<ModelInfo[]>([]);

  useEffect(() => {
    setModels([]);
    void api
      .models(sessionKey, choice.backend)
      .then((result) => {
        if (result.ok) setModels(result.models ?? []);
      })
      .catch(() => {});
  }, [sessionKey, choice.backend]);

  // Arm (or re-arm after a server restart) on every change of the pick.
  useEffect(() => {
    saveChoice(choice);
    void api.putProsecutor(sessionKey, {
      backend: choice.backend,
      ...(choice.modelId
        ? { model: { provider: choice.provider, id: choice.modelId } }
        : {}),
    });
  }, [sessionKey, choice]);

  const modelValue = choice.modelId ? `${choice.provider}/${choice.modelId}` : "";

  return (
    <div className="route-setup">
      <div className="route-setup__bar">
        <strong>Prosecutor</strong>
        <span className="route-setup__hint">
          accepted only when the prosecutor can't write a failing test
        </span>
      </div>
      <ul className="route-setup__rows">
        <li className="route-setup__row">
          <span className="route-setup__kind is-execute">execute</span>
          <span
            className="route-setup__mark"
            style={{ color: backendMark(executorBackend).color }}
          >
            <BackendLogo backend={executorBackend} size={14} />
          </span>
          <label className="route-setup__select">
            <select aria-label="Executor backend" value={executorBackend} disabled>
              <option value={executorBackend}>
                {backendLabel(executorBackend).toLowerCase()}
              </option>
            </select>
          </label>
          <label className="route-setup__select route-setup__select--model">
            <select aria-label="Executor model" value="current" disabled>
              <option value="current">{executorModel || "default"}</option>
            </select>
          </label>
          <em>writes the fix · from model picker</em>
        </li>
        <li className="route-setup__row">
          <span className="route-setup__kind is-review">prosecute</span>
          <span
            className="route-setup__mark"
            style={{ color: backendMark(choice.backend).color }}
          >
            <BackendLogo backend={choice.backend} size={14} />
          </span>
          <label className="route-setup__select">
            <select
              aria-label="Prosecutor backend"
              value={choice.backend}
              onChange={(event) =>
                setChoice({
                  backend: event.target.value as AgentBackend,
                  modelId: "",
                  modelName: "",
                  provider: "",
                })
              }
            >
              {backendIds.map((backend) => (
                <option key={backend} value={backend}>
                  {backendLabel(backend).toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <label className="route-setup__select route-setup__select--model">
            <select
              aria-label="Prosecutor model"
              value={modelValue}
              onChange={(event) => {
                const option = models.find(
                  (item) => `${item.provider}/${item.id}` === event.target.value,
                );
                setChoice({
                  ...choice,
                  modelId: option?.id ?? "",
                  modelName: option?.name ?? option?.id ?? "",
                  provider: option?.provider ?? "",
                });
              }}
            >
              <option value="">default</option>
              {choice.modelId &&
                !models.some((item) => item.id === choice.modelId) && (
                  <option value={modelValue}>
                    {choice.modelName || choice.modelId}
                  </option>
                )}
              {models.map((item) => (
                <option
                  key={`${item.provider}/${item.id}`}
                  value={`${item.provider}/${item.id}`}
                >
                  {item.name || item.id}
                </option>
              ))}
            </select>
          </label>
          <em>writes failing tests</em>
        </li>
      </ul>
    </div>
  );
}
