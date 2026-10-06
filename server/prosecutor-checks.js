/**
 * Prosecutor mode's server-side checks -- what the prompts only ask for,
 * enforced: test-file ownership and integrity, the prosecutor's edit
 * boundary, and the acceptance gate the server itself runs.
 *
 * Gate commands come only from the user's per-workspace config (stored in
 * DevDen's own database, outside the repository the agents can write), never
 * from a model's report: the server never executes a model-chosen command.
 */
import { spawn } from "node:child_process";
import { realpath, rm } from "node:fs/promises";
import { isAbsolute, join, matchesGlob, relative } from "node:path";
import { git, withScratchIndex } from "./snapshots.js";

export const DEFAULT_TEST_PATTERNS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "test/**",
  "tests/**",
  "**/test/**",
  "**/tests/**",
];
const DEFAULT_TIMEOUT_SEC = 300;
const OUTPUT_CHARS = 6000;

/** A user's gate config, validated: this is a trust boundary. */
export function normalizeConfig(raw) {
  const strings = (value, max, len) =>
    (Array.isArray(value) ? value : [])
      .map((item) => String(item ?? "").trim())
      .filter((item) => item && item.length <= len)
      .slice(0, max);
  const patterns = strings(raw?.testPatterns, 50, 200);
  const commands = (Array.isArray(raw?.commands) ? raw.commands : [])
    .map((item) => (typeof item === "string" ? { run: item } : item))
    .map((item) => ({
      run: String(item?.run ?? "").trim(),
      timeoutSec: Math.min(3600, Math.max(1, Math.round(Number(item?.timeoutSec) || DEFAULT_TIMEOUT_SEC))),
    }))
    .filter((item) => item.run && item.run.length <= 500)
    .slice(0, 10);
  return { testPatterns: patterns.length ? patterns : DEFAULT_TEST_PATTERNS, commands };
}

export const isTestPath = (path, patterns = DEFAULT_TEST_PATTERNS) =>
  patterns.some((pattern) => matchesGlob(path, pattern));

/** Repo-relative and inside the repo: an absolute path or a `..` would make
 *  git refuse the whole pathspec, and the integrity check fail open. */
export const isRepoPath = (path) =>
  Boolean(path) && !isAbsolute(path) && !path.split("/").includes("..");

/** `git diff --name-status` output -> [{ status, path }]. */
export function parseNameStatus(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.match(/^([AMDT])\t(.+)$/))
    .filter(Boolean)
    .map(([, status, path]) => ({ status, path }));
}

