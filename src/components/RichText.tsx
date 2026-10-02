import { memo, useState, type JSX, type ReactNode } from "react";
import { highlightCode, NumberedCode } from "../lib/highlight";
import { clipOutput, isShellLanguage } from "../lib/runInTerminal";
import { useTerminalRuns, type TerminalRun } from "../lib/terminalRuns";
import { CopyButton } from "./CopyButton";
import { AskCard } from "./AskCard";
import { SkillDraftCard } from "./SkillDraftCard";
import { IconPlay } from "./icons";
import { askIncoming, messageAsk, parseAsk } from "../lib/askBlock";
import { parseSkillDraft } from "../lib/skilldraft";

type Segment =
  | { type: "prose"; text: string }
  | { type: "code"; text: string; language?: string };

export const RichText = memo(function RichText({
  text,
  live = false,
  onAnswer,
  skillBackend = "pi",
}: {
  text: string;
  live?: boolean;
  onAnswer?: (text: string) => void;
  skillBackend?: "pi" | "codex";
}) {
  // An ask turn is the card: hide format-talk, closing reports, and a
  // second fence the model echoed in the same message. messageAsk also
  // catches a model that dropped the fence markers, or tagged the fence
  // json, but kept the payload.
  const questions = messageAsk(text);
  if (questions) {
    return (
      <div className={`rich-text${live ? " rich-text--live" : ""}`}>
        <AskCard questions={questions} onAnswer={onAnswer} />
      </div>
    );
  }
  // Half-arrived ask (open fence, json fence, or bare JSON still streaming)
  // shows the pending card instead of raw protocol text.
  if (live && askIncoming(text)) {
    return (
      <div className={`rich-text${live ? " rich-text--live" : ""}`}>
        <div className="ask-card ask-card--pending" aria-busy="true">
          Asking…
        </div>
      </div>
    );
  }
  const segments = splitFencedBlocks(text, live);
  return (
    <div className={`rich-text${live ? " rich-text--live" : ""}`}>
      {segments.map((segment, index) =>
        segment.type === "code" ? (
          <MaybeAskBlock
            key={index}
            code={segment.text}
            language={segment.language}
            live={live}
            onAnswer={onAnswer}
            skillBackend={skillBackend}
          />
        ) : (
          <MarkdownBlocks key={index} text={segment.text} />
        ),
      )}
    </div>
  );
});

/** An ```ask fence renders as pickable options; anything else, as code. */
function MaybeAskBlock({
  code,
  language,
  live,
  onAnswer,
  skillBackend = "pi",
}: {
  code: string;
  language?: string;
  live?: boolean;
  onAnswer?: (text: string) => void;
  skillBackend?: "pi" | "codex";
}) {
  const questions = language === "ask" ? parseAsk(code) : null;
  if (questions) return <AskCard questions={questions} onAnswer={onAnswer} />;
  const skillDraft = language === "skilldraft" ? parseSkillDraft(code) : null;
  if (skillDraft) return <SkillDraftCard draft={{ ...skillDraft, backend: skillBackend }} />;
  return <CodeBlock code={code} language={language} live={live} />;
}

function CodeBlock({
  code,
  language,
  live,
}: {
  code: string;
  language?: string;
  live?: boolean;
}) {
  const terminalRuns = useTerminalRuns();
  const [runId, setRunId] = useState<string | null>(null);
  const run = runId ? terminalRuns?.runs[runId] : undefined;
  const runnable =
    Boolean(terminalRuns) &&
    !live &&
    isShellLanguage(language) &&
    Boolean(code.trim());
  const running = run?.status === "queued" || run?.status === "running";

  return (
    <div
      className={`md-code-block${runnable ? " md-code-block--runnable" : ""}`}
    >
      <NumberedCode code={code} language={language} />
      <div className="md-code-block__actions">
        {runnable && (
          <button
            type="button"
            className="md-code-block__run"
            aria-label="Run in terminal"
            title="Run in terminal"
            disabled={running}
            onClick={() => {
              const id = terminalRuns?.runCommand(code);
              if (id) setRunId(id);
            }}
          >
            <IconPlay />
          </button>
        )}
        <CopyButton
          text={code}
          label="Copy command"
          className="md-code-block__copy"
          iconOnly
        />
      </div>
      {run && <CodeRunResult run={run} />}
    </div>
  );
}

