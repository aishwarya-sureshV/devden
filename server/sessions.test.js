/**
 * Tests for sessions.js path discipline — the highest-risk logic in the repo.
 * Only failure paths are exercised (they mutate nothing); success paths would
 * write into the real ~/.pi/agent session store.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messagesFromClaudeLog } from "./claude-agent.js";
import {
  archiveSession,
  childMessagesFromGrokUpdates,
  deleteSession,
  loadGrokChildMessages,
  loadSessionLog,
  messagesFromGrokLog,
  readSessionMessages,
  stripTrailingCompactTurn,
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

  it("strips the /compact recap and its tool calls from the tail", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "fix the bug" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "text", text: "/compact" }] },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "bash", arguments: {} },
          { type: "text", text: "Subagent pane — current state" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        content: [{ type: "text", text: "M file" }],
      },
    ];
    const stripped = stripTrailingCompactTurn(messages);
    assert.deepEqual(
      stripped.map((m) => m.role),
      ["user", "assistant"],
    );
    assert.equal(stripped[0].content[0].text, "fix the bug");
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

  it("re-attaches a spawned child's findings under its call", () => {
    const spawnLog = [
      {
        type: "user",
        prompt_index: 0,
        content: [{ type: "text", text: "<user_query>go</user_query>" }],
      },
      {
        type: "assistant",
        content: "spawning",
        tool_calls: [
          {
            id: "call-spawn",
            name: "spawn_subagent",
            arguments: '{"prompt":"do it"}',
          },
        ],
      },
      {
        type: "tool_result",
        tool_call_id: "call-spawn",
        content:
          "Subagent started in background.\nsubagent_id: 01a08782-f05a-7770-b454-686a549ba415",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const findings = "## 1. What I did\n- one grep\n\n## 2. What I found\n- 42";
    const loaded = [];
    const messages = messagesFromGrokLog(spawnLog, (childId) => {
      loaded.push(childId);
      return findings;
    });
    // The parent log only carries the spawn receipt; the child's findings
    // are re-attached as a nested assistant message so the subagent panel
    // still shows them after a page refresh.
    assert.deepEqual(loaded, ["01a08782-f05a-7770-b454-686a549ba415"]);
    const nested = messages.find((m) => m.parentToolUseId === "call-spawn");
    assert.ok(nested, "findings attached under the spawn call");
    assert.equal(nested.role, "assistant");
    assert.equal(nested.content[0].text, findings);
    // No loader, or a child with no output on disk: no attachment, no throw.
    assert.equal(messagesFromGrokLog(spawnLog).length, 3);
    const absent = messagesFromGrokLog(spawnLog, () => undefined);
    assert.equal(
      absent.some((m) => m.parentToolUseId),
      false,
    );
  });

  it("replays child tools from updates.jsonl under the spawn", () => {
    const updates =
      [
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "I'll look." },
            },
          },
        },
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "grep-1",
              title: "grep",
              rawInput: { pattern: "health" },
            },
          },
        },
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "grep-1",
              status: "completed",
              content: [
                {
                  type: "content",
                  content: { type: "text", text: "hit" },
                },
              ],
            },
          },
        },
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "## findings" },
            },
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n";
    const nested = childMessagesFromGrokUpdates(updates, "call-spawn");
    assert.equal(nested[0].role, "assistant");
    assert.equal(nested[0].parentToolUseId, "call-spawn");
    assert.equal(nested[0].content[0].text, "I'll look.");
    assert.equal(nested[1].content[0].type, "toolCall");
    assert.equal(nested[1].content[0].id, "grep-1");
    assert.equal(nested[1].parentToolUseId, "call-spawn");
    assert.equal(nested[2].role, "toolResult");
    assert.equal(nested[2].content[0].text, "hit");
    assert.equal(nested[3].content[0].text, "## findings");
  });

  it("reads grok child tool output from rawOutput when content is empty", () => {
    const updates =
      JSON.stringify({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "list-1",
            title: "list_dir",
            rawInput: { target_directory: "/tmp" },
          },
        },
      }) +
      "\n" +
      JSON.stringify({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "list-1",
            status: "completed",
            rawOutput: {
              type: "ListDir",
              Content: { content: "- /tmp/\n  - alpha.txt" },
            },
          },
        },
      }) +
      "\n";
    const nested = childMessagesFromGrokUpdates(updates, "spawn-1");
    const result = nested.find((message) => message.role === "toolResult");
    assert.match(result.content[0].text, /alpha\.txt/);
  });

  it("loadGrokChildMessages splices tools and late findings from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-child-"));
    try {
      const parentDir = join(dir, "encoded-cwd", "parent-1");
      const childId = "01a08782-f05a-7770-b454-686a549ba415";
      const childDir = join(dir, "encoded-cwd", childId);
      await mkdir(join(parentDir, "subagents", childId), { recursive: true });
      await mkdir(childDir, { recursive: true });
      await writeFile(
        join(childDir, "updates.jsonl"),
        JSON.stringify({
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "read-1",
              title: "read_file",
              rawInput: { target_file: "a.ts" },
            },
          },
        }) + "\n",
      );
      await writeFile(
        join(parentDir, "subagents", childId, "output.json"),
        JSON.stringify({ output: "## official" }),
      );
      const extra = loadGrokChildMessages(
        join(parentDir, "chat_history.jsonl"),
        childId,
        "call-spawn",
      );
      assert.equal(extra[0].content[0].id, "read-1");
      assert.equal(extra[0].parentToolUseId, "call-spawn");
      assert.equal(extra.at(-1).content[0].text, "## official");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
      line({
        type: "user",
        timestamp: "2026-01-01T00:00:03Z",
        message: {
          role: "user",
          content:
            "<task-notification>\n<task-id>abc</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n<result>found it</result>\n</task-notification>",
        },
      }),
    ].join("\n");
    const messages = messagesFromClaudeLog(log);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content[0].text, "fix the parser");
  });
});

describe("claude subagent hydration", () => {
  it("splices a child transcript under the Agent call that spawned it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-claude-sub-"));
    try {
      const sessionPath = join(dir, "s1.jsonl");
      const child = join(dir, "s1", "subagents");
      await mkdir(child, { recursive: true });
      const line = (entry) => `${JSON.stringify(entry)}\n`;
      await writeFile(
        sessionPath,
        line({
          type: "assistant",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_1", name: "Agent", input: {} },
            ],
          },
        }) +
          line({
            type: "user",
            timestamp: "2026-01-01T00:00:01.000Z",
            toolUseResult: { name: "Agent" },
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "toolu_1", content: "done" },
              ],
            },
          }),
      );
      await writeFile(
        join(child, "agent-abc.meta.json"),
        JSON.stringify({ toolUseId: "toolu_1", agentType: "Explore" }),
      );
      await writeFile(
        join(child, "agent-abc.jsonl"),
        line({
          type: "user",
          timestamp: "2026-01-01T00:00:00.500Z",
          message: { role: "user", content: "go and look" },
        }) +
          line({
            type: "assistant",
            timestamp: "2026-01-01T00:00:00.600Z",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "found it" },
                { type: "tool_use", id: "toolu_2", name: "Read", input: {} },
              ],
            },
          }),
      );

      const messages = messagesFromClaudeLog(
        await readFile(sessionPath, "utf8"),
        sessionPath,
      );
      const nested = messages.filter((m) => m.parentToolUseId === "toolu_1");
      assert.equal(nested.length, 1, "one nested assistant message");
      assert.equal(nested[0].role, "assistant");
      assert.equal(nested[0].content[1].name, "Read");
      // The child's own prompt must not come back as the user's message.
      assert.ok(
        !messages.some((m) => m.role === "user" && m.parentToolUseId),
        "child prompt is dropped",
      );
      // It lands right after the spawn's result, not at the end.
      const resultIndex = messages.findIndex((m) => m.role === "toolResult");
      assert.equal(messages[resultIndex + 1], nested[0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op for a session with no subagents dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-claude-nosub-"));
    try {
      const sessionPath = join(dir, "s2.jsonl");
      const log = `${JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      })}\n`;
      await writeFile(sessionPath, log);
      assert.deepEqual(
        messagesFromClaudeLog(log, sessionPath),
        messagesFromClaudeLog(log),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
