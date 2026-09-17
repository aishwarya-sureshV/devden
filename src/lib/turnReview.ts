import type { TimelineItem } from "./timeline";

function isWriteTool(name: string): boolean {
  const key = name.trim().toLowerCase().replace(/-/g, "_");
  return (
    key === "edit" ||
    key === "write" ||
    key.endsWith("_edit") ||
    key.endsWith("_write")
  );
}

function toolPath(args: Record<string, unknown>): string {
  for (const key of ["path", "file_path", "target_file", "file", "targetFile"]) {
    if (typeof args[key] === "string" && args[key]) return args[key] as string;
  }
  return "";
}

export interface TurnStats {
  durationMs: number;
  toolCount: number;
  fileCount: number;
  files: string[];
}

export type IntegritySeverity = "blocker" | "major" | "minor";

export interface IntegrityFinding {
  severity: IntegritySeverity;
  file: string;
  startLine: number;
  endLine: number;
  category: string;
  trigger: string;
  consequence: string;
  uncertainty: string;
}

export interface IntegrityReview {
  verdict: "pass" | "issues_found";
  findings: IntegrityFinding[];
  needsVerification: string[];
}

export interface TaskRequirement {
  item: string;
  status: "satisfied" | "partial" | "not_satisfied" | "needs_human";
  note: string;
}

export interface TaskReview {
  requirements: TaskRequirement[];
  approachConcern: string;
  unrequestedChanges: string[];
}

export interface MergedReview {
  verdict: "pass" | "issues_found" | "send_back";
  findings: IntegrityFinding[];
  requirements: TaskRequirement[];
  approachConcern: string;
  unrequestedChanges: string[];
  needsVerification: string[];
  sendBack: boolean;
}

/** Slice from the last user message through the end of the transcript. */
export function lastTurnItems(items: TimelineItem[]): TimelineItem[] {
  let start = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.kind === "user") {
      start = i;
      break;
    }
  }
  return items.slice(start);
}

export function lastUserRequest(items: TimelineItem[]): string {
  const user = lastTurnItems(items).find((item) => item.kind === "user");
  return user?.kind === "user" ? user.text.trim() : "";
}

export function lastUserTimestamp(items: TimelineItem[]): number {
  const user = lastTurnItems(items).find((item) => item.kind === "user");
  return user?.kind === "user" ? user.timestamp : 0;
}

function itemTime(item: TimelineItem): number {
  if (item.kind === "tool") return item.startedAt;
  return item.timestamp ?? 0;
}

export function statsForTurn(turn: TimelineItem[]): TurnStats {
  const first = turn[0] ? itemTime(turn[0]) : 0;
  const last = turn.reduce(
    (latest, item) => Math.max(latest, itemTime(item)),
    first,
  );
  const files: string[] = [];
  let toolCount = 0;
  for (const item of turn) {
    if (item.kind !== "tool") continue;
    toolCount += 1;
    if (!isWriteTool(item.name)) continue;
    const path = toolPath(item.args);
    if (path && !files.includes(path)) files.push(path);
  }
  return {
    durationMs: Math.max(0, last - first),
    toolCount,
    fileCount: files.length,
    files,
  };
}

export function turnStats(items: TimelineItem[]): TurnStats {
  return statsForTurn(lastTurnItems(items));
}

export function formatTurnDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const minutes = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function isTestPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  if (/(^|\/)(__tests__|tests?|spec)(\/|$)/i.test(p)) return true;
  if (/\.(test|spec|tests)\.[^.]+$/i.test(p)) return true;
  if (/_test\.[^.]+$/i.test(p)) return true;
  if (/(^|\/)test_[^/]+$/i.test(p)) return true;
  return false;
}

export function splitDiffFiles(
  diff: string,
): { path: string; body: string }[] {
  const parts = `\n${diff}`.split(/\n(?=diff --git )/).filter((part) => part.trim());
  return parts.map((body) => {
    const plus = body.match(/^\+\+\+ (?:b\/)?(.+)$/m);
    const minus = body.match(/^--- (?:a\/)?(.+)$/m);
    const git = body.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    let path = git?.[2] ?? git?.[1] ?? "unknown";
    if (plus?.[1] && plus[1] !== "/dev/null") path = plus[1];
    else if (minus?.[1] && minus[1] !== "/dev/null") path = minus[1];
    return { path, body: body.replace(/^\n/, "") };
  });
}

