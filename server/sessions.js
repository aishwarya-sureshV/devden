/** Discovers and manages resumable Pi, Claude Code, Grok, and Codex sessions. */
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const AGENT_ROOT = join(homedir(), ".pi", "agent");
const SESSIONS_ROOT = join(AGENT_ROOT, "sessions");
const ARCHIVE_INDEX = join(AGENT_ROOT, "pi-web-archived-sessions.json");
const CLAUDE_ROOT = join(homedir(), ".claude");
const CLAUDE_SESSIONS_ROOT = join(CLAUDE_ROOT, "projects");
const CLAUDE_ARCHIVE_INDEX = join(CLAUDE_ROOT, "pi-web-archived-sessions.json");
// grok's own session store -- pi-web only reads from it and keeps its own
// archive index alongside it rather than writing into grok's files.
const GROK_ROOT = join(homedir(), ".grok");
const GROK_SESSIONS_ROOT = join(GROK_ROOT, "sessions");
const GROK_ARCHIVE_INDEX = join(GROK_ROOT, "pi-web-archived-sessions.json");
// codex's rollout store. Its own thread index already knows every session's
// title, cwd and timestamps, so listing goes through the app-server rather
// than re-deriving them by scanning rollout JSONL.
const CODEX_ROOT = process.env.CODEX_HOME || join(homedir(), ".codex");
const CODEX_SESSIONS_ROOT = join(CODEX_ROOT, "sessions");
const CODEX_ARCHIVE_INDEX = join(CODEX_ROOT, "pi-web-archived-sessions.json");
let archiveMutation = Promise.resolve();

import { messagesFromClaudeLog } from "./claude-agent.js";
import { codexRequest } from "./codex-app-server.js";
import { threadIdFromPath } from "./codex-agent.js";

// Every listing re-read every session file end to end (~175MB of Claude
// JSONL here, ~0.8s per call, and the sidebar asks for recent + archived on
// each page load, so a backend switch paid it twice). Session logs are
// append-only, so mtime+size is a safe cache key: a session that changed is
// re-read, everything else costs one stat.
// ponytail: unbounded map, keyed by path — bounded by session count in
// practice; add an LRU if that ever stops being true.
const sessionSummaries = new Map();

async function cachedSummary(path, read) {
  let key;
  try {
    const file = await stat(path);
    key = `${file.mtimeMs}:${file.size}`;
  } catch {
    sessionSummaries.delete(path);
    return undefined;
  }
  const hit = sessionSummaries.get(path);
  if (hit && hit.key === key) return hit.session;
  const session = await read(path);
  sessionSummaries.set(path, { key, session });
  return session;
}

export async function listSessions({ archived = false, backend = "pi" } = {}) {
  // "all" is what the sidebar asks for: sessions from every agent in one
  // list, so a pi session and a claude session can sit side by side instead
  // of the UI being scoped to whichever backend the page was opened with.
  if (backend === "all") {
    const lists = await Promise.all(
      ["pi", "claude", "grok", "codex"].map((name) =>
        listSessions({ archived, backend: name }).catch(() => ({
          ok: false,
          sessions: [],
        })),
      ),
    );
    const sessions = lists.flatMap((result) => result.sessions ?? []);
    sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return { ok: true, sessions };
  }
  if (backend === "claude") return listClaudeSessions({ archived });
  if (backend === "grok") return listGrokSessions({ archived });
  if (backend === "codex") return listCodexSessions({ archived });
  return listPiSessions({ archived });
}