function CodeRunResult({ run }: { run: TerminalRun }) {
  const running = run.status === "queued" || run.status === "running";
  const failed =
    run.status === "error" || (run.status === "exited" && run.exitCode !== 0);
  const head = running
    ? "Running in terminal…"
    : run.status === "error"
      ? run.error || "Failed"
      : `Exit ${run.exitCode ?? "?"}`;
  const output = clipOutput(run.output);
  return (
    <div
      className={`md-code-run${running ? " is-running" : ""}${failed ? " is-fail" : ""}${run.status === "exited" && run.exitCode === 0 ? " is-ok" : ""}`}
      role="status"
    >
      <div className="md-code-run__head">{head}</div>
      {output ? <pre className="md-code-run__out">{output}</pre> : null}
    </div>
  );
}

const MarkdownBlocks = memo(function MarkdownBlocks({
  text,
}: {
  text: string;
}) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    // A callout divider ("★ Insight ─────" or a bare "─────" close line).
    // Output-style presets hardcode a fixed dash count on each side, which
    // rarely renders to the same pixel width once wrapped proportionally
    // (the label eats into one side's budget). Drawing a real rule instead
    // of literal dash characters makes both lines span the same width no
    // matter which preset produced them.
    // Some presets wrap each divider line in its own backtick span; strip
    // one from each end before matching so those still count as a rule.
    const unbackticked = trimmed.replace(/^`|`$/g, "");
    const rule = /^(.*?)\s*[─━]{6,}\s*$/u.exec(unbackticked);
    if (rule) {
      const label = (rule[1] ?? "").trim();
      nodes.push(
        label ? (
          <div key={`rule-${index}`} className="md-rule-row">
            <span>{inline(label)}</span>
            <span className="md-rule-line" />
          </div>
        ) : (
          <hr key={`rule-${index}`} className="md-rule" />
        ),
      );
      index += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = (heading[1] ?? "").length;
      const HeadingTag =
        `h${Math.min(level + 2, 6)}` as keyof JSX.IntrinsicElements;
      nodes.push(
        <HeadingTag key={`heading-${index}`} className="md-heading">
          {inline(heading[2] ?? "")}
        </HeadingTag>,
      );
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableLines = [lines[index] ?? ""];
      index += 2;
      while (index < lines.length && isTableRow(lines[index] ?? "")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      nodes.push(<MarkdownTable key={`table-${index}`} lines={tableLines} />);
      continue;
    }

    const listMarker = /^[-*•]\s+/.test(trimmed)
      ? /^[-*•]\s+/
      : /^\d+[.)]\s+/.test(trimmed)
        ? /^\d+[.)]\s+/
        : null;
    if (listMarker) {
      const ordered = listMarker.source.startsWith("^\\d");
      const start = ordered ? parseInt(trimmed, 10) : undefined;
      const items: string[] = [];
      while (
        index < lines.length &&
        listMarker.test((lines[index] ?? "").trim())
      ) {
        items.push((lines[index] ?? "").trim().replace(listMarker, ""));
        index += 1;
      }
      const ListTag = ordered ? "ol" : "ul";
      nodes.push(
        <ListTag
          key={`list-${index}`}
          className={`md-list${ordered ? " md-list--ordered" : ""}`}
          start={start}
        >
          {items.map((item, itemIndex) => (
            <li
              key={`${itemIndex}-${item}`}
              data-n={start === undefined ? undefined : start + itemIndex}
            >
              {inline(item)}
            </li>
          ))}
        </ListTag>,
      );
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !/^(#{1,4})\s+/.test((lines[index] ?? "").trim()) &&
      !/^([-*•]|\d+[.)])\s+/.test((lines[index] ?? "").trim()) &&
      !isTableStart(lines, index)
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    nodes.push(
      <p key={`paragraph-${index}`} className="md-paragraph">
        {inline(paragraph.join("\n"))}
      </p>,
    );
  }

  return <>{nodes}</>;
});

