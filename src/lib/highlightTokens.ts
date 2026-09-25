/**
 * Language-agnostic tokenizer shared by the live <RichText/> highlighter
 * and the standalone replay HTML (which cannot import React).
 */

const LANG_ALIASES: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  node: "js",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
};

const C_LIKE = new Set([
  "js",
  "javascript",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "typescript",
  "tsx",
  "mts",
  "cts",
  "json",
  "jsonc",
  "json5",
  "go",
  "rust",
  "rs",
  "java",
  "c",
  "h",
  "cpp",
  "cc",
  "cxx",
  "hpp",
  "c++",
  "cs",
  "csharp",
  "swift",
  "kotlin",
  "kt",
  "scala",
  "dart",
  "php",
  "groovy",
  "less",
  "scss",
  "sass",
]);

const HASH_LANGS = new Set([
  "python",
  "py",
  "rb",
  "ruby",
  "sh",
  "bash",
  "zsh",
  "shell",
  "shellsession",
  "yaml",
  "yml",
  "toml",
  "ini",
  "r",
  "perl",
  "pl",
  "dockerfile",
  "makefile",
  "make",
  "ps1",
  "powershell",
  "conf",
  "gitconfig",
  "gitignore",
]);

const DASH_LANGS = new Set(["sql", "lua", "haskell", "hs", "ada"]);
const MARKUP_LANGS = new Set([
  "html",
  "xml",
  "svg",
  "vue",
  "svelte",
  "markdown",
  "md",
]);

const KEYWORDS = [
  "const",
  "let",
  "var",
  "function",
  "def",
  "fn",
  "func",
  "class",
  "struct",
  "enum",
  "interface",
  "trait",
  "impl",
  "extends",
  "implements",
  "namespace",
  "module",
  "package",
  "import",
  "export",
  "from",
  "use",
  "require",
  "return",
  "yield",
  "if",
  "elif",
  "else",
  "for",
  "foreach",
  "while",
  "do",
  "loop",
  "switch",
  "case",
  "match",
  "default",
  "break",
  "continue",
  "pass",
  "new",
  "delete",
  "del",
  "async",
  "await",
  "try",
  "catch",
  "finally",
  "throw",
  "throws",
  "raise",
  "except",
  "with",
  "as",
  "in",
  "is",
  "of",
  "not",
  "and",
  "or",
  "lambda",
  "global",
  "nonlocal",
  "assert",
  "static",
  "final",
  "abstract",
  "public",
  "private",
  "protected",
  "readonly",
  "override",
  "virtual",
  "get",
  "set",
  "type",
  "alias",
  "typedef",
  "infer",
  "keyof",
  "satisfies",
  "declare",
  "constructor",
  "super",
  "this",
  "self",
  "mut",
  "pub",
  "ref",
  "move",
  "dyn",
  "where",
  "unsafe",
  "go",
  "defer",
  "chan",
  "map",
  "range",
  "select",
  "SELECT",
  "FROM",
  "WHERE",
  "INSERT",
  "INTO",
  "UPDATE",
  "DELETE",
  "CREATE",
  "TABLE",
  "DROP",
  "ALTER",
  "ADD",
  "COLUMN",
  "VALUES",
  "SET",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "ON",
  "GROUP",
  "BY",
  "ORDER",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "PRIMARY",
  "KEY",
  "FOREIGN",
  "REFERENCES",
  "INDEX",
  "UNIQUE",
  "DISTINCT",
  "AS",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "IS",
];

const BOOLS = [
  "true",
  "false",
  "null",
  "undefined",
  "True",
  "False",
  "None",
  "nil",
  "NaN",
  "Infinity",
];

export const TOKEN_KINDS = [
  "comment",
  "string",
  "number",
  "decorator",
  "bool",
  "keyword",
  "func",
  "type",
] as const;

export type TokenKind = (typeof TOKEN_KINDS)[number];

export interface CodeToken {
  kind?: TokenKind;
  text: string;
}

