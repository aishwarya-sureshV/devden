/**
 * Context X-ray: what compaction ate.
 *
 * Pure helpers shared by pi-agent's post-compaction guard and the
 * /api/xray endpoint: detect standing instructions in user messages,
 * decide whether the new context still carries them, and parse a pi
 * session file's compaction entries back into renderable records.
 *
 * ponytail: keyword heuristics, not semantics — instructions are detected
 * by modal-verb patterns and "carried" by significant-word overlap with the
 * summary. Upgrade to an embedding/LLM check only if misses actually hurt.
 */

/** User messages that read like a standing instruction, not a question. */
const INSTRUCTION_RE =
  /\b(always|never|must|make sure|ensure|do not|don'?t|from now on|whenever|before you|remember to|keep the|keep using|use only|only use|prefer|no matter|every time|without fail|be sure to)\b/i;

/** Words too generic to prove a summary carried a specific instruction. */
const STOPWORDS = new Set([
  "that",
  "this",
  "with",
  "from",
  "have",
  "then",
  "when",
  "what",
  "which",
  "your",
  "will",
  "should",
  "would",
  "could",
  "them",
  "they",
  "here",
  "there",
  "into",
  "just",
  "like",
  "also",
  "more",
  "most",
  "some",
  "such",
  "than",
  "only",
  "very",
  "much",
  "over",
  "under",
  "again",
  "both",
  "each",
  "other",
  "being",
  "been",
  "because",
  "about",
  "after",
  "before",
  "while",
  "these",
  "those",
  "want",
  "need",
  "make",
  "made",
  "sure",
  "files",
  "file",
]);

export function isStandingInstruction(text) {
  const value = String(text ?? "").trim();
  if (!value || value.startsWith("/")) return false;
  return INSTRUCTION_RE.test(value);
}

/** One-line snippet of an instruction, for cards and re-assertion lists. */
export function instructionSnippet(text, max = 240) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function significantWords(text) {
  const words = String(text ?? "")
    .toLowerCase()
    .match(/[a-z][a-z0-9_.-]{3,}/g);
  if (!words) return [];
  return [...new Set(words.filter((word) => !STOPWORDS.has(word)))];
}

/**
 * Heuristic: is `text` still reflected in `haystack` (the post-compaction
 * context — summary plus kept messages)? Two significant-word hits, or a
 * direct snippet match when the instruction has almost no keywords.
 */
export function carriedIn(haystack, text) {
  const hay = String(haystack ?? "").toLowerCase();
  if (!hay) return false;
  const words = significantWords(text);
  if (words.length === 0)
    return hay.includes(instructionSnippet(text, 80).toLowerCase());
  const hits = words.filter((word) => hay.includes(word)).length;
  return hits >= Math.min(2, words.length);
}

/** Extract plain text from a pi AgentMessage (string or content blocks). */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("\n")
    .trim();
}

export function entryTimestamp(entry) {
  const value = Number(entry?.message?.timestamp);
  if (Number.isFinite(value) && value > 0) return value;
  const parsed = Date.parse(String(entry?.timestamp ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * User messages that read like standing instructions.
 * `messages` are pi AgentMessages ({ role, content }).
 */
export function standingInstructions(messages) {
  const found = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "user") continue;
    const text = messageText(message);
    if (!text || !isStandingInstruction(text)) continue;
    found.push({ text: instructionSnippet(text), fullText: text });
  }
  return found;
}

/**
 * Standing instructions from `userMessages` that neither the summary nor the
 * kept context still mention — the ones compaction silently dropped.
 */
export function findDroppedInstructions({ summary, liveText, userMessages }) {
  const hay = `${String(summary ?? "")}\n${String(liveText ?? "")}`;
  return standingInstructions(userMessages).filter(
    (instruction) => !carriedIn(hay, instruction.fullText),
  );
}

/**
 * Parse a pi session .jsonl into x-ray records: one per compaction entry,
 * each with the cut resolved to the timestamp of the first kept entry.
 */
export function parseSessionCompactions(contents) {
  const entries = [];
  for (const line of String(contents || "").split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* skip malformed lines; the transcript is append-only so this is rare */
    }
  }
  const compactions = [];
  for (const entry of entries) {
    if (entry?.type !== "compaction") continue;
    const kept = entries.find(
      (candidate) => candidate?.id === entry.firstKeptEntryId,
    );
    compactions.push({
      at: entryTimestamp(entry) || Date.now(),
      tokensBefore:
        typeof entry.tokensBefore === "number" ? entry.tokensBefore : null,
      summary: typeof entry.summary === "string" ? entry.summary : "",
      firstKeptEntryId: String(entry.firstKeptEntryId ?? ""),
      cutTimestamp: kept ? entryTimestamp(kept) : null,
    });
  }
  return { compactions, entries };
}

/** Counts of what fell into the dead zone (entries before the cut). */
export function deadZoneStats(entries, cutTimestamp) {
  const stats = {
    messages: 0,
    userMessages: 0,
    toolCalls: 0,
    failedToolCalls: 0,
  };
  if (!cutTimestamp) return stats;
  for (const entry of entries) {
    if (entry?.type !== "message" || !entry?.message) continue;
    if (entryTimestamp(entry) >= cutTimestamp) continue;
    const role = entry.message.role;
    if (role === "user" || role === "assistant") stats.messages += 1;
    if (role === "user") stats.userMessages += 1;
    if (role === "toolResult") {
      stats.toolCalls += 1;
      if (entry.message.isError) stats.failedToolCalls += 1;
    }
  }
  return stats;
}

/** Failed tool calls still live in the model's context (after the cut). */
export function liveFailures(entries, cutTimestamp) {
  const counts = new Map();
  const cut = cutTimestamp ?? 0;
  for (const entry of entries) {
    if (entry?.type !== "message" || !entry?.message) continue;
    if (entryTimestamp(entry) < cut) continue;
    if (entry.message.role !== "toolResult" || !entry.message.isError) continue;
    const name = String(entry.message.toolName ?? "tool");
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/** The message devden auto-sends after a compaction ate live constraints. */
export function buildReassertion(dropped) {
  const lines = dropped
    .map(
      (instruction) =>
        `- ${instructionSnippet(instruction.text ?? instruction.fullText)}`,
    )
    .join("\n");
  return [
    `[context guard] The compaction summary above no longer mentions the standing instructions below. They remain in force:`,
    lines,
    `Acknowledge briefly and keep following them for the rest of the session.`,
  ].join("\n");
}
