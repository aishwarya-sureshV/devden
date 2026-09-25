import { cloneElement, Fragment, isValidElement, type ReactNode } from "react";
import { tokenizeCode } from "./highlightTokens.ts";

/**
 * Tiny, dependency-free syntax highlighter for prose (markdown) code blocks
 * rendered by <RichText/>. It is intentionally approximate — good enough for an
 * IDE-like feel (keywords, strings, comments, numbers, functions, types) without
 * pulling in shiki/prism.
 */

const TOKEN_CLASS: Record<string, string> = {
  comment: "agent-workbench__tok-comment",
  string: "agent-workbench__tok-string",
  number: "agent-workbench__tok-number",
  decorator: "agent-workbench__tok-decorator",
  bool: "agent-workbench__tok-bool",
  keyword: "agent-workbench__tok-keyword",
  func: "agent-workbench__tok-func",
  type: "agent-workbench__tok-type",
};

export function highlightCode(
  code: string,
  language: string | undefined,
): ReactNode[] {
  if (!code) return [];
  return tokenizeCode(code, language).map((tok, i) =>
    tok.kind ? (
      <span key={i} className={TOKEN_CLASS[tok.kind]}>
        {tok.text}
      </span>
    ) : (
      <Fragment key={i}>{tok.text}</Fragment>
    ),
  );
}

/** Split highlighted output into one node array per source line. */
function splitCodeLines(nodes: ReactNode[]): ReactNode[][] {
  return splitWithKey(nodes, { n: 0 });
}

function splitWithKey(nodes: ReactNode[], key: { n: number }): ReactNode[][] {
  const lines: ReactNode[][] = [[]];
  const pushText = (text: string) => {
    const parts = text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part)
        lines[lines.length - 1]!.push(
          <Fragment key={`s${key.n++}`}>{part}</Fragment>,
        );
    });
  };
  const walk = (node: ReactNode): void => {
    if (node === null || node === undefined || typeof node === "boolean")
      return;
    if (typeof node === "string" || typeof node === "number") {
      pushText(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (isValidElement<{ children?: ReactNode }>(node)) {
      const children = node.props.children;
      if (children === null || children === undefined) return;
      const childLines = splitWithKey(
        Array.isArray(children) ? children : [children],
        key,
      );
      childLines.forEach((childLine, index) => {
        if (index > 0) lines.push([]);
        if (childLine.length > 0) {
          lines[lines.length - 1]!.push(
            cloneElement(node, { key: `c${key.n++}` }, childLine),
          );
        }
      });
      return;
    }
    lines[lines.length - 1]!.push(node);
  };
  nodes.forEach(walk);
  return lines;
}

/** Code block with a line-number gutter. `startAt` offsets numbering (diff hunks). */
export function NumberedCode({
  code,
  language,
  startAt = 1,
  highlight = true,
  className,
}: {
  code: string;
  language?: string;
  startAt?: number;
  highlight?: boolean;
  className?: string;
}) {
  const source = (code ?? "").replace(/\r\n/g, "\n");
  const rows = splitCodeLines(
    highlight ? highlightCode(source, language) : [source],
  );
  const width = String(startAt + Math.max(rows.length, 1) - 1).length;
  return (
    <pre
      className={`code-numbered${className ? ` ${className}` : ""}`}
      {...(language ? { "data-language": language } : {})}
    >
      <code>
        {rows.map((row, index) => (
          <span className="code-line" key={index}>
            <span
              className="code-line__no"
              aria-hidden="true"
              style={{ minWidth: `${width}ch` }}
            >
              {startAt + index}
            </span>
            <span className="code-line__text">
              {row.length > 0 ? row : "\u00a0"}
            </span>
          </span>
        ))}
      </code>
    </pre>
  );
}