function buildKeywordSource(words: string[]): string {
  const sorted = [...new Set(words)].sort((a, b) => b.length - a.length);
  return `\\b(?:${sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`;
}

function commentSource(lang: string | undefined): string {
  const parts: string[] = [];
  const l = (lang ?? "").toLowerCase();
  if (MARKUP_LANGS.has(l)) parts.push("<!--[\\s\\S]*?-->");
  parts.push("/\\*[\\s\\S]*?\\*/");
  if (
    C_LIKE.has(l) ||
    ["css", "scss", "less", "sass", "go", "rust", "rs", "swift", "java", "c", "cpp", "cs", "php"].includes(l)
  ) {
    parts.push("//[^\\n]*");
  }
  if (HASH_LANGS.has(l)) parts.push("#[^\\n]*");
  if (DASH_LANGS.has(l)) parts.push("--[^\\n]*");
  if (!l) parts.push("//[^\\n]*");
  return parts.join("|");
}

function buildRegex(lang: string | undefined): RegExp {
  const comment = commentSource(lang);
  const string = [
    '"""[\\s\\S]*?"""',
    "'''[\\s\\S]*?'''",
    "`(?:\\\\.|[^`\\\\])*`",
    '"(?:\\\\.|[^"\\\\])*"',
    "'(?:\\\\.|[^'\\\\])*'",
  ].join("|");
  const number =
    "\\b0x[0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b";
  const decorator = "@[A-Za-z_]\\w*";
  const bool = `\\b(?:${BOOLS.join("|")})\\b`;
  const keyword = buildKeywordSource(KEYWORDS);
  const func = "[A-Za-z_$][\\w$]*(?=\\s*\\()";
  const type = "\\b[A-Z][A-Za-z0-9_]*\\b";
  const source = [
    `(?<comment>${comment})`,
    `(?<string>${string})`,
    `(?<number>${number})`,
    `(?<decorator>${decorator})`,
    `(?<bool>${bool})`,
    `(?<keyword>${keyword})`,
    `(?<func>${func})`,
    `(?<type>${type})`,
  ].join("|");
  return new RegExp(source, "g");
}

const regexCache = new Map<string, RegExp>();

function getRegex(lang: string | undefined): RegExp {
  const key = lang ?? "";
  let re = regexCache.get(key);
  if (!re) {
    re = buildRegex(lang);
    regexCache.set(key, re);
  }
  return re;
}

export function normalizeLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const raw = language.trim().toLowerCase();
  if (!raw || raw === "text" || raw === "plain" || raw === "plaintext" || raw === "txt")
    return undefined;
  return LANG_ALIASES[raw] ?? raw;
}

export function canHighlight(language: string | undefined): boolean {
  if (!language) return false;
  return (
    C_LIKE.has(language) ||
    HASH_LANGS.has(language) ||
    DASH_LANGS.has(language) ||
    MARKUP_LANGS.has(language) ||
    language === "css"
  );
}

export function tokenizeCode(code: string, language?: string): CodeToken[] {
  if (!code) return [];
  const lang = normalizeLanguage(language);
  if (!canHighlight(lang)) return [{ text: code }];
  const re = getRegex(lang);
  re.lastIndex = 0;
  const tokens: CodeToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: code.slice(lastIndex, match.index) });
    }
    const groups = match.groups ?? {};
    let kind: TokenKind | undefined;
    for (const name of TOKEN_KINDS) {
      if (groups[name] !== undefined) {
        kind = name;
        break;
      }
    }
    tokens.push(kind ? { kind, text: match[0] } : { text: match[0] });
    lastIndex = re.lastIndex;
    if (match.index === re.lastIndex) re.lastIndex += 1;
  }
  if (lastIndex < code.length) tokens.push({ text: code.slice(lastIndex) });
  return tokens;
}

export function highlightToHtml(code: string, language?: string): string {
  return tokenizeCode(code, language)
    .map((tok) =>
      tok.kind
        ? `<span class="tok-${tok.kind}">${esc(tok.text)}</span>`
        : esc(tok.text),
    )
    .join("");
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
