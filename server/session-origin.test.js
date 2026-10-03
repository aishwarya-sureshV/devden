import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("legacy origins exclude outside sessions and recover Pi/Ollama activity", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "devden-origin-"));
  process.env.HOME = home;
  process.env.DEVDEN_HOME = join(home, ".devden");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { listSessions } = await import("./sessions.js");
  const fence = "[devden harness instruction — fixture]\ncontext\n[end devden harness instruction]\nhello";
  const paths = [];
  for (const name of ["owned", "external"]) {
    const dir = join(home, ".grok", "sessions", "workspace", name);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "chat_history.jsonl");
    paths.push(path);
    await writeFile(join(dir, "summary.json"), JSON.stringify({ generated_title: name, num_chat_messages: 3 }));
    await writeFile(path, JSON.stringify({
      type: name === "owned" ? "user" : "assistant",
      content: [{ type: "text", text: `<user_query>\n${fence}\n</user_query>` }],
    }));
  }
  const transcripts = join(process.env.DEVDEN_HOME, "transcripts");
  await mkdir(transcripts, { recursive: true });
  await writeFile(join(transcripts, "old-historyjsonl.md"), "# Old transcript");
  const recent = await listSessions({ backend: "grok" });
  assert.deepEqual(recent.sessions.map((session) => session.path), [paths[0]]);
  await writeFile(join(home, ".grok", "devden-archived-sessions.json"), JSON.stringify({ paths }));
  const archived = await listSessions({ backend: "grok", archived: true });
  assert.deepEqual(archived.sessions.map((session) => session.path), [paths[0]]);

  const piDir = join(home, ".pi", "agent", "sessions", "workspace");
  await mkdir(piDir, { recursive: true });
  const piPaths = [];
  for (const name of ["success", "bridge-error", "standalone", "legacy"]) {
    const path = join(piDir, `${name}.jsonl`);
    piPaths.push(path);
    await writeFile(path, [
      { type: "session", cwd: home },
      { type: "model_change", provider: "ollama", modelId: "local-model" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      { type: "message", message: { role: "toolResult", toolName: "run_in_terminal",
        details: name === "success" ? { ok: true, tabId: "terminal-1" } : {},
        content: [{ type: "text", text: name === "bridge-error" ? "Terminal tab failed: unknown route"
          : "Terminal tabs are unavailable in this session (no devden bridge)." }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
  }
  const { db, docSet } = await import("./db.js");
  db(join(home, ".pi-web")).prepare(`INSERT INTO turns
    (session_key, session_path, repo, started_at, ended_at) VALUES ('old', ?, ?, 1, 2)`)
    .run(piPaths[3], home);
  const pi = await listSessions({ backend: "pi" });
  assert.deepEqual(new Set(pi.sessions.map((session) => session.path)), new Set([piPaths[0], piPaths[1], piPaths[3]]));
  assert.ok(pi.sessions.every((session) => session.lastModelProvider === "ollama"));
  // Explicitly accepted legacy exports qualify without weakening discovery.
  docSet("devden-sessions", piPaths[2], "legacy-export");
  const restored = await listSessions({ backend: "pi" });
  assert.deepEqual(new Set(restored.sessions.map((session) => session.path)), new Set(piPaths));
});
