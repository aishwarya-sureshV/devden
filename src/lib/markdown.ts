/**
 * Small markdown → HTML for replay prose (agent replies, user asks).
 * Matches the live chat subset: fences, headings, lists, tables, inline
 * code / bold / italic, plus numbered lists the chat renderer still skips.
 */
import { highlightToHtml } from "./highlightTokens.ts";

export function mdToHtml(source: string): string {
  const parts = splitFences(source.replace(/\r\n/g, "\n"));
  return parts
    .map((part) =>
      part.type === "code" ? renderCode(part.text, part.language) : renderBlocks(part.text),
    )
    .join("");
}

type Part =
  | { type: "prose"; text: string }
  | { type: "code"; text: string; language?: string };

function splitFences(text: string): Part[] {
  const lines = text.split("\n");
  const parts: Part[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (!prose.length) return;
    const chunk = prose.join("\n");
    prose = [];
    if (chunk.length) parts.push({ type: "prose", text: chunk });
  };

  for (let i = 0; i < lines.length; i++) {
    const opening = matchOpeningFence(lines[i] ?? "");
    if (!opening) {
      prose.push(lines[i] ?? "");
      continue;
    }
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (isClosingFence(lines[j] ?? "", opening.char, opening.length)) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      prose.push(lines[i] ?? "");
      continue;
    }
    flush();
    parts.push({
      type: "code",
      text: lines.slice(i + 1, close).join("\n"),
      language: opening.language,
    });
    i = close;
  }
  flush();
  return parts.length ? parts : [{ type: "prose", text: "" }];
}

function matchOpeningFence(
  line: string,
): { char: string; length: number; language?: string } | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const marker = match[2] ?? "";
  const rest = match[3] ?? "";
  const char = marker[0] ?? "`";
  if (char === "`" && rest.includes("`")) return null;
  const info = rest.trim();
  const token = info.split(/\s+/, 1)[0] ?? "";
  const language = /^[\w.+#-]+$/.test(token) ? token : undefined;
  return { char, length: marker.length, language };
}

function isClosingFence(line: string, char: string, length: number): boolean {
  const match = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(line);
  if (!match) return false;
  const marker = match[2] ?? "";
  return marker[0] === char && marker.length >= length;
}

function renderCode(text: string, language?: string): string {
  const lang = language ? ` data-lang="${esc(language)}"` : "";
  return `<pre class="md-code"${lang}><code>${highlightToHtml(text, language)}</code></pre>`;
}

function renderBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = Math.min((heading[1] ?? "").length + 2, 6);
      out.push(`<h${level} class="md-h">${inline(heading[2] ?? "")}</h${level}>`);
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      const table = [lines[i] ?? ""];
      i += 2;
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        table.push(lines[i] ?? "");
        i += 1;
      }
      out.push(renderTable(table));
      continue;
    }
    if (/^[-*•]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test((lines[i] ?? "").trim())) {
        items.push((lines[i] ?? "").trim().replace(/^[-*•]\s+/, ""));
        i += 1;
      }
      out.push(
        `<ul class="md-list">${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`,
      );
      continue;
    }
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test((lines[i] ?? "").trim())) {
        items.push((lines[i] ?? "").trim().replace(/^\d+[.)]\s+/, ""));
        i += 1;
      }
      out.push(
        `<ol class="md-list">${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ol>`,
      );
      continue;
    }
    const para = [line];
    i += 1;
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^(#{1,4})\s+/.test((lines[i] ?? "").trim()) &&
      !/^[-*•]\s+/.test((lines[i] ?? "").trim()) &&
      !/^\d+[.)]\s+/.test((lines[i] ?? "").trim()) &&
      !isTableStart(lines, i)
    ) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    out.push(`<p>${inline(para.join("\n"))}</p>`);
  }
  return out.join("");
}

