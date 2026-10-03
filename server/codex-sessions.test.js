import { strict as assert } from "node:assert";
import test from "node:test";
import { listSessions, messagesFromCodexLog } from "./sessions.js";
import { threadIdFromPath } from "./codex-agent.js";

const line = (payload, type = "response_item") =>
  JSON.stringify({ timestamp: "2026-09-06T20:48:50.000Z", type, payload });

const log = [
  line({ type: "message", role: "developer", content: [{ text: "system" }] }),
  line({
    type: "message",
    role: "user",
    content: [
      { text: "<recommended_plugins>\nAirtable\n</recommended_plugins>" },
    ],
  }),
  line({
    type: "message",
    role: "user",
    content: [
      {
        text: "[devden harness instruction — this block is not part of the user's message; do not quote, repeat, or reference it]\nblah\n[end devden harness instruction]\nrun echo pong",
      },
    ],
  }),
  line({ type: "reasoning", summary: [], encrypted_content: "opaque" }),
  line({
    type: "message",
    role: "assistant",
    content: [{ text: "Running it now." }],
  }),
  line({ type: "custom_tool_call", call_id: "c1", name: "exec", input: "{}" }),
  line({
    type: "custom_tool_call_output",
    call_id: "c1",
    output: [{ text: "pong\n" }],
  }),
  line({ type: "message", role: "assistant", content: [{ text: "done" }] }),
  // event_msg entries differ per rollout vintage and must not be read.
  line({ type: "agent_message", message: "ignored" }, "event_msg"),
].join("\n");

test("reads a rollout's response items into timeline messages", () => {
  const messages = messagesFromCodexLog(log);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  // The harness prefix and codex's injected context never reach the preview.
  assert.equal(messages[0].content[0].text, "run echo pong");
  assert.equal(messages[1].content[0].text, "Running it now.");
  assert.equal(messages[1].content[1].name, "exec");
  assert.equal(messages[2].toolName, "exec");
  assert.equal(messages[2].content[0].text, "pong\n");
});

test("recovers the thread id from a rollout path", () => {
  assert.equal(
    threadIdFromPath(
      "/Users/x/.codex/sessions/2026/09/06/rollout-2026-09-06T20-48-49-01a0774c-fcd3-7073-90c7-8e40dc764182.jsonl",
    ),
    "01a0774c-fcd3-7073-90c7-8e40dc764182",
  );
  assert.equal(threadIdFromPath("/Users/x/notes.jsonl"), undefined);
});


test("concurrent Codex listings share pagination and keep sidebar reply tails small", async (t) => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { closeSharedCodex } = await import("./codex-app-server.js");
  const dir = await mkdtemp(join(tmpdir(), "devden-listing-"));
  const executable = join(dir, "codex");
  const calls = join(dir, "calls");
  const path = join(dir, "rollout.jsonl");
  const legacyPaths = ["devden", "pi_web", "exported"].map((name) => join(dir, `${name}.jsonl`));
  const originalBin = process.env.DEVDEN_CODEX_BIN;
  const originalHome = process.env.DEVDEN_HOME;
  process.env.DEVDEN_HOME = dir;
  const { db, docSet } = await import("./db.js");
  // The earlier transcript fallback polluted the allowlist; ignore it too.
  docSet("devden-sessions", legacyPaths[2], true);
  // A previous DevDen turn proves ownership; a matching cwd does not.
  db().prepare(`INSERT INTO turns (session_key, session_path, repo, started_at, ended_at)
    VALUES ('fixture', ?, ?, 1, 2)`).run(path, dir);
  closeSharedCodex();
  t.after(async () => {
    closeSharedCodex();
    if (originalBin === undefined) delete process.env.DEVDEN_CODEX_BIN;
    else process.env.DEVDEN_CODEX_BIN = originalBin;
    if (originalHome === undefined) delete process.env.DEVDEN_HOME;
    else process.env.DEVDEN_HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(path, line({ type: "message", role: "assistant", content: [{ text: "x".repeat(4000) + "Which one?" }] }));
  for (const [index, legacyPath] of legacyPaths.entries()) {
    await writeFile(legacyPath, [
      line({ originator: ["devden", "pi_web", "Codex Desktop"][index] }, "session_meta"),
      line({ type: "message", role: "user", content: [{ text: "legacy fixture" }] }),
    ].join("\n"));
  }
  const transcriptId = legacyPaths[2].replace(/[^a-zA-Z0-9]+/g, "").slice(-12);
  await mkdir(join(dir, "transcripts"));
  await writeFile(join(dir, "transcripts", `legacy-${transcriptId}.md`), "# legacy fixture");
  await writeFile(executable, `#!${process.execPath}
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  let result = {};
  if (req.method === "thread/list") {
    appendFileSync(${JSON.stringify(calls)}, "list\\n");
    result = req.params.cursor ? { data: [] } : {
      data: [
        { path: ${JSON.stringify(path)}, preview: "fixture", cwd: ${JSON.stringify(dir)}, createdAt: 1 },
        ...${JSON.stringify(legacyPaths)}.map(path => ({ path, preview: "legacy fixture", cwd: ${JSON.stringify(dir)}, createdAt: 1 })),
        { path: ${JSON.stringify(join(dir, "external.jsonl"))}, preview: "external", cwd: ${JSON.stringify(dir)}, createdAt: 2 }
      ], nextCursor: "page2"
    };
  }
  setTimeout(() => process.stdout.write(JSON.stringify({ id: req.id, result }) + "\\n"), 10);
});
`, { mode: 0o755 });
  process.env.DEVDEN_CODEX_BIN = executable;
  const [recent, duplicate, archived] = await Promise.all([
    listSessions({ backend: "codex" }),
    listSessions({ backend: "codex" }),
    listSessions({ backend: "codex", archived: true }),
  ]);
  assert.equal(recent.ok, true, recent.error);
  assert.deepEqual(recent.sessions.map((session) => session.path), [path, ...legacyPaths.slice(0, 2)]);
  assert.deepEqual(recent, duplicate);
  assert.equal(archived.sessions.length, 0);
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 2);
  assert.equal(recent.sessions[0].lastAssistantText.length, 800);
  assert.ok(recent.sessions[0].lastAssistantText.endsWith("Which one?"));
  db().prepare("DELETE FROM turns").run();
  await rm(join(dir, "transcripts"), { recursive: true });
  await writeFile(path, line({ type: "message", role: "assistant", content: [{ text: "updated" }] }));
  const refreshed = await listSessions({ backend: "codex" });
  assert.deepEqual(refreshed.sessions.map((session) => session.path), [path, ...legacyPaths.slice(0, 2)]);
  assert.equal(refreshed.sessions[0].lastAssistantText, "updated");
});
