/**
 * Project-wide content search and go-to-definition.
 *
 * `git grep` does the work: it already knows the repo's ignore rules, skips
 * binaries, and is far faster than walking the tree in JS. When the root is not
 * a git repo we fall back to plain `grep -r` with the same directory skips the
 * file picker uses. Neither goes through a shell — every value is an argv entry
 * — but callers are still validated below, because a pathological regex costs
 * CPU even without injection.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

const MAX_MATCHES = 200;
const MAX_PREVIEW = 400;
const GREP_TIMEOUT_MS = 10_000;

// Mirrors SEARCH_SKIP in index.js: directories whose contents are never source.
const SKIP_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "DerivedData",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "graphify-out",
  "worktrees",
];

/** Identifiers we will look up. Anything else is not a symbol worth grepping. */
const SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;

function run(command, args, cwd) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, timeout: GREP_TIMEOUT_MS });
    } catch {
      return resolve({ code: -1, stdout: "" });
    }
    const chunks = [];
    let size = 0;
    child.stdout.on("data", (chunk) => {
      // Cap what we buffer: a one-letter query in a big repo can emit MBs long
      // before we have collected MAX_MATCHES worth of lines.
      if (size > 8 << 20) return child.kill();
      size += chunk.length;
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => resolve({ code: -1, stdout: "" }));
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout: Buffer.concat(chunks).toString("utf8") }),
    );
  });
}

/**
 * Parse `git grep -z -n` output: `path NUL line NUL content LF` per match.
 * Splitting on NUL rather than `:` is the whole point — paths and matched text
 * both contain colons, so the naive split mis-parses real code.
 */
