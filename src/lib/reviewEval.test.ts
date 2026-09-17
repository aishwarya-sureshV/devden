import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  REVIEW_EVAL_CASES,
  evalPrompts,
  formatEvalCatalog,
  predictionFromYaml,
  scoreCase,
  scoreEvalSet,
  type ReviewEvalCase,
} from "./reviewEval.ts";
import { partitionUnifiedDiff, scanPrechecks } from "./turnReview.ts";
import type { IntegrityReview, TaskReview } from "./turnReview.ts";

test("eval set is 20 cases, five per bucket, unique ids", () => {
  assert.equal(REVIEW_EVAL_CASES.length, 20);
  const buckets = { clean: 0, bug: 0, masking: 0, partial: 0 };
  const ids = new Set<string>();
  for (const entry of REVIEW_EVAL_CASES) {
    buckets[entry.bucket] += 1;
    assert.equal(ids.has(entry.id), false, `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.userRequest.trim(), entry.id);
    assert.ok(entry.sourceDiff.includes("diff --git"), entry.id);
    assert.ok(entry.why.trim(), entry.id);
  }
  assert.deepEqual(buckets, { clean: 5, bug: 5, masking: 5, partial: 5 });
});

test("clean cases expect no catches; others label a file or requirement", () => {
  for (const entry of REVIEW_EVAL_CASES) {
    if (entry.bucket === "clean") {
      assert.equal(entry.expect.catches.length, 0, entry.id);
      assert.equal(entry.expect.integrity, "pass");
      continue;
    }
    assert.ok(entry.expect.catches.length, entry.id);
    if (entry.bucket === "partial") {
      assert.ok(
        entry.expect.catches.every((item) => item.category === "task"),
        entry.id,
      );
    } else {
      assert.ok(
        entry.expect.catches.every((item) => item.file),
        entry.id,
      );
    }
  }
});

test("every fixture diff splits into files", () => {
  for (const entry of REVIEW_EVAL_CASES) {
    const parts = partitionUnifiedDiff(entry.sourceDiff + "\n" + entry.testDiff);
    assert.ok(
      parts.sourceFiles.length + parts.testFiles.length > 0,
      entry.id,
    );
  }
});

test("skipped-test masking case is visible to deterministic prechecks", () => {
  const entry = REVIEW_EVAL_CASES.find((item) => item.id === "mask-03")!;
  const facts = scanPrechecks(entry.sourceDiff, entry.testDiff);
  assert.ok(facts.some((fact) => /skip/i.test(fact)));
});

test("evalPrompts carry the verbatim request and this-turn diffs", () => {
  const entry = REVIEW_EVAL_CASES[0]!;
  const prompts = evalPrompts(entry);
  assert.match(prompts.integrity, new RegExp(entry.userRequest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompts.integrity, /SOURCE_DIFF:/);
  assert.match(prompts.task, /USER_REQUEST:/);
});

function oracle(entry: ReviewEvalCase): {
  integrity: IntegrityReview;
  task: TaskReview;
} {
  const integrity: IntegrityReview = {
    verdict: entry.expect.integrity,
    findings: entry.expect.catches
      .filter((item) => item.category !== "task")
      .map((item) => ({
        severity: "blocker" as const,
        file: item.file,
        startLine: 1,
        endLine: 1,
        category: item.category,
        trigger: "labelled",
        consequence: "labelled",
        uncertainty: "",
      })),
    needsVerification: [],
  };
  const task: TaskReview = {
    requirements: entry.expect.catches
      .filter((item) => item.category === "task")
      .map((item) => ({
        item: `missing ${item.requirement}`,
        status: "not_satisfied" as const,
        note: item.requirement ?? "",
      })),
    approachConcern: "",
    unrequestedChanges: [],
  };
  return { integrity, task };
}

test("a perfect reviewer scores 100% catch and 0% clean false positives", () => {
  const predictions = Object.fromEntries(
    REVIEW_EVAL_CASES.map((entry) => [entry.id, oracle(entry)]),
  );
  const report = scoreEvalSet(predictions);
  assert.equal(report.buckets.clean.falsePositiveRate, 0);
  assert.equal(report.buckets.bug.catchRate, 1);
  assert.equal(report.buckets.masking.catchRate, 1);
  assert.equal(report.buckets.partial.catchRate, 1);
  assert.equal(report.cases.every((row) => row.caught), true);
});

test("a finding on a clean case is a false positive, not a catch miss", () => {
  const clean = REVIEW_EVAL_CASES.find((item) => item.bucket === "clean")!;
  const scored = scoreCase(
    clean,
    {
      verdict: "issues_found",
      findings: [
        {
          severity: "minor",
          file: "src/settle.ts",
          startLine: 1,
          endLine: 1,
          category: "other",
          trigger: "rename",
          consequence: "style",
          uncertainty: "",
        },
      ],
      needsVerification: [],
    },
    { requirements: [], approachConcern: "", unrequestedChanges: [] },
  );
  assert.equal(scored.falsePositive, true);
  assert.equal(scored.caught, true);
});

test("an empty integrity review misses a labelled bug", () => {
  const bug = REVIEW_EVAL_CASES.find((item) => item.id === "bug-01")!;
  const scored = scoreCase(
    bug,
    { verdict: "pass", findings: [], needsVerification: [] },
    { requirements: [], approachConcern: "", unrequestedChanges: [] },
  );
  assert.equal(scored.caught, false);
  assert.equal(scored.missed[0]?.category, "bug");
});

test("predictionFromYaml scores a masking catch from reviewer output", () => {
  const entry = REVIEW_EVAL_CASES.find((item) => item.id === "mask-01")!;
  const parsed = predictionFromYaml(
    `
verdict: issues_found
findings:
  - severity: blocker
    file: src/events.ts
    start_line: 4
    end_line: 6
    category: masking
    trigger: |
      malformed JSON
    consequence: |
      caller sees undefined
needs_verification:
`,
    `
requirements:
  - item: fail the turn on malformed events
    status: not_satisfied
    note: swallow
`,
  );
  const scored = scoreCase(entry, parsed.integrity, parsed.task);
  assert.equal(scored.caught, true);
});

test("catalog lists every id", () => {
  const catalog = formatEvalCatalog();
  for (const entry of REVIEW_EVAL_CASES) assert.match(catalog, new RegExp(entry.id));
});
