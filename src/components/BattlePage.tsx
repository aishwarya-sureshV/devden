import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconArrowUp, IconFolder, IconPlus } from "./icons";
import {
  AGENT_BACKENDS,
  api,
  backendLabel,
  backendMark,
  type AgentBackend,
  type ModelInfo,
} from "../lib/api";
import {
  candidateTests,
  loadRaces,
  raceSlug,
  saveRaces,
  sumChanges,
  type CandidateMetrics,
  type RaceRecord,
} from "../lib/race";
import { useStore, type Attachment, type ConversationTab } from "../lib/store";
import { compactTokens, estimateContext } from "../lib/sessionMetrics";
import { sessionPaneLayout } from "../lib/sessionLayout";
import { formatRelativeTime } from "../lib/time";
import { Conversation, fileAsBase64 } from "./Conversation";

/** One contender slot: the same backend can appear twice, models independent. */
interface Slot {
  id: string;
  backend: AgentBackend;
  on: boolean;
  model?: ModelInfo;
  thinkingLevel?: string;
}

/**
 * Battle mode: one task fanned out to several backends, each in its own git
 * worktree, live side by side with a ticking scoreboard. The race itself is
 * thin — candidates are ordinary sessions pointed at worktrees (the board's
 * dispatch, times N), so the store's timelines, streams and approvals all
 * work unmodified inside the columns.
 */
