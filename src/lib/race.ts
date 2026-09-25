/**
 * Race (battle) state: one task fanned out to several backends, each in its
 * own git worktree. Records live in localStorage next to the board — a race
 * is a per-person view over ordinary sessions, not server state.
 */

import type { AgentBackend, GitChange } from "./api";
import type { TimelineItem } from "./timeline";

/** The scoreboard row: what is ticking per candidate while the race runs. */
export interface CandidateMetrics {
  /** Session tokens when the backend reports them, else a context estimate. */
  tokens: number | null;
  tokensEstimated?: boolean;
  filesChanged: number;
  additions: number;
  deletions: number;
  /** Test commands the candidate ran that have finished. */
  testRuns: number;
  testsPassed: number | null;
  testsFailed: number | null;
}

export interface RaceCandidate {
  backend: AgentBackend;
  /** Conversation tab key; the session IS the candidate. */
  key: string;
  worktreePath: string;
  branch: string;
  /** Picked model's label; set when same-backend twins need telling apart. */
  model?: string;
  /** Snapshot recorded once the race settles; null when it never produced one. */
  final?: CandidateMetrics | null;
}

export interface RaceRecord {
  id: string;
  task: string;
  cwd: string;
  createdAt: number;
  finishedAt?: number;
  candidates: RaceCandidate[];
  /** Contenders whose worktree failed at start (they never raced). */
  benched?: string[];
  /** Set once the race's worktrees were removed from the history row. */
  cleanedAt?: number;
}

const STORAGE_KEY = "pi-web:races";
const MAX_RACES = 20;

/** Races are rebuilt from ordinary sessions, so a corrupt entry is droppable. */
function isRace(value: unknown): value is RaceRecord {
  if (!value || typeof value !== "object") return false;
  const race = value as Record<string, unknown>;
  return (
    typeof race.id === "string" &&
    typeof race.task === "string" &&
    Array.isArray(race.candidates)
  );
}

export function loadRaces(): RaceRecord[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(isRace) : [];
  } catch {
    return [];
  }
}

/** Newest first. Returns the capped list so callers can adopt it as state. */
export function saveRaces(races: RaceRecord[]): RaceRecord[] {
  const next = races.slice(0, MAX_RACES);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn("race: could not persist", error);
  }
  return next;
}

/** Worktree/branch name for one candidate: a few sturdy words of the task. */
export function raceSlug(task: string): string {
  const words = task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
  return (words.slice(0, 4).join("-") || "race").slice(0, 40);
}

// A test *run*, not a file path that mentions tests: a runner invoked
// directly, or a package-manager/go/cargo/make test invocation. `cat
// foo.test.ts` must not count.
// ponytail: not every runner shape ("yarn jest" slips through). Widen the
// alternation when a real candidate's command misses.
const TEST_COMMAND =
  /^\s*(?:npx\s+)?(?:vitest|jest|pytest)\b|(?:^|\s)(?:npm|pnpm|yarn|bun|deno)\s+(?:\S+\s+)*test\b|(?:^|\s)(?:go|cargo|make)\s+test\b/i;

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

function lastCount(text: string, pattern: RegExp): number | null {
  let last: number | null = null;
  for (const match of text.matchAll(pattern)) last = Number(match[1]);
  return last;
}

/**
 * Passed/failed counts from a test runner's summary lines. jest, vitest and
 * pytest all print "N passed" / "N failed"; the last mention wins because the
 * summary comes at the end. null when the output has neither.
 *
 * ponytail: string scraping, not a per-runner parser. Add a runner's exact
 * format here only when its summary genuinely lacks "N passed".
 */
export function parseTestCounts(
  output: string,
): { passed: number; failed: number } | null {
  const passed = lastCount(output, /(\d+)\s+passed/g);
  const failed = lastCount(output, /(\d+)\s+failed/g);
  if (passed === null && failed === null) return null;
  return { passed: passed ?? 0, failed: failed ?? 0 };
}

/** Command text of a shell-ish tool call, across the four adapters. */
function commandOf(item: Extract<TimelineItem, { kind: "tool" }>): string {
  const command = item.args?.command ?? item.args?.cmd;
  return typeof command === "string" ? command : "";
}

const RUN_TOOL = /bash|shell|exec|terminal/i;

/** Reads a candidate's transcript for test runs and their results. */
export function candidateTests(items: TimelineItem[]): {
  testRuns: number;
  testsPassed: number | null;
  testsFailed: number | null;
} {
  let testRuns = 0;
  let testsPassed: number | null = null;
  let testsFailed: number | null = null;
  for (const item of items) {
    if (item.kind === "terminal") {
      if (!isTestCommand(item.command) || item.status === "running") continue;
      testRuns += 1;
      const counts = parseTestCounts(item.output);
      if (counts) {
        testsPassed = counts.passed;
        testsFailed = counts.failed;
      }
      continue;
    }
    if (item.kind !== "tool" || item.status === "running") continue;
    if (!RUN_TOOL.test(item.name) && commandOf(item) === "") continue;
    const command =
      commandOf(item) || (item.execKind === "execute" ? item.output : "");
    if (!isTestCommand(command)) continue;
    testRuns += 1;
    const counts = parseTestCounts(item.output);
    if (counts) {
      testsPassed = counts.passed;
      testsFailed = counts.failed;
    }
  }
  return { testRuns, testsPassed, testsFailed };
}

/** Edit stats from the candidate worktree's change list. */
export function sumChanges(changes: GitChange[]): {
  filesChanged: number;
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const change of changes) {
    additions += change.additions || 0;
    deletions += change.deletions || 0;
  }
  return { filesChanged: changes.length, additions, deletions };
}