function renderTable(lines: string[]): string {
  const [headerLine = "", ...body] = lines;
  const headers = splitCells(headerLine);
  const rows = body.map(splitCells);
  const head = headers.map((cell) => `<th>${inline(cell)}</th>`).join("");
  const trs = rows
    .map(
      (row) =>
        `<tr>${headers.map((_, n) => `<td>${inline(row[n] ?? "")}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<div class="md-table"><table><thead><tr>${head}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

function isTableStart(lines: string[], index: number): boolean {
  const current = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return (
    isTableRow(current) &&
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)
  );
}

function isTableRow(line: string): boolean {
  return line.includes("|") && splitCells(line).length > 1;
}

function splitCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function inline(text: string): string {
  let out = "";
  let buf = "";
  const flush = () => {
    if (!buf) return;
    out += esc(buf);
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "\\" && i + 1 < text.length && "*_`~\\[]".includes(text[i + 1] ?? "")) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      let ticks = 0;
      while (text[i + ticks] === "`") ticks += 1;
      const closer = "`".repeat(ticks);
      const end = text.indexOf(closer, i + ticks);
      if (end !== -1 && end !== i + ticks) {
        let code = text.slice(i + ticks, end);
        if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" "))
          code = code.slice(1, -1);
        flush();
        out += `<code>${esc(code)}</code>`;
        i = end + ticks;
        continue;
      }
    }
    if (ch === "[") {
      const mid = text.indexOf("](", i + 1);
      const end = mid === -1 ? -1 : text.indexOf(")", mid + 2);
      if (mid !== -1 && end !== -1) {
        const href = text.slice(mid + 2, end).trim();
        if (/^(https?:|mailto:)/i.test(href)) {
          flush();
          out += `<a href="${esc(href)}" target="_blank" rel="noreferrer">${inline(text.slice(i + 1, mid))}</a>`;
          i = end + 1;
          continue;
        }
      }
    }
    if (text.startsWith("***", i)) {
      const end = findDelim(text, "***", i + 3);
      if (end !== -1) {
        flush();
        out += `<strong><em>${inline(text.slice(i + 3, end))}</em></strong>`;
        i = end + 3;
        continue;
      }
    }
    if (text.startsWith("**", i)) {
      const end = findDelim(text, "**", i + 2);
      if (end !== -1) {
        flush();
        out += `<strong>${inline(text.slice(i + 2, end))}</strong>`;
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith("~~", i)) {
      const end = findDelim(text, "~~", i + 2);
      if (end !== -1) {
        flush();
        out += `<del>${inline(text.slice(i + 2, end))}</del>`;
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" && isEmOpen(text, i, "*")) {
      const end = findEmClose(text, i + 1, "*");
      if (end !== -1) {
        flush();
        out += `<em>${inline(text.slice(i + 1, end))}</em>`;
        i = end + 1;
        continue;
      }
    }
    if (ch === "_" && isEmOpen(text, i, "_") && !isWord(text[i - 1])) {
      const end = findEmClose(text, i + 1, "_");
      if (end !== -1 && !isWord(text[end + 1])) {
        flush();
        out += `<em>${inline(text.slice(i + 1, end))}</em>`;
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

function isEmOpen(text: string, index: number, marker: "*" | "_"): boolean {
  const next = text[index + 1];
  return Boolean(next && next !== marker && next !== " " && next !== "\n");
}

function isWord(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9]/.test(char));
}

function findDelim(text: string, delim: string, from: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text.startsWith(delim, i)) return i;
    i += 1;
  }
  return -1;
}

function findEmClose(text: string, from: number, marker: "*" | "_"): number {
  const doubled = marker + marker;
  let i = from;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text.startsWith(doubled, i)) {
      i += 2;
      continue;
    }
    if (text[i] === marker && text[i - 1] !== " " && text[i - 1] !== "\n")
      return i;
    i += 1;
  }
  return -1;
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    if (ch === '"') return "&quot;";
    return "&#39;";
  });
}
