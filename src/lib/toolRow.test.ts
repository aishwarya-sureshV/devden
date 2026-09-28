import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { TimelineItem } from "./timeline.ts";
import {
  describeTool,
  formatDuration,
  groupTranscriptRows,
  liveFraction,
  splitArgPath,
  unknownProgress,
} from "./toolRow.ts";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

function tool(partial: Partial<ToolItem> & Pick<ToolItem, "name">): ToolItem {
  return {
    id: partial.id ?? partial.name,
    kind: "tool",
    name: partial.name,
    args: partial.args ?? {},
    details: partial.details ?? {},
    output: partial.output ?? "",
    status: partial.status ?? "done",
    startedAt: partial.startedAt ?? 1_000,
    elapsed: partial.elapsed,
  };
}

test("paths inside the workspace keep the directory dim and the file bright", () => {
  const row = describeTool(
    tool({
      name: "read",
      args: { path: "/repo/src/App.tsx" },
      output: "a\nb\n",
      elapsed: 400,
    }),
    "/repo",
  );
  assert.equal(row.prefix, "src/");
  assert.equal(row.main, "App.tsx");
  assert.equal(row.tag, "");
  assert.equal(row.duration, "");
  assert.equal(row.parts[0]?.text, "2");
  assert.equal(row.parts[1]?.text, " lines");
  assert.equal(row.thread, "settled");
});

test("paths outside the workspace get a tmp or uploads tag and only the tail", () => {
  const tmp = splitArgPath("/tmp/devden/note.txt", "/repo");
  assert.equal(tmp.tag, "tmp");
  assert.equal(tmp.name, "note.txt");
  const uploads = splitArgPath(
    "/var/folders/x/devden-uploads/conv/shot.png",
    "/repo",
  );
  assert.equal(uploads.tag, "uploads");
  assert.equal(uploads.name, "shot.png");
});

test("unknown progress opens quickly and keeps climbing without stepping backward", () => {
  const a = unknownProgress(0);
  const b = unknownProgress(400);
  const c = unknownProgress(2000);
  const d = unknownProgress(12000);
  assert.ok(b > 0.2, `400ms should already be visibly underway, got ${b}`);
  assert.ok(a < b && b < c && c < d);
  assert.ok(d < 0.95);
});

test("a live log's latest n of m is the bar's real progress", () => {
  assert.equal(liveFraction(""), null);
  assert.equal(liveFraction("1 of 14 failed"), 1 / 14);
  assert.ok(Math.abs((liveFraction("running 3 of 14\n12 of 14") ?? 0) - 12 / 14) < 0.001);
});

test("a short call hides its duration and a long one keeps it", () => {
  assert.equal(formatDuration(400), "");
  assert.equal(formatDuration(1200), "1.2s");
  assert.equal(formatDuration(400, true), "0.4s");
});

test("grep reports matches and files, and an empty search is not a failure", () => {
  const hit = describeTool(
    tool({
      name: "grep",
      args: { pattern: "border", path: "/repo/src" },
      output: "src/a.ts:1:border\nsrc/b.ts:2:border\n",
    }),
    "/repo",
  );
  assert.equal(hit.main, '"border"');
  assert.equal(hit.suffix, " in src/");
  assert.equal(hit.parts.map((part) => part.text).join(""), "2 matches · 2 files");
  assert.equal(hit.thread, "settled");

  const none = describeTool(
    tool({ name: "grep", args: { pattern: "nope" }, output: "" }),
  );
  assert.equal(none.parts[0]?.text, "no matches");
  assert.equal(none.thread, "settled");
});

test("an edit shows added and removed counts, not a done flag", () => {
  const row = describeTool(
    tool({
      name: "edit",
      args: {
        path: "/repo/src/App.tsx",
        old_string: "a\nb",
        new_string: "a\nb\nc",
      },
      elapsed: 1500,
    }),
    "/repo",
  );
  assert.equal(row.duration, "1.5s");
  assert.equal(row.parts.some((part) => part.tone === "add"), true);
  assert.equal(row.parts.some((part) => part.text === "done"), false);
  assert.equal(row.detail, "diff");
});

test("a missing file is a tool error with a note, not a generic error word", () => {
  const row = describeTool(
    tool({
      name: "read",
      args: { path: "/repo/src/Missing.tsx" },
      status: "error",
      output: "No such file. Closest match: src/components/Pane.tsx",
    }),
    "/repo",
  );
  assert.equal(row.thread, "failed");
  assert.equal(row.parts[0]?.text, "not found");
  assert.match(row.note, /Closest match: src\/components\/Pane\.tsx/);
  assert.equal(row.breakAt, 32);
});

test("a denied command is struck through and is not red", () => {
  const row = describeTool(
    tool({
      name: "bash",
      args: { command: "git push origin main" },
      status: "error",
      output: "Denied by user",
      elapsed: 2000,
    }),
  );
  assert.equal(row.thread, "denied");
  assert.equal(row.strike, true);
  assert.equal(row.dimVerb, true);
  assert.equal(row.prefix, "$ ");
  assert.equal(row.main, "git push origin main");
  assert.equal(row.duration, "");
});

test("reads and searches fold only after the next non-read tool starts", () => {
  const read = (id: string, name = "read") =>
    tool({ id, name, args: { path: `/repo/${id}.ts` }, output: "x\n" });
  const open = groupTranscriptRows([
    read("a"),
    read("b", "grep"),
    { id: "say", kind: "assistant", text: "looking", live: false, timestamp: 2 },
  ]);
  assert.equal(open.some((block) => block.type === "explored"), false);

  const folded = groupTranscriptRows([
    read("a"),
    read("b"),
    tool({ id: "edit", name: "edit", args: { path: "/repo/a.ts", old_string: "x", new_string: "y" } }),
  ]);
  assert.equal(folded[0]?.type, "explored");
  if (folded[0]?.type === "explored") {
    assert.equal(folded[0].calls, 2);
    assert.equal(folded[0].entries.length, 2);
  }
  assert.equal(folded[1]?.type, "item");
});

test("the same file read three times collapses to one row", () => {
  const read = (id: string) =>
    tool({ id, name: "read", args: { path: "/repo/src/App.tsx" }, output: "a\n" });
  const rows = groupTranscriptRows([read("1"), read("2"), read("3")]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.type, "item");
  if (rows[0]?.type === "item") assert.equal(rows[0].repeat, 3);
});
