import { useEffect, useState } from "react";
import {
  api,
  backendLabel,
  backendMark,
  type AgentBackend,
  type ModelInfo,
  type ProsecutorConfig,
  type ProsecutorEffort,
  type ProsecutorState,
} from "../lib/api";
import { pickerBackendIds } from "../lib/agentAvailability.ts";
import { useStore } from "../lib/store";
import { BackendLogo } from "./icons";
import { IconClose } from "./AskCard";
import { effortLabel } from "../lib/effortStops";
import { nudgeChoices, showLowerNudge } from "../lib/prosecutorEffort";

type ProsecutorChoice = {
  backend: AgentBackend;
  modelId: string;
  modelName: string;
  provider: string;
  /** Unset = automatic: high for round 1, medium after. */
  effort?: ProsecutorEffort;
};

const EFFORT_CHOICES: ProsecutorEffort[] = ["low", "medium", "high"];

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
const STATUS_LABEL: Record<NonNullable<ProsecutorState["status"]>, string> = {
  fixing: "executor fixing",
  reviewing: "prosecutor reviewing",
  verifying: "server verifying",
  verified: "verified",
  stopped: "stopped",
  inconclusive: "inconclusive — not verified",
};

const lines = (text: string) =>
  text.split("\n").map((line) => line.trim()).filter(Boolean);