export function partitionUnifiedDiff(diff: string): {
  sourceDiff: string;
  testDiff: string;
  sourceFiles: string[];
  testFiles: string[];
} {
  const source: string[] = [];
  const tests: string[] = [];
  const sourceFiles: string[] = [];
  const testFiles: string[] = [];
  for (const file of splitDiffFiles(diff)) {
    if (isTestPath(file.path)) {
      tests.push(file.body);
      testFiles.push(file.path);
    } else {
      source.push(file.body);
      sourceFiles.push(file.path);
    }
  }
  return {
    sourceDiff: source.join("\n"),
    testDiff: tests.join("\n"),
    sourceFiles,
    testFiles,
  };
}

/** Strip cwd and ./ so tool paths and git paths compare. */
export function normalizeRepoPath(path: string, cwd = ""): string {
  let next = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const root = cwd.trim().replace(/\\/g, "/").replace(/\/$/, "");
  if (root && (next === root || next.startsWith(`${root}/`)))
    next = next.slice(root.length).replace(/^\//, "");
  return next;
}

export function reviewPathsMatch(left: string, right: string, cwd = ""): boolean {
  const a = normalizeRepoPath(left, cwd);
  const b = normalizeRepoPath(right, cwd);
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** Keep only paths this turn touched, when the server could not isolate. */
export function filterDiffToFiles(
  diff: string,
  files: string[],
  cwd = "",
): string {
  if (!files.length) return diff;
  return splitDiffFiles(diff)
    .filter((file) =>
      files.some((item) => reviewPathsMatch(file.path, item, cwd)),
    )
    .map((file) => file.body)
    .join("\n");
}

/**
 * PR-Agent style: each file's hunks split into old/new with line numbers
 * injected into the new hunk so a finding can point at a line.
 */
export function formatReviewHunks(diff: string): string {
  if (!diff.trim()) return "";
  const blocks: string[] = [];
  for (const file of splitDiffFiles(diff)) {
    const hunks: string[] = [];
    const lines = file.body.split("\n");
    let oldLine = 0;
    let newLine = 0;
    let oldLines: string[] = [];
    let newLines: string[] = [];
    const flush = () => {
      if (!oldLines.length && !newLines.length) return;
      hunks.push(
        ["### old", ...oldLines, "", "### new", ...newLines].join("\n"),
      );
      oldLines = [];
      newLines = [];
    };
    for (const line of lines) {
      const header = line.match(
        /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/,
      );
      if (header) {
        flush();
        oldLine = Number(header[1]);
        newLine = Number(header[2]);
        continue;
      }
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file"))
        continue;
      if (line.startsWith("+")) {
        newLines.push(`${newLine}+ ${line.slice(1)}`);
        newLine += 1;
        continue;
      }
      if (line.startsWith("-")) {
        oldLines.push(`${oldLine}- ${line.slice(1)}`);
        oldLine += 1;
        continue;
      }
      if (line.startsWith("\\")) continue;
      const text = line.startsWith(" ") ? line.slice(1) : line;
      oldLines.push(`${oldLine}  ${text}`);
      newLines.push(`${newLine}  ${text}`);
      oldLine += 1;
      newLine += 1;
    }
    flush();
    blocks.push(`## ${file.path}\n\n${hunks.join("\n\n")}`.trim());
  }
  return blocks.join("\n\n");
}

export function scanPrechecks(sourceDiff: string, testDiff: string): string[] {
  const facts: string[] = [];
  const added = (diff: string) =>
    diff
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
  const sourceAdded = added(sourceDiff).join("\n");
  const testAdded = added(testDiff).join("\n");
  if (
    /catch\s*\([^)]*\)\s*\{\s*\}/.test(sourceAdded) ||
    /except(?:\s+\w+)?\s*:\s*(?:pass|return)\s*$/m.test(sourceAdded)
  )
    facts.push("Empty or swallowing catch/except in added source lines.");
  if (
    /\.skip\(|\.only\(|\bxit\(|\bxdescribe\(|it\.skip|describe\.skip/.test(
      testAdded,
    )
  )
    facts.push("Test file adds .skip / .only / xit / xdescribe.");
  for (const file of splitDiffFiles(testDiff)) {
    if (/\n\+\+\+ \/dev\/null(?:\n|$)/.test(file.body))
      facts.push(`Test file deleted: ${file.path}`);
  }
  return facts;
}

const REVIEW_TOOLS =
  "You may read files around the hunks and run tests to verify behaviour. Do not edit files, do not commit, do not weaken or skip tests. End with valid YAML — no approval.";

export function integrityPrompt(args: {
  userRequest: string;
  sourceHunks: string;
  testHunks: string;
  prechecks: string[];
}): string {
  const precheckBlock = args.prechecks.length
    ? [
        "",
        "## Pre-checks (facts, already verified — do not re-guess these)",
        ...args.prechecks.map((fact) => `- ${fact}`),
        "",
      ].join("\n")
    : "";
  return [
    REVIEW_TOOLS,
    "",
    "You are reviewing a code change written by an AI coding agent. You did",
    "not write it and have not seen the author's reasoning. Your job is to",
    "find where the change makes a problem invisible rather than fixing it.",
    "The SOURCE_DIFF and TEST_DIFF are this turn only.",
    "",
    "## Context limits",
    "- The attached diff is this turn, not the whole dirty tree. Read the",
    "  surrounding file when a hunk is not enough to judge a path.",
    "- Run tests when a finding depends on behaviour, not on how code looks.",
    "- If code ends at an opening brace or a statement that starts a new",
    "  scope (if, for, try), it is not incomplete. Acknowledge the visible",
    "  boundary and analyse only what is shown.",
    "- Judge only what this change introduces.",
    "",
    "## Check 1 — Masking and shortcuts",
    "Did this fix the cause, or hide the symptom? Look for:",
    "- try/catch that swallows or only logs, so the caller still sees success",
    "- hardcoded values or branches special-cased to specific inputs",
    "- heuristics that work for the observed case but not in general",
    "- tests changed, weakened, skipped, or deleted",
    "- retries, fallbacks or defaults added where the underlying failure",
    "  was never addressed",
    "- records, events or errors dropped with no signal",
    "For each: is this a correct deliberate strategy, or is it making a",
    "problem invisible? State which and why.",
    "Test-file changes get named explicitly, even if they look reasonable.",
    "",
    "## Check 2 — Bugs",
    "Logic errors, off-by-one, null/undefined paths, unhandled errors,",
    "race conditions, resource leaks, incorrect async handling.",
    "",
    "## Check 3 — Side effects",
    "Changed signatures, return shapes, removed fields, changed defaults,",
    "shared state. Do NOT speculate that something might break other code",
    "unless you can identify the specific affected path from the diff.",
    "Otherwise put it under NEEDS_VERIFICATION.",
    "",
    "## Check 4 — Security",
    "Only if concretely reachable: injection, authz gaps, secrets in code",
    "or logs, unvalidated input crossing a trust boundary.",
    "",
    "## Check 5 — Anything else",
    "Checks 1-4 are priorities, not a complete list. Report a real problem",
    "that fits none of them only if you can name its trigger and its",
    "consequence. If you can't, it goes under NEEDS_VERIFICATION.",
    "",
    "## Confidence",
    "- Clear bugs, security issues, and masking: be thorough. Do not skip a",
    "  real problem just because the trigger is narrow.",
    "- Lower-severity concerns: be certain. If you cannot explain the",
    "  problem with a concrete scenario, do not flag it.",
    "- Limited confidence but high impact (data loss, security, silent",
    "  corruption): report it, and state explicitly what is uncertain.",
    "- Otherwise prefer not reporting over guessing.",
    "",
    "## Every finding states",
    "  TRIGGER — the condition under which it goes wrong",
    "  CONSEQUENCE — what actually happens then",
    "Trace the real execution path. Do not pattern-match on how code looks.",
    "No style, naming, formatting, refactor or architecture comments.",
    "",
    "## Output — valid YAML after any tool use",
    "",
    "verdict: pass | issues_found",
    "findings:            # all of them, worst first, empty list is fine",
    "  - severity: blocker | major | minor",
    "    file: path",
    "    start_line: int",
    "    end_line: int",
    "    category: masking | bug | side_effect | security | other",
    "    trigger: |",
    "    consequence: |",
    "    uncertainty: |    # only if confidence is limited",
    "needs_verification:",
    "  - |",
    precheckBlock,
    "---",
    `USER_REQUEST: ${args.userRequest || "(empty)"}`,
    "SOURCE_DIFF:",
    args.sourceHunks.trim() || "none",
    "TEST_DIFF:",
    args.testHunks.trim() || "none",
  ].join("\n");
}

export function taskPrompt(args: {
  userRequest: string;
  sourceHunks: string;
}): string {
  return [
    REVIEW_TOOLS,
    "",
    "You are checking whether a code change does what was asked. You have",
    "not seen the author's reasoning. SOURCE_DIFF is this turn only.",
    "You may read files and run tests. Do not edit.",
    "",
    "## Step 1",
    "Restate, in your own words as a bullet list, every distinct thing",
    "USER_REQUEST asked for — including sub-tasks and implied acceptance",
    "criteria. Do this before looking at the diff.",
    "",
    "## Step 2",
    "Sort each item into exactly one bucket:",
    "  satisfied      — the diff clearly does it",
    "  partial        — started but incomplete; say which part is missing",
    "  not_satisfied  — absent from the diff",
    "  needs_human    — cannot be judged from code alone (UI, browser",
    "                   behaviour, external service, perf under load), or",
    "                   the requirement itself is ambiguous",
    "",
    "## Step 3 — Approach viability",
    "Flag the approach ONLY if it cannot work or does not address the real",
    "problem — e.g. it treats a symptom while the cause is untouched, or it",
    "will fail under conditions the request implies. Do not flag an approach",
    "that merely differs from your preference. No architecture opinions.",
    "",
    "## Step 4 — Scope creep",
    "Anything in the diff that USER_REQUEST did not ask for. Note it; do not",
    "judge it unless it carries risk.",
    "",
    "## Output — valid YAML, nothing else",
    "requirements:",
    "  - item: |",
    "    status: satisfied | partial | not_satisfied | needs_human",
    "    note: |",
    "approach_concern: |     # empty if none",
    "unrequested_changes:",
    "  - |",
    "",
    "---",
    `USER_REQUEST: ${args.userRequest || "(empty)"}`,
    "SOURCE_DIFF:",
    args.sourceHunks.trim() || "none",
  ].join("\n");
}

function extractDocument(text: string): string {
  const fences = [...text.matchAll(/```(?:yaml|yml)?\s*\n([\s\S]*?)```/gi)];
  if (fences.length) return fences[fences.length - 1]![1]!.trim();
  const start = text.search(
    /^(verdict|findings|requirements|approach_concern):/m,
  );
  return (start >= 0 ? text.slice(start) : text).trim();
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^["'](.*)["']$/);
  return quoted ? quoted[1]! : trimmed;
}

function keyedValue(src: string, key: string): string {
  const block = src.match(new RegExp(`^(\\s*)${key}:\\s*\\|\\s*$`, "m"));
  if (block) {
    const indent = block[1]!.length + 2;
    const after = src.slice((block.index ?? 0) + block[0].length);
    const lines: string[] = [];
    for (const line of after.split("\n").slice(1)) {
      if (!line.trim()) {
        if (lines.length) lines.push("");
        continue;
      }
      const lead = line.match(/^(\s*)/)![1]!.length;
      if (lead < indent) break;
      lines.push(line.slice(indent));
    }
    return lines.join("\n").trim();
  }
  const inline = src.match(new RegExp(`^(\\s*)${key}:\\s+(.*)$`, "m"));
  if (!inline) return "";
  return stripQuotes(inline[2] ?? "");
}

function dashItems(src: string, key: string): string[] {
  const header = src.match(new RegExp(`^(\\s*)${key}:\\s*$`, "m"));
  if (!header) {
    const inline = keyedValue(src, key);
    return inline && inline !== "[]" ? [inline] : [];
  }
  const base = header[1]!.length;
  const after = src.slice((header.index ?? 0) + header[0].length);
  const items: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) items.push(current.join("\n"));
    current = [];
  };
  for (const line of after.split("\n").slice(1)) {
    if (!line.trim()) {
      if (current.length) current.push("");
      continue;
    }
    const lead = line.match(/^(\s*)/)![1]!.length;
    if (lead < base + 2 && !/^\s*-\s/.test(line)) break;
    if (lead === base && !/^\s*-\s/.test(line)) break;
    const dash = line.match(new RegExp(`^\\s{${base + 2}}-\\s?(.*)$`));
    if (dash) {
      flush();
      current.push(dash[1]!);
      continue;
    }
    if (current.length) current.push(line.slice(base + 4));
  }
  flush();
  return items.map((item) => item.trim()).filter(Boolean);
}

function mappingItems(src: string, key: string): string[] {
  const header = src.match(new RegExp(`^(\\s*)${key}:\\s*$`, "m"));
  if (!header) return [];
  const base = header[1]!.length;
  const after = src.slice((header.index ?? 0) + header[0].length);
  const items: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) items.push(current.join("\n"));
    current = [];
  };
  for (const line of after.split("\n").slice(1)) {
    if (!line.trim()) {
      if (current.length) current.push("");
      continue;
    }
    const lead = line.match(/^(\s*)/)![1]!.length;
    if (lead <= base && !/^\s*-\s/.test(line)) break;
    if (new RegExp(`^\\s{${base + 2}}-\\s`).test(line)) {
      flush();
      current.push(line.replace(new RegExp(`^\\s{${base + 2}}-\\s`), ""));
      continue;
    }
    if (current.length) current.push(line.slice(base + 4));
  }
  flush();
  return items;
}

const SEVERITY: Record<string, IntegritySeverity> = {
  blocker: "blocker",
  blocking: "blocker",
  major: "major",
  concern: "major",
  bug: "major",
  minor: "minor",
  question: "minor",
  note: "minor",
  nit: "minor",
};

export function parseIntegrityReview(text: string): IntegrityReview {
  const src = extractDocument(text);
  const verdictRaw = keyedValue(src, "verdict").toLowerCase();
  const findings = mappingItems(src, "findings").map((block) => {
    const severity =
      SEVERITY[keyedValue(block, "severity").toLowerCase()] ?? "minor";
    const startLine = Number(keyedValue(block, "start_line")) || 0;
    const endLine = Number(keyedValue(block, "end_line")) || startLine;
    return {
      severity,
      file: keyedValue(block, "file"),
      startLine,
      endLine,
      category: keyedValue(block, "category"),
      trigger: keyedValue(block, "trigger"),
      consequence: keyedValue(block, "consequence"),
      uncertainty: keyedValue(block, "uncertainty"),
    } satisfies IntegrityFinding;
  });
  return {
    verdict: verdictRaw === "pass" ? "pass" : "issues_found",
    findings,
    needsVerification: dashItems(src, "needs_verification"),
  };
}

const TASK_STATUS: Record<string, TaskRequirement["status"]> = {
  satisfied: "satisfied",
  partial: "partial",
  not_satisfied: "not_satisfied",
  needs_human: "needs_human",
};

export function parseTaskReview(text: string): TaskReview {
  const src = extractDocument(text);
  const requirements = mappingItems(src, "requirements").map((block) => {
    const status =
      TASK_STATUS[keyedValue(block, "status").toLowerCase()] ?? "needs_human";
    return {
      item: keyedValue(block, "item"),
      status,
      note: keyedValue(block, "note"),
    } satisfies TaskRequirement;
  });
  return {
    requirements,
    approachConcern: keyedValue(src, "approach_concern"),
    unrequestedChanges: dashItems(src, "unrequested_changes"),
  };
}

const RANK: Record<IntegritySeverity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
};

export function mergeReviews(
  integrity: IntegrityReview,
  task: TaskReview,
): MergedReview {
  const findings = [...integrity.findings].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity],
  );
  const missing = task.requirements.filter(
    (item) => item.status === "not_satisfied",
  );
  const sendBack =
    findings.some((item) => item.severity === "blocker") || missing.length > 0;
  let verdict: MergedReview["verdict"] = "pass";
  if (sendBack) verdict = "send_back";
  else if (
    integrity.verdict === "issues_found" ||
    findings.length ||
    task.requirements.some((item) => item.status === "partial") ||
    task.approachConcern
  )
    verdict = "issues_found";
  return {
    verdict,
    findings,
    requirements: task.requirements,
    approachConcern: task.approachConcern,
    unrequestedChanges: task.unrequestedChanges,
    needsVerification: integrity.needsVerification,
    sendBack,
  };
}