async function listPiSessions({ archived = false } = {}) {
  try {
    const [folders, archivedPaths] = await Promise.all([
      readdir(SESSIONS_ROOT, { withFileTypes: true }),
      readArchiveIndex(),
    ]);
    const paths = (
      await Promise.all(
        folders
          .filter((entry) => entry.isDirectory())
          .map(async (folder) => {
            const entries = await readdir(join(SESSIONS_ROOT, folder.name), {
              withFileTypes: true,
            });
            return entries
              .filter(
                (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
              )
              .map((entry) => join(SESSIONS_ROOT, folder.name, entry.name));
          }),
      )
    )
      .flat()
      .filter((path) => archivedPaths.has(path) === archived);
    const sessions = (
      await Promise.all(
        paths.map((path) => cachedSummary(path, readResumeSession)),
      )
    )
      .filter(Boolean)
      .map((session) => ({ ...session, backend: "pi" }));
    sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return { ok: true, sessions };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), sessions: [] };
  }
}

async function listClaudeSessions({ archived = false } = {}) {
  try {
    const [projects, archivedPaths] = await Promise.all([
      readdir(CLAUDE_SESSIONS_ROOT, { withFileTypes: true }),
      readArchiveIndex(CLAUDE_ARCHIVE_INDEX),
    ]);
    const paths = (
      await Promise.all(
        projects
          .filter((entry) => entry.isDirectory())
          .map(async (project) => {
            const directory = join(CLAUDE_SESSIONS_ROOT, project.name);
            const entries = await readdir(directory, { withFileTypes: true });
            return entries
              .filter(
                (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
              )
              .map((entry) => join(directory, entry.name));
          }),
      )
    )
      .flat()
      .filter((path) => archivedPaths.has(path) === archived);
    const sessions = (
      await Promise.all(
        paths.map((path) => cachedSummary(path, readClaudeResumeSession)),
      )
    ).filter((session) => session && !isInternalClaudeSession(session));
    sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return { ok: true, sessions };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, sessions: [] };
    return { ok: false, error: String(error?.message ?? error), sessions: [] };
  }
}

// grok's own layout: GROK_SESSIONS_ROOT/<encodeURIComponent(cwd)>/<sessionId>/,
// each holding chat_history.jsonl plus a summary.json with everything needed
// for the sidebar entry (title, message count, model, timestamps) -- no need
// to parse chat_history.jsonl itself just to list sessions.
async function listGrokSessions({ archived = false } = {}) {
  try {
    const [cwdFolders, archivedPaths] = await Promise.all([
      readdir(GROK_SESSIONS_ROOT, { withFileTypes: true }),
      readArchiveIndex(GROK_ARCHIVE_INDEX),
    ]);
    const sessionDirs = (
      await Promise.all(
        cwdFolders
          .filter((entry) => entry.isDirectory())
          .map(async (cwdFolder) => {
            const cwdPath = join(GROK_SESSIONS_ROOT, cwdFolder.name);
            let entries;
            try {
              entries = await readdir(cwdPath, { withFileTypes: true });
            } catch {
              return [];
            }
            return entries
              .filter((entry) => entry.isDirectory())
              .map((entry) => join(cwdPath, entry.name));
          }),
      )
    ).flat();
    const sessions = (await Promise.all(sessionDirs.map(readGrokResumeSession)))
      .filter(Boolean)
      .filter((session) => archivedPaths.has(session.path) === archived)
      // Merely opening the workbench used to spawn a grok agent, and grok
      // immediately writes a chat_history.jsonl (system prompt + one synthetic
      // user entry) even if nothing is ever sent. Those ghosts showed up here
      // as empty "Untitled session" rows. num_chat_messages counts raw history
      // lines, so any conversation with at least one real turn has 3+.
      .filter((session) => session.messageCount >= 3);
    sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return { ok: true, sessions };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, sessions: [] };
    return { ok: false, error: String(error?.message ?? error), sessions: [] };
  }
}