export function ProsecutorSetup({
  sessionKey,
  sessionPath,
  cwd,
  executorBackend,
  executorModel,
  caseState,
  effort,
  levels,
  onEffort,
  onSend,
}: {
  sessionKey: string;
  /** Session file path. Stable across refresh; how a restarted case is found. */
  sessionPath?: string;
  /** The workspace whose acceptance gate config this panel edits. */
  cwd?: string;
  executorBackend: AgentBackend;
  executorModel: string;
  /** The server-side case (useProsecutorCase). */
  caseState: ProsecutorState | null;
  /** The executor's effort and levels: the composer picker owns them. */
  effort: string;
  levels: string[];
  onEffort: (level: string) => void;
  /** Sends a message as the user would (resuming a paused executor). */
  onSend: (text: string) => void;
}) {
  const { backendCatalog } = useStore();
  const backendIds = pickerBackendIds(backendCatalog);
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
  const [resumeError, setResumeError] = useState("");
  const [config, setConfig] = useState<ProsecutorConfig | null>(null);
  const [gateDraft, setGateDraft] = useState<{ commands: string; patterns: string; timeout: string } | null>(null);

  // The case itself comes from useProsecutorCase; this panel only loads the
  // workspace's acceptance-gate config.
  useEffect(() => {
    if (!cwd) return;
    let open = true;
    void api
      .prosecutorState(sessionKey, undefined, cwd)
      .then((next) => {
        if (open && next.config) setConfig(next.config);
      })
      .catch(() => {});
    return () => {
      open = false;
    };
  }, [sessionKey, cwd]);

  // An open case keeps its prosecutor when a tab attaches; show that one.
  useEffect(() => {
    if (!caseState?.armed || !caseState.open || !caseState.backend) return;
    const id = caseState.model?.id ?? "";
    setChoice((prev) =>
      prev.backend === caseState.backend &&
      prev.modelId === id &&
      prev.effort === (caseState.effort ?? undefined)
        ? prev
        : {
            backend: caseState.backend!,
            modelId: id,
            modelName: id,
            provider: caseState.model?.provider ?? "",
            effort: caseState.effort ?? undefined,
          },
    );
  }, [caseState]);

  const editGate = () =>
    setGateDraft({
      commands: (config?.commands ?? []).map((command) => command.run).join("\n"),
      patterns: (config?.testPatterns ?? []).join("\n"),
      timeout: String(config?.commands[0]?.timeoutSec ?? 300),
    });
  const saveGate = async () => {
    if (!gateDraft || !cwd) return;
    const timeoutSec = Number(gateDraft.timeout) || 300;
    const result = await api
      .putProsecutorConfig(sessionKey, cwd, {
        commands: lines(gateDraft.commands).map((run) => ({ run, timeoutSec })),
        testPatterns: lines(gateDraft.patterns),
      })
      .catch(() => null);
    if (result?.ok && result.config) {
      setConfig(result.config);
      setGateDraft(null);
    }
  };
  // The case whose lower-effort nudge was answered; ignoring it changes nothing.
  const [nudged, setNudged] = useState<number | null>(null);
  const nudge = nudgeChoices(levels, effort);
  const [nudgeLevel, setNudgeLevel] = useState("");
  const showNudge =
    showLowerNudge("prosecutor", caseState, nudged, effort) && nudge.choices.length > 0;
  const closeNudge = () => setNudged(caseState?.caseId ?? null);

  const resume = async () => {
    setResumeError("");
    const result = await api.resumeProsecutor(sessionKey, sessionPath).catch((error: Error) => ({
      ok: false as const,
      error: error.message,
      side: undefined,
      prompt: undefined,
    }));
    if (!result.ok) return setResumeError(result.error ?? "Could not resume");
    // Executor side: through the composer, so a backend switched in the
    // model picker starts and gets its transcript handoff.
    if (result.side === "executor" && result.prompt) onSend(result.prompt);
  };
  const paused = caseState?.paused;
  const status = caseState?.status;
  const gate = caseState?.gate;
  const findings = status === "fixing" || status === "reviewing" ? (caseState?.findings ?? []) : [];

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
    void api.putProsecutor(
      sessionKey,
      {
        backend: choice.backend,
        ...(choice.modelId
          ? { model: { provider: choice.provider, id: choice.modelId } }
          : {}),
        ...(choice.effort ? { effort: choice.effort } : {}),
      },
      sessionPath,
    );
  }, [sessionKey, sessionPath, choice]);

  const modelValue = choice.modelId ? `${choice.provider}/${choice.modelId}` : "";

  return (
    <div className="route-setup">
      <div className="route-setup__bar">
        <strong>Prosecutor</strong>
        {status ? (
          <span className="route-setup__hint">
            round {caseState?.round ?? 0} ·{" "}
            <span
              className={`route-setup__status is-${status}`}
              role="status"
            >
              {STATUS_LABEL[status]}
            </span>
          </span>
        ) : (
          <span className="route-setup__hint">
            accepted only when the prosecutor can't write a failing test and
            the server's gate passes
          </span>
        )}
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
                  effort: choice.effort,
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
          <label className="route-setup__select">
            <select
              aria-label="Prosecutor effort"
              value={choice.effort ?? ""}
              onChange={(event) =>
                setChoice({
                  ...choice,
                  effort: (event.target.value || undefined) as ProsecutorEffort | undefined,
                })
              }
            >
              <option value="">auto effort</option>
              {EFFORT_CHOICES.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <em>writes failing tests</em>
        </li>
        <li className="route-setup__row">
          <span className="route-setup__kind is-review">verify</span>
          <span className="route-setup__gate-cmds">
            {config?.commands.length
              ? config.commands.map((command) => command.run).join(" · ")
              : "no acceptance gate — acquittals stay unverified"}
          </span>
          {cwd && !gateDraft && (
            <button type="button" className="route-setup__link" onClick={editGate}>
              edit
            </button>
          )}
          <em>server runs it</em>
        </li>
      </ul>
      {gateDraft && (
        <div className="route-setup__gate-edit">
          <label>
            Gate commands, one per line, run by the server in {cwd}. Use{" "}
            <code>{"{file}"}</code> to run once per prosecutor test file.
            <textarea
              rows={3}
              value={gateDraft.commands}
              placeholder={"npm test\nnpm run typecheck"}
              onChange={(event) => setGateDraft({ ...gateDraft, commands: event.target.value })}
            />
          </label>
          <label>
            Prosecutor test files (globs, one per line) — it may edit nothing else.
            <textarea
              rows={3}
              value={gateDraft.patterns}
              onChange={(event) => setGateDraft({ ...gateDraft, patterns: event.target.value })}
            />
          </label>
          <label className="route-setup__gate-timeout">
            Timeout per command (s)
            <input
              type="number"
              min={1}
              max={3600}
              value={gateDraft.timeout}
              onChange={(event) => setGateDraft({ ...gateDraft, timeout: event.target.value })}
            />
          </label>
          <div className="route-setup__gate-actions">
            <button type="button" onClick={() => setGateDraft(null)}>
              Cancel
            </button>
            <button type="button" onClick={() => void saveGate()}>
              Save gate
            </button>
          </div>
        </div>
      )}
      {findings.length > 0 && (
        <ul className="route-setup__findings">
          {findings.map((finding) => (
            <li key={finding.id}>
              <strong>{finding.id}</strong> <code>{finding.test ?? "?"}</code>
              {finding.requirement && <span> — “{finding.requirement}”</span>}
              {finding.objection && <em> · objection: {finding.objection}</em>}
            </li>
          ))}
        </ul>
      )}
      {gate?.results && gate.state !== "not_configured" && (
        <details className="route-setup__gate">
          <summary>
            Gate (round {gate.round}):{" "}
            {gate.state === "verified"
              ? `${gate.results.length}/${gate.results.length} passed`
              : `${gate.results.filter((result) => !result.ok).length} of ${gate.results.length} failed`}
          </summary>
          {gate.results.map((result, index) => (
            <div key={index} className={result.ok ? "is-pass" : "is-fail"}>
              <code>
                {result.ok ? "pass" : result.timedOut ? "timed out" : `exit ${result.exitCode}`} ·{" "}
                {(result.ms / 1000).toFixed(1)}s · {result.command}
              </code>
              {!result.ok && <pre>{result.output}</pre>}
            </div>
          ))}
        </details>
      )}
      {caseState?.interrupted ? (
        <div className="route-setup__paused" role="alert">
          {caseState.changes?.trim() ? (
            <pre className="route-setup__changes">{caseState.changes}</pre>
          ) : null}
          <span>
            This review was interrupted
            {paused?.round ? ` during round ${paused.round}` : ""}. Resume sends a fresh brief
            from the saved rounds
            {caseState.changes?.trim() ? " and the files above" : ""}. The workspace is left
            as it is.
            {paused?.reason && paused.reason !== "server restarted"
              ? ` Last pause: ${paused.reason}.`
              : ""}
          </span>
          <button type="button" onClick={() => void resume()}>
            Resume review
          </button>
          {resumeError && <em>{resumeError}</em>}
        </div>
      ) : paused ? (
        <div className="route-setup__paused" role="alert">
          <span>
            Case paused at round {paused.round || 1}: the {paused.side} failed (
            {paused.reason}). Switch the {paused.side}
            {paused.side === "executor" ? " in the model picker" : " above"} if you like, then
            resume — the case continues where it stopped.
          </span>
          <button type="button" onClick={() => void resume()}>
            Resume case
          </button>
          {resumeError && <em>{resumeError}</em>}
        </div>
      ) : null}
      {showNudge && (
        <div className="prosecutor-nudge" role="status">
          <span>
            Round 1 found bugs. Fix-up rounds rarely need {effortLabel(effort)} — lower the
            builder's effort?
          </span>
          <select
            aria-label="Builder effort for later rounds"
            value={nudgeLevel || nudge.preset}
            onChange={(event) => setNudgeLevel(event.target.value)}
          >
            {nudge.choices.map((level) => (
              <option key={level} value={level}>
                {effortLabel(level)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="prosecutor-nudge__apply"
            onClick={() => {
              onEffort(nudgeLevel || nudge.preset);
              closeNudge();
            }}
          >
            Apply
          </button>
          <button type="button" className="prosecutor-nudge__later" onClick={closeNudge}>
            Not now
          </button>
          <button
            type="button"
            className="ask-card__icon-btn"
            aria-label="Dismiss"
            onClick={closeNudge}
          >
            <IconClose />
          </button>
        </div>
      )}
    </div>
  );
}
