/**
 * Reviewer eval set: 20 hand-labelled this-turn diffs.
 *
 *  5 clean    — findings must be empty (false-positive rate; the number that matters)
 *  5 bug      — Call A must report category bug on the labelled file
 *  5 masking  — Call A must report category masking on the labelled file
 *  5 partial  — Call B must mark the skipped requirement partial/not_satisfied
 *
 * Score catch and false positives separately, and per bucket. When a live
 * run is noisy, cluster misses/FPs by case id — do not rewrite the prompt
 * from an overall average.
 */
import {
  formatReviewHunks,
  integrityPrompt,
  mergeReviews,
  parseIntegrityReview,
  parseTaskReview,
  scanPrechecks,
  taskPrompt,
  type IntegrityReview,
  type MergedReview,
  type TaskReview,
} from "./turnReview.ts";

export type EvalBucket = "clean" | "bug" | "masking" | "partial";

export interface EvalCatch {
  /** Integrity category that must appear, or "task" for a Call B miss. */
  category: "bug" | "masking" | "side_effect" | "security" | "other" | "task";
  file: string;
  /** For bucket=partial: substring that must appear on a missing requirement. */
  requirement?: string;
}

export interface ReviewEvalCase {
  id: string;
  bucket: EvalBucket;
  title: string;
  /** Why this case exists — the labelled fault, or why it must stay empty. */
  why: string;
  userRequest: string;
  sourceDiff: string;
  testDiff: string;
  expect: {
    integrity: "pass" | "issues_found";
    catches: EvalCatch[];
  };
}

export interface CaseScore {
  id: string;
  bucket: EvalBucket;
  caught: boolean;
  falsePositive: boolean;
  softNoise: boolean;
  missed: EvalCatch[];
  extra: { category: string; file: string }[];
}

export interface BucketScore {
  n: number;
  caught: number;
  catchRate: number;
  falsePositives: number;
  falsePositiveRate: number;
  softNoise: number;
}

export interface EvalReport {
  buckets: Record<EvalBucket, BucketScore>;
  extraByCategory: Record<string, number>;
  cases: CaseScore[];
}

function diff(
  path: string,
  hunk: string,
): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    hunk.trim(),
    "",
  ].join("\n");
}