export function BattlePage({
  showThinking,
  onFocusSession,
}: {
  showThinking: boolean;
  onFocusSession: (key: string) => void;
}) {
  const {
    tabs,
    workingKeys,
    awaitingKeys,
    active,
    openConversation,
    seedTask,
    closeConversation,
    backendCatalog,
  } = useStore();
  const backendIds = backendCatalog.length
    ? backendCatalog.map((item) => item.id)
    : [...AGENT_BACKENDS];
  const [races, setRaces] = useState<RaceRecord[]>(() => loadRaces());
  const [task, setTask] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelLists, setModelLists] = useState<
    Partial<Record<AgentBackend, ModelInfo[]>>
  >({});
  const [effortLists, setEffortLists] = useState<
    Partial<Record<AgentBackend, string[]>>
  >({});
  /** Contender slots; a backend can appear more than once, each with its own
   *  model/effort pick — that is the point of same-backend matchups. */
  const [slots, setSlots] = useState<Slot[]>(() =>
    AGENT_BACKENDS.map((backend) => ({
      id: crypto.randomUUID(),
      backend,
      on: true,
    })),
  );
  useEffect(() => {
    setSlots((current) => {
      const have = new Set(current.map((slot) => slot.backend));
      const extra = backendIds
        .filter((backend) => !have.has(backend))
        .map((backend) => ({
          id: crypto.randomUUID(),
          backend,
          on: true,
        }));
      return extra.length ? [...current, ...extra] : current;
    });
  }, [backendIds.join("\0")]);
  const updateSlot = (id: string, next: Partial<Slot>) =>
    setSlots((current) =>
      current.map((slot) => (slot.id === id ? { ...slot, ...next } : slot)),
    );
  /** A twin slots in right below its sibling, not at the list's end. */
  const addSlot = (backend: AgentBackend) =>
    setSlots((current) => {
      const at = current.map((slot) => slot.backend).lastIndexOf(backend) + 1;
      return [
        ...current.slice(0, at),
        { id: crypto.randomUUID(), backend, on: true },
        ...current.slice(at),
      ];
    });
  const removeSlot = (id: string) =>
    setSlots((current) => current.filter((slot) => slot.id !== id));
  const setAllSlots = (on: boolean) =>
    setSlots((current) => current.map((slot) => ({ ...slot, on })));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** Race prompt attachments. One upload feeds every candidate: the file
   *  lands in the shared temp dir and each seeded prompt references its path. */
  const uploadFiles = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      if (file.size > 20 * 1024 * 1024) {
        setError(`${file.name} is larger than the 20 MB upload limit.`);
        continue;
      }
      try {
        const data = await fileAsBase64(file);
        const result = await api.upload(
          "race",
          file.name,
          file.type || "application/octet-stream",
          data,
        );
        if (!result.ok || !result.path) {
          setError(result.error ?? `Could not upload ${file.name}`);
          continue;
        }
        setAttachments((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            path: result.path!,
            ...(file.type.startsWith("image/") ? { imageData: data } : {}),
          },
        ]);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : `Could not upload ${file.name}`,
        );
      }
    }
  };
  /** Worktree root override for the next race; null = active session's repo. */
  const [cwdOverride, setCwdOverride] = useState<string | null>(null);
  const raceCwd = cwdOverride ?? active?.cwd ?? tabs[0]?.cwd;
  /** Native macOS folder dialog — the server's osascript is the only way to
   *  hand a web page an absolute path. */
  const pickRoot = async () => {
    const result = await api.pickDirectory("Choose the worktree root");
    if (result.ok && result.path) setCwdOverride(result.path);
    else if (result.error) setError(result.error);
  };

  const listKey = active?.key ?? tabs[0]?.key ?? "race";
  const loadList = (backend: AgentBackend) => {
    if (!modelLists[backend])
      void api.models(listKey, backend).then((result) => {
        if (result.ok)
          setModelLists((current) => ({
            ...current,
            [backend]: result.models ?? [],
          }));
      });
    if (!effortLists[backend])
      void api.thinkingLevels(listKey, backend).then((result) => {
        if (result.ok)
          setEffortLists((current) => ({
            ...current,
            [backend]: result.levels ?? [],
          }));
      });
  };
  useEffect(() => {
    for (const backend of AGENT_BACKENDS) loadList(backend);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeRace = useMemo(
    () => races.find((race) => !race.finishedAt) ?? null,
    [races],
  );

  const candidateTabs = useMemo(() => {
    const map = new Map<string, ConversationTab | undefined>();
    for (const candidate of activeRace?.candidates ?? [])
      map.set(
        candidate.key,
        tabs.find((tab) => tab.key === candidate.key),
      );
    return map;
  }, [activeRace, tabs]);
  const candidateTabsRef = useRef(candidateTabs);
  candidateTabsRef.current = candidateTabs;

  /** Scoreboard snapshot per candidate key; ref so the finisher reads latest. */
  const [live, setLive] = useState<Record<string, CandidateMetrics>>({});
  const metricsRef = useRef<Record<string, CandidateMetrics>>({});
  metricsRef.current = live;

  const raceKeys = (activeRace?.candidates ?? [])
    .map((candidate) => candidate.key)
    .join(",");

  /**
   * One scoreboard tick. Merges into the last snapshot instead of replacing
   * it, so a closed tab keeps its final numbers; diffs against the
   * worktree's base commit (base=1) so committed work still counts.
   */
  const pollRace = useCallback(async (race: RaceRecord) => {
    const snapshot: Record<string, CandidateMetrics> = {};
    for (const candidate of race.candidates) {
      const tab = candidateTabsRef.current.get(candidate.key);
      if (!tab) continue; // tab closed: the merge keeps its last snapshot
      const [changes, usage] = await Promise.all([
        api
          .gitChanges(candidate.key, candidate.worktreePath, true)
          .catch(() => null),
        api.usage(candidate.key, candidate.backend).catch(() => null),
      ]);
      const items = tab.timeline.items;
      const tokens = usage?.usage?.tokens?.total ?? null;
      const context =
        tokens === null ? estimateContext(items, tab.timeline.state) : null;
      snapshot[candidate.key] = {
        tokens: tokens ?? context?.estimatedTokens ?? null,
        tokensEstimated: tokens === null,
        ...sumChanges(changes?.changes ?? []),
        ...candidateTests(items),
      };
    }
    if (Object.keys(snapshot).length > 0) {
      metricsRef.current = { ...metricsRef.current, ...snapshot };
      setLive(metricsRef.current);
    }
  }, []);

  useEffect(() => {
    if (!activeRace) return;
    void pollRace(activeRace);
    const id = setInterval(() => void pollRace(activeRace), 5_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRace?.id, raceKeys]);

  /** A candidate is done when it stopped after real activity (or its tab is
   *  gone). Waiting-on-you does not count — the user answers in the column.
   *  A contender whose process died before writing anything to the timeline
   *  never settles on its own; past a start-up grace a silent tab is done. */
  const allSettled = Boolean(
    activeRace &&
      activeRace.candidates.every((candidate) => {
        const tab = candidateTabs.get(candidate.key);
        if (!tab) return true;
        if (workingKeys.has(candidate.key) || awaitingKeys.has(candidate.key))
          return false;
        return (
          tab.timeline.items.some(
            (item) =>
              item.kind === "assistant" ||
              item.kind === "tool" ||
              item.kind === "notice",
          ) || Date.now() - activeRace.createdAt > 120_000
        );
      }),
  );

  const finishedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeRace || !allSettled || finishedRef.current === activeRace.id)
      return;
    finishedRef.current = activeRace.id;
    void (async () => {
      // One last tick, so the final turn's edits/tests make the snapshot.
      await pollRace(activeRace);
      setRaces((current) => {
        // A race resurrected from localStorage belongs to a dead page — tab
        // keys are page-scoped, so its columns can never come back. Drop the
        // record instead of finishing it into a null-metrics history row.
        const anyTab = activeRace.candidates.some((candidate) =>
          candidateTabsRef.current.get(candidate.key),
        );
        if (!anyTab)
          return saveRaces(current.filter((race) => race.id !== activeRace.id));
        const next = current.map((race) =>
          race.id === activeRace.id
            ? {
                ...race,
                finishedAt: Date.now(),
                candidates: race.candidates.map((candidate) => ({
                  ...candidate,
                  final: metricsRef.current[candidate.key] ?? null,
                })),
              }
            : race,
        );
        return saveRaces(next);
      });
    })();
  }, [allSettled, activeRace, pollRace]);

  const startRace = async () => {
    const clean = task.trim();
    const cwd = raceCwd;
    const racers = slots.filter((slot) => slot.on);
    if (!clean || racers.length === 0 || !cwd || starting) return;
    setStarting(true);
    setError(null);
    try {
      const slug = raceSlug(clean);
      const record: RaceRecord = {
        id: crypto.randomUUID(),
        task: clean,
        cwd,
        createdAt: Date.now(),
        candidates: [],
      };
      const failures: string[] = [];
      for (const slot of racers) {
        const backend = slot.backend;
        const made = await api.createWorktree(
          "race",
          cwd,
          `${slug}-${backend}`,
        );
        if (!made.ok || !made.data) {
          failures.push(backendLabel(backend));
          continue;
        }
        // Same-backend twins get their model in the label; two columns or
        // sidebar rows named just "Pi" would be indistinguishable.
        const twins =
          racers.filter((racer) => racer.backend === backend).length > 1;
        const modelLabel = twins
          ? slot.model?.name || slot.model?.id || "default"
          : null;
        const key = openConversation(
          made.data.path,
          `${backendLabel(backend)}${modelLabel ? ` · ${modelLabel}` : ""} · ${clean.split("\n", 1)[0].slice(0, 50)}`,
          backend,
          {
            activate: false,
            model: slot.model,
            thinkingLevel: slot.thinkingLevel,
          },
        );
        record.candidates.push({
          backend,
          key,
          worktreePath: made.data.path,
          branch: made.data.branch,
          ...(modelLabel ? { model: modelLabel } : {}),
        });
        seedTask(key, { prompt: clean, attachments });
      }
      if (record.candidates.length === 0) {
        setError(
          `No worktrees could be created (${failures.join(", ")}). Is ${cwd} a git repo?`,
        );
        return;
      }
      // Contenders whose worktree never materialized are benched, not hidden.
      if (failures.length > 0) record.benched = failures;
      setAttachments([]);
      setLive({});
      metricsRef.current = {};
      setRaces((current) => saveRaces([record, ...current]));
    } finally {
      setStarting(false);
    }
  };

  const stopRace = async () => {
    if (!activeRace) return;
    for (const candidate of activeRace.candidates)
      await api.abort(candidate.key).catch(() => {});
  };

  /** Remove a finished race's worktrees. `branch -d` inside removeWorktree
   *  keeps unmerged branches, so a losing contender stays recoverable; only
   *  uncommitted work in those worktrees is discarded. */
  const cleanupRace = async (race: RaceRecord) => {
    for (const candidate of race.candidates)
      await api
        .removeWorktree(race.id, race.cwd, candidate.worktreePath, true)
        .catch(() => {});
    setRaces((current) =>
      saveRaces(
        current.map((entry) =>
          entry.id === race.id ? { ...entry, cleanedAt: Date.now() } : entry,
        ),
      ),
    );
  };

  const layout = sessionPaneLayout(activeRace?.candidates.length ?? 1);

  return (
    <div className="resource-page battle-page">
      {activeRace ? (
        <div className="battle-board">
          <header className="battle-board__head">
            <div className="battle-board__task">
              <h1>{activeRace.task.split("\n", 1)[0]}</h1>
              <p>
                {activeRace.candidates.length} contenders racing in isolated
                worktrees of{" "}
                <code>{activeRace.cwd.split("/").filter(Boolean).at(-1)}</code>
              </p>
              {activeRace.benched && activeRace.benched.length > 0 && (
                <p className="battle-board__benched">
                  benched at start: {activeRace.benched.join(", ")}
                </p>
              )}
            </div>
            <button
              type="button"
              className="battle-stop"
              onClick={() => void stopRace()}
            >
              Stop race
            </button>
          </header>
          <div
            className="battle-grid"
            data-density={layout.density}
            style={{
              gridTemplateColumns: `repeat(${activeRace.candidates.length}, minmax(360px, 1fr))`,
            }}
          >
            {activeRace.candidates.map((candidate) => (
              <BattleColumn
                key={candidate.key}
                candidate={candidate}
                tab={candidateTabs.get(candidate.key)}
                metrics={live[candidate.key]}
                working={workingKeys.has(candidate.key)}
                awaiting={awaitingKeys.has(candidate.key)}
                settled={allSettled}
                density={layout.density}
                showThinking={showThinking}
                onFocus={() => onFocusSession(candidate.key)}
                onClose={() => closeConversation(candidate.key)}
              />
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="resource-page__content">
            <BattleSetup
              task={task}
              slots={slots}
              starting={starting}
              error={error}
              modelLists={modelLists}
              effortLists={effortLists}
              cwd={raceCwd}
              attachments={attachments}
              onPickRoot={() => void pickRoot()}
              onUploadFiles={uploadFiles}
              onRemoveAttachment={(id) =>
                setAttachments((current) =>
                  current.filter((attachment) => attachment.id !== id),
                )
              }
              onTask={setTask}
              onStart={() => void startRace()}
              onToggleSlot={(id) =>
                updateSlot(id, {
                  on: !slots.find((slot) => slot.id === id)?.on,
                })
              }
              onPickSlot={(id, next) => updateSlot(id, next)}
              onAddSlot={addSlot}
              onRemoveSlot={removeSlot}
              onSetAll={setAllSlots}
              onLoadList={loadList}
            />

            <BattleHistory
              races={races}
              onFocusSession={onFocusSession}
              onCleanup={(race) => void cleanupRace(race)}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** Setup screen per the Battle Setup design: header, prompt card, contender rows. */
function BattleSetup({
  task,
  slots,
  starting,
  error,
  modelLists,
  effortLists,
  cwd,
  attachments,
  onPickRoot,
  onUploadFiles,
  onRemoveAttachment,
  onTask,
  onStart,
  onToggleSlot,
  onPickSlot,
  onAddSlot,
  onRemoveSlot,
  onSetAll,
  onLoadList,
}: {
  task: string;
  slots: Slot[];
  starting: boolean;
  error: string | null;
  modelLists: Partial<Record<AgentBackend, ModelInfo[]>>;
  effortLists: Partial<Record<AgentBackend, string[]>>;
  cwd: string | undefined;
  attachments: Attachment[];
  onPickRoot: () => void;
  onUploadFiles: (files: FileList | File[] | null) => Promise<void>;
  onRemoveAttachment: (id: string) => void;
  onTask: (value: string) => void;
  onStart: () => void;
  onToggleSlot: (id: string) => void;
  onPickSlot: (
    id: string,
    next: { model?: ModelInfo; thinkingLevel?: string },
  ) => void;
  onAddSlot: (backend: AgentBackend) => void;
  onRemoveSlot: (id: string) => void;
  onSetAll: (on: boolean) => void;
  onLoadList: (backend: AgentBackend) => void;
}) {
  const onCount = slots.filter((slot) => slot.on).length;
  const ready = task.trim().length > 0 && onCount > 0 && Boolean(cwd);
  const allIn = slots.length > 0 && slots.every((slot) => slot.on);
  /* Same grow as the session composer: 45px floor, 196px ceiling. */
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoGrow = () => {
    const el = taskRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 45), 196)}px`;
  };
  return (
    <div className="battle-setup">
      <header className="battle-setup__head">
        <div className="battle-setup__intro">
          <div className="battle-setup__eyebrow">
            <span className="battle-setup__pulse" aria-hidden />
            battle
          </div>
          <h1>One task, every backend.</h1>
          <p>
            Each contender runs in its own isolated worktree. The scoreboard
            ticks while they race.
          </p>
        </div>
        <div className="battle-setup__root">
          <span>worktree root</span>
          <button
            type="button"
            className="battle-setup__root-chip"
            disabled={starting}
            title={
              cwd ? `${cwd} — click to change` : "Choose the worktree root"
            }
            onClick={onPickRoot}
          >
            <IconFolder size={12} />
            <span>
              {cwd
                ? (cwd.split("/").filter(Boolean).at(-1) ?? cwd)
                : "choose folder"}
            </span>
          </button>
        </div>
      </header>

      <form
        className="composer__card"
        onSubmit={(event) => {
          event.preventDefault();
          onStart();
        }}
      >
        <input
          ref={fileInputRef}
          className="composer__file-input"
          type="file"
          multiple
          onChange={(event) => {
            void onUploadFiles(event.target.files);
            event.target.value = "";
          }}
        />
        {attachments.length > 0 && (
          <div className="composer__attachments" aria-label="Attached files">
            {attachments.map((attachment) => (
              <span
                className="attachment-chip"
                key={attachment.id}
                title={attachment.path}
              >
                <span>{attachment.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => onRemoveAttachment(attachment.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer__scroll">
          <textarea
            ref={taskRef}
            className="composer__textarea"
            rows={2}
            placeholder="Describe the task for every backend to race on…"
            value={task}
            onChange={(event) => {
              onTask(event.target.value);
              autoGrow();
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                onStart();
              }
            }}
          />
        </div>
        <div className="composer__row">
          <div className="composer__tools">
            <button
              type="button"
              className="composer__add"
              aria-label="Attach files"
              title="Attach files (20 MB max) — sent to every contender"
              onClick={() => fileInputRef.current?.click()}
            >
              <IconPlus />
            </button>
          </div>
          <div className="composer__trailing">
            <span className="battle-setup__count">
              {onCount === 0
                ? "no contenders selected"
                : `${onCount} of ${slots.length} racing`}
            </span>
            <button
              type="submit"
              className="composer__primary"
              aria-label="Start race"
              title={
                cwd
                  ? "Start race (⌘⏎)"
                  : "Open a session in the repo you want to race in first."
              }
              disabled={!ready || starting}
            >
              <IconArrowUp />
            </button>
          </div>
        </div>
      </form>

      <div className="battle-setup__divider">
        <span>contenders</span>
        <span className="battle-setup__rule" aria-hidden />
        <button
          type="button"
          className="battle-setup__all"
          onClick={() => onSetAll(!allIn)}
        >
          {allIn ? "bench all" : "race all"}
        </button>
      </div>

      <div className="battle-setup__rows">
        {slots.map((slot) => {
          const twins = slots.filter((item) => item.backend === slot.backend);
          const instance = twins.findIndex((item) => item.id === slot.id) + 1;
          return (
            <ContenderRow
              key={slot.id}
              backend={slot.backend}
              included={slot.on}
              instance={instance}
              multi={twins.length > 1}
              models={modelLists[slot.backend] ?? []}
              efforts={effortLists[slot.backend] ?? []}
              pick={slot}
              onToggle={() => onToggleSlot(slot.id)}
              onLoad={() => onLoadList(slot.backend)}
              onPick={(next) => onPickSlot(slot.id, next)}
              onAdd={() => onAddSlot(slot.backend)}
              onRemove={() => onRemoveSlot(slot.id)}
            />
          );
        })}
      </div>

      <p className="battle-setup__foot">
        Each contender gets a fresh worktree branched from HEAD. Nothing is
        merged until you pick a winner.
      </p>
      {error && <p className="battle-setup__error">{error}</p>}
    </div>
  );
}

/** One contender row: include checkbox, name, model and effort pickers,
 *  plus add/remove for same-backend twins. */
function ContenderRow({
  backend,
  included,
  instance,
  multi,
  models,
  efforts,
  pick,
  onToggle,
  onLoad,
  onPick,
  onAdd,
  onRemove,
}: {
  backend: AgentBackend;
  included: boolean;
  /** 1-based position among this backend's slots; disambiguates twins. */
  instance: number;
  multi: boolean;
  models: ModelInfo[];
  efforts: string[];
  pick: { model?: ModelInfo; thinkingLevel?: string };
  onToggle: () => void;
  onLoad: () => void;
  onPick: (next: { model?: ModelInfo; thinkingLevel?: string }) => void;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const mark = backendMark(backend);
  const name = multi
    ? `${backendLabel(backend)} ${instance}`
    : backendLabel(backend);
  const rowRef = useRef<HTMLDivElement | null>(null);
  // A freshly added twin can land below the list's scroll cap; keep it in view.
  useEffect(() => {
    if (instance > 1) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [instance]);
  const modelValue = pick.model
    ? `${pick.model.provider}/${pick.model.id}`
    : "";
  return (
    <div ref={rowRef} className={`battle-row${included ? "" : " is-off"}`}>
      <button
        type="button"
        role="checkbox"
        aria-checked={included}
        aria-label={`Include ${name}`}
        className="battle-row__box"
        style={
          included
            ? { background: mark.color, borderColor: mark.color }
            : undefined
        }
        onClick={onToggle}
      >
        {included ? "✓" : ""}
      </button>
      <span className="battle-row__id">
        <span
          className="battle-row__glyph"
          style={{ color: mark.color }}
          aria-hidden
        >
          {mark.glyph}
        </span>
        <strong className="battle-row__name">{name}</strong>
      </span>
      <select
        aria-label={`Model for ${name}`}
        value={modelValue}
        onFocus={onLoad}
        onChange={(event) => {
          const option = models.find(
            (item) => `${item.provider}/${item.id}` === event.target.value,
          );
          onPick({ model: option });
        }}
      >
        <option value="">default model</option>
        {models.map((item) => (
          <option
            key={`${item.provider}/${item.id}`}
            value={`${item.provider}/${item.id}`}
          >
            {item.name || item.id}
          </option>
        ))}
      </select>
      <select
        aria-label={`Effort for ${name}`}
        value={pick.thinkingLevel ?? ""}
        onChange={(event) =>
          onPick({ thinkingLevel: event.target.value || undefined })
        }
      >
        <option value="">default effort</option>
        {efforts.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
      <span className="battle-row__actions">
        <button
          type="button"
          className="battle-row__act"
          aria-label={`Add another ${backendLabel(backend)} contender`}
          title={`Race another ${backendLabel(backend)} with its own model pick`}
          onClick={onAdd}
        >
          +
        </button>
        {multi && (
          <button
            type="button"
            className="battle-row__act"
            aria-label={`Remove ${name} contender`}
            title="Remove this contender"
            onClick={onRemove}
          >
            ×
          </button>
        )}
      </span>
      <span className="battle-row__state">
        {included ? "ready" : "benched"}
      </span>
    </div>
  );
}

function BattleColumn({
  candidate,
  tab,
  metrics,
  working,
  awaiting,
  settled,
  density,
  showThinking,
  onFocus,
  onClose,
}: {
  candidate: import("../lib/race").RaceCandidate;
  tab: ConversationTab | undefined;
  metrics: CandidateMetrics | undefined;
  working: boolean;
  awaiting: boolean;
  settled: boolean;
  density: import("../lib/sessionLayout").PaneDensity;
  showThinking: boolean;
  onFocus: () => void;
  onClose: () => void;
}) {
  const mark = backendMark(candidate.backend);
  /* Model label from live state, so same-backend twins are tellable apart. */
  const modelLabel =
    tab?.timeline.state?.model?.name ??
    tab?.timeline.state?.model?.id ??
    candidate.model ??
    null;
  const status = awaiting
    ? { label: "waiting on you", tone: "awaiting" }
    : working
      ? { label: "racing", tone: "working" }
      : settled
        ? { label: "done", tone: "done" }
        : { label: "starting", tone: "idle" };
  const tokens =
    metrics?.tokens == null
      ? "—"
      : `${metrics.tokensEstimated ? "~" : ""}${compactTokens(metrics.tokens)}`;
  const edits =
    metrics == null
      ? "—"
      : metrics.filesChanged === 0
        ? "0 files"
        : `${metrics.filesChanged}f +${metrics.additions}/−${metrics.deletions}`;
  const tests =
    metrics == null
      ? "—"
      : metrics.testsPassed == null
        ? metrics.testRuns > 0
          ? `${metrics.testRuns} run${metrics.testRuns === 1 ? "" : "s"}`
          : "no tests"
        : `${metrics.testsPassed}✓${
            metrics.testsFailed ? ` ${metrics.testsFailed}✗` : ""
          }`;

  if (!tab) {
    return (
      <div className="battle-col battle-col--closed">
        <div className="battle-col__head">
          <span style={{ color: mark.color }}>{mark.glyph}</span>
          <strong>{backendLabel(candidate.backend)}</strong>
        </div>
        <p>
          Session closed. Its branch <code>{candidate.branch}</code> and
          worktree still exist.
        </p>
      </div>
    );
  }

  return (
    <div className="battle-col">
      <div className="battle-col__head">
        <span className="battle-col__mark" style={{ color: mark.color }}>
          {mark.glyph}
        </span>
        <strong>{backendLabel(candidate.backend)}</strong>
        {modelLabel && (
          <span className="battle-col__model" title={modelLabel}>
            {modelLabel}
          </span>
        )}
        <span className={`battle-col__dot battle-col__dot--${status.tone}`} />
        <em>{status.label}</em>
        <button
          type="button"
          className="battle-col__focus"
          onClick={onFocus}
          title="Open this session full-size"
        >
          ⤢
        </button>
      </div>
      <div className="battle-col__score" title="tokens · edits · tests passed">
        <span>{tokens}</span>
        <span>{edits}</span>
        <span>{tests}</span>
      </div>
      <div className="battle-col__pane">
        <section className="session-pane">
          <Conversation
            tab={tab}
            showThinking={showThinking}
            split
            density={density}
            onClose={onClose}
          />
        </section>
      </div>
    </div>
  );
}

/** Finished races — the seed of a real-workload leaderboard. */
function BattleHistory({
  races,
  onFocusSession,
  onCleanup,
}: {
  races: RaceRecord[];
  onFocusSession: (key: string) => void;
  onCleanup: (race: RaceRecord) => void;
}) {
  const finished = races.filter((race) => race.finishedAt).slice(0, 10);
  if (finished.length === 0) return null;
  return (
    <section className="battle-history">
      <h2>Past races</h2>
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Repo</th>
            <th>When</th>
            <th>Results (tokens · edits · tests)</th>
          </tr>
        </thead>
        <tbody>
          {finished.map((race) => (
            <tr key={race.id}>
              <td className="battle-history__task">
                {race.task.split("\n", 1)[0].slice(0, 70)}
              </td>
              <td>
                <code>{race.cwd.split("/").filter(Boolean).at(-1)}</code>
              </td>
              <td>
                {race.finishedAt ? formatRelativeTime(race.finishedAt) : ""}
                <button
                  type="button"
                  className="battle-history__clean"
                  disabled={Boolean(race.cleanedAt)}
                  title="Remove this race's worktrees. Unmerged branches are kept; uncommitted work is discarded."
                  onClick={() => onCleanup(race)}
                >
                  {race.cleanedAt ? "cleaned" : "clean up"}
                </button>
              </td>
              <td>
                <div className="battle-history__results">
                  {race.candidates.map((candidate) => {
                    const mark = backendMark(candidate.backend);
                    const final = candidate.final;
                    return (
                      <button
                        type="button"
                        key={candidate.key}
                        className="battle-history__result"
                        style={{ borderColor: mark.color }}
                        onClick={() => onFocusSession(candidate.key)}
                        title={`${candidate.branch} — open the session`}
                      >
                        <span style={{ color: mark.color }}>
                          {backendLabel(candidate.backend)}
                          {candidate.model ? ` · ${candidate.model}` : ""}
                        </span>
                        {final
                          ? ` ${compactTokens(final.tokens ?? 0)} · ${final.filesChanged}f +${final.additions}/−${final.deletions} · ${
                              final.testsPassed == null
                                ? "—"
                                : `${final.testsPassed}✓${final.testsFailed ? ` ${final.testsFailed}✗` : ""}`
                            }`
                          : " no metrics"}
                      </button>
                    );
                  })}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
