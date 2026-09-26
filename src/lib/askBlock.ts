/**
 * Structured clarifying questions.
 *
 * CLARIFY_PROMPT tells every backend to ask its questions inside an ```ask
 * fence holding JSON, so the UI can render pickable options instead of asking
 * the user to type an answer to a question the model already enumerated. A
 * ```json fence with that same payload counts too: some models (glm-5.3-flash)
 * tag the fence json. The fence is the whole protocol: no tool channel, which
 * matters because pi (RPC), claude (SDK) and grok (ACP) have three different ones.
 */

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

/** A fenced ```ask block anywhere in the message. */
const ASK_FENCE = /(^|\n)[ ]{0,3}(?:`{3,}|~{3,})[ \t]*ask[ \t]*(\n|$)/;

export function hasAskBlock(text: string | undefined): boolean {
  return ASK_FENCE.test(text ?? "");
}

/** Body of the first complete ```ask fence, or null if none has closed yet. */
export function firstAskPayload(text: string | undefined): string | null {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^( {0,3})(`{3,}|~{3,})[ \t]*ask[ \t]*$/.exec(lines[i] ?? "");
    if (!open) continue;
    const marker = open[2] ?? "```";
    const char = marker[0];
    for (let j = i + 1; j < lines.length; j++) {
      const close = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(lines[j] ?? "");
      if (
        close &&
        (close[2] ?? "")[0] === char &&
        (close[2] ?? "").length >= marker.length
      ) {
        return lines.slice(i + 1, j).join("\n");
      }
    }
    // No closing fence: glm-5.3 tags the fence open and appends a
    // hallucinated tool-call tail (</arg_value></tool_call>) instead of the
    // closer, so the body reads unterminated even though the payload is
    // complete. Return the body and let parseAsk validate — a half-streamed
    // payload just won't parse, so streaming still shows the pending card.
    return lines.slice(i + 1).join("\n");
  }
  return null;
}

/** Parsed questions from the first complete ask fence; later duplicates ignored. */
export function firstAsk(text: string | undefined): AskQuestion[] | null {
  const payload = firstAskPayload(text);
  return payload == null ? null : parseAsk(payload);
}

/**
 * Questions from a message: the first ```ask fence, or — when the model kept
 * the payload but dropped the fence markers (flash-tier models do this) — the
 * bare JSON itself, or a ```json fence whose body is that same payload
 * (glm-5.3-flash tags the fence json). Only a message that is exactly the
 * payload matches the bare path; JSON.parse fails fast on any surrounding
 * prose, so ordinary replies that merely mention or quote the shape never
 * become cards. A json fence still has to parse as questions with options.
 */
export function messageAsk(text: string | undefined): AskQuestion[] | null {
  return firstAsk(text) ?? parseAsk((text ?? "").trim()) ?? firstJsonAsk(text);
}

/** Does this message carry the ask protocol, fenced or bare? */
export function isAskMessage(text: string | undefined): boolean {
  return messageAsk(text) !== null || hasAskBlock(text);
}

/** Start of a fence-less questions payload still streaming in. */
const BARE_ASK_START = /^\s*\{\s*"questions"\s*:/;

/**
 * Open ```json fence whose body has started the questions object. A finished
 * fence is messageAsk's job; this only covers the stream, before the closer.
 */
const JSON_ASK_STREAM =
  /(?:^|\n)[ ]{0,3}(?:`{3,}|~{3,})[ \t]*json[ \t]*\n[\s\S]*\{\s*"questions"\s*:/i;

/** Live check: an ask is on the way but not parseable yet. */
export function askIncoming(text: string | undefined): boolean {
  const raw = text ?? "";
  if (messageAsk(raw)) return false;
  if (hasAskBlock(raw) || BARE_ASK_START.test(raw)) return true;
  return JSON_ASK_STREAM.test(raw);
}

/**
 * First ```json fence whose body parses as questions. Other fences are
 * skipped. An unclosed fence swallows the rest of the message, so this
 * returns null until the closer arrives.
 */
function firstJsonAsk(text: string | undefined): AskQuestion[] | null {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*$/.exec(
      lines[i] ?? "",
    );
    if (!open) continue;
    const lang = (open[3] ?? "").toLowerCase();
    const marker = open[2] ?? "```";
    const char = marker[0];
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const end = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(lines[j] ?? "");
      if (
        end &&
        (end[2] ?? "")[0] === char &&
        (end[2] ?? "").length >= marker.length
      ) {
        close = j;
        break;
      }
    }
    if (close === -1) return null;
    if (lang === "json") {
      const parsed = parseAsk(lines.slice(i + 1, close).join("\n"));
      if (parsed) return parsed;
    }
    i = close;
  }
  return null;
}

/**
 * Parse an ask block's payload. Returns null for anything malformed — a
 * half-streamed fence, or a model that wrote prose in it — so callers fall
 * back to rendering the raw block rather than showing a broken card.
 */
/** A line that is only XML tags — the tool-call tail glm-5.3 emits instead
 *  of the closing fence (`</arg_value></tool_call>`). Never valid JSON, so
 *  stripping trailing ones before parsing is safe. */
const XML_TAG_LINE = /^\s*(?:<\/?[a-zA-Z][^<>]*>[\s]*)+$/;

function stripTrailingXmlTags(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && XML_TAG_LINE.test(lines[lines.length - 1] ?? "")) {
    lines.pop();
  }
  return lines.join("\n");
}

export function parseAsk(raw: string): AskQuestion[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingXmlTags(raw));
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return null;

  const questions: AskQuestion[] = [];
  for (const entry of list) {
    const row = entry as Partial<AskQuestion> | null;
    const question = typeof row?.question === "string" ? row.question : "";
    const options: AskOption[] = [];
    for (const raw of Array.isArray(row?.options) ? row.options : []) {
      // Models drop to a bare string list about as often as they follow the
      // object shape; both mean the same thing.
      if (typeof raw === "string" && raw) options.push({ label: raw });
      else if (typeof (raw as AskOption)?.label === "string")
        options.push({
          label: (raw as AskOption).label,
          description:
            typeof (raw as AskOption).description === "string"
              ? (raw as AskOption).description
              : undefined,
        });
    }
    if (!question || options.length === 0) continue;
    questions.push({
      question,
      header: typeof row?.header === "string" ? row.header : undefined,
      options,
      multiSelect: row?.multiSelect === true,
    });
  }
  return questions.length > 0 ? questions : null;
}