/** Test files a report points at as path:line (its failing tests). */
export function reportedTestFiles(report, patterns) {
  const found = new Set();
  for (const [, path] of String(report ?? "").matchAll(/([\w./@-]+\.[A-Za-z]+):\d+/g)) {
    // file:///abs/path (a link) and absolute paths: git's own change list
    // already covers the files a round touched.
    const clean = path.replace(/^\.\//, "");
    if (isRepoPath(clean) && isTestPath(clean, patterns)) found.add(clean);
  }
  return [...found];
}

const toplevel = async (cwd) => {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return top.ok ? top.out : null;
};

/** Unified diff from `commit` to the working tree for `paths` (new files included). */
async function diffPaths(cwd, commit, paths, args = []) {
  const top = await toplevel(cwd);
  if (!top) return null;
  const result = await withScratchIndex(top, async (env) => {
    const staged = await git(top, ["add", "-A"], env);
    if (!staged.ok) return staged;
    return git(top, ["diff", "--cached", "--no-renames", ...args, commit, "--", ...paths], env);
  });
  return result?.ok ? result.out : null;
}

// Lines that, removed, take a check away -- or, added, switch one off.
const CHECK_LINE = /\b(assert\w*|expect|should)\b|\b(test|it|describe)\s*\(|^\s*def test_|t\.(Error|Fatal)/;
const DISABLE_LINE = /\.(skip|only|todo)\b|\b(xit|xtest|xdescribe)\s*\(|\bskip\s*:\s*true|@pytest\.mark\.(skip|xfail)|\bt\.Skip\(|#\[ignore\]/;

/** What an edit to one test file did, from its unified diff. */
export function weakening(patch) {
  let removedChecks = 0;
  let disabled = 0;
  for (const line of String(patch ?? "").split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("-") && CHECK_LINE.test(line.slice(1))) removedChecks += 1;
    if (line.startsWith("+") && DISABLE_LINE.test(line.slice(1))) disabled += 1;
  }
  return { removedChecks, disabled };
}

/**
 * The executor's repair against the prosecutor's tests: every owned file
 * changed or deleted since the round-end snapshot. Null when git can't tell.
 */
export async function checkIntegrity(cwd, commit, owned) {
  owned = (owned ?? []).filter(isRepoPath);
  if (!commit || !owned.length) return [];
  const status = await diffPaths(cwd, commit, owned, ["--name-status"]);
  if (status == null) return null;
  const flags = [];
  for (const { status: kind, path } of parseNameStatus(status)) {
    if (kind === "D") {
      flags.push({ path, kind: "deleted" });
      continue;
    }
    const patch = (await diffPaths(cwd, commit, [path])) ?? "";
    flags.push({ path, kind: "edited", ...weakening(patch) });
  }
  return flags;
}

export const describeFlags = (flags) =>
  flags
    .map((flag) =>
      flag.kind === "deleted"
        ? `${flag.path} deleted`
        : `${flag.path} edited${flag.removedChecks ? `, ${flag.removedChecks} check line(s) removed` : ""}${flag.disabled ? `, ${flag.disabled} skip/only/todo added` : ""}`,
    )
    .join("; ");

/**
 * Split the prosecutor's round changes at the edit boundary: test files it
 * now owns, and everything else (a breach). Null when git can't tell.
 */
export async function prosecutorChanges(cwd, commit, patterns) {
  if (!commit) return null;
  const top = await toplevel(cwd);
  if (!top) return null;
  const result = await withScratchIndex(top, async (env) => {
    const staged = await git(top, ["add", "-A"], env);
    if (!staged.ok) return staged;
    return git(top, ["diff", "--cached", "--name-status", "--no-renames", commit], env);
  });
  if (!result?.ok) return null;
  const tests = [];
  const breach = [];
  for (const change of parseNameStatus(result.out))
    (isTestPath(change.path, patterns) ? tests : breach).push(change);
  return { tests, breach };
}

/** Put breached files back as they were at `commit` (added ones removed). */
export async function revertChanges(cwd, commit, changes) {
  const top = await toplevel(cwd);
  if (!top) return false;
  const restore = changes.filter((change) => change.status !== "A").map((change) => change.path);
  if (restore.length) {
    const done = await git(top, ["restore", `--source=${commit}`, "--worktree", "--", ...restore]);
    if (!done.ok) return false;
  }
  for (const change of changes.filter((item) => item.status === "A"))
    await rm(join(top, change.path), { force: true, recursive: true });
  return true;
}

const shellQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

/** Run one configured command; never throws. */
export function runCommand(command, cwd, timeoutSec) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    let child;
    try {
      // detached: a timeout kills the whole process group, not just sh.
      child = spawn("/bin/sh", ["-c", command], {
        cwd,
        detached: true,
        env: { ...process.env, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ command, ok: false, exitCode: null, timedOut: false, ms: 0, output: String(error?.message ?? error) });
      return;
    }
    const keep = (chunk) => {
      output = (output + chunk).slice(-OUTPUT_CHARS * 2);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutSec * 1000);
    const done = (exitCode, extra = "") => {
      clearTimeout(timer);
      const tail = (output + extra).slice(-OUTPUT_CHARS);
      resolve({ command, ok: !timedOut && exitCode === 0, exitCode, timedOut, ms: Date.now() - started, output: tail });
    };
    child.on("error", (error) => done(null, `\n${error.message}`));
    child.on("close", (code) => done(code));
  });
}

/**
 * The acceptance gate: every configured command, in order. A command with
 * `{file}` runs once per prosecutor test file (paths shell-quoted: their
 * names were chosen by a model). Empty config -> { configured: false }.
 */
export async function runGate(cwd, config, owned = []) {
  owned = owned.filter(isRepoPath);
  if (!config?.commands?.length) return { configured: false, ok: false, results: [] };
  const top = (await toplevel(cwd)) ?? cwd;
  // git reports the real path (macOS: /var -> /private/var); match it.
  const here = await realpath(cwd).catch(() => cwd);
  const results = [];
  for (const { run, timeoutSec } of config.commands) {
    const expanded = run.includes("{file}")
      ? owned.map((path) => run.replaceAll("{file}", shellQuote(relative(here, join(top, path)) || ".")))
      : [run];
    if (!expanded.length)
      results.push({ command: run, ok: false, exitCode: null, timedOut: false, ms: 0, output: "No prosecutor test files to run it on." });
    for (const command of expanded) results.push(await runCommand(command, cwd, timeoutSec));
  }
  return { configured: true, ok: results.every((result) => result.ok), results, at: Date.now() };
}

export const gateSummary = (gate) =>
  gate.results
    .map((result) => `${result.ok ? "pass" : result.timedOut ? "TIMED OUT" : `FAIL (exit ${result.exitCode})`}: ${result.command}`)
    .join("\n");

/** The gate's failures, as a report the executor can repair from. */
export function gateReport(gate) {
  const failed = gate.results.filter((result) => !result.ok);
  return `The server ran the workspace's acceptance gate after the prosecutor acquitted, and it did not pass:

${failed
  .map(
    (result) =>
      `$ ${result.command}\n${result.timedOut ? "(timed out -- killed)\n" : `(exit ${result.exitCode})\n`}${result.output.trim()}`,
  )
  .join("\n\n")}

Fix the code so these commands pass.`;
}

/**
 * Structured findings, leniently: `FINDING <id> | requirement: "..." |
 * test: path:line name | command: ...`. A report without the block falls
 * back to its path:line references, so formatting never stops the loop.
 */
export function parseFindings(report) {
  const text = String(report ?? "");
  const findings = [];
  for (const [, id, rest] of text.matchAll(/^[\s>*_-]*FINDING\W*\s*([A-Za-z]*\d+|[A-Za-z][\w-]*)\s*[:|-]?\s*(.*)$/gim)) {
    const finding = { id: id.toUpperCase() };
    for (const part of rest.split("|")) {
      const field = part.match(/^\s*\**\s*(requirement|test|command)\s*\**\s*[:=]\s*(.+?)\s*$/i);
      if (field) finding[field[1].toLowerCase()] = field[2].replace(/^["“]|["”]$/g, "");
    }
    if (finding.test || finding.requirement) findings.push(finding);
  }
  if (findings.length) return findings;
  const refs = [...new Set([...text.matchAll(/([\w./@-]+\.[A-Za-z]+:\d+)/g)].map((match) => match[1]))];
  return refs.map((test, index) => ({ id: `F${index + 1}`, test }));
}

/** The executor's OBJECTION lines -> [{ target, reason }]. */
export function parseObjections(reply) {
  return [...String(reply ?? "").matchAll(/OBJECTION\W*\s*(.+?)\s+(?:--|—|–)\s+(.+)$/gim)].map(
    ([, target, reason]) => ({ target: target.trim(), reason: reason.trim() }),
  );
}