export const REVIEW_EVAL_CASES: ReviewEvalCase[] = [
  // --- clean: reviewer must return empty ---------------------------------
  {
    id: "clean-01",
    bucket: "clean",
    title: "Rename with callers and tests updated",
    why: "Pure rename. A style/naming flag here is a false positive.",
    userRequest: "Rename isBusy to hasOpenTools everywhere, same behaviour.",
    sourceDiff: diff(
      "src/settle.ts",
      `
@@ -1,8 +1,8 @@
-export function isBusy(open: number) {
+export function hasOpenTools(open: number) {
   return open > 0;
 }
 
-export function wait(isBusy: boolean) {
+export function wait(hasOpenTools: boolean) {
   return hasOpenTools ? "hold" : "send";
 }`,
    ),
    testDiff: diff(
      "src/settle.test.ts",
      `
@@ -1,6 +1,6 @@
-import { isBusy } from "./settle";
+import { hasOpenTools } from "./settle";
 
-test("busy", () => expect(isBusy(1)).toBe(true));
+test("busy", () => expect(hasOpenTools(1)).toBe(true));`,
    ),
    expect: { integrity: "pass", catches: [] },
  },
  {
    id: "clean-02",
    bucket: "clean",
    title: "Extract helper, behaviour unchanged",
    why: "Refactor only. Architecture opinions are out of scope.",
    userRequest: "Pull the path join into a helper. Do not change behaviour.",
    sourceDiff: diff(
      "src/paths.ts",
      `
@@ -1,7 +1,11 @@
+function joinRepo(root: string, rel: string) {
+  return root.replace(/\\/$/, "") + "/" + rel.replace(/^\\//, "");
+}
+
 export function toolPath(root: string, rel: string) {
-  return root.replace(/\\/$/, "") + "/" + rel.replace(/^\\//, "");
+  return joinRepo(root, rel);
 }`,
    ),
    testDiff: "",
    expect: { integrity: "pass", catches: [] },
  },
  {
    id: "clean-03",
    bucket: "clean",
    title: "Structured log on a real error path",
    why: "Logging the error then rethrowing is not swallowing.",
    userRequest: "Log parse failures with the session key, still throw.",
    sourceDiff: diff(
      "src/parse.ts",
      `
@@ -4,6 +4,8 @@
 export function readJson(raw: string, sessionKey: string) {
   try {
     return JSON.parse(raw);
   } catch (error) {
+    console.error("parse failed", { sessionKey, error });
     throw error;
   }
 }`,
    ),
    testDiff: "",
    expect: { integrity: "pass", catches: [] },
  },
  {
    id: "clean-04",
    bucket: "clean",
    title: "Off-by-one fixed and pinned",
    why: "The boundary is tested. Catching the old bug is a false positive.",
    userRequest: "Inclusive last index was dropping the final item. Fix it and pin with a test.",
    sourceDiff: diff(
      "src/slice.ts",
      `
@@ -1,4 +1,4 @@
 export function rest(items: string[], start: number) {
-  return items.slice(start, items.length - 1);
+  return items.slice(start);
 }`,
    ),
    testDiff: diff(
      "src/slice.test.ts",
      `
@@ -1,3 +1,6 @@
 import { rest } from "./slice";
+
+test("keeps the last item", () => {
+  expect(rest(["a", "b", "c"], 1)).toEqual(["b", "c"]);
+});`,
    ),
    expect: { integrity: "pass", catches: [] },
  },
  {
    id: "clean-05",
    bucket: "clean",
    title: "Guard throws instead of returning a default",
    why: "A throw is a signal, not a silent default.",
    userRequest: "Reject an empty session key. Do not invent a fallback id.",
    sourceDiff: diff(
      "src/session.ts",
      `
@@ -1,6 +1,8 @@
 export function bind(key: string) {
+  if (!key) throw new Error("session key required");
   return { key };
 }`,
    ),
    testDiff: diff(
      "src/session.test.ts",
      `
@@ -1,3 +1,6 @@
 import { bind } from "./session";
+
+test("empty key throws", () => {
+  expect(() => bind("")).toThrow(/session key/);
+});`,
    ),
    expect: { integrity: "pass", catches: [] },
  },

  // --- bug ----------------------------------------------------------------
  {
    id: "bug-01",
    bucket: "bug",
    title: "Off-by-one still drops the last item",
    why: "slice end is length-1. Trigger: last element. Consequence: dropped.",
    userRequest: "Return every item from start through the end, inclusive.",
    sourceDiff: diff(
      "src/slice.ts",
      `
@@ -1,4 +1,4 @@
 export function rest(items: string[], start: number) {
-  return items.slice(start);
+  return items.slice(start, items.length - 1);
 }`,
    ),
    testDiff: "",
    expect: {
      integrity: "issues_found",
      catches: [{ category: "bug", file: "src/slice.ts" }],
    },
  },
  {
    id: "bug-02",
    bucket: "bug",
    title: "Null path after dropping optional chaining",
    why: "state can be null. Trigger: missing state. Consequence: throw.",
    userRequest: "Read the model id off session state.",
    sourceDiff: diff(
      "src/state.ts",
      `
@@ -1,4 +1,4 @@
 export function modelId(state: { model?: { id: string } } | null) {
-  return state?.model?.id ?? "";
+  return state.model.id;
 }`,
    ),
    testDiff: "",
    expect: {
      integrity: "issues_found",
      catches: [{ category: "bug", file: "src/state.ts" }],
    },
  },
  {
    id: "bug-03",
    bucket: "bug",
    title: "Fire-and-forget async, race on settle",
    why: "Missing await. Trigger: prompt() still in flight. Consequence: idle flag flips early.",
    userRequest: "Mark the session idle only after prompt() finishes.",
    sourceDiff: diff(
      "src/queue.ts",
      `
@@ -2,7 +2,7 @@
 export async function drain(prompt: () => Promise<void>) {
   busy = true;
-  await prompt();
+  prompt();
   busy = false;
 }`,
    ),
    testDiff: "",
    expect: {
      integrity: "issues_found",
      catches: [{ category: "bug", file: "src/queue.ts" }],
    },
  },
  {
    id: "bug-04",
    bucket: "bug",
    title: "Wrong predicate: includes instead of exact backend",
    why: "\"pi\" matches \"devden\". Trigger: backend devden. Consequence: wrong agent.",
    userRequest: "Use the pi backend only when backend is exactly \"pi\".",
    sourceDiff: diff(
      "src/backend.ts",
      `
@@ -1,4 +1,4 @@
 export function isPi(backend: string) {
-  return backend === "pi";
+  return backend.includes("pi");
 }`,
    ),
    testDiff: "",
    expect: {
      integrity: "issues_found",
      catches: [{ category: "bug", file: "src/backend.ts" }],
    },
  },
  {
    id: "bug-05",
    bucket: "bug",
    title: "Listener never removed",
    why: "Each call adds a listener. Trigger: repeated bind(). Consequence: leak / double handle.",
    userRequest: "Subscribe to agent_settled. Do not leak listeners across binds.",
    sourceDiff: diff(
      "src/events.ts",
      `
@@ -1,6 +1,8 @@
 export function bind(onSettled: () => void) {
-  events.removeListener("agent_settled", onSettled);
   events.on("agent_settled", onSettled);
 }`,
    ),
    testDiff: "",
    expect: {
      integrity: "issues_found",
      catches: [{ category: "bug", file: "src/events.ts" }],
    },
  },

  // --- masking ------------------------------------------------------------
  {
    id: "mask-01",
    bucket: "masking",
    title: "Empty catch, caller still sees success",
    why: "Swallowed exception. Check 1.",
    userRequest: "Parse the agent event. If it is malformed, fail the turn.",
    sourceDiff: diff(
      "src/events.ts",
      `
@@ -1,6 +1,8 @@
 export function handle(raw: string) {
-  return JSON.parse(raw);
+  try {
+    return JSON.parse(raw);
+  } catch (e) {}
 }`,
    ),
    testDiff: "",
    expect: {
      integrity: "issues_found",
      catches: [{ category: "masking", file: "src/events.ts" }],
    },
  },
  {
    id: "mask-02",
    bucket: "masking",
    title: "Hardcoded branch for the one failing input",
    why: "Special-case, not a general fix.",
    userRequest: "Empty cwd should resolve to the process cwd for every caller.",
    sourceDiff: diff(
      "src/cwd.ts",
      `
@@ -1,4 +1,5 @@
 export function resolveCwd(cwd: string) {
+  if (cwd === "") return "/Users/demo/project";
   return cwd || process.cwd();
 }`,
    ),
    testDiff: "",
    expect: {
      integrity: "issues_found",
      catches: [{ category: "masking", file: "src/cwd.ts" }],
    },
  },
  {
    id: "mask-03",
    bucket: "masking",
    title: "Test skipped instead of fixed",
    why: "it.skip hides the failure. Pre-check should also fire.",
    userRequest: "The settle test is failing. Fix the production code, keep the test.",
    sourceDiff: diff(
      "src/settle.ts",
      `
@@ -1,4 +1,4 @@
 export function ready(open: number) {
-  return open === 0;
+  return open >= 0;
 }`,
    ),
    testDiff: diff(
      "src/settle.test.ts",
      `
@@ -1,5 +1,5 @@
 import { ready } from "./settle";
 
-test("not ready while a tool is open", () => {
+test.skip("not ready while a tool is open", () => {
   expect(ready(2)).toBe(false);
 });`,
    ),
    expect: {
      integrity: "issues_found",
      catches: [{ category: "masking", file: "src/settle.test.ts" }],
    },
  },
  {
    id: "mask-04",
    bucket: "masking",
    title: "Retry loop that never surfaces the error",
    why: "Retries until success is assumed; the underlying failure is dropped.",
    userRequest: "If prompt() fails, fail the turn. Do not hide it.",
    sourceDiff: diff(
      "src/prompt.ts",
      `
@@ -1,6 +1,10 @@
 export async function send(prompt: () => Promise<void>) {
-  await prompt();
+  for (let i = 0; i < 5; i++) {
+    try {
+      await prompt();
+      return;
+    } catch {}
+  }
 }`,
    ),
    testDiff: "",
    expect: {
      integrity: "issues_found",
      catches: [{ category: "masking", file: "src/prompt.ts" }],
    },
  },
  {
    id: "mask-05",
    bucket: "masking",
    title: "Catch returns a default, caller cannot tell",
    why: "Error dropped with no signal.",
    userRequest: "Read usage. If the provider errors, surface it — do not invent zeros.",
    sourceDiff: diff(
      "src/usage.ts",
      `
@@ -1,6 +1,8 @@
 export async function load() {
-  return await provider.usage();
+  try {
+    return await provider.usage();
+  } catch {
+    return { used: 0, cap: 0 };
+  }
 }`,
    ),
    testDiff: "",
    expect: {
      integrity: "issues_found",
      catches: [{ category: "masking", file: "src/usage.ts" }],
    },
  },

  // --- partial ------------------------------------------------------------
  {
    id: "part-01",
    bucket: "partial",
    title: "Fix without the requested test",
    why: "USER_REQUEST asked to pin with a test. Diff has no test file.",
    userRequest:
      "Inclusive rest() was dropping the last item. Fix it and add a test that the last item stays.",
    sourceDiff: diff(
      "src/slice.ts",
      `
@@ -1,4 +1,4 @@
 export function rest(items: string[], start: number) {
-  return items.slice(start, items.length - 1);
+  return items.slice(start);
 }`,
    ),
    testDiff: "",
    expect: {
      integrity: "pass",
      catches: [
        {
          category: "task",
          file: "",
          requirement: "test",
        },
      ],
    },
  },
  {
    id: "part-02",
    bucket: "partial",
    title: "One of two required backends",
    why: "Asked for pi and grok. Only pi is handled.",
    userRequest:
      "hasOpenTools must be true for both the pi and grok backends when a turn is running.",
    sourceDiff: diff(
      "src/busy.ts",
      `
@@ -1,4 +1,4 @@
 export function hasOpenTools(backend: string, open: number) {
-  return false;
+  return backend === "pi" && open > 0;
 }`,
    ),
    testDiff: "",
    expect: {
      integrity: "pass",
      catches: [
        { category: "task", file: "", requirement: "grok" },
      ],
    },
  },
  {
    id: "part-03",
    bucket: "partial",
    title: "Fix left the debug guard in",
    why: "Asked to remove the port-4319 skip and fix settle. Skip remains.",
    userRequest:
      "Remove the debug skip for port 4319 and make settle wait for open tools. Both.",
    sourceDiff: diff(
      "src/settle.ts",
      `
@@ -1,8 +1,8 @@
 export function settle(open: number, port: number) {
   if (port === 4319) return true;
-  return true;
+  return open === 0;
 }`,
    ),
    testDiff: "",
    expect: {
      integrity: "pass",
      catches: [
        { category: "task", file: "", requirement: "4319" },
      ],
    },
  },
  {
    id: "part-04",
    bucket: "partial",
    title: "New API, no migration of callers",
    why: "Asked for the helper and to switch callers. Only the helper landed.",
    userRequest:
      "Add formatTurnDuration and switch every caller of the old formatMs helper over to it.",
    sourceDiff: diff(
      "src/time.ts",
      `
@@ -1,3 +1,8 @@
 export function formatMs(ms: number) {
   return Math.round(ms / 1000) + "s";
 }
+
+export function formatTurnDuration(ms: number) {
+  const sec = Math.round(ms / 1000);
+  return sec < 60 ? sec + "s" : Math.floor(sec / 60) + "m";
+}`,
    ),
    testDiff: "",
    expect: {
      integrity: "pass",
      catches: [
        { category: "task", file: "", requirement: "caller" },
      ],
    },
  },
  {
    id: "part-05",
    bucket: "partial",
    title: "Gate without the replay pin",
    why: "Asked for the open-tools gate AND a replay test. Only the gate.",
    userRequest:
      "Composer must stay on Stop while a tool is open, and pin that with a replay test on a tool-only turn.",
    sourceDiff: diff(
      "src/composer.ts",
      `
@@ -1,4 +1,4 @@
 export function label(open: number) {
-  return "Send";
+  return open > 0 ? "Stop" : "Send";
 }`,
    ),
    testDiff: "",
    expect: {
      integrity: "pass",
      catches: [
        { category: "task", file: "", requirement: "replay" },
      ],
    },
  },
];

