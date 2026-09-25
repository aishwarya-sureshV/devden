/**
 * Cut a Grok fork at a user prompt. Grok's x.ai/session/fork copies the whole
 * session unless targetPromptIndex is set, and even then some builds leave
 * updates.jsonl longer than chat_history.jsonl. These helpers slice the
 * in-memory transcript and trim both journals so the new tab stops at the
 * reply that was forked.
 */
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { messagesFromGrokLog, parseSubagentId } from "./sessions.js";

const JOURNAL_FILES = ["chat_history.jsonl", "updates.jsonl"];

/** True when the log has at least one real user turn (not a system reminder). */
export function grokChatHasTurns(contents) {
  return messagesFromGrokLog(contents).some((message) => message?.role === "user");
}

export function grokSubagentIdsFromHistory(contents) {
  const ids = [];
  const seen = new Set();
  for (const line of String(contents || "").split("\n")) {
    const id = parseSubagentId(line);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** GROK_SESSIONS_ROOT/<encodeURIComponent(cwd)>/<sessionId>/chat_history.jsonl */
export function cwdFromGrokSession(sessionPath) {
  if (!sessionPath) return "";
  try {
    const decoded = decodeURIComponent(basename(dirname(dirname(sessionPath))));
    return decoded.startsWith("/") || /^[A-Za-z]:\\/.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Grok journals have no timestamps (the loader stamps Date.now()), so a
 * client promptIndex that counted an extra steer or reminder row has to be
 * checked against the clicked user text. Exact text wins; otherwise the
 * client index stands.
 */
export function resolvePromptIndex(messages, promptIndex, userText) {
  const users = (Array.isArray(messages) ? messages : []).filter(
    (message) => message?.role === "user",
  );
  const last = Math.max(0, users.length - 1);
  const given = Number.isFinite(Number(promptIndex))
    ? Math.max(0, Number(promptIndex))
    : last;
  const capped = Math.min(given, last);
  const needle = String(userText ?? "").trim();
  if (!needle || users.length === 0) return capped;
  if (messageText(users[capped]) === needle) return capped;
  let best = capped;
  let bestDist = Infinity;
  users.forEach((message, index) => {
    if (messageText(message) !== needle) return;
    const dist = Math.abs(index - given);
    if (dist < bestDist) {
      bestDist = dist;
      best = index;
    }
  });
  return bestDist === Infinity ? capped : best;
}

/** Copy Grok's journals so an empty ACP fork can still open the source chat. */
export async function copyGrokJournals(sourceSessionFile, destSessionFile) {
  if (!sourceSessionFile || !destSessionFile) return;
  if (sourceSessionFile === destSessionFile) return;
  const srcDir = dirname(sourceSessionFile);
  const destDir = dirname(destSessionFile);
  await mkdir(destDir, { recursive: true });
  await Promise.all(
    JOURNAL_FILES.map(async (name) => {
      const from = join(srcDir, name);
      if (!existsSync(from)) return;
      await copyFile(from, join(destDir, name));
    }),
  );
}

/**
 * Child sessions live as sibling folders under the same cwd encoding, plus
 * parent/subagents/<id>. Copy only the children named in the dest journal
 * so a mid-chat fork does not inherit later spawns.
 */
export function copyGrokForkSidecars(sourceSessionFile, destSessionFile) {
  if (!sourceSessionFile || !destSessionFile) return;
  const srcDir = dirname(sourceSessionFile);
  const destDir = dirname(destSessionFile);
  mkdirSync(destDir, { recursive: true });
  const history = join(destDir, "chat_history.jsonl");
  const ids = grokSubagentIdsFromHistory(
    existsSync(history) ? readFileSync(history, "utf8") : "",
  );
  const srcAgents = join(srcDir, "subagents");
  if (existsSync(srcAgents) && ids.length > 0) {
    const destAgents = join(destDir, "subagents");
    mkdirSync(destAgents, { recursive: true });
    for (const id of ids) {
      const from = join(srcAgents, id);
      if (!existsSync(from)) continue;
      cpSync(from, join(destAgents, id), { recursive: true });
    }
  }
  if (srcDir === destDir) return;
  const srcCwdDir = dirname(srcDir);
  const destCwdDir = dirname(destDir);
  mkdirSync(destCwdDir, { recursive: true });
  for (const id of ids) {
    const from = join(srcCwdDir, id);
    const to = join(destCwdDir, id);
    if (!existsSync(from) || from === to) continue;
    cpSync(from, to, { recursive: true });
  }
}

/**
 * ACP fork sometimes writes only a system reminder into the new session
 * (source id was a fresh newSession, or targetPromptIndex cut too hard).
 * If the dest log has no readable turns, copy the source journals first,
 * then trim both files to the fork point.
 */
export async function seedGrokForkJournals(sourceSessionFile, destSessionFile, promptIndex) {
  if (!destSessionFile) return;
  const destHistory = join(dirname(destSessionFile), "chat_history.jsonl");
  const destText = existsSync(destHistory)
    ? await readFile(destHistory, "utf8")
    : "";
  if (
    !grokChatHasTurns(destText) &&
    sourceSessionFile &&
    existsSync(sourceSessionFile)
  ) {
    await copyGrokJournals(sourceSessionFile, destSessionFile);
  }
  await trimGrokForkFiles(destSessionFile, promptIndex);
  try {
    copyGrokForkSidecars(sourceSessionFile, destSessionFile);
  } catch {
    /* journals still open the fork; nested tools hydrate on the next refresh */
  }
}

/** 0-based user-turn index of the assistant closest to `timestamp`. */
export function promptIndexFromTimestamp(messages, timestamp) {
  const list = Array.isArray(messages) ? messages : [];
  const requested = Number(timestamp);
  let best = -1;
  let bestDist = Infinity;
  if (Number.isFinite(requested)) {
    for (let i = 0; i < list.length; i++) {
      if (list[i]?.role !== "assistant") continue;
      const time = Number(list[i]?.timestamp);
      if (!Number.isFinite(time)) continue;
      const dist = Math.abs(time - requested);
      if (dist <= bestDist) {
        bestDist = dist;
        best = i;
      }
    }
  }
  if (best < 0) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.role === "assistant") {
        best = i;
        break;
      }
    }
  }
  if (best < 0) return 0;
  let users = 0;
  for (let i = 0; i <= best; i++) {
    if (list[i]?.role === "user") users += 1;
  }
  return Math.max(0, users - 1);
}

/** Keep user turns [0..promptIndex] and the assistant/tool results after them. */
export function sliceMessagesThroughPrompt(messages, promptIndex) {
  const list = Array.isArray(messages) ? messages : [];
  const keep = Number.isFinite(Number(promptIndex))
    ? Math.max(0, Number(promptIndex))
    : list.length;
  const out = [];
  let seen = 0;
  for (const message of list) {
    if (message?.role === "user") {
      if (seen > keep) break;
      seen += 1;
    }
    out.push(message);
  }
  return out;
}

export function trimGrokChatHistory(contents, promptIndex) {
  const keep = Math.max(0, Number(promptIndex) || 0);
  const lines = [];
  let dropping = false;
  let userOrdinal = -1;
  for (const line of String(contents || "").split("\n")) {
    if (!line) {
      if (!dropping) lines.push(line);
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      if (!dropping) lines.push(line);
      continue;
    }
    if (entry?.type === "user" && !entry.synthetic_reason) {
      userOrdinal += 1;
      // Older journals have no prompt_index. Counting real user rows is the
      // same cut the field would have recorded.
      const index =
        typeof entry.prompt_index === "number" ? entry.prompt_index : userOrdinal;
      if (index > keep) {
        dropping = true;
        continue;
      }
    }
    if (dropping) continue;
    lines.push(line);
  }
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Keep updates through `keepTurns` turn_completed events (promptIndex + 1). */
export function trimGrokUpdates(contents, keepTurns) {
  const keep = Math.max(0, Number(keepTurns) || 0);
  if (keep === 0) return "";
  const lines = [];
  let completed = 0;
  for (const line of String(contents || "").split("\n")) {
    if (!line) continue;
    lines.push(line);
    try {
      const entry = JSON.parse(line);
      const update = entry?.params?.update ?? {};
      if (update.sessionUpdate === "turn_completed") {
        completed += 1;
        if (completed >= keep) break;
      }
    } catch {
      /* keep the line; it is not a completed-turn marker */
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export async function trimGrokForkFiles(sessionFile, promptIndex) {
  if (!sessionFile) return;
  const dir = dirname(sessionFile);
  const history = join(dir, "chat_history.jsonl");
  const updates = join(dir, "updates.jsonl");
  if (existsSync(history)) {
    await writeFile(
      history,
      trimGrokChatHistory(await readFile(history, "utf8"), promptIndex),
    );
  }
  if (existsSync(updates)) {
    await writeFile(
      updates,
      trimGrokUpdates(await readFile(updates, "utf8"), Number(promptIndex) + 1),
    );
  }
}