function MarkdownTable({ lines }: { lines: string[] }) {
  const [headerLine = "", ...bodyLines] = lines;
  const headers = splitTableCells(headerLine);
  const rows = bodyLines.map(splitTableCells);
  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>
            {headers.map((cell, index) => (
              <th key={`${index}-${cell}`}>{inline(cell)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={row.join("|") || rowIndex}>
              {headers.map((_, cellIndex) => (
                <td key={cellIndex}>{inline(row[cellIndex] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
  return line.includes("|") && splitTableCells(line).length > 1;
}

function splitTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * CommonMark-style fences: must start a line (0–3 spaces), use 3+ ` or ~,
 * and close with a same-character fence at least as long. Mid-line ``` and
 * unmatched fences in finished messages stay as prose so messages *about*
 * markdown don't swallow the rest of the reply.
 */
function splitFencedBlocks(text: string, live: boolean): Segment[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const segments: Segment[] = [];
  let prose: string[] = [];

  const flushProse = () => {
    if (prose.length === 0) return;
    const chunk = prose.join("\n");
    prose = [];
    if (chunk.length) segments.push({ type: "prose", text: chunk });
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
      // Streaming: keep an open fence as a code block. Finished messages leave
      // unmatched ``` as prose so examples/discussion of fences don't swallow
      // the rest of the reply.
      if (live) {
        flushProse();
        segments.push({
          type: "code",
          text: lines.slice(i + 1).join("\n"),
          language: opening.language,
        });
        return segments;
      }
      prose.push(lines[i] ?? "");
      continue;
    }

    flushProse();
    segments.push({
      type: "code",
      text: lines.slice(i + 1, close).join("\n"),
      language: opening.language,
    });
    i = close;
  }

  flushProse();
  return segments.length ? segments : [{ type: "prose", text: "" }];
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

function inline(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let buffer = "";
  let key = 0;

  const flush = () => {
    if (!buffer) return;
    nodes.push(buffer);
    buffer = "";
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i] ?? "";

    if (
      char === "\\" &&
      i + 1 < text.length &&
      "*_`~\\".includes(text[i + 1] ?? "")
    ) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }

    if (char === "`") {
      let ticks = 0;
      while (text[i + ticks] === "`") ticks += 1;
      const closer = "`".repeat(ticks);
      const end = text.indexOf(closer, i + ticks);
      if (end !== -1 && end !== i + ticks) {
        let code = text.slice(i + ticks, end);
        if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" "))
          code = code.slice(1, -1);
        flush();
        const language = inlineLanguage(code);
        nodes.push(
          <code key={key++} className="md-inline-code">
            {language ? highlightCode(code, language) : code}
          </code>,
        );
        i = end + ticks;
        continue;
      }
    }

    if (text.startsWith("***", i)) {
      const end = findDelimiter(text, "***", i + 3);
      if (end !== -1) {
        flush();
        nodes.push(
          <strong key={key++}>
            <em>{inline(text.slice(i + 3, end))}</em>
          </strong>,
        );
        i = end + 3;
        continue;
      }
    }

    if (text.startsWith("**", i)) {
      const end = findDelimiter(text, "**", i + 2);
      if (end !== -1) {
        flush();
        nodes.push(
          <strong key={key++}>{inline(text.slice(i + 2, end))}</strong>,
        );
        i = end + 2;
        continue;
      }
    }

    if (char === "*" && isEmphOpen(text, i, "*")) {
      const end = findEmClose(text, i + 1, "*");
      if (end !== -1) {
        flush();
        nodes.push(<em key={key++}>{inline(text.slice(i + 1, end))}</em>);
        i = end + 1;
        continue;
      }
    }

    if (char === "_" && isEmphOpen(text, i, "_") && !isWordChar(text[i - 1])) {
      const end = findEmClose(text, i + 1, "_");
      if (end !== -1 && !isWordChar(text[end + 1])) {
        flush();
        nodes.push(<em key={key++}>{inline(text.slice(i + 1, end))}</em>);
        i = end + 1;
        continue;
      }
    }

    buffer += char;
    i += 1;
  }

  flush();
  return nodes;
}

function isEmphOpen(text: string, index: number, marker: "*" | "_"): boolean {
  const next = text[index + 1];
  return Boolean(next && next !== marker && next !== " " && next !== "\n");
}

function isWordChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9]/.test(char));
}

function findDelimiter(text: string, delim: string, from: number): number {
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

function inlineLanguage(code: string): string | undefined {
  const trimmed = code.trim();
  if (
    /^(?:const|let|var|function|class|interface|type|import|export)\b/.test(
      trimmed,
    )
  )
    return "ts";
  if (/^(?:def|class|from|import|print)\b/.test(trimmed)) return "python";
  if (/^(?:SELECT|INSERT|UPDATE|DELETE|CREATE)\b/i.test(trimmed)) return "sql";
  if (/^(?:npm|pnpm|yarn|git|cd|ls|rg|grep|curl)\b/.test(trimmed))
    return "bash";
  if (/^[{[]/.test(trimmed)) return "json";
  return undefined;
}
