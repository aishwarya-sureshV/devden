import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  candidateTests,
  isTestCommand,
  parseTestCounts,
  raceSlug,
  sumChanges,
} from "./race.ts";
import type { GitChange, GitChangesResponse } from "./api.ts";
import type { TimelineItem } from "./timeline.ts";

describe("raceSlug", () => {
  it("keeps a few sturdy words", () => {
    assert.equal(
      raceSlug("Fix the auth bug in login flow!!"),
      "fix-the-auth-bug",
    );
  });

  it("falls back when nothing survives", () => {
    assert.equal(raceSlug("a? to be or"), "race");
  });
});

describe("isTestCommand", () => {
  it("matches the usual runners", () => {
    for (const command of [
      "npm test",
      "npm run test:unit",
      "npx vitest run",
      "pytest -q",
      "go test ./...",
      "make test",
    ]) {
      assert.ok(isTestCommand(command), command);
    }
  });

  it("does not match file edits that merely mention tests", () => {
    assert.ok(!isTestCommand("Edit src/foo.test.ts"));
    assert.ok(!isTestCommand("cat foo.test.ts"));
    assert.ok(!isTestCommand("latest changes"));
  });
});

describe("parseTestCounts", () => {
  it("reads jest and vitest summaries", () => {
    assert.deepEqual(parseTestCounts("Tests: 5 passed, 2 failed"), {
      passed: 5,
      failed: 2,
    });
  });

  it("reads pytest summaries", () => {
    assert.deepEqual(
      parseTestCounts("==== 3 passed, 1 failed, 2 skipped in 0.12s ===="),
      { passed: 3, failed: 1 },
    );
  });

  it("takes the last mention", () => {
    assert.deepEqual(parseTestCounts("1 passed\nrerun: 2 passed, 1 failed"), {
      passed: 2,
      failed: 1,
    });
  });

  it("returns null without counts", () => {
    assert.equal(parseTestCounts("no tests here"), null);
    assert.equal(parseTestCounts("PASS\nok"), null);
  });
});

const tool = (
  name: string,
  command: string,
  output: string,
): Extract<TimelineItem, { kind: "tool" }> => ({
  kind: "tool",
  id: name + command,
  name,
  args: { command },
  details: {},
  output,
  status: "done",
  startedAt: 0,
});

describe("candidateTests", () => {
  it("counts runs and keeps the latest result", () => {
    const items: TimelineItem[] = [
      tool("bash", "npm test", "Tests: 1 passed"),
      tool("bash", "npm test", "Tests: 4 passed, 1 failed"),
      tool("bash", "ls -la", ""),
    ];
    assert.deepEqual(candidateTests(items), {
      testRuns: 2,
      testsPassed: 4,
      testsFailed: 1,
    });
  });

  it("ignores edits that touch test files", () => {
    const edit: TimelineItem = {
      kind: "tool",
      id: "e1",
      name: "Edit",
      args: { file_path: "src/app.test.ts" },
      details: {},
      output: "file written",
      status: "done",
      startedAt: 0,
    };
    assert.deepEqual(candidateTests([edit]), {
      testRuns: 0,
      testsPassed: null,
      testsFailed: null,
    });
  });

  it("skips still-running commands", () => {
    const running: TimelineItem = {
      ...tool("bash", "npm test", ""),
      status: "running",
    };
    assert.deepEqual(candidateTests([running]), {
      testRuns: 0,
      testsPassed: null,
      testsFailed: null,
    });
  });
});

describe("sumChanges", () => {
  it("sums the worktree change list", () => {
    const changes: GitChange[] = [
      { path: "a", status: "modified", additions: 3, deletions: 1 },
      { path: "b", status: "added", additions: 10, deletions: 0 },
    ];
    assert.deepEqual(sumChanges(changes), {
      filesChanged: 2,
      additions: 13,
      deletions: 1,
    });
    assert.deepEqual(sumChanges([]), {
      filesChanged: 0,
      additions: 0,
      deletions: 0,
    });
  });
});

// The GitChangesResponse import only shapes the endpoint contract; keep it
// exercised so a rename cannot silently strand this import.
it("git changes response type stays compatible", () => {
  const response = { ok: true, changes: [] } as GitChangesResponse;
  assert.deepEqual(sumChanges(response.changes ?? []), {
    filesChanged: 0,
    additions: 0,
    deletions: 0,
  });
});
