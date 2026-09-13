/**
 * Fixtures here are the shapes a live pi-subagents run actually produced:
 * status.json with `state: "complete"` and a `steps[].sessionFile`, and a child
 * session log whose assistant messages carry text/thinking/toolCall parts with
 * `toolResult` messages between them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PiSubagentFollows,
  asyncDirOf,
  childFindings,
  childSessionEvents,
  isPiSubagentTool,
  isSpawnArgs,
  controlNotices,
  receiptTextOf,
  resolveAsyncDir,
  runIdOf,
  setStallMsForTesting,
  statusTerminal,
} from "./pi-subagent.js";

const CHILD_SESSION = [
  { type: "session", version: 3 },
  {
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "Task: list files" }] },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "simple task" },
        { type: "text", text: "I'll list the working directory contents now." },
        { type: "toolCall", id: "call_ls", name: "ls", arguments: {} },
      ],
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call_ls",
      toolName: "ls",
      isError: false,
      content: [{ type: "text", text: "alpha.txt\nbeta.txt" }],
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Directory listing complete: alpha.txt, beta.txt." }],
    },
  },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n";

describe("childSessionEvents", () => {
  it("turns a child session into nested tool and text events", () => {
    const { events, messagesSeen } = childSessionEvents(
      CHILD_SESSION,
      0,
      "pi-sub-1-main",
      "spawn-1",
    );
    assert.equal(messagesSeen, 4);
    assert.deepEqual(
      events.map((event) => event.type),
      ["message_update", "tool_execution_start", "tool_execution_end", "message_update"],
    );
    // Everything nested carries the spawn's id; that is what puts it in the panel.
    assert.equal(events[0].parentToolUseId, "spawn-1");
    assert.equal(events[1].parentToolUseId, "spawn-1");
    assert.equal(events[1].toolName, "ls");
    assert.equal(events[2].toolCallId, "call_ls");
    assert.equal(events[2].isError, false);
    // Text blocks get their own indexes so they render in order, not stacked.
    assert.deepEqual(
      events.filter((e) => e.type === "message_update").map((e) => e.assistantMessageEvent.contentIndex),
      [0, 1],
    );
  });

  it("drops thinking and the task prompt", () => {
    const { events } = childSessionEvents(CHILD_SESSION, 0, "s", "spawn-1");
    const texts = events
      .filter((event) => event.type === "message_update")
      .map((event) => event.assistantMessageEvent.content);
    assert.ok(!texts.some((text) => text.includes("simple task")), "no thinking");
    assert.ok(!texts.some((text) => text.includes("Task: list files")), "no prompt echo");
  });

  it("replays only what is new, so a re-read does not duplicate", () => {
    const first = childSessionEvents(CHILD_SESSION, 0, "s", "spawn-1");
    const second = childSessionEvents(
      CHILD_SESSION,
      first.messagesSeen,
      "s",
      "spawn-1",
      first.textIndex,
    );
    assert.equal(second.events.length, 0);
    assert.equal(second.messagesSeen, first.messagesSeen);
  });

  it("survives a torn trailing line", () => {
    const { events } = childSessionEvents(`${CHILD_SESSION}{"type":"mess`, 0, "s", "spawn-1");
    assert.equal(events.length, 4);
  });

  it("reads the findings as the child's last word", () => {
    assert.match(childFindings(CHILD_SESSION), /Directory listing complete/);
    assert.equal(childFindings(""), "");
  });

  it("drops the parent history a forked run inherited", () => {
    // A run started from the parent's session opens with a `session` header
    // naming the session it forked from; the inherited messages predate it
    // and are the *parent* talking, not the child.
    const forked =
      [
        {
          type: "session",
          version: 3,
          timestamp: "2026-09-10T16:15:30.666Z",
          parentSession: "/sessions/parent.jsonl",
        },
        {
          type: "message",
          message: {
            role: "assistant",
            timestamp: Date.parse("2026-09-10T16:12:00.000Z"),
            content: [{ type: "text", text: "I'll spawn a worker subagent." }],
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            timestamp: Date.parse("2026-09-10T16:15:35.758Z"),
            content: [
              { type: "text", text: "I'll start by exploring the project." },
              { type: "toolCall", id: "call_ls", name: "ls", arguments: {} },
            ],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n";

    const { events, messagesSeen } = childSessionEvents(forked, 0, "k", "spawn-1");
    assert.equal(messagesSeen, 1);
    const texts = events
      .filter((event) => event.type === "message_update")
      .map((event) => event.assistantMessageEvent.content);
    assert.deepEqual(texts, ["I'll start by exploring the project."]);
  });
});

describe("controlNotices", () => {
  const row = (event) => JSON.stringify({ type: "subagent.control", event });

  it("reports a child blocked on a supervisor reply", () => {
    const chunk = [
      row({
        type: "needs_attention",
        agent: "worker",
        message: "worker is waiting for a supervisor reply",
        reason: "supervisor_request",
      }),
      // Merely slow is not worth interrupting for.
      row({
        type: "active_long_running",
        agent: "worker",
        message: "worker is still active but long-running",
      }),
      JSON.stringify({ type: "subagent.workflow.started" }),
      "{ torn line",
    ].join("\n");
    assert.deepEqual(controlNotices(chunk), [
      "worker is waiting for a supervisor reply",
    ]);
  });

  it("names the agent when the message does not", () => {
    assert.deepEqual(
      controlNotices(row({ type: "needs_attention", agent: "scout", message: "blocked" })),
      ["scout: blocked"],
    );
    assert.deepEqual(controlNotices(""), []);
  });
});

describe("run identification", () => {
  it("recognises the tool, its asyncDir and its receipt", () => {
    assert.ok(isPiSubagentTool("subagent"));
    assert.ok(!isPiSubagentTool("bash"));
    assert.equal(asyncDirOf({ details: { asyncDir: "/tmp/run" } }), "/tmp/run");
    // A foreground child (`async: false`) has no artifacts to follow.
    assert.equal(asyncDirOf({ details: {} }), "");
    assert.equal(receiptTextOf({ content: [{ type: "text", text: "started" }] }), "started");
  });

  it("uses the extension's own state vocabulary", () => {
    // Live: the run is still going.
    for (const state of ["queued", "running", "paused"])
      assert.equal(statusTerminal({ state }), undefined, state);
    // `complete`, not `completed` — this is what a real run writes.
    assert.equal(statusTerminal({ state: "complete" }), "done");
    assert.equal(statusTerminal({ state: "partial" }), "done");
    for (const state of ["failed", "stopped", "rejected"])
      assert.equal(statusTerminal({ state }), "failed", state);
    // A status.json written before `state` exists must not end the run.
    assert.equal(statusTerminal({}), undefined);
  });
});

describe("claiming a run", () => {
  const RUN = "af95821c-19b2-4e6d-a7d8-1d1f8e536efa";

  it("prefers the directory the result names outright", () => {
    assert.equal(resolveAsyncDir({ details: { asyncDir: "/tmp/run" } }), "/tmp/run");
  });

  it("digs the run id out of a blocking workflow result", () => {
    // details.runId is the *tool call* id here; the real one is nested.
    assert.equal(
      runIdOf({
        details: { runId: "call_98kp27xi", workflow: { value: { key: "main", runId: RUN } } },
      }),
      RUN,
    );
  });

  it("ignores a runId that is not a run id", () => {
    assert.equal(runIdOf({ details: { runId: "call_98kp27xi" } }), "");
    assert.equal(runIdOf({ details: {} }), "");
    assert.equal(resolveAsyncDir({ details: {} }), "");
  });

  it("only lets a real spawn claim a run", () => {
    assert.ok(isSpawnArgs({ agent: "scout", task: "look around" }));
    assert.ok(isSpawnArgs({ workflowScript: "return runs.run(...)" }));
    // Status polls and guide reads quote the run id of a run they only
    // describe; treating one as a spawn minted a duplicate panel whose tool
    // ids collided with the real one's.
    assert.ok(!isSpawnArgs({ action: "status", id: RUN }));
    assert.ok(!isSpawnArgs({ action: "guide", topic: "tool-reference" }));
    assert.ok(!isSpawnArgs({}));
    assert.ok(!isSpawnArgs(undefined));
  });
});

describe("PiSubagentFollows", () => {
  const withRun = async (status, run) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-web-subrun-"));
    try {
      const sessionFile = join(dir, "session.jsonl");
      writeFileSync(sessionFile, CHILD_SESSION);
      writeFileSync(
        join(dir, "status.json"),
        JSON.stringify({
          ...status,
          steps: [{ agent: "scout", workflowKey: "main", status: "completed", sessionFile }],
        }),
      );
      return await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("nests the child's work and ends the spawn with its findings", async () => {
    await withRun({ state: "complete" }, async (dir) => {
      const emitted = [];
      const follows = new PiSubagentFollows((event) => emitted.push(event));
      assert.equal(follows.start("spawn-1", dir, "detached and running"), true);
      setStallMsForTesting(5 * 60_000, 0, 0); // close out a terminal run at once
      await follows.drained();
      setStallMsForTesting(5 * 60_000, 20_000, 3_000);

      // A nested tool_execution_end is matched by toolCallId, so like grok's
      // child tool ends it carries no parent tag of its own.
      const nested = emitted.filter((event) => event.parentToolUseId === "spawn-1");
      assert.deepEqual(
        nested.map((event) => event.type),
        ["message_update", "tool_execution_start", "message_update"],
      );
      assert.ok(
        emitted.some((e) => e.type === "tool_execution_end" && e.toolCallId === "call_ls"),
        "the child's tool result closes its card",
      );
      const end = emitted.at(-1);
      assert.equal(end.toolCallId, "spawn-1");
      assert.equal(end.isError, false);
      // The receipt is replaced by what the child actually found.
      assert.match(end.result.content[0].text, /Directory listing complete/);
    });
  });

  it("waits for the child a workflow wrapper launched, not the wrapper", async () => {
    // The real topology: a spawn lays down two sibling run dirs. The wrapper
    // says `complete` a second in; the child is still working.
    const root = mkdtempSync(join(tmpdir(), "pi-web-subruns-"));
    try {
      const wrapper = join(root, "wrapper-run");
      const child = join(root, "child-run");
      mkdirSync(wrapper);
      mkdirSync(child);
      const sessionFile = join(root, "session.jsonl");
      writeFileSync(sessionFile, CHILD_SESSION);
      const steps = [{ workflowKey: "main", sessionFile }];
      writeFileSync(
        join(wrapper, "status.json"),
        JSON.stringify({ state: "complete", mode: "workflow", runId: "w-1", steps }),
      );
      writeFileSync(
        join(child, "status.json"),
        JSON.stringify({
          state: "running",
          mode: "single",
          runId: "c-1",
          parentWorkflowRunId: "w-1",
          steps,
        }),
      );

      const emitted = [];
      const follows = new PiSubagentFollows((event) => emitted.push(event));
      setStallMsForTesting(5 * 60_000, 0, 0);
      follows.start("spawn-1", wrapper, "receipt");
      await new Promise((resolve) => setTimeout(resolve, 250));

      // The wrapper is terminal, but nothing has been handed over: the child
      // it launched is still running.
      assert.ok(
        !emitted.some(
          (event) =>
            event.type === "tool_execution_end" && event.toolCallId === "spawn-1",
        ),
        "the spawn must not be closed out while the child is still working",
      );
      assert.ok(
        emitted.some((event) => event.parentToolUseId === "spawn-1"),
        "the child's work still streams into the panel meanwhile",
      );

      // Now the child finishes.
      writeFileSync(
        join(child, "status.json"),
        JSON.stringify({
          state: "complete",
          mode: "single",
          runId: "c-1",
          parentWorkflowRunId: "w-1",
          steps,
        }),
      );
      await follows.drained();
      const end = emitted.at(-1);
      assert.equal(end.type, "tool_execution_end");
      assert.equal(end.toolCallId, "spawn-1");
      assert.match(end.result.content[0].text, /Directory listing complete/);
    } finally {
      setStallMsForTesting(5 * 60_000, 20_000, 3_000);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces a child blocked on a supervisor reply, tagged to its run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-web-attention-"));
    try {
      const sessionFile = join(dir, "session.jsonl");
      writeFileSync(sessionFile, CHILD_SESSION);
      writeFileSync(
        join(dir, "status.json"),
        JSON.stringify({
          state: "running",
          steps: [{ workflowKey: "main", sessionFile }],
        }),
      );
      writeFileSync(
        join(dir, "events.jsonl"),
        JSON.stringify({
          type: "subagent.control",
          event: {
            type: "needs_attention",
            agent: "worker",
            message: "worker is waiting for a supervisor reply",
          },
        }) + "\n",
      );

      const emitted = [];
      const follows = new PiSubagentFollows((event) => emitted.push(event));
      follows.start("spawn-1", dir, "receipt");
      await new Promise((resolve) => setTimeout(resolve, 250));

      const notice = emitted.find((event) => event.type === "notice");
      assert.ok(notice, "the block is reported rather than looking like work");
      assert.equal(notice.tone, "warning");
      assert.equal(notice.parentToolUseId, "spawn-1");
      assert.match(notice.message, /waiting for a supervisor reply/);
      // Re-read on every tick must not repeat it.
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(emitted.filter((e) => e.type === "notice").length, 1);
      follows.stopAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks a failed run as an error", async () => {
    await withRun({ state: "failed" }, async (dir) => {
      const emitted = [];
      const follows = new PiSubagentFollows((event) => emitted.push(event));
      follows.start("spawn-1", dir, "receipt");
      setStallMsForTesting(5 * 60_000, 0, 0);
      await follows.drained();
      setStallMsForTesting(5 * 60_000, 20_000, 3_000);
      assert.equal(emitted.at(-1).isError, true);
    });
  });

  it("keeps following while the run is live, and does not end the spawn", async () => {
    await withRun({ state: "running" }, async (dir) => {
      const emitted = [];
      const follows = new PiSubagentFollows((event) => emitted.push(event));
      follows.start("spawn-1", dir, "receipt");
      assert.equal(follows.size, 1, "still following");
      assert.ok(
        !emitted.some((e) => e.type === "tool_execution_end" && e.toolCallId === "spawn-1"),
        "spawn stays open while the child works",
      );
      // Nested work is already streaming, before the run finishes.
      assert.ok(emitted.some((e) => e.parentToolUseId === "spawn-1"));
      follows.stopAll();
    });
  });

  it("picks up a transcript written after the run was closed out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-web-late-"));
    try {
      const sessionFile = join(dir, "session.jsonl");
      // Terminal, but the child has not named its transcript yet — exactly
      // what a real run does, and why a fixed wait was not reliable.
      writeFileSync(
        join(dir, "status.json"),
        JSON.stringify({ state: "complete", steps: [{ agent: "scout", workflowKey: "main" }] }),
      );
      const emitted = [];
      const follows = new PiSubagentFollows((event) => emitted.push(event));
      follows.start("spawn-1", dir, "receipt");
      setStallMsForTesting(5 * 60_000, 0, 0);
      await follows.drained();
      setStallMsForTesting(5 * 60_000, 20_000, 3_000);
      assert.equal(
        emitted.filter((e) => e.parentToolUseId === "spawn-1").length,
        0,
        "nothing to publish yet",
      );
      assert.equal(emitted.at(-1).result.content[0].text, "receipt");

      // The runner finishes writing, and the parent turn settles.
      writeFileSync(sessionFile, CHILD_SESSION);
      writeFileSync(
        join(dir, "status.json"),
        JSON.stringify({
          state: "complete",
          steps: [{ agent: "scout", workflowKey: "main", status: "complete", sessionFile }],
        }),
      );
      follows.reconcile();

      assert.ok(
        emitted.some((e) => e.type === "tool_execution_start" && e.toolName === "ls"),
        "the child's tools arrive late but still arrive",
      );
      assert.match(emitted.at(-1).result.content[0].text, /Directory listing complete/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not follow a foreground child, so its result is not held", () => {
    const follows = new PiSubagentFollows(() => {});
    assert.equal(follows.start("spawn-1", "", "receipt"), false);
    assert.equal(follows.size, 0);
  });

  it("gives up on a runner that never writes, instead of wedging the card", async () => {
    setStallMsForTesting(0, 0, 0);
    try {
      const emitted = [];
      const follows = new PiSubagentFollows((event) => emitted.push(event));
      follows.start("spawn-1", join(tmpdir(), "pi-web-missing-run"), "receipt");
      await follows.drained();
      assert.equal(follows.size, 0);
      assert.equal(emitted.at(-1).isError, true);
      assert.equal(emitted.at(-1).result.content[0].text, "receipt");
    } finally {
      setStallMsForTesting(5 * 60_000, 20_000, 3_000);
    }
  });

  it("ends every live run when the pi process dies", async () => {
    await withRun({ state: "running" }, async (dir) => {
      const emitted = [];
      const follows = new PiSubagentFollows((event) => emitted.push(event));
      follows.start("spawn-1", dir, "receipt");
      follows.stopAll();
      assert.equal(follows.size, 0);
      assert.equal(emitted.at(-1).isError, true);
    });
  });
});
