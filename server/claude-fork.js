/**
 * Fork a Claude Code session at a reply: slice the JSONL through that
 * assistant, remap ids, and write a new ~/.claude/projects file.
 */
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

function claudeHome() {
  return process.env.HOME || homedir();
}

function parseJsonl(contents) {
  const entries = [];
  for (const line of String(contents || "").split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* skip a corrupt line */
    }
  }
  return entries;
}

function isToolResultUser(entry) {
  const content = entry?.message?.content;
  return (
    Array.isArray(content) &&
    content.some((block) => block?.type === "tool_result")
  );
}

function isRealUser(entry) {
  return (
    entry?.type === "user" && !entry.isMeta && !isToolResultUser(entry)
  );
}

/** Inclusive index of the assistant closest to `timestamp`, plus its tools. */
export function cutoffIndexForTimestamp(entries, timestamp) {
  const list = Array.isArray(entries) ? entries : [];
  const requested = Number(timestamp);
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < list.length; i++) {
    if (list[i]?.type !== "assistant") continue;
    const at = Date.parse(list[i]?.timestamp ?? "");
    if (!Number.isFinite(at)) continue;
    if (!Number.isFinite(requested)) {
      best = i;
      continue;
    }
    const dist = Math.abs(at - requested);
    if (dist <= bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  if (best < 0) return Math.max(0, list.length - 1);
  let end = best;
  for (let i = best + 1; i < list.length; i++) {
    if (isRealUser(list[i])) break;
    end = i;
  }
  return end;
}

function collectToolUseIds(entries) {
  const ids = new Set();
  for (const entry of entries) {
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && typeof block.id === "string")
        ids.add(block.id);
    }
  }
  return ids;
}

/** Copy child transcripts whose Agent/Task call is in the sliced parent log. */
export function copyClaudeSubagents(sourcePath, destPath, entries) {
  if (!sourcePath || !destPath || sourcePath === destPath) return;
  const srcDir = join(String(sourcePath).replace(/\.jsonl$/, ""), "subagents");
  if (!existsSync(srcDir)) return;
  const keep = collectToolUseIds(entries);
  // No tool call in the slice means no child belongs to the fork. Copying
  // every folder (the old keep.size === 0 bypass) pulled in later spawns.
  if (keep.size === 0) return;
  const destDir = join(String(destPath).replace(/\.jsonl$/, ""), "subagents");
  mkdirSync(destDir, { recursive: true });
  let names = [];
  try {
    names = readdirSync(srcDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    try {
      const meta = JSON.parse(readFileSync(join(srcDir, name), "utf8"));
      const toolUseId = String(meta.toolUseId ?? "");
      if (!toolUseId || !keep.has(toolUseId)) continue;
      copyFileSync(join(srcDir, name), join(destDir, name));
      const log = name.replace(/\.meta\.json$/, ".jsonl");
      if (existsSync(join(srcDir, log)))
        copyFileSync(join(srcDir, log), join(destDir, log));
    } catch {
      /* a child still mid-flight has no readable meta/log pair yet */
    }
  }
}

function remapId(ids, value) {
  if (typeof value !== "string") return value;
  return ids.has(value) ? ids.get(value) : null;
}

export function remapClaudeEntries(entries, newSessionId, forkCwd) {
  const ids = new Map();
  const mapped = [];
  for (const entry of entries) {
    if (typeof entry?.uuid === "string" && !ids.has(entry.uuid))
      ids.set(entry.uuid, randomUUID());
  }
  for (const entry of entries) {
    const copy = { ...entry, sessionId: newSessionId };
    if (typeof entry.uuid === "string") copy.uuid = ids.get(entry.uuid);
    if (typeof entry.parentUuid === "string")
      copy.parentUuid = remapId(ids, entry.parentUuid);
    if (typeof entry.logicalParentUuid === "string")
      copy.logicalParentUuid = remapId(ids, entry.logicalParentUuid);
    if (typeof entry.leafUuid === "string")
      copy.leafUuid = remapId(ids, entry.leafUuid);
    if (typeof entry.messageId === "string")
      copy.messageId = remapId(ids, entry.messageId);
    if (typeof entry.snapshotMessageId === "string")
      copy.snapshotMessageId = remapId(ids, entry.snapshotMessageId);
    if (typeof entry.sourceToolAssistantUUID === "string")
      copy.sourceToolAssistantUUID = remapId(ids, entry.sourceToolAssistantUUID);
    if (typeof entry.sessionId === "string") copy.forkedFrom = entry.sessionId;
    if (forkCwd && typeof copy.cwd === "string") copy.cwd = forkCwd;
    mapped.push(copy);
  }
  return mapped;
}

/** Checkpoint blobs live in ~/.claude/file-history/<sessionId>/<hash>@vN. */
async function copyClaudeFileHistory(oldSessionId, newSessionId, entries) {
  if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) return;
  const src = join(claudeHome(), ".claude", "file-history", oldSessionId);
  if (!existsSync(src)) return;
  const names = new Set();
  for (const entry of entries) {
    const name = entry?.backup?.backupFileName;
    if (typeof name !== "string" || !name || name.includes("/") || name.includes(".."))
      continue;
    names.add(name);
  }
  if (names.size === 0) return;
  const dest = join(claudeHome(), ".claude", "file-history", newSessionId);
  await mkdir(dest, { recursive: true });
  await Promise.all(
    [...names].map(async (name) => {
      const from = join(src, name);
      if (!existsSync(from)) return;
      await copyFile(from, join(dest, name));
    }),
  );
}

export async function forkClaudeTranscript(sourcePath, timestamp, destDir, forkCwd) {
  // ponytail: the JSON.parse of a 100MB transcript still blocks once the
  // bytes are in memory. Stream the cut if session logs actually get that big.
  const entries = parseJsonl(await readFile(sourcePath, "utf8"));
  if (entries.length === 0) throw new Error("Claude session log is empty");
  const end = cutoffIndexForTimestamp(entries, timestamp);
  const sliced = entries.slice(0, end + 1);
  const sessionId = randomUUID();
  const remapped = remapClaudeEntries(sliced, sessionId, forkCwd);
  const outDir = destDir || dirname(sourcePath);
  await mkdir(outDir, { recursive: true });
  const sessionFile = join(outDir, `${sessionId}.jsonl`);
  await writeFile(
    sessionFile,
    `${remapped.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  copyClaudeSubagents(sourcePath, sessionFile, sliced);
  await copyClaudeFileHistory(
    basename(String(sourcePath)).replace(/\.jsonl$/, ""),
    sessionId,
    sliced,
  );
  return { sessionId, sessionFile, entries: remapped };
}
