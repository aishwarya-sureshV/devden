/**
 * Tests for project-wide search and go-to-definition. The parsers are the part
 * worth pinning: `git grep -z` output is NUL-delimited precisely because paths
 * and matched source both contain colons, and a naive split silently returns
 * wrong line numbers rather than failing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { grepWorkspace, findDefinition, __test__ } from "./workspace-search.js";

const run = promisify(execFile);
const { parseNullGrep, parsePlainGrep, rankDefinitions, columnOf } = __test__;

describe("grep output parsing", () => {
  it("splits git grep -z records on NUL, not on colons in the source", () => {
    const stdout = 'src/a.ts\u0000' + '12\u0000' + 'const url = "http://x:8080"\n';
    const { matches } = parseNullGrep(stdout, "/root");
    assert.deepEqual(matches, [
      {
        path: "/root/src/a.ts",
        relativePath: "src/a.ts",
        line: 12,
        preview: 'const url = "http://x:8080"',
      },
    ]);
  });

  it("keeps colons in the preview when parsing plain grep -rn", () => {
    const { matches } = parsePlainGrep("./src/a.ts:12:a: b: c\n", "/root");
    assert.equal(matches[0].relativePath, "src/a.ts");
    assert.equal(matches[0].line, 12);
    assert.equal(matches[0].preview, "a: b: c");
  });

  it("reports truncation past the match cap", () => {
    const stdout = "a.ts\u00001\u0000x\n".repeat(250);
    const { matches, truncated } = parseNullGrep(stdout, "/root");
    assert.equal(matches.length, 200);
    assert.equal(truncated, true);
  });

  it("finds the column case-insensitively, defaulting to 1", () => {
    assert.equal(columnOf("const Foo = 1", "foo", false), 7);
    assert.equal(columnOf("const Foo = 1", "foo", true), 1);
  });
});

describe("definition ranking", () => {
  it("puts a declaration ahead of a call site and tests last", () => {
    const ranked = rankDefinitions(
      [
        { relativePath: "src/use.ts", preview: "  parse(input)", line: 4 },
        { relativePath: "src/parse.test.ts", preview: "function parse() {}", line: 1 },
        { relativePath: "src/parse.ts", preview: "export function parse() {}", line: 9 },
      ],
      "parse",
    );
    assert.deepEqual(
      ranked.map((match) => match.relativePath),
      ["src/parse.ts", "src/use.ts", "src/parse.test.ts"],
    );
  });
});

describe("against a real repository", () => {
  it("greps content and locates a definition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-search-"));
    try {
      await run("git", ["init", "-q"], { cwd: dir });
      await writeFile(join(dir, "lib.ts"), "export function widget() {\n  return 1\n}\n");
      await writeFile(join(dir, "use.ts"), "import { widget } from './lib'\nwidget()\n");
      await run("git", ["add", "."], { cwd: dir });

      const found = await grepWorkspace(dir, "widget");
      assert.equal(found.ok, true);
      assert.equal(found.matches.length, 3);
      assert.ok(found.matches.every((match) => match.line >= 1 && match.column >= 1));

      const definition = await findDefinition(dir, "widget");
      assert.equal(definition.matches[0].relativePath, "lib.ts");
      assert.equal(definition.matches[0].line, 1);

      // A fixed-string search must not treat the query as a pattern.
      assert.deepEqual((await grepWorkspace(dir, "wid.et")).matches, []);
      assert.equal((await grepWorkspace(dir, "wid.et", { regex: true })).matches.length, 3);

      assert.equal((await findDefinition(dir, "a b")).ok, false);
      assert.deepEqual((await grepWorkspace(dir, "  ")).matches, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
