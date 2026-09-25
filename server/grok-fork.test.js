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
  copyGrokForkSidecars,
  grokChatHasTurns,
  promptIndexFromTimestamp,
  resolvePromptIndex,
  seedGrokForkJournals,
  sliceMessagesThroughPrompt,
  trimGrokChatHistory,
  trimGrokUpdates,
} from "./grok-fork.js";

describe("sliceMessagesThroughPrompt", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "a1" }], timestamp: 2 },
    { role: "user", content: [{ type: "text", text: "two" }], timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "a2" }], timestamp: 4 },
    { role: "user", content: [{ type: "text", text: "three" }], timestamp: 5 },
    { role: "assistant", content: [{ type: "text", text: "a3" }], timestamp: 6 },
  ];

  it("keeps through the first user turn", () => {
    const sliced = sliceMessagesThroughPrompt(messages, 0);
    assert.deepEqual(
      sliced.map((m) => m.role + (m.content[0].text)),
      ["userone", "assistanta1"],
    );
  });

  it("keeps through a later turn", () => {
    const sliced = sliceMessagesThroughPrompt(messages, 1);
    assert.equal(sliced.length, 4);
    assert.equal(sliced.at(-1).content[0].text, "a2");
  });
});

describe("promptIndexFromTimestamp", () => {
  const messages = [
    { role: "user", timestamp: 10 },
    { role: "assistant", timestamp: 20 },
    { role: "user", timestamp: 30 },
    { role: "assistant", timestamp: 40 },
  ];
  it("maps an assistant timestamp to its user-turn index", () => {
    assert.equal(promptIndexFromTimestamp(messages, 20), 0);
    assert.equal(promptIndexFromTimestamp(messages, 41), 1);
  });
});

describe("trimGrokChatHistory", () => {
  const log = [
    JSON.stringify({ type: "user", synthetic_reason: "info", content: [] }),
    JSON.stringify({ type: "user", prompt_index: 0, content: [{ type: "text", text: "first" }] }),
    JSON.stringify({ type: "assistant", content: [{ type: "text", text: "a1" }] }),
    JSON.stringify({ type: "user", prompt_index: 1, content: [{ type: "text", text: "second" }] }),
    JSON.stringify({ type: "assistant", content: [{ type: "text", text: "a2" }] }),
  ].join("\n");

  it("drops user turns after the fork point", () => {
    const trimmed = trimGrokChatHistory(log, 0);
    assert.match(trimmed, /first/);
    assert.match(trimmed, /"a1"/);
    assert.doesNotMatch(trimmed, /second/);
    assert.doesNotMatch(trimmed, /"a2"/);
  });

  it("counts real user rows when prompt_index is missing", () => {
    const old = [
      JSON.stringify({ type: "user", content: [{ type: "text", text: "first" }] }),
      JSON.stringify({ type: "assistant", content: [{ type: "text", text: "a1" }] }),
      JSON.stringify({ type: "user", content: [{ type: "text", text: "second" }] }),
      JSON.stringify({ type: "assistant", content: [{ type: "text", text: "a2" }] }),
    ].join("\n");
    const trimmed = trimGrokChatHistory(old, 0);
    assert.match(trimmed, /first/);
    assert.doesNotMatch(trimmed, /second/);
  });
});

describe("resolvePromptIndex", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "one" }] },
    { role: "assistant", content: [{ type: "text", text: "a1" }] },
    { role: "user", content: [{ type: "text", text: "two" }] },
    { role: "assistant", content: [{ type: "text", text: "a2" }] },
  ];

  it("corrects an index that counted an extra user row", () => {
    assert.equal(resolvePromptIndex(messages, 1, "one"), 0);
    assert.equal(resolvePromptIndex(messages, 0, "one"), 0);
    assert.equal(resolvePromptIndex(messages, 5, "nope"), 1);
  });
});

describe("trimGrokUpdates", () => {
  const log = [
    JSON.stringify({
      params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "one" } } },
    }),
    JSON.stringify({
      params: { update: { sessionUpdate: "agent_message_chunk" } },
    }),
    JSON.stringify({
      params: { update: { sessionUpdate: "turn_completed", prompt_id: "p0" } },
    }),
    JSON.stringify({
      params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "two" } } },
    }),
    JSON.stringify({
      params: { update: { sessionUpdate: "turn_completed", prompt_id: "p1" } },
    }),
  ].join("\n");

  it("stops after the requested number of completed turns", () => {
    const trimmed = trimGrokUpdates(log, 1);
    assert.match(trimmed, /"p0"/);
    assert.doesNotMatch(trimmed, /"p1"/);
    assert.doesNotMatch(trimmed, /two/);
  });
});

