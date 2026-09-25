import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  copyClaudeSubagents,
  cutoffIndexForTimestamp,
  forkClaudeTranscript,
  remapClaudeEntries,
} from "./claude-fork.js";

const user = (uuid, ts, text, parent = null) => ({
  type: "user",
  uuid,
  parentUuid: parent,
  sessionId: "src",
  timestamp: ts,
  message: { role: "user", content: [{ type: "text", text }] },
});
const assistant = (uuid, ts, text, parent) => ({
  type: "assistant",
  uuid,
  parentUuid: parent,
  sessionId: "src",
  timestamp: ts,
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const toolResult = (uuid, ts, parent) => ({
  type: "user",
  uuid,
  parentUuid: parent,
  sessionId: "src",
  timestamp: ts,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
  },
});

describe("cutoffIndexForTimestamp", () => {
  const entries = [
    user("u1", "2026-01-01T00:00:00.000Z", "one"),
    assistant("a1", "2026-01-01T00:00:01.000Z", "first", "u1"),
    user("u2", "2026-01-01T00:00:10.000Z", "two", "a1"),
    assistant("a2", "2026-01-01T00:00:11.000Z", "second", "u2"),
    toolResult("tr", "2026-01-01T00:00:12.000Z", "a2"),
    user("u3", "2026-01-01T00:00:20.000Z", "three", "tr"),
    assistant("a3", "2026-01-01T00:00:21.000Z", "third", "u3"),
  ];

  it("cuts after the matching assistant and its tool results", () => {
    const end = cutoffIndexForTimestamp(
      entries,
      Date.parse("2026-01-01T00:00:11.000Z"),
    );
    assert.equal(entries[end].uuid, "tr");
  });

  it("does not include the next user prompt", () => {
    const end = cutoffIndexForTimestamp(
      entries,
      Date.parse("2026-01-01T00:00:01.000Z"),
    );
    assert.equal(entries[end].uuid, "a1");
  });
});

describe("remapClaudeEntries", () => {
  it("gives every entry a new session id and remaps parent links", () => {
    const entries = [
      user("u1", "2026-01-01T00:00:00.000Z", "one"),
      assistant("a1", "2026-01-01T00:00:01.000Z", "first", "u1"),
    ];
    const mapped = remapClaudeEntries(entries, "fork-id");
    assert.equal(mapped[0].sessionId, "fork-id");
    assert.equal(mapped[1].sessionId, "fork-id");
    assert.notEqual(mapped[0].uuid, "u1");
    assert.equal(mapped[1].parentUuid, mapped[0].uuid);
    assert.equal(mapped[0].forkedFrom, "src");
  });

  it("remaps leafUuid and points cwd at the fork checkout", () => {
    const mapped = remapClaudeEntries(
      [
        user("u1", "2026-01-01T00:00:00.000Z", "one"),
        {
          type: "summary",
          leafUuid: "u1",
          cwd: "/tmp/parent",
          sessionId: "src",
        },
        { type: "summary", leafUuid: "missing", sessionId: "src" },
      ],
      "fork-id",
      "/tmp/worktree",
    );
    assert.equal(mapped[1].leafUuid, mapped[0].uuid);
    assert.equal(mapped[1].cwd, "/tmp/worktree");
    assert.equal(mapped[2].leafUuid, null);
  });
});

describe("forkClaudeTranscript", () => {
  it("writes a new jsonl that stops at the forked reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-fork-"));
    const source = join(dir, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl");
    const entries = [
      user("u1", "2026-01-01T00:00:00.000Z", "one"),
      assistant("a1", "2026-01-01T00:00:01.000Z", "first", "u1"),
      user("u2", "2026-01-01T00:00:10.000Z", "two", "a1"),
      assistant("a2", "2026-01-01T00:00:11.000Z", "second", "u2"),
    ];
    writeFileSync(source, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const forked = await forkClaudeTranscript(
      source,
      Date.parse("2026-01-01T00:00:01.000Z"),
    );
    assert.notEqual(forked.sessionId, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const written = readFileSync(forked.sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(written.length, 2);
    assert.equal(written[0].sessionId, forked.sessionId);
    assert.match(JSON.stringify(written[1].message), /first/);
    assert.doesNotMatch(JSON.stringify(written), /second/);
  });

  it("copies subagent transcripts for tool calls kept in the slice", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-fork-sub-"));
    const source = join(dir, "src.jsonl");
    const dest = join(dir, "dest.jsonl");
    const toolUse = {
      type: "assistant",
      uuid: "a1",
      sessionId: "src",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_keep", name: "Agent" }],
      },
    };
    writeFileSync(source, `${JSON.stringify(toolUse)}\n`);
    writeFileSync(dest, "\n");
    const agents = join(dir, "src", "subagents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      join(agents, "agent-1.meta.json"),
      JSON.stringify({ toolUseId: "call_keep" }),
    );
    writeFileSync(join(agents, "agent-1.jsonl"), '{"type":"assistant"}\n');
    writeFileSync(
      join(agents, "agent-2.meta.json"),
      JSON.stringify({ toolUseId: "call_later" }),
    );
    writeFileSync(join(agents, "agent-2.jsonl"), '{"type":"assistant"}\n');
    copyClaudeSubagents(source, dest, [toolUse]);
    const copied = readFileSync(
      join(dir, "dest", "subagents", "agent-1.jsonl"),
      "utf8",
    );
    assert.match(copied, /assistant/);
    assert.throws(() =>
      readFileSync(join(dir, "dest", "subagents", "agent-2.jsonl")),
    );
  });

  it("copies no children when the slice has no tool call", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-fork-empty-"));
    const source = join(dir, "src.jsonl");
    const dest = join(dir, "dest.jsonl");
    writeFileSync(source, "{}\n");
    writeFileSync(dest, "{}\n");
    const agents = join(dir, "src", "subagents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "agent-1.meta.json"), JSON.stringify({}));
    writeFileSync(join(agents, "agent-1.jsonl"), "{}\n");
    writeFileSync(
      join(agents, "agent-2.meta.json"),
      JSON.stringify({ toolUseId: "later" }),
    );
    copyClaudeSubagents(source, dest, [
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
    ]);
    assert.equal(existsSync(join(dir, "dest", "subagents")), false);
  });
});