async function readGrokResumeSession(sessionDir) {
  try {
    const summaryPath = join(sessionDir, "summary.json");
    const chatPath = join(sessionDir, "chat_history.jsonl");
    const [summaryRaw, file] = await Promise.all([
      readFile(summaryPath, "utf8"),
      stat(chatPath),
    ]);
    const summary = JSON.parse(summaryRaw);
    const createdAt =
      Date.parse(summary.created_at ?? "") || file.birthtimeMs || file.mtimeMs;
    const modifiedAt =
      Date.parse(summary.updated_at ?? summary.last_active_at ?? "") ||
      file.mtimeMs;
    const name =
      (summary.generated_title || summary.session_summary || "").trim() ||
      "Untitled session";
    return {
      path: chatPath,
      backend: "grok",
      name,
      cwd: summary.info?.cwd || summary.git_root_dir || "",
      createdAt,
      modifiedAt,
      messageCount: Number(
        summary.num_chat_messages ?? summary.num_messages ?? 0,
      ),
      firstPrompt: undefined,
      lastModel:
        typeof summary.current_model_id === "string"
          ? summary.current_model_id
          : undefined,
      // Grok models always live under the grok-sdk provider, so the model
      // picker can restore the id on a reopened session.
      lastModelProvider:
        typeof summary.current_model_id === "string" ? "grok-sdk" : undefined,
      models:
        typeof summary.current_model_id === "string"
          ? [summary.current_model_id]
          : [],
      lastEffort:
        typeof summary.reasoning_effort === "string"
          ? summary.reasoning_effort
          : undefined,
    };
  } catch {
    return null;
  }
}

// codex owns a thread index that already carries title, preview, cwd and
// timestamps, so one `thread/list` replaces a scan of the rollout files.
// Archiving stays in pi-web's own index (as for claude and grok) rather than
// mutating codex's, so un-archiving here never surprises the codex CLI.
async function listCodexSessions({ archived = false } = {}) {
  try {
    const [threads, archivedPaths] = await Promise.all([
      codexRequest("thread/list", { limit: 200 }),
      readArchiveIndex(CODEX_ARCHIVE_INDEX),
    ]);
    const sessions = (threads?.data ?? [])
      .filter((thread) => typeof thread?.path === "string" && thread.path)
      .filter((thread) => archivedPaths.has(thread.path) === archived)
      // A thread that was opened but never prompted has no preview; those
      // are the codex equivalent of grok's empty-session ghosts.
      .filter((thread) => String(thread.preview ?? "").trim())
      .map((thread) => {
        const firstPrompt = stripHarnessPrefix(String(thread.preview).trim());
        return {
          path: thread.path,
          backend: "codex",
          // codex titles a thread a few turns in; until then the prompt is a
          // better label than "Untitled".
          name:
            (thread.name || "").trim() ||
            firstPrompt.split("\n")[0].slice(0, 80) ||
            "Untitled session",
          cwd: thread.cwd || "",
          createdAt: Number(thread.createdAt ?? 0) * 1000,
          modifiedAt: Number(thread.updatedAt ?? thread.createdAt ?? 0) * 1000,
          messageCount: 0,
          firstPrompt,
          lastModel: undefined,
          models: [],
        };
      });
    sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return { ok: true, sessions };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), sessions: [] };
  }
}

export async function archiveSession(path) {
  return updateArchiveIndex(path, true);
}

export async function restoreSession(path) {
  return updateArchiveIndex(path, false);
}