describe("grokChatHasTurns", () => {
  it("ignores a system reminder with no real user turn", () => {
    const log = [
      JSON.stringify({ type: "system", content: [] }),
      JSON.stringify({
        type: "user",
        synthetic_reason: "system_reminder",
        content: [{ type: "text", text: "<user_info>cwd</user_info>" }],
      }),
    ].join("\n");
    assert.equal(grokChatHasTurns(log), false);
  });

  it("counts a real <user_query> turn", () => {
    const log = JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "<user_query>hello</user_query>" }],
    });
    assert.equal(grokChatHasTurns(log), true);
  });
});

describe("seedGrokForkJournals", () => {
  it("copies source journals when the ACP fork wrote no real turns", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-fork-"));
    const sourceDir = join(root, "source");
    const destDir = join(root, "dest");
    mkdirSync(sourceDir);
    mkdirSync(destDir);
    const sourceFile = join(sourceDir, "chat_history.jsonl");
    const destFile = join(destDir, "chat_history.jsonl");
    const history = [
      JSON.stringify({
        type: "user",
        prompt_index: 0,
        content: [{ type: "text", text: "<user_query>first</user_query>" }],
      }),
      JSON.stringify({
        type: "assistant",
        content: [{ type: "text", text: "a1" }],
      }),
      JSON.stringify({
        type: "user",
        prompt_index: 1,
        content: [{ type: "text", text: "<user_query>second</user_query>" }],
      }),
      JSON.stringify({
        type: "assistant",
        content: [{ type: "text", text: "a2" }],
      }),
    ].join("\n");
    writeFileSync(sourceFile, `${history}\n`);
    writeFileSync(
      join(sourceDir, "updates.jsonl"),
      `${JSON.stringify({ params: { update: { sessionUpdate: "turn_completed" } } })}\n`,
    );
    writeFileSync(
      destFile,
      `${JSON.stringify({
        type: "user",
        synthetic_reason: "system_reminder",
        content: [{ type: "text", text: "<user_info>x</user_info>" }],
      })}\n`,
    );
    await seedGrokForkJournals(sourceFile, destFile, 0);
    const copied = readFileSync(destFile, "utf8");
    assert.match(copied, /first/);
    assert.match(copied, /"a1"/);
    assert.doesNotMatch(copied, /second/);
  });

  it("copies only the child sessions named in the dest journal", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-fork-kids-"));
    const cwdA = join(root, "cwdA");
    const cwdB = join(root, "cwdB");
    const sourceDir = join(cwdA, "parent");
    const destDir = join(cwdB, "parent");
    const keepId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const dropId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    mkdirSync(join(sourceDir, "subagents", keepId), { recursive: true });
    mkdirSync(join(sourceDir, "subagents", dropId), { recursive: true });
    mkdirSync(join(cwdA, keepId), { recursive: true });
    mkdirSync(join(cwdA, dropId), { recursive: true });
    mkdirSync(destDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "subagents", keepId, "output.json"),
      JSON.stringify({ output: "kept findings" }),
    );
    writeFileSync(
      join(sourceDir, "subagents", dropId, "output.json"),
      JSON.stringify({ output: "later findings" }),
    );
    writeFileSync(join(cwdA, keepId, "updates.jsonl"), "{}\n");
    writeFileSync(join(cwdA, dropId, "updates.jsonl"), "{}\n");
    writeFileSync(
      join(destDir, "chat_history.jsonl"),
      `${JSON.stringify({
        type: "tool_result",
        content: [
          {
            type: "text",
            text: `Subagent started in background.\nsubagent_id: ${keepId}`,
          },
        ],
      })}\n`,
    );
    copyGrokForkSidecars(
      join(sourceDir, "chat_history.jsonl"),
      join(destDir, "chat_history.jsonl"),
    );
    assert.equal(
      existsSync(join(destDir, "subagents", keepId, "output.json")),
      true,
    );
    assert.equal(
      existsSync(join(destDir, "subagents", dropId, "output.json")),
      false,
    );
    assert.equal(existsSync(join(cwdB, keepId, "updates.jsonl")), true);
    assert.equal(existsSync(join(cwdB, dropId, "updates.jsonl")), false);
  });
});
