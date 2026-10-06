import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  timelineToMarkdown,
  exportFilename,
  transcriptFilename,
  handoffPrompt,
  planSwitch,
  type PendingHandoff,
} from "./exportSession.ts";
import { handoffNotice, splitHandoff, wrapHandoff } from "./handoffBlock.ts";
import { Timeline } from "./timeline.ts";
import type { SessionState } from "./api.ts";
import type { TimelineItem } from "./timeline.ts";

const at = new Date("2026-09-05T12:00:00.000Z");
const meta = { title: "Fix the gauge", backend: "claude", model: "sonnet-5", exportedAt: at };

test("renders turns in order with a header", () => {
  const items: TimelineItem[] = [
    { id: "1", kind: "user", text: "hello", timestamp: 1 },
    { id: "2", kind: "assistant", text: "hi", live: false, timestamp: 2 },
  ];
  const md = timelineToMarkdown(items, meta);
  assert.match(md, /^# Fix the gauge/);
  assert.match(md, /\*\*Agent:\*\* claude \(sonnet-5\)/);
  assert.ok(md.indexOf("## User") < md.indexOf("### Assistant"));
});

test("tool output containing a fence cannot escape its own block", () => {
  const items: TimelineItem[] = [
    {
      id: "t", kind: "tool", name: "bash", args: {}, details: {},
      output: "```\nnested\n```", status: "done", startedAt: 1,
    },
  ];
  const md = timelineToMarkdown(items, meta);
  // The wrapper must be longer than the longest run inside it.
  assert.ok(md.includes("````"), "expected a longer fence than the nested one");
});

test("long output is truncated with a count, not silently cut", () => {
  const items: TimelineItem[] = [
    {
      id: "t", kind: "tool", name: "bash", args: {}, details: {},
      output: "x".repeat(5000), status: "done", startedAt: 1,
    },
  ];
  assert.match(timelineToMarkdown(items, meta), /… \(1000 more characters\)/);
});

test("filenames are slugged and dated", () => {
  assert.equal(exportFilename("Fix the Gauge!", at), "fix-the-gauge-2026-09-05.md");
  assert.equal(exportFilename("", at), "session-2026-09-05.md");
});

test("full mode keeps a long turn intact for the auto-saved copy", () => {
  const long = "x".repeat(9000);
  const items: TimelineItem[] = [
    { id: "1", kind: "user", text: long, timestamp: 1 },
  ];
  assert.match(timelineToMarkdown(items, meta), /more characters/);
  assert.ok(timelineToMarkdown(items, meta, { full: true }).includes(long));
});

test("unfinished tasks are listed so a handoff knows what is next", () => {
  const md = timelineToMarkdown([], { ...meta, todos: ["Wire the sensor"] });
  assert.match(md, /## Still to do/);
  assert.match(md, /- \[ \] Wire the sensor/);
});

test("transcript name is stable for one session, distinct across sessions", () => {
  const a = transcriptFilename("/x/y/abc123def456.jsonl", "Fix the gauge");
  assert.equal(a, transcriptFilename("/x/y/abc123def456.jsonl", "Fix the gauge"));
  assert.notEqual(a, transcriptFilename("/x/y/zzz999888777.jsonl", "Fix the gauge"));
});

// --- backend-switch handoff -------------------------------------------------

let seq = 0;
const user = (text: string): TimelineItem => ({ id: `u${++seq}`, kind: "user", text, timestamp: seq });
const reply = (text: string, modelId?: string, parentToolUseId?: string): TimelineItem => ({
  id: `a${++seq}`, kind: "assistant", text, live: false, timestamp: seq,
  ...(modelId ? { modelId } : {}), ...(parentToolUseId ? { parentToolUseId } : {}),
});
const tool = (name: string, args: Record<string, unknown>): TimelineItem => ({
  id: `t${++seq}`, kind: "tool", name, args, details: {}, output: "", status: "done", startedAt: seq,
});
const notice = (from: string, to: string, record: string): TimelineItem => ({
  id: `n${++seq}`, kind: "notice", text: handoffNotice({ from, to, record }), tone: "info", timestamp: seq, detail: record,
});

/** switchBackend + send, minus React: the timeline and what each backend receives. */
function session() {
  const items: TimelineItem[] = [];
  let pending: PendingHandoff | null = null;
  let producer = "claude";
  let native: string | undefined = "claude-1.jsonl";
  const received: Record<string, string[]> = {};
  return {
    items,
    switchTo(next: string) {
      const plan = planSwitch(pending, producer, next, native);
      native = plan.back ? plan.sessionPath : undefined; // setConversationBackend drops it
      pending = plan.back ? null : { path: "/t/full.md", from: producer, sessionPath: plan.sessionPath };
      return plan;
    },
    send(backend: string, text: string, ...rest: TimelineItem[]) {
      const record = pending && pending.from !== backend
        ? handoffPrompt({ items: [...items], from: pending.from, cwd: "/repo", transcriptPath: pending.path, message: text })
        : null;
      if (record) items.push(notice(pending!.from, backend, record));
      pending = null;
      producer = backend;
      native ??= `${backend}-${seq}.jsonl`;
      (received[backend] ??= []).push(record ? wrapHandoff(text, record, "X", backend) : text);
      items.push(user(text), ...rest);
      return record;
    },
    received,
    get native() { return native; },
  };
}

test("chained A -> B -> C -> A: every new backend gets every earlier turn", () => {
  const s = session();
  s.send("claude", "Codeword PELICAN-42. Decision: SQLite, not Postgres.", reply("Noted: SQLite.", "opus"));
  s.switchTo("codex");
  const toB = s.send("codex", "Create notes.txt", tool("apply_patch", { changes: [{ path: "notes.txt", kind: "add" }] }), reply("Created notes.txt", "gpt-5"))!;
  assert.match(toB, /PELICAN-42/);
  assert.match(toB, /SQLite, not Postgres/);
  s.switchTo("pi");
  const toC = s.send("pi", "Add a line", tool("edit", { path: "README.md", oldText: "a", newText: "b" }), reply("Edited README", "glm"))!;
  assert.match(toC, /PELICAN-42/);
  assert.match(toC, /Files changed: notes\.txt/);
  assert.match(toC, /— Handed off from claude to codex —/);
  s.switchTo("claude");
  const backToA = s.send("claude", "What did each agent change?")!;
  assert.ok(backToA, "switching back after other backends ran must hand off");
  for (const want of [/PELICAN-42/, /notes\.txt/, /README\.md/, /Edited README/, /Turn 3/])
    assert.match(backToA, want);
  assert.doesNotMatch(backToA, /What did each agent change/, "the new message is not part of its own record");
  assert.match(backToA, /This is not a new session/);
  assert.match(backToA, /Workspace: `\/repo`/);
  // The user's words lead the message; the record follows.
  assert.ok(s.received.claude.at(-1)!.startsWith("What did each agent change?\n\n<handoff "));
});

test("switching straight back resumes the native session with no handoff", () => {
  const s = session();
  s.send("claude", "Codeword PELICAN-42.", reply("ok"));
  assert.deepEqual(s.switchTo("codex"), { back: false, sessionPath: "claude-1.jsonl" });
  assert.equal(s.native, undefined);
  assert.deepEqual(s.switchTo("pi"), { back: false, sessionPath: "claude-1.jsonl" });
  assert.deepEqual(s.switchTo("claude"), { back: true, sessionPath: "claude-1.jsonl" });
  assert.equal(s.native, "claude-1.jsonl");
  assert.equal(s.send("claude", "next"), null);
});

test("the block splits back into the user's words and the record", () => {
  const wrapped = wrapHandoff("Fix it\n\nAttached files:\n- a.png: /x/a.png", "### Turn 1\nUser: hi", "Claude", "Codex");
  assert.deepEqual(splitHandoff(wrapped), {
    text: "Fix it\n\nAttached files:\n- a.png: /x/a.png",
    handoff: { from: "Claude", to: "Codex", record: "### Turn 1\nUser: hi" },
  });
  assert.deepEqual(splitHandoff("plain <handoff> talk"), { text: "plain <handoff> talk" });
  assert.equal(handoffNotice({ from: "Claude", to: "Codex", record: "### Turn 1\n### Turn 2" }), "Handed off from Claude to Codex · 2 turns");
});

test("timeline: a hydrated handoff message is a notice plus the user's own words", () => {
  const timeline = new Timeline("conv-handoff");
  const record = handoffPrompt({ items: [user("Codeword PELICAN-42."), reply("ok")], from: "Claude" });
  timeline.hydrate(
    [{ role: "user", content: wrapHandoff("Create notes.txt", record, "Claude", "Codex"), timestamp: 1 }],
    { isStreaming: false } as SessionState,
  );
  const [first, second] = timeline.items;
  assert.equal(first.kind, "notice");
  assert.equal(first.kind === "notice" && first.text, "Handed off from Claude to Codex · 1 turn");
  assert.equal(first.kind === "notice" && first.detail, record);
  assert.equal(second.kind === "user" && second.text, "Create notes.txt");
});

test("timeline: a backend's echo of the handoff message adds nothing", () => {
  const timeline = new Timeline("conv-echo");
  timeline.appendNotice("Handed off from Claude to Codex · 1 turn", "info", undefined, "### Turn 1");
  timeline.appendUser("Create notes.txt");
  const before = timeline.items.length;
  timeline.handle({
    type: "message_start",
    message: { role: "user", content: wrapHandoff("Create notes.txt", "### Turn 1", "Claude", "Codex") },
  } as never);
  assert.equal(timeline.items.length, before);
});

test("a reload without carried history keeps the earlier record, once", () => {
  const first = handoffPrompt({ items: [user("Codeword PELICAN-42."), reply("ok")], from: "Claude", transcriptPath: "/t/a.md" });
  // Hydrated codex session: its first message's handoff became a notice.
  const items = [notice("Claude", "Codex", first), user("Create notes.txt"), reply("done"), user("x".repeat(9000)), reply("y")];
  const next = handoffPrompt({ items, from: "Codex" });
  assert.match(next, /Earlier handoff record/);
  assert.equal(next.split("PELICAN-42").length - 1, 1);
  assert.match(next, /### Turn 2\nUser: Create notes\.txt/);
  assert.match(next, /…\[clipped\]/);
  assert.doesNotMatch(next, /\/t\/a\.md/, "nested footers are dropped");
});

test("a twice-reloaded chain keeps every turn of every nested record", () => {
  const a = handoffPrompt({ items: [user("Codeword PELICAN-42."), reply("ok")], from: "Claude", transcriptPath: "/t/a.md" });
  const b = handoffPrompt({
    items: [notice("Claude", "Codex", a), user("Create notes.txt"), reply("Created notes.txt")],
    from: "Codex", transcriptPath: "/t/b.md", sessionFiles: ["notes.txt"],
  });
  const c = handoffPrompt({ items: [notice("Codex", "Grok", b), user("Edit README"), reply("Edited README")], from: "Grok" });
  for (const want of [/PELICAN-42/, /User: Create notes\.txt/, /Created notes\.txt/, /User: Edit README/])
    assert.match(c, want);
  assert.equal(c.split("Full transcript with").length - 1, 0, "nested footers are dropped");
  assert.equal(c.split("This is not a new session").length - 1, 1, "one header");
  assert.deepEqual([...c.matchAll(/^### Turn (\d+)/gm)].map((m) => m[1]), ["1", "2", "3"]);
});

test("prosecutor resume: the case record rides the message once, not again in the handoff", () => {
  const defense = "The prosecutor wrote failing tests against your change. Your task was: fix parse";
  const items = [user("Fix the parser"), reply("fixed"), reply("prosecutor's own text", "m", "prosecutor-1"), user(defense), reply("FIXED test_a")];
  const resume = `Prosecutor-mode case record so far (earlier rounds...)\n\n${defense}`;
  const record = handoffPrompt({ items, from: "Codex", message: resume });
  assert.doesNotMatch(record, /prosecutor round/);
  assert.doesNotMatch(record, /prosecutor's own text/);
  assert.match(record, /Fix the parser/);
  assert.equal(wrapHandoff(resume, record, "Codex", "Claude").split("Prosecutor-mode case record").length - 1, 1);
  assert.match(handoffPrompt({ items, from: "Codex", message: "go on" }), /\[prosecutor round/);
});

test("a long session keeps the first ask and the newest turns within budget", () => {
  const items = Array.from({ length: 60 }, (_, i) => [user(`ask ${i} ${"x".repeat(1500)}`), reply(`done ${i}`)]).flat();
  const record = handoffPrompt({ items, from: "Pi" });
  assert.ok(record.length < 27000, String(record.length));
  assert.match(record, /ask 0 /);
  assert.match(record, /ask 59 /);
  assert.match(record, /middle turn\(s\) omitted/);
});