export async function deleteSession(path) {
  try {
    const {
      path: safePath,
      archiveIndex,
      backend,
    } = await resolveSessionPath(path);
    // grok's chat_history.jsonl lives alongside summary.json, events.jsonl,
    // etc. under one directory per session -- delete the whole thing rather
    // than orphaning the rest of grok's own session metadata.
    if (backend === "grok")
      await rm(dirname(safePath), { recursive: true, force: true });
    // Unlinking a rollout would leave codex's own thread index pointing at a
    // file that no longer exists; let codex retire the thread itself.
    else if (backend === "codex")
      await codexRequest("thread/delete", {
        threadId: threadIdFromPath(safePath),
      });
    else await unlink(safePath);
    await mutateArchiveIndex(archiveIndex, async (archivedPaths) => {
      archivedPaths.delete(safePath);
      return archivedPaths;
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

export async function readSessionMessages(path) {
  try {
    const { path: safePath, backend } = await resolveSessionPath(path);
    const contents = await readFile(safePath, "utf8");
    const messages =
      backend === "claude"
        ? messagesFromClaudeLog(contents)
        : backend === "grok"
          ? messagesFromGrokLog(contents)
          : backend === "codex"
            ? messagesFromCodexLog(contents)
            : messagesFromPiLog(contents);
    return { ok: true, messages };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), messages: [] };
  }
}

// chat_history.jsonl is grok's own full request log -- item-list format
// (type: system/user/reasoning/assistant/tool_result), not role+content
// blocks. Real user turns are wrapped in <user_query> tags and carry a
// numeric prompt_index; synthetic context grok injects for itself
// (<user_info>, skill listings, etc.) carries synthetic_reason instead and
// is skipped so the preview matches what the user actually typed.
export function messagesFromGrokLog(contents) {
  const messages = [];
  // tool_result entries name only the call id, so the tool name is carried
  // forward from the assistant entry that made the call.
  const toolNames = new Map();
  let pendingThinking = "";
  for (const line of String(contents || "").split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "reasoning") {
      // grok writes reasoning as its own entry immediately before the
      // assistant entry it belongs to; only the plaintext summary is
      // readable (encrypted_content is opaque).
      pendingThinking = (Array.isArray(entry.summary) ? entry.summary : [])
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
    } else if (entry.type === "user") {
      if (entry.synthetic_reason) continue;
      const text = grokContentText(entry.content);
      const match = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
      // A real turn is wrapped in <user_query>. prompt_index is NOT the test:
      // a compacted session's surviving turn carries none, so requiring one
      // made every compacted session read back empty — and grok also injects
      // unflagged context blobs (<user_info>, <system-reminder>) as plain
      // "user" entries, which the wrapper is what rules out.
      if (!match && typeof entry.prompt_index !== "number") continue;
      const clean = stripHarnessPrefix((match ? match[1] : text).trim());
      pendingThinking = "";
      if (clean)
        messages.push({
          role: "user",
          content: [{ type: "text", text: clean }],
          timestamp: Date.now(),
        });
    } else if (entry.type === "assistant") {
      const content = [];
      if (pendingThinking)
        content.push({ type: "thinking", thinking: pendingThinking });
      pendingThinking = "";
      const text = grokContentText(entry.content).trim();
      if (text) content.push({ type: "text", text });
      for (const call of Array.isArray(entry.tool_calls)
        ? entry.tool_calls
        : []) {
        const id = String(call?.id ?? "");
        const name = String(call?.name ?? "tool");
        toolNames.set(id, name);
        content.push({
          type: "toolCall",
          id,
          name,
          arguments: parseGrokToolArguments(call?.arguments),
        });
      }
      if (content.length)
        messages.push({ role: "assistant", content, timestamp: Date.now() });
    } else if (entry.type === "tool_result") {
      const id = String(entry.tool_call_id ?? "");
      messages.push({
        role: "toolResult",
        toolCallId: id,
        toolName: toolNames.get(id) ?? "tool",
        content: [{ type: "text", text: grokContentText(entry.content) }],
        timestamp: Date.now(),
      });
    }
  }
  return messages;
}

// The grok and codex adapters prefix every prompt with a bracketed harness
// instruction block (their CLARIFY_PROMPT_PREFIX); both store it verbatim, so
// it has to come back out to show what the user actually typed.
function stripHarnessPrefix(text) {
  const end = "[end pi-web harness instruction]";
  // Loop: a turn can carry more than one block (the clarify gate plus, on a
  // resumed turn, the interruption notice), and stripping only the first
  // left the second showing as something the user had typed.
  let rest = text;
  while (rest.startsWith("[pi-web harness instruction")) {
    const at = rest.indexOf(end);
    if (at === -1) return rest;
    rest = rest.slice(at + end.length).trimStart();
  }
  return rest;
}

// grok serializes tool arguments as a JSON string; the timeline's tool cards
// (paths, commands, diffs) need the parsed object.
function parseGrokToolArguments(value) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function grokContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function messagesFromPiLog(contents) {
  const messages = [];
  for (const line of String(contents || "").split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      entry.type !== "message" ||
      !entry.message ||
      typeof entry.message !== "object"
    )
      continue;
    const timestamp =
      Date.parse(entry.timestamp ?? entry.message.timestamp ?? "") ||
      Date.now();
    messages.push({ ...entry.message, timestamp });
  }
  return messages;
}