export function reviewVerdictLabel(verdict: MergedReview["verdict"]): string {
  if (verdict === "send_back") return "Needs changes";
  if (verdict === "issues_found") return "Issues found";
  return "Looks good";
}

export function queueFixesPrompt(merged: MergedReview): string {
  if (merged.verdict === "pass") return "";
  const lines: string[] = [];
  if (merged.sendBack) {
    lines.push(
      "Review sent this back. It is not an approval. Address the following, then I will re-review.",
      "",
    );
  } else {
    lines.push("Review notes (not blocking). Address what is real:", "");
  }
  const listed = merged.sendBack
    ? merged.findings.filter(
        (item) => item.severity === "blocker" || item.severity === "major",
      )
    : merged.findings;
  if (listed.length) {
    lines.push("## Integrity");
    for (const item of listed) {
      const where = item.file
        ? `${item.file}:${item.startLine || "?"}${item.endLine && item.endLine !== item.startLine ? `-${item.endLine}` : ""}`
        : "unknown";
      lines.push(`- ${item.severity} ${where} [${item.category || "other"}]`);
      if (item.trigger) lines.push(`  trigger: ${item.trigger}`);
      if (item.consequence) lines.push(`  consequence: ${item.consequence}`);
    }
    lines.push("");
  }
  const missing = merged.requirements.filter(
    (item) => item.status === "not_satisfied" || item.status === "partial",
  );
  if (missing.length) {
    lines.push("## Requirements");
    for (const item of missing) {
      lines.push(`- (${item.status}) ${item.item}${item.note ? ` — ${item.note}` : ""}`);
    }
    lines.push("");
  }
  if (merged.approachConcern)
    lines.push(`## Approach\n${merged.approachConcern}`, "");
  return lines.join("\n").trim();
}
