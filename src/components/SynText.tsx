import type { ReactNode } from "react";
import { paintLine, type SyntaxLang } from "../lib/syntaxPaint";

/** Painted source line. Hunk rows color only the @@ marker. */
export function SynText({
  text,
  lang,
  variant = "code",
}: {
  text: string;
  lang: SyntaxLang;
  variant?: "code" | "hunk";
}): ReactNode {
  if (variant === "hunk") {
    if (text.startsWith("@@")) {
      return (
        <>
          <span className="syn syn--hunk">@@</span>
          <span className="syn syn--file">{text.slice(2)}</span>
        </>
      );
    }
    return <span className="syn syn--file">{text}</span>;
  }
  const toks = paintLine(text, lang);
  if (!toks.length) return text || " ";
  return toks.map((tok, index) =>
    tok.role ? (
      <span key={index} className={`syn syn--${tok.role}`}>
        {tok.text}
      </span>
    ) : (
      <span key={index}>{tok.text}</span>
    ),
  );
}