function parseNullGrep(stdout, root) {
  const matches = [];
  let truncated = false;
  let offset = 0;
  while (offset < stdout.length) {
    const pathEnd = stdout.indexOf("\0", offset);
    if (pathEnd === -1) break;
    const relativePath = stdout.slice(offset, pathEnd);
    const lineEnd = stdout.indexOf("\0", pathEnd + 1);
    if (lineEnd === -1) break;
    const line = Number(stdout.slice(pathEnd + 1, lineEnd));
    let contentEnd = stdout.indexOf("\n", lineEnd + 1);
    if (contentEnd === -1) contentEnd = stdout.length;
    const preview = stdout.slice(lineEnd + 1, contentEnd);
    offset = contentEnd + 1;
    if (!relativePath || !Number.isFinite(line)) continue;
    matches.push({
      path: join(root, relativePath),
      relativePath,
      line,
      preview: preview.slice(0, MAX_PREVIEW),
    });
    if (matches.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
  }
  return { matches, truncated };
}

/** Parse `grep -rn` output: `path:line:content`, path first so colons in the
 *  matched text stay in the preview where they belong. */
function parsePlainGrep(stdout, root) {
  const matches = [];
  let truncated = false;
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    const first = raw.indexOf(":");
    const second = raw.indexOf(":", first + 1);
    if (first === -1 || second === -1) continue;
    const line = Number(raw.slice(first + 1, second));
    if (!Number.isFinite(line)) continue;
    const relativePath = raw.slice(0, first).replace(/^\.\//, "");
    matches.push({
      path: join(root, relativePath),
      relativePath,
      line,
      preview: raw.slice(second + 1).slice(0, MAX_PREVIEW),
    });
    if (matches.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
  }
  return { matches, truncated };
}

/** 1-based column of `query` within `preview`, for placing the cursor. */
function columnOf(preview, query, caseSensitive) {
  const haystack = caseSensitive ? preview : preview.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const index = haystack.indexOf(needle);
  return index === -1 ? 1 : index + 1;
}

/**
 * Search file contents under `root`.
 * `regex` opts into ERE; the default is a fixed-string search, which is both
 * what people mean by "find in files" and immune to a pasted `(a+)+` stalling
 * the server.
 */
export async function grepWorkspace(root, query, options = {}) {
  const needle = String(query ?? "").trim();
  if (!needle) return { ok: true, matches: [], truncated: false };
  if (needle.length > 512)
    return { ok: false, error: "Search text is too long." };

  const { caseSensitive = false, wholeWord = false, regex = false } = options;
  // --untracked so a file created since the last commit is still findable;
  // ignored paths stay out either way.
  const flags = ["-I", "-n", "-z", "--untracked", regex ? "-E" : "-F"];
  if (!caseSensitive) flags.push("-i");
  if (wholeWord) flags.push("-w");

  const git = await run("git", ["-C", root, "grep", ...flags, "-e", needle], root);
  // git grep exits 1 for "no matches" and 128 for "not a git repository".
  const parsed =
    git.code === 0 || git.code === 1
      ? parseNullGrep(git.stdout, root)
      : parsePlainGrep(
          (
            await run(
              "grep",
              [
                "-rIn",
                regex ? "-E" : "-F",
                ...(caseSensitive ? [] : ["-i"]),
                ...(wholeWord ? ["-w"] : []),
                ...SKIP_DIRS.map((dir) => `--exclude-dir=${dir}`),
                "-e",
                needle,
                ".",
              ],
              root,
            )
          ).stdout,
          root,
        );

  return {
    ok: true,
    truncated: parsed.truncated,
    matches: parsed.matches.map((match) => ({
      ...match,
      column: columnOf(match.preview, needle, caseSensitive),
    })),
  };
}

/**
 * Where is `symbol` defined? Three ERE patterns cover declaration syntax across
 * the languages this repo sees: a `<keyword> name` declaration, a `name = ...`
 * binding of a function or arrow, and a bare `name(...)` signature (methods,
 * Go/C-style functions). Character classes stand in for `\b`, which git's ERE
 * does not portably support.
 *
 * ponytail: grep heuristic, not a language server — it cannot tell two
 * same-named symbols apart, so it returns every candidate ranked and lets the
 * caller pick. Swap in an LSP client if cross-file type resolution is ever
 * needed.
 */
export async function findDefinition(root, symbol) {
  const name = String(symbol ?? "").trim();
  if (!SYMBOL.test(name))
    return { ok: false, error: "Not a symbol that can be looked up." };

  const edge = "[^[:alnum:]_$]";
  const patterns = [
    `(^|${edge})(function|class|interface|type|enum|struct|trait|impl|def|fn|const|let|var)[[:space:]]+${name}(${edge}|$)`,
    `(^|${edge})${name}[[:space:]]*[:=][[:space:]]*(async[[:space:]]+)?(function(${edge}|$)|\\(|<)`,
    `(^|${edge})${name}[[:space:]]*\\(.*\\)[[:space:]]*(\\{|:|->|=>)`,
  ];
  const args = ["-C", root, "grep", "-I", "-n", "-z", "--untracked", "-E"];
  for (const pattern of patterns) args.push("-e", pattern);

  const git = await run("git", args, root);
  if (git.code !== 0 && git.code !== 1)
    return { ok: true, matches: [], truncated: false };

  const { matches } = parseNullGrep(git.stdout, root);
  return { ok: true, matches: rankDefinitions(matches, name), truncated: false };
}

/**
 * Best guess first: an exported/keyword declaration beats an assignment, source
 * beats tests and type stubs, and shallower paths beat deep ones.
 */
function rankDefinitions(matches, name) {
  const declaring = new RegExp(
    `\\b(function|class|interface|type|enum|struct|trait|impl|def|fn)\\s+${name}\\b`,
  );
  return matches
    .map((match) => ({
      match,
      score:
        (declaring.test(match.preview) ? 0 : 2) +
        (/\b(export|pub)\b/.test(match.preview) ? 0 : 1) +
        (/(\.test\.|\.spec\.|[/_]tests?[/_]|\.d\.ts$)/.test(match.relativePath)
          ? 4
          : 0),
      depth: match.relativePath.split("/").length,
    }))
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.depth - right.depth ||
        left.match.relativePath.localeCompare(right.match.relativePath),
    )
    .slice(0, 50)
    .map(({ match }) => ({
      ...match,
      column: Math.max(1, match.preview.indexOf(name) + 1),
    }));
}

export const __test__ = { parseNullGrep, parsePlainGrep, rankDefinitions, columnOf };
