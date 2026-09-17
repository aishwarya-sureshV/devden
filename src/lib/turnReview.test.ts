import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { TimelineItem } from "./timeline.ts";
import {
  formatReviewHunks,
  formatTurnDuration,
  integrityPrompt,
  isTestPath,
  lastTurnItems,
  lastUserRequest,
  filterDiffToFiles,
  mergeReviews,
  normalizeRepoPath,
  reviewPathsMatch,
  parseIntegrityReview,
  parseTaskReview,
  partitionUnifiedDiff,
  queueFixesPrompt,
  reviewVerdictLabel,
  scanPrechecks,
  taskPrompt,
  statsForTurn,
  turnStats,
  type IntegrityFinding,
  type IntegrityReview,
  type TaskReview,
} from "./turnReview.ts";

const user = (
  id: string,
  text: string,
  timestamp: number,
): TimelineItem => ({ id, kind: "user", text, timestamp });

const assistant = (
  id: string,
  text: string,
  timestamp: number,
): TimelineItem => ({
  id,
  kind: "assistant",
  text,
  live: false,
  timestamp,
});

const tool = (
  id: string,
  name: string,
  path: string,
  timestamp: number,
): TimelineItem => ({
  id,
  kind: "tool",
  name,
  args: { path },
  details: {},
  output: "ok",
  status: "done",
  startedAt: timestamp,
});

test("lastUserRequest is the last turn's user text, verbatim", () => {
  const items: TimelineItem[] = [
    user("u1", "old", 1),
    assistant("a1", "old reply", 2),
    user("u2", "fix the adapter, no prompt patch", 3),
    assistant("a2", "done", 5),
  ];
  assert.equal(lastTurnItems(items)[0]?.id, "u2");
  assert.equal(lastUserRequest(items), "fix the adapter, no prompt patch");
});

test("turnStats counts tools, unique writes, and duration", () => {
  const items: TimelineItem[] = [
    user("u", "go", 1_000),
    tool("t1", "read", "src/a.ts", 1_500),
    tool("t2", "edit", "src/a.ts", 2_000),
    tool("t3", "write", "src/b.ts", 3_000),
    assistant("a", "done", 5_000),
  ];
  const stats = turnStats(items);
  assert.equal(stats.toolCount, 3);
  assert.equal(stats.fileCount, 2);
  assert.deepEqual(stats.files, ["src/a.ts", "src/b.ts"]);
  assert.equal(stats.durationMs, 4_000);
  assert.equal(formatTurnDuration(252_000), "4m 12s");
  const earlier: TimelineItem[] = [
    user("u0", "old", 100),
    assistant("a0", "old reply", 200),
    ...items,
  ];
  assert.deepEqual(statsForTurn(items), stats);
  assert.deepEqual(turnStats(earlier), stats);
});

test("isTestPath and partitionUnifiedDiff label tests separately", () => {
  assert.equal(isTestPath("src/a.ts"), false);
  assert.equal(isTestPath("src/a.test.ts"), true);
  assert.equal(isTestPath("src/__tests__/a.ts"), true);
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    "diff --git a/src/a.test.ts b/src/a.test.ts",
    "--- a/src/a.test.ts",
    "+++ b/src/a.test.ts",
    "@@ -1,1 +1,1 @@",
    "-it('x')",
    "+it.skip('x')",
  ].join("\n");
  const parts = partitionUnifiedDiff(diff);
  assert.deepEqual(parts.sourceFiles, ["src/a.ts"]);
  assert.deepEqual(parts.testFiles, ["src/a.test.ts"]);
  assert.match(parts.sourceDiff, /src\/a\.ts/);
  assert.match(parts.testDiff, /a\.test\.ts/);
});

test("formatReviewHunks injects new-hunk line numbers", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@",
    " keep",
    "-gone",
    "+added",
    " still",
  ].join("\n");
  const formatted = formatReviewHunks(diff);
  assert.match(formatted, /## src\/a\.ts/);
  assert.match(formatted, /### old/);
  assert.match(formatted, /### new/);
  assert.match(formatted, /11\+ added/);
  assert.match(formatted, /11- gone/);
});

test("scanPrechecks reports skip and empty catch as facts", () => {
  const source = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,0 +1,1 @@",
    "+try { run() } catch (e) {}",
  ].join("\n");
  const tests = [
    "diff --git a/src/a.test.ts b/src/a.test.ts",
    "--- a/src/a.test.ts",
    "+++ b/src/a.test.ts",
    "@@ -1,1 +1,1 @@",
    "-it('x')",
    "+it.skip('x')",
  ].join("\n");
  const facts = scanPrechecks(source, tests);
  assert.ok(facts.some((fact) => /catch/i.test(fact)));
  assert.ok(facts.some((fact) => /skip/i.test(fact)));
});

test("integrity and task prompts carry verbatim request and labelled diffs, not a transcript", () => {
  const a = integrityPrompt({
    userRequest: "fix the adapter, no prompt patch",
    sourceHunks: "## src/a.ts\n\n### new\n1+ x",
    testHunks: "none",
    prechecks: ["Empty catch in added source lines."],
  });
  assert.match(a, /USER_REQUEST: fix the adapter, no prompt patch/);
  assert.match(a, /SOURCE_DIFF:/);
  assert.match(a, /TEST_DIFF:/);
  assert.doesNotMatch(a, /Turn transcript/);
  assert.match(a, /read files/);
  assert.match(a, /run tests/);
  assert.match(a, /this turn only/);
  assert.match(a, /blocker \| major \| minor/);
  assert.doesNotMatch(a, /max 5/);
  assert.match(a, /Empty catch/);
  const b = taskPrompt({
    userRequest: "fix the adapter, no prompt patch",
    sourceHunks: "## src/a.ts",
  });
  assert.match(b, /USER_REQUEST: fix the adapter, no prompt patch/);
  assert.doesNotMatch(b, /TEST_DIFF/);
});