export function evalPrompts(entry: ReviewEvalCase): {
  integrity: string;
  task: string;
} {
  const sourceHunks = formatReviewHunks(entry.sourceDiff);
  const testHunks = formatReviewHunks(entry.testDiff) || "none";
  const prechecks = scanPrechecks(entry.sourceDiff, entry.testDiff);
  return {
    integrity: integrityPrompt({
      userRequest: entry.userRequest,
      sourceHunks,
      testHunks,
      prechecks,
    }),
    task: taskPrompt({
      userRequest: entry.userRequest,
      sourceHunks,
    }),
  };
}

function fileHit(expected: string, actual: string): boolean {
  if (!expected) return true;
  const want = expected.replace(/\\/g, "/");
  const got = actual.replace(/\\/g, "/");
  return got === want || got.endsWith(`/${want}`) || got.includes(want);
}

function catchHit(
  expected: EvalCatch,
  integrity: IntegrityReview,
  task: TaskReview,
): boolean {
  if (expected.category === "task") {
    const needle = (expected.requirement ?? "").toLowerCase();
    return task.requirements.some((item) => {
      if (item.status !== "partial" && item.status !== "not_satisfied")
        return false;
      if (!needle) return true;
      return `${item.item} ${item.note}`.toLowerCase().includes(needle);
    });
  }
  return integrity.findings.some(
    (finding) =>
      finding.category === expected.category &&
      fileHit(expected.file, finding.file),
  );
}

