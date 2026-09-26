/**
 * Server-side ask detection, mirroring src/lib/askBlock.ts (same fence, same
 * exact-bare-JSON fallback for models that drop the fence markers, same
 * ```json fence for models that tag the payload json). Needed because the
 * queue must hold typed prompts while a settled turn's ask waits for an
 * answer — and the queue lives on the server, where no message text was
 * previously parsed.
 */
const ASK_FENCE = /(^|\n)[ ]{0,3}(?:`{3,}|~{3,})[ \t]*ask[ \t]*(\n|$)/;

function payloadIsAsk(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed ?? undefined)?.questions;
    if (!Array.isArray(list)) return false;
    return list.some(
      (entry) =>
        entry &&
        typeof entry.question === "string" &&
        Array.isArray(entry.options) &&
        entry.options.length > 0,
    );
  } catch {
    return false;
  }
}

/** Closed ```json fence whose body is an ask payload. */
function jsonFenceIsAsk(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
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
    if (close === -1) return false;
    if (lang === "json" && payloadIsAsk(lines.slice(i + 1, close).join("\n"))) {
      return true;
    }
    i = close;
  }
  return false;
}

export function hasAskBlock(text) {
  const t = String(text ?? "");
  if (ASK_FENCE.test(t)) return true;
  // messageAsk()'s fallback: only a message that is exactly the payload
  // counts, so ordinary replies quoting the shape never read as an ask.
  // A ```json fence is the other flash-model slip (glm-5.3-flash).
  if (payloadIsAsk(t)) return true;
  return jsonFenceIsAsk(t);
}