const integrityYaml = `
verdict: issues_found
findings:
  - severity: blocker
    file: src/a.ts
    start_line: 12
    end_line: 18
    category: masking
    trigger: |
      empty input
    consequence: |
      caller sees success
  - severity: concern
    file: src/b.ts
    start_line: 4
    end_line: 4
    category: bug
    trigger: off by one
    consequence: last item dropped
needs_verification:
  - |
    whether callers handle the new return
`;

test("parseIntegrityReview reads YAML findings", () => {
  const parsed = parseIntegrityReview(`Here you go.\n\`\`\`yaml${integrityYaml}\n\`\`\``);
  assert.equal(parsed.verdict, "issues_found");
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[0]?.severity, "blocker");
  assert.equal(parsed.findings[1]?.severity, "major");
  assert.equal(parsed.findings[0]?.file, "src/a.ts");
  assert.equal(parsed.findings[0]?.startLine, 12);
  assert.match(parsed.findings[0]?.trigger ?? "", /empty input/);
  assert.equal(parsed.needsVerification.length, 1);
});

test("parseTaskReview and mergeReviews gate on blockers and not_satisfied", () => {
  const task = parseTaskReview(`
requirements:
  - item: |
      gate settle on open tool count
    status: not_satisfied
    note: |
      not in the diff
  - item: keep prompts untouched
    status: satisfied
    note: ""
approach_concern: |
unrequested_changes:
  - debug port guard
`);
  assert.equal(task.requirements[0]?.status, "not_satisfied");
  const integrity: IntegrityReview = {
    verdict: "issues_found",
    findings: [
      {
        severity: "blocker",
        file: "src/a.ts",
        startLine: 12,
        endLine: 18,
        category: "masking",
        trigger: "empty input",
        consequence: "success",
        uncertainty: "",
      },
    ],
    needsVerification: [],
  };
  const merged = mergeReviews(integrity, task);
  assert.equal(merged.sendBack, true);
  assert.equal(merged.verdict, "send_back");
  assert.equal(reviewVerdictLabel(merged.verdict), "Needs changes");
  const queued = queueFixesPrompt(merged);
  assert.match(queued, /not an approval/i);
  assert.match(queued, /src\/a\.ts:12-18/);
  assert.match(queued, /not_satisfied/);
});

test("mergeReviews keeps every finding, sorted blocker then major then minor", () => {
  const findings: IntegrityFinding[] = [1, 2, 3, 4, 5, 6].map((n) => ({
    severity: n === 1 ? "blocker" : n < 4 ? "major" : "minor",
    file: `src/${n}.ts`,
    startLine: n,
    endLine: n,
    category: "bug",
    trigger: `t${n}`,
    consequence: `c${n}`,
    uncertainty: "",
  }));
  const merged = mergeReviews(
    { verdict: "issues_found", findings, needsVerification: [] },
    { requirements: [], approachConcern: "", unrequestedChanges: [] },
  );
  assert.equal(merged.findings.length, 6);
  assert.equal(merged.findings[0]?.severity, "blocker");
  assert.equal(merged.findings.at(-1)?.severity, "minor");
});

test("reviewPathsMatch equates absolute tool paths with git relative paths", () => {
  const cwd = "/Users/aishwarya/dev/pi-web";
  assert.equal(normalizeRepoPath(`${cwd}/src/a.ts`, cwd), "src/a.ts");
  assert.equal(normalizeRepoPath("./src/a.ts", cwd), "src/a.ts");
  assert.equal(
    reviewPathsMatch(`${cwd}/src/a.ts`, "src/a.ts", cwd),
    true,
  );
  assert.equal(reviewPathsMatch("src/a.ts", "src/b.ts", cwd), false);
});

test("filterDiffToFiles drops files this turn did not touch", () => {
  const diff = [
    "diff --git a/src/old.ts b/src/old.ts",
    "--- a/src/old.ts",
    "+++ b/src/old.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/src/new.ts b/src/new.ts",
    "--- a/src/new.ts",
    "+++ b/src/new.ts",
    "@@ -1 +1 @@",
    "-c",
    "+d",
  ].join("\n");
  const filtered = filterDiffToFiles(diff, ["src/new.ts"]);
  assert.match(filtered, /src\/new\.ts/);
  assert.doesNotMatch(filtered, /src\/old\.ts/);
});

test("clean integrity + satisfied task is a pass, never an approval to send", () => {
  const integrity: IntegrityReview = {
    verdict: "pass",
    findings: [],
    needsVerification: [],
  };
  const task: TaskReview = {
    requirements: [
      { item: "fix adapter", status: "satisfied", note: "" },
    ],
    approachConcern: "",
    unrequestedChanges: [],
  };
  const merged = mergeReviews(integrity, task);
  assert.equal(merged.verdict, "pass");
  assert.equal(merged.sendBack, false);
  assert.equal(queueFixesPrompt(merged), "");
});
