/**
 * Tests for sessions.js path discipline — the highest-risk logic in the repo.
 * Only failure paths are exercised (they mutate nothing); success paths would
 * write into the real ~/.pi/agent session store.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messagesFromClaudeLog } from "./claude-agent.js";
import {
  archiveSession,
  deleteSession,
  loadSessionLog,
  messagesFromGrokLog,
  readSessionMessages,
} from "./sessions.js";

describe("session path confinement", () => {
  it("rejects non-jsonl paths", async () => {
    const result = await archiveSession("/etc/passwd");
    assert.equal(result.ok, false);
    assert.match(result.error, /Invalid saved session path/);
  });

  it("rejects jsonl files outside the session roots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-sessions-test-"));
    try {
      const outside = join(dir, "not-a-session.jsonl");
      await writeFile(outside, "{}");
      const result = await archiveSession(outside);
      assert.equal(result.ok, false);
      assert.match(result.error, /not a saved Pi, Claude, or Grok session/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing files", async () => {
    const result = await loadSessionLog("/tmp/does-not-exist.jsonl");
    assert.equal(result.ok, false);
  });

  it("rejects empty and non-string paths", async () => {
    assert.equal((await archiveSession("")).ok, false);
    assert.equal((await deleteSession(undefined)).ok, false);
  });

  it("readSessionMessages never throws on hostile input", async () => {
    const result = await readSessionMessages("/tmp/not-a-session.jsonl");
    assert.equal(result.ok, false);
    assert.deepEqual(result.messages, []);
  });
});

describe("grok history conversion", () => {
  const log = [
    { type: "system", content: "you are grok" },
    {
      type: "user",
      content: [{ type: "text", text: "<user_info>x</user_info>" }],
      synthetic_reason: "context",
    },
    {
      type: "user",
      prompt_index: 0,
      content: [
        {
          type: "text",
          text: "<user_query>\n[pi-web harness instruction — ignore]\nbe nice\n[end pi-web harness instruction]\nfix the bug\n</user_query>",
        },
      ],
    },
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "thinking hard" }],
    },
    {
      type: "assistant",
      content: "on it",
      tool_calls: [
        {
          id: "call-1",
          name: "read_file",
          arguments: '{"target_file":"a.js"}',
        },
      ],
    },
    { type: "tool_result", tool_call_id: "call-1", content: "1→hello" },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  it("keeps thinking, tool calls and results, and strips harness scaffolding", () => {
    const messages = messagesFromGrokLog(log);
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "assistant", "toolResult"],
    );
    assert.equal(messages[0].content[0].text, "fix the bug");
    assert.deepEqual(
      messages[1].content.map((c) => c.type),
      ["thinking", "text", "toolCall"],
    );
    assert.deepEqual(messages[1].content[2].arguments, { target_file: "a.js" });
    assert.equal(messages[2].toolName, "read_file");
    assert.equal(messages[2].content[0].text, "1→hello");
  });

  it("keeps the surviving turn of a compacted session (no prompt_index)", () => {
    const compacted = [
      { type: "system", content: "you are grok" },
      {
        type: "user",
        content: [{ type: "text", text: "<user_info>x</user_info>" }],
        synthetic_reason: "context",
      },
      {
        type: "user",
        content: [
          { type: "text", text: "<user_info>OS Version: macos</user_info>" },
        ],
      },
      {
        type: "user",
        content: [
          {
            type: "text",
            text: "<user_query>\nwhat are u doing\n</user_query>",
          },
        ],
      },
      {
        type: "user",
        content: [{ type: "text", text: "This session is being continued..." }],
        synthetic_reason: "compaction",
      },
      { type: "assistant", content: "working on it" },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const messages = messagesFromGrokLog(compacted);
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "assistant"],
    );
    assert.equal(messages[0].content[0].text, "what are u doing");
  });

  it("survives malformed tool arguments", () => {
    const messages = messagesFromGrokLog(
      JSON.stringify({
        type: "assistant",
        content: "",
        tool_calls: [{ id: "x", name: "bash", arguments: "not json" }],
      }),
    );
    assert.deepEqual(messages[0].content[0].arguments, {});
  });
});

describe("claude history conversion", () => {
  const line = (entry) => JSON.stringify(entry);

  it("drops harness-injected user turns and strips system reminders", () => {
    const log = [
      line({
        type: "user",
        isMeta: true,
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: "SessionStart hook success: BANNER" },
      }),
      line({
        type: "user",
        timestamp: "2026-01-01T00:00:01Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "fix the parser\n<system-reminder>secret</system-reminder>",
            },
          ],
        },
      }),
      line({
        type: "user",
        timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>only noise</system-reminder>",
            },
          ],
        },
      }),
    ].join("\n");
    const messages = messagesFromClaudeLog(log);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content[0].text, "fix the parser");
  });
});