// A codex rollout is codex's own append-only event log. Its `event_msg`
// entries come in two vocabularies depending on how the thread was created
// (Codex Desktop writes `item_completed`, an app-server thread writes
// `user_message`/`agent_message`), but both write the same `response_item`
// entries -- the model conversation itself -- so that is what the preview
// reads. Reasoning is skipped: rollouts store an empty summary and an
// encrypted body, so there is nothing to show.
export function messagesFromCodexLog(contents) {
  const messages = [];
  const toolNames = new Map();
  let assistant;
  const pushAssistant = () => {
    if (assistant?.content.length) messages.push(assistant);
    assistant = undefined;
  };
  const openAssistant = (timestamp) => {
    if (!assistant) assistant = { role: "assistant", content: [], timestamp };
    return assistant;
  };
  for (const line of String(contents || "").split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "response_item") continue;
    const item = entry.payload;
    if (!item) continue;
    const timestamp = Date.parse(entry.timestamp ?? "") || Date.now();
    if (item.type === "message") {
      const text = codexItemText(item.content);
      if (item.role === "assistant") {
        if (text.trim())
          openAssistant(timestamp).content.push({
            type: "text",
            text: text.trim(),
          });
      } else if (item.role === "user") {
        // codex injects its own context as user messages
        // (<recommended_plugins>, <environment_context>, ...); a real prompt
        // is not an XML block.
        if (/^\s*<[a-z_-]+>/i.test(text)) continue;
        const clean = stripHarnessPrefix(text.trim());
        if (!clean) continue;
        pushAssistant();
        messages.push({
          role: "user",
          content: [{ type: "text", text: clean }],
          timestamp,
        });
      }
      continue;
    }
    if (item.type === "custom_tool_call" || item.type === "function_call") {
      const id = String(item.call_id ?? item.id ?? "");
      const name = String(item.name ?? "tool");
      toolNames.set(id, name);
      openAssistant(timestamp).content.push({
        type: "toolCall",
        id,
        name,
        arguments: parseGrokToolArguments(item.arguments ?? item.input),
      });
      continue;
    }
    if (
      item.type === "custom_tool_call_output" ||
      item.type === "function_call_output"
    ) {
      const id = String(item.call_id ?? "");
      pushAssistant();
      messages.push({
        role: "toolResult",
        toolCallId: id,
        toolName: toolNames.get(id) ?? "tool",
        content: [{ type: "text", text: codexItemText(item.output) }],
        timestamp,
      });
    }
  }
  pushAssistant();
  return messages;
}