export function scoreCase(
  entry: ReviewEvalCase,
  integrity: IntegrityReview,
  task: TaskReview,
): CaseScore {
  const missed = entry.expect.catches.filter(
    (item) => !catchHit(item, integrity, task),
  );
  const labelledFiles = new Set(
    entry.expect.catches.map((item) => item.file).filter(Boolean),
  );
  const extra = integrity.findings
    .filter((finding) => {
      if (!entry.expect.catches.length) return true;
      return !entry.expect.catches.some(
        (item) =>
          item.category !== "task" &&
          item.category === finding.category &&
          fileHit(item.file, finding.file),
      );
    })
    .map((finding) => ({ category: finding.category, file: finding.file }));
  const falsePositive =
    entry.bucket === "clean" &&
    (integrity.findings.length > 0 ||
      task.requirements.some(
        (item) =>
          item.status === "not_satisfied" || item.status === "partial",
      ));
  const softNoise =
    entry.bucket === "clean" && integrity.needsVerification.length > 0;
  return {
    id: entry.id,
    bucket: entry.bucket,
    caught: missed.length === 0,
    falsePositive,
    softNoise,
    missed,
    extra: entry.bucket === "clean" ? extra : extra.filter((item) => !labelledFiles.has(item.file)),
  };
}

export function scoreEvalSet(
  predictions: Record<
    string,
    { integrity: IntegrityReview; task: TaskReview }
  >,
  cases: ReviewEvalCase[] = REVIEW_EVAL_CASES,
): EvalReport {
  const scores = cases.map((entry) => {
    const predicted = predictions[entry.id] ?? {
      integrity: { verdict: "pass" as const, findings: [], needsVerification: [] },
      task: {
        requirements: [],
        approachConcern: "",
        unrequestedChanges: [],
      },
    };
    return scoreCase(entry, predicted.integrity, predicted.task);
  });
  const buckets = {} as Record<EvalBucket, BucketScore>;
  for (const bucket of ["clean", "bug", "masking", "partial"] as const) {
    const rows = scores.filter((row) => row.bucket === bucket);
    const caught = rows.filter((row) => row.caught).length;
    const fps = rows.filter((row) => row.falsePositive).length;
    buckets[bucket] = {
      n: rows.length,
      caught,
      catchRate: rows.length ? caught / rows.length : 0,
      falsePositives: fps,
      falsePositiveRate: rows.length ? fps / rows.length : 0,
      softNoise: rows.filter((row) => row.softNoise).length,
    };
  }
  const extraByCategory: Record<string, number> = {};
  for (const row of scores) {
    for (const extra of row.extra) {
      extraByCategory[extra.category] = (extraByCategory[extra.category] ?? 0) + 1;
    }
  }
  return { buckets, extraByCategory, cases: scores };
}

export function formatEvalCatalog(
  cases: ReviewEvalCase[] = REVIEW_EVAL_CASES,
): string {
  const lines = [
    "Review eval set — 5 clean / 5 bug / 5 masking / 5 partial",
    "Score catch and false positives separately. Clean FP is the number that matters.",
    "",
  ];
  for (const entry of cases) {
    lines.push(
      `${entry.id.padEnd(10)} ${entry.bucket.padEnd(8)} ${entry.title}`,
    );
    lines.push(`           ${entry.why}`);
  }
  return lines.join("\n");
}

export function predictionFromYaml(
  integrityYaml: string,
  taskYaml: string,
): { integrity: IntegrityReview; task: TaskReview; merged: MergedReview } {
  const integrity = parseIntegrityReview(integrityYaml);
  const task = parseTaskReview(taskYaml);
  return { integrity, task, merged: mergeReviews(integrity, task) };
}
