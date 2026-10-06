import type { ProsecutorState } from "./api.ts";
import { effortRank } from "./effortStops.ts";

/** The executor's first turn of a task builds most of the bugs: it runs at least here. */
export const ROUND_ONE_FLOOR = "high";
/** What the nudge suggests for the fix-up rounds after the first guilty verdict. */
export const LATER_ROUND_SUGGESTION = "medium";

/**
 * The lowest effort the executor may run at, or null for no floor. Only in
 * prosecutor mode, and only until round 1's verdict is in: a task with no
 * verdict yet (or no open task -- the next message starts one) is round 1.
 */
export function effortFloor(mode: string, state: ProsecutorState | null): string | null {
  if (mode !== "prosecutor") return null;
  return state?.open && state.verdict ? null : ROUND_ONE_FLOOR;
}

export const belowFloor = (level: string, floor: string | null) =>
  Boolean(floor) && effortRank(level) < effortRank(floor!);

/** The level to lift `effort` to so it meets the floor; null when it already does or the model has none. */
export function liftedEffort(levels: string[], effort: string, floor: string | null): string | null {
  if (!floor || !effort || !belowFloor(effort, floor)) return null;
  const ok = levels.filter((level) => !belowFloor(level, floor) && effortRank(level) < 99);
  return ok.sort((a, b) => effortRank(a) - effortRank(b))[0] ?? null;
}

/**
 * Suggest lowering the builder's effort once per task, after the first guilty
 * verdict, whatever the current level. `handledCase` is the case the user
 * already answered (applied or dismissed). `effort` stays in the signature so
 * callers needn't change; the panel hides the bar when nothing is lower.
 */
export function showLowerNudge(
  mode: string,
  state: ProsecutorState | null,
  handledCase: number | null,
  effort: string,
): boolean {
  return (
    mode === "prosecutor" &&
    Boolean(state?.open) &&
    state?.verdict === "guilty" &&
    state.caseId !== handledCase &&
    Boolean(effort)
  );
}

/** The nudge's choices: the model's levels below the current one; medium preselected when offered. */
export function nudgeChoices(levels: string[], effort: string) {
  const choices = levels.filter((level) => effortRank(level) < effortRank(effort));
  const preset = choices.includes(LATER_ROUND_SUGGESTION) ? LATER_ROUND_SUGGESTION : choices.at(-1) ?? "";
  return { choices, preset };
}