// Rollout content blocks are input_text/output_text parts; a tool output can
// also be a bare string.
function codexItemText(content) {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

export async function loadSessionLog(path) {
  try {
    const { path: safePath } = await resolveSessionPath(path);
    return {
      ok: true,
      path: safePath,
      contents: await readFile(safePath, "utf8"),
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

async function updateArchiveIndex(path, archived) {
  try {
    const { path: safePath, archiveIndex } = await resolveSessionPath(path);
    await mutateArchiveIndex(archiveIndex, async (archivedPaths) => {
      if (archived) archivedPaths.add(safePath);
      else archivedPaths.delete(safePath);
      return archivedPaths;
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

async function resolveSessionPath(path) {
  if (typeof path !== "string" || !path.endsWith(".jsonl"))
    throw new Error("Invalid saved session path.");
  const requested = resolve(path);
  let candidate;
  try {
    candidate = await realpath(requested);
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new Error("The saved session no longer exists.");
    throw error;
  }
  for (const config of [
    { root: SESSIONS_ROOT, archiveIndex: ARCHIVE_INDEX, backend: "pi" },
    {
      root: CLAUDE_SESSIONS_ROOT,
      archiveIndex: CLAUDE_ARCHIVE_INDEX,
      backend: "claude",
    },
    {
      root: GROK_SESSIONS_ROOT,
      archiveIndex: GROK_ARCHIVE_INDEX,
      backend: "grok",
    },
    {
      root: CODEX_SESSIONS_ROOT,
      archiveIndex: CODEX_ARCHIVE_INDEX,
      backend: "codex",
    },
  ]) {
    let root;
    try {
      root = await realpath(config.root);
    } catch {
      continue;
    }
    const fromRoot = relative(root, candidate);
    if (fromRoot && !fromRoot.startsWith("..") && !isAbsolute(fromRoot)) {
      const file = await stat(candidate);
      if (!file.isFile())
        throw new Error("The saved session no longer exists.");
      return {
        path: candidate,
        archiveIndex: config.archiveIndex,
        backend: config.backend,
      };
    }
  }
  throw new Error(
    "The requested file is not a saved Pi, Claude, or Grok session.",
  );
}

async function readArchiveIndex(indexPath = ARCHIVE_INDEX) {
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8"));
    return new Set(
      Array.isArray(parsed?.paths)
        ? parsed.paths.filter((path) => typeof path === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

async function mutateArchiveIndex(indexPath, change) {
  const operation = archiveMutation.then(async () => {
    const paths = await change(await readArchiveIndex(indexPath));
    await mkdir(
      indexPath === CLAUDE_ARCHIVE_INDEX
        ? CLAUDE_ROOT
        : indexPath === GROK_ARCHIVE_INDEX
          ? GROK_ROOT
          : AGENT_ROOT,
      { recursive: true },
    );
    const temporary = `${indexPath}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, paths: [...paths].sort() }, null, 2)}\n`,
      "utf8",
    );
    await rename(temporary, indexPath);
  });
  archiveMutation = operation.catch(() => {});
  return operation;
}

function isInternalClaudeSession(session) {
  const text = `${session?.name || ""}\n${session?.firstPrompt || ""}`;
  return /<local-command-caveat>|<command-name>|<command-message>|<command-args>/.test(
    text,
  );
}

function rememberModel(models, value) {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id || id === "<synthetic>") return undefined;
  models.add(id);
  return id;
}

async function readClaudeResumeSession(path) {
  try {
    const [contents, file] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ]);
    let name;
    let cwd = "";
    let createdAt = file.birthtimeMs || file.mtimeMs;
    // Claude touches a resumed JSONL by appending bookkeeping records such as
    // `last-prompt`, `atis-latch`, and `mode`. Those are not conversation
    // activity, so the sidebar's "Recent" time must come from a real turn.
    let modifiedAt = 0;
    let messageCount = 0;
    let firstPrompt = "";
    let lastModel;
    let lastEffort;
    const models = new Set();
    for (const line of contents.split("\n")) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const timestamp =
        typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (Number.isFinite(timestamp))
        createdAt = Math.min(createdAt, timestamp);
      if (typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;
      if (
        entry.type === "custom-title" &&
        typeof entry.customTitle === "string" &&
        entry.customTitle.trim()
      ) {
        name = entry.customTitle.trim();
      } else if (
        !name &&
        entry.type === "ai-title" &&
        typeof entry.aiTitle === "string" &&
        entry.aiTitle.trim()
      ) {
        name = entry.aiTitle.trim();
      }
      if (entry.type === "assistant") {
        const model = rememberModel(models, entry.message?.model);
        if (model) lastModel = model;
        if (typeof entry.effort === "string" && entry.effort.trim())
          lastEffort = entry.effort.trim();
      }
      if (entry.type !== "user" && entry.type !== "assistant") continue;
      if (Number.isFinite(timestamp))
        modifiedAt = Math.max(modifiedAt, timestamp);
      messageCount += 1;
      if (firstPrompt || entry.type !== "user") continue;
      const content = entry.message?.content;
      if (typeof content === "string" && content.trim())
        firstPrompt = content.trim();
      else if (Array.isArray(content)) {
        const text = content.find(
          (part) => part?.type === "text" && typeof part.text === "string",
        )?.text;
        if (text?.trim()) firstPrompt = text.trim();
      }
    }
    return {
      path,
      backend: "claude",
      name: name || firstPrompt || "Untitled session",
      cwd,
      createdAt,
      modifiedAt: modifiedAt || createdAt,
      messageCount,
      firstPrompt: firstPrompt || undefined,
      lastModel,
      models: [...models],
      lastEffort,
    };
  } catch {
    return null;
  }
}

export async function readResumeSession(path) {
  try {
    const [contents, file] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ]);
    let name;
    let cwd = "";
    let createdAt = file.birthtimeMs || file.mtimeMs;
    let modifiedAt = file.mtimeMs;
    let messageCount = 0;
    let firstPrompt = "";
    let lastModel;
    let lastModelProvider;
    // Cumulative usage across the session's assistant turns — the composer's
    // "USED tokens" chip for sessions whose agent is not running.
    let usage;
    // The tail of the final assistant message, sent so the sidebar can mark a
    // session that ended on a question as waiting on the user. Only kept when
    // that message is genuinely last: if the user has already replied, the
    // session is not waiting even though the question is still the newest
    // assistant text. The rule itself lives client-side (awaitingAnswer.ts) —
    // the server only supplies the text it runs on.
    let lastAssistantText = "";
    let lastRole = "";
    const models = new Set();
    for (const line of contents.split("\n")) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === "session") {
        if (typeof entry.cwd === "string") cwd = entry.cwd;
        if (typeof entry.timestamp === "string")
          createdAt = Date.parse(entry.timestamp) || createdAt;
      } else if (
        entry.type === "session_info" &&
        typeof entry.name === "string"
      ) {
        name = entry.name.trim() || undefined;
      } else if (entry.type === "model_change") {
        // Authoritative even when the switched-to model never produced a
        // turn: without it a reopened session loses its model picker label.
        if (typeof entry.modelId === "string" && entry.modelId) {
          lastModel = entry.modelId;
          if (typeof entry.provider === "string")
            lastModelProvider = entry.provider;
          models.add(entry.modelId);
        }
      } else if (entry.type === "message") {
        messageCount++;
        if (typeof entry.timestamp === "string")
          modifiedAt = Date.parse(entry.timestamp) || modifiedAt;
        const message = entry.message;
        if (message?.role) lastRole = message.role;
        if (message?.role === "assistant") {
          const model = rememberModel(models, message.model);
          if (model) {
            lastModel = model;
            if (typeof message.provider === "string")
              lastModelProvider = message.provider;
          }
          if (message.usage) {
            const input = Number(message.usage.input ?? 0);
            const output = Number(message.usage.output ?? 0);
            const total = Number(message.usage.totalTokens ?? input + output);
            usage = {
              input: (usage?.input ?? 0) + (Number.isFinite(input) ? input : 0),
              output:
                (usage?.output ?? 0) + (Number.isFinite(output) ? output : 0),
              total: (usage?.total ?? 0) + (Number.isFinite(total) ? total : 0),
            };
          }
          const text = Array.isArray(message.content)
            ? message.content
                .filter(
                  (part) =>
                    part?.type === "text" && typeof part.text === "string",
                )
                .map((part) => part.text)
                .join("\n")
                .trim()
            : "";
          if (text) lastAssistantText = text;
        }
        if (
          !firstPrompt &&
          message?.role === "user" &&
          Array.isArray(message.content)
        ) {
          const text = message.content.find(
            (part) =>
              typeof part === "object" &&
              part !== null &&
              part.type === "text" &&
              typeof part.text === "string",
          )?.text;
          if (text) firstPrompt = text;
        }
      }
    }
    return {
      path,
      name: name || firstPrompt || "Untitled session",
      cwd,
      createdAt,
      modifiedAt,
      messageCount,
      firstPrompt: firstPrompt || undefined,
      lastAssistantText:
        lastRole === "assistant" && lastAssistantText
          ? lastAssistantText.slice(-800)
          : undefined,
      lastModel,
      lastModelProvider,
      usage,
      models: [...models],
    };
  } catch {
    return null;
  }
}

/** How many of the most recent sessions a single search will open. */
const SEARCH_SESSION_LIMIT = 80;
/** Snippets returned per session, so one chatty session can't crowd out the rest. */
const SEARCH_SNIPPETS_PER_SESSION = 3;
/** Sessions returned to the UI after ranking. */
const SEARCH_MAX_RESULTS = 25;

/** Flatten a normalized history message to searchable text. */
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part?.text === "string"
            ? part.text
            : "",
      )
      .filter(Boolean)
      .join(" ");
  return typeof message?.text === "string" ? message.text : "";
}

/** A window of text around the hit, with the surrounding words kept intact. */
function snippetAround(text, index, query, radius = 90) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.length + radius);
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}

/**
 * Full-text search across saved sessions for one backend.
 *
 * Two passes on purpose: a cheap lowercase substring test against the raw log
 * rejects almost every file, and only the survivors are parsed into messages
 * to build snippets. Parsing every session up front is what would make this
 * too slow to run from a search box.
 */
export async function searchSessions({ query, backend = "pi" } = {}) {
  const needle = String(query ?? "")
    .trim()
    .toLowerCase();
  if (needle.length < 2)
    return { ok: true, results: [], error: "Enter at least two characters." };

  const listed = await listSessions({ backend });
  if (!listed.ok) return { ok: false, error: listed.error, results: [] };

  const sessions = [...listed.sessions]
    .sort((left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0))
    .slice(0, SEARCH_SESSION_LIMIT);

  const results = [];
  for (const session of sessions) {
    let raw = "";
    try {
      raw = await readFile(session.path, "utf8");
    } catch {
      continue; // deleted between listing and reading
    }
    if (!raw.toLowerCase().includes(needle)) continue;

    const { messages = [] } = await readSessionMessages(session.path);
    const snippets = [];
    for (const message of messages) {
      const text = messageText(message);
      const at = text.toLowerCase().indexOf(needle);
      if (at === -1) continue;
      snippets.push({
        role: String(message.role ?? "assistant"),
        text: snippetAround(text, at, needle),
      });
      if (snippets.length >= SEARCH_SNIPPETS_PER_SESSION) break;
    }
    // The raw log matched but no rendered message did — the hit is in metadata
    // or tool payloads. Still worth surfacing the session, without a snippet.
    results.push({
      path: session.path,
      name: session.name,
      cwd: session.cwd,
      backend: session.backend,
      modifiedAt: session.modifiedAt,
      messageCount: session.messageCount,
      snippets,
    });
  }
  // Sessions where a rendered message matched are far more useful than ones
  // that only matched inside tool payloads or metadata, so they lead.
  results.sort(
    (left, right) =>
      (right.snippets.length > 0 ? 1 : 0) -
        (left.snippets.length > 0 ? 1 : 0) ||
      (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0),
  );
  return { ok: true, results: results.slice(0, SEARCH_MAX_RESULTS) };
}
