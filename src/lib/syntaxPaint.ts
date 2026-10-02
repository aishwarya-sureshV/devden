/**
 * Line painter for edit wells and the review dock.
 * Every token is one of 15 roles. Identifiers get Variable, not the
 * near-white foreground, so added lines are not white-on-green.
 */

export type SynRole =
  | "kw"
  | "sto"
  | "typ"
  | "fn"
  | "prop"
  | "vr"
  | "str"
  | "num"
  | "cst"
  | "op"
  | "pun"
  | "com"
  | "tag"
  | "attr"
  | "sel";

export type SyntaxLang =
  | "ts"
  | "css"
  | "py"
  | "rs"
  | "go"
  | "json"
  | "sh"
  | "sql"
  | "code";

export interface SynTok {
  text: string;
  role: SynRole | null;
}

const BY_NAME: Record<string, SyntaxLang> = {
  ts: "ts",
  tsx: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
  mts: "ts",
  cts: "ts",
  javascript: "ts",
  typescript: "ts",
  html: "ts",
  xml: "ts",
  svg: "ts",
  vue: "ts",
  svelte: "ts",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  py: "py",
  pyi: "py",
  python: "py",
  rs: "rs",
  rust: "rs",
  go: "go",
  golang: "go",
  json: "json",
  jsonc: "json",
  jsonl: "json",
  yaml: "json",
  yml: "json",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  shell: "sh",
  sql: "sql",
};

function words(source: string): Set<string> {
  return new Set(source.split(/\s+/).filter(Boolean));
}

const TS_KW = words(
  "import export from return if else await new typeof as async try catch finally throw switch case break continue for while do of in yield delete instanceof extends implements default elif match",
);
const TS_STO = words(
  "const let var function interface type class enum struct namespace module declare abstract public private protected readonly static override virtual pub mut impl trait",
);
const PY_KW = words(
  "def return if else elif await import from as async try except finally raise for while in yield pass with and or not is lambda assert del global nonlocal break continue match case",
);
const PY_STO = words("class");
const RS_KW = words(
  "fn return if else match for while loop break continue use as where async await move ref dyn unsafe mod crate super in extern",
);
const RS_STO = words("pub mut impl struct enum trait type let const static");
const GO_KW = words(
  "func return if else for range switch case select go defer package import break continue fallthrough goto map chan",
);
const GO_STO = words("var const type struct interface");
const SQL_KW = words(
  "select from where insert into update delete create table drop alter add column values set join left right inner outer on group by order having limit offset primary key foreign references index unique distinct as and or not is in like between exists union all case when then else end",
);
const CODE_KW = words(`${[...TS_KW].join(" ")} def fn func`);
const CODE_STO = TS_STO;

const KW: Record<SyntaxLang, Set<string>> = {
  ts: TS_KW,
  css: new Set(),
  py: PY_KW,
  rs: RS_KW,
  go: GO_KW,
  json: new Set(),
  sh: new Set(),
  sql: SQL_KW,
  code: CODE_KW,
};
const STO: Record<SyntaxLang, Set<string>> = {
  ts: TS_STO,
  css: new Set(),
  py: PY_STO,
  rs: RS_STO,
  go: GO_STO,
  json: new Set(),
  sh: new Set(),
  sql: new Set(),
  code: CODE_STO,
};

const CST = new Set(
  "true false null undefined none nil this self nan infinity True False None".split(
    " ",
  ),
);
const BUILTIN = new Set(
  "string bool boolean number int float dict list u8 u16 u32 u64 i8 i16 i32 i64 f32 f64 usize isize uint byte bytes str any unknown never void int8 int16 int32 int64 uint8 uint16 uint32 uint64 float32 float64".split(
    " ",
  ),
);
const FN_HEAD = new Set(["function", "def", "fn", "func"]);
const OPS = [
  "...",
  "===",
  "!==",
  ">>>",
  ">>=",
  "<<=",
  "=>",
  "<=",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
  "??",
  "?.",
  "::",
  "->",
  ":=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "<<",
  ">>",
  "**",
  "++",
  "--",
  "//",
];
const CSS_VALUE = new Set(
  "transparent solid none auto inherit initial unset revert flex block inline inline-block inline-flex grid contents absolute relative fixed sticky static hidden visible collapse bold bolder lighter normal center left right top bottom pointer default ease linear ease-in ease-out ease-in-out both forwards reverse alternate thin thick medium dotted dashed double scroll cover contain wrap nowrap column row space-between space-around space-evenly baseline stretch start end italic underline uppercase lowercase capitalize ellipsis break-word pre pre-wrap monospace sans-serif serif".split(
    " ",
  ),
);

export function syntaxLang(language?: string, path?: string): SyntaxLang {
  return named(language) ?? named(path) ?? "code";
}

function named(value: string | undefined): SyntaxLang | null {
  if (!value) return null;
  const lower = value.trim().toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  const base = lower.split(/[?#]/)[0] ?? lower;
  const ext = base.includes(".") ? (base.split(".").pop() ?? "") : "";
  return ext && BY_NAME[ext] ? BY_NAME[ext] : null;
}

export function paintLine(source: string, lang: SyntaxLang): SynTok[] {
  if (!source) return [];
  // TODO(human): this painter sees one line at a time, so the tail of a
  // multi-line /* … */ comment (e.g. "   grays (…). */") gets painted as
  // CSS selectors / code. Detect a comment continuation here and return
  // it as { text, role: "com" } tokens (painting any code after "*/").
  if (lang === "css") return paintCss(source);
  if (lang === "sh") return paintShell(source);
  return paintProgram(source, lang);
}

function isKw(word: string, lang: SyntaxLang): boolean {
  const set = KW[lang];
  return set.has(word) || (lang === "sql" && set.has(word.toLowerCase()));
}

function isSto(word: string, lang: SyntaxLang): boolean {
  const set = STO[lang];
  return set.has(word) || (lang === "sql" && set.has(word.toLowerCase()));
}

function isCst(word: string, lang: SyntaxLang): boolean {
  if (CST.has(word)) return true;
  if (
    (lang === "sql" || lang === "json" || lang === "py") &&
    CST.has(word.toLowerCase())
  )
    return true;
  return lang === "json" && /^(yes|no)$/i.test(word);
}

function isBuiltin(word: string): boolean {
  return BUILTIN.has(word);
}

function isKey(line: string, i: number): boolean {
  let j = i;
  while (line[j] === " " || line[j] === "\t") j += 1;
  if (line[j] === "?" && line[j + 1] !== ".") j += 1;
  return line[j] === ":" && line[j + 1] !== ":" && line[j + 1] !== "=";
}

function readString(line: string, i: number): string {
  const q = line[i] ?? "";
  if ((q === '"' || q === "'") && line.startsWith(q + q + q, i)) {
    const end = line.indexOf(q + q + q, i + 3);
    return end < 0 ? line.slice(i) : line.slice(i, end + 3);
  }
  let j = i + 1;
  while (j < line.length) {
    if (line[j] === "\\") {
      j += 2;
      continue;
    }
    if (line[j] === q) return line.slice(i, j + 1);
    j += 1;
  }
  return line.slice(i);
}

function isNumStart(line: string, i: number): boolean {
  const c = line[i] ?? "";
  if (c >= "0" && c <= "9") return true;
  return c === "." && (line[i + 1] ?? "") >= "0" && (line[i + 1] ?? "") <= "9";
}

function readNumber(line: string, i: number, units: boolean): string {
  let j = i;
  if (line.startsWith("0x", i) || line.startsWith("0X", i)) {
    j = i + 2;
    while (/[0-9a-fA-F_]/.test(line[j] ?? "")) j += 1;
    return line.slice(i, j);
  }
  if (line[j] === ".") j += 1;
  while (/[0-9_]/.test(line[j] ?? "")) j += 1;
  if (line[j] === "." && /[0-9]/.test(line[j + 1] ?? "")) {
    j += 1;
    while (/[0-9_]/.test(line[j] ?? "")) j += 1;
  }
  if ((line[j] === "e" || line[j] === "E") && /[+\-\d]/.test(line[j + 1] ?? "")) {
    j += 1;
    if (line[j] === "+" || line[j] === "-") j += 1;
    while (/[0-9]/.test(line[j] ?? "")) j += 1;
  }
  if (units) {
    const unit = /^(%|px|rem|em|vh|vw|vmin|vmax|dvh|dvw|ch|ex|fr|ms|s|deg|pt|pc|in|cm|mm)/.exec(
      line.slice(j),
    );
    if (unit) j += unit[0].length;
  }
  return line.slice(i, Math.max(j, i + 1));
}

function readHexColor(line: string, i: number): string | null {
  if (line[i] !== "#") return null;
  let j = i + 1;
  while (/[0-9a-fA-F]/.test(line[j] ?? "")) j += 1;
  const len = j - (i + 1);
  if (len === 3 || len === 4 || len === 6 || len === 8) return line.slice(i, j);
  return null;
}

function wordRole(
  word: string,
  lang: SyntaxLang,
  line: string,
  at: number,
  intro: boolean,
  member: boolean,
  prevWord: string,
): SynRole {
  const call = line[at] === "(";
  const macro = lang === "rs" && line[at] === "!" && line[at + 1] !== "=";
  const key = isKey(line, at);
  const allCaps = /^[A-Z][A-Z0-9_]+$/.test(word);
  const caps = /^[A-Z]/.test(word);
  if (prevWord === "new") return "typ";
  if (member && !call && !macro) return "prop";
  if (key && (intro || lang === "json") && !isKw(word, lang)) return "prop";
  if (isKw(word, lang)) return "kw";
  if (isSto(word, lang)) return "sto";
  if (macro) return "fn";
  if (call && !caps && !isBuiltin(word)) return "fn";
  if (call && allCaps && lang === "sql") return "fn";
  if (isCst(word, lang) || allCaps) return "cst";
  if (isBuiltin(word) || caps) return "typ";
  return "vr";
}

function paintProgram(line: string, lang: SyntaxLang): SynTok[] {
  const out: SynTok[] = [];
  let i = 0;
  let intro = true;
  let member = false;
  let tightWord = false;
  let prevWord = "";
  let paren = 0;
  let wantFn = false;
  let tagSlot: "name" | "attr" | null = null;
  let exprDepth = 0;

  const emit = (text: string, role: SynRole | null) => {
    if (!text) return;
    out.push({ text, role });
    if (!text.trim()) {
      tightWord = false;
      return;
    }
    if (text === "(") paren += 1;
    else if (text === ")") paren = Math.max(0, paren - 1);
    member = text === "." || text === "?.";
    intro = text.length === 1 && "{(,;".includes(text);
    tightWord = /^[A-Za-z_$]/.test(text);
    if (/^[A-Za-z_$][\w$]*$/.test(text)) prevWord = text;
  };

  const slashComment =
    lang === "ts" || lang === "code" || lang === "go" || lang === "rs" || lang === "json";
  const hashComment = lang === "py" || lang === "json";
  const blockComment = lang !== "py" && lang !== "json";

  while (i < line.length) {
    const c = line[i] ?? "";
    if (c === " " || c === "\t") {
      let j = i + 1;
      while (line[j] === " " || line[j] === "\t") j += 1;
      emit(line.slice(i, j), null);
      i = j;
      continue;
    }
    if (blockComment && c === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      const j = end < 0 ? line.length : end + 2;
      emit(line.slice(i, j), "com");
      i = j;
      continue;
    }
    if (slashComment && c === "/" && line[i + 1] === "/") {
      emit(line.slice(i), "com");
      break;
    }
    if (hashComment && c === "#") {
      emit(line.slice(i), "com");
      break;
    }
    if (lang === "sql" && c === "-" && line[i + 1] === "-") {
      emit(line.slice(i), "com");
      break;
    }
    if (lang === "rs" && c === "#" && line[i + 1] === "[") {
      emit("#[", "attr");
      i += 2;
      wantFn = false;
      const j = i;
      let k = j;
      while (/[\w$]/.test(line[k] ?? "")) k += 1;
      if (k > j) {
        emit(line.slice(j, k), "attr");
        i = k;
      }
      continue;
    }
    if (
      c === "@" &&
      /[A-Za-z_]/.test(line[i + 1] ?? "") &&
      lang !== "sql" &&
      lang !== "json"
    ) {
      let j = i + 1;
      while (/[\w$]/.test(line[j] ?? "")) j += 1;
      emit(line.slice(i, j), "attr");
      i = j;
      continue;
    }
    if (lang === "rs" && c === "'") {
      const n1 = line[i + 1] ?? "";
      const n2 = line[i + 2] ?? "";
      if (/[A-Za-z_]/.test(n1) && n2 !== "'") {
        let j = i + 1;
        while (/[\w]/.test(line[j] ?? "")) j += 1;
        emit("'", "pun");
        emit(line.slice(i + 1, j), "typ");
        i = j;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`" || (lang === "py" && /[rRuUbBfF]/.test(c) && /["']/.test(line[i + 1] ?? ""))) {
      let start = i;
      if (lang === "py" && /[rRuUbBfF]/.test(c) && /["']/.test(line[i + 1] ?? "")) {
        start = /[rRuUbBfF]/.test(line[i + 1] ?? "") && /["']/.test(line[i + 2] ?? "") ? i + 2 : i + 1;
      }
      const body = readString(line, start);
      const text = line.slice(i, start + body.length);
      const role =
        isKey(line, start + body.length) && (lang === "json" || lang === "py" || intro)
          ? "prop"
          : "str";
      emit(text, role);
      i = start + body.length;
      continue;
    }
    if (isNumStart(line, i)) {
      const text = readNumber(line, i, false);
      emit(text, "num");
      i += text.length;
      continue;
    }
    const op = OPS.find((item) => line.startsWith(item, i));
    if (op) {
      emit(op, "op");
      i += op.length;
      continue;
    }
    if (c === "<" && !tightWord && /^<\/?[A-Za-z]/.test(line.slice(i))) {
      emit("<", "pun");
      i += 1;
      if (line[i] === "/") {
        emit("/", "pun");
        i += 1;
      }
      tagSlot = "name";
      exprDepth = 0;
      continue;
    }
    if (tagSlot && line.startsWith("/>", i)) {
      emit("/>", "pun");
      tagSlot = null;
      exprDepth = 0;
      i += 2;
      continue;
    }
    if (tagSlot && exprDepth === 0 && c === ">") {
      emit(">", "pun");
      tagSlot = null;
      i += 1;
      continue;
    }
    if (c === "{" && tagSlot && exprDepth === 0) {
      emit("{", "pun");
      exprDepth = 1;
      i += 1;
      continue;
    }
    if (c === "}" && exprDepth > 0) {
      exprDepth -= 1;
      emit("}", "pun");
      i += 1;
      continue;
    }
    if ("{}()[];,.".includes(c)) {
      if (c === "." && isNumStart(line, i)) {
        const text = readNumber(line, i, false);
        emit(text, "num");
        i += text.length;
        continue;
      }
      emit(c, "pun");
      i += 1;
      continue;
    }
    if ("=+-*/%<>!&|^~?:".includes(c)) {
      emit(c, c === ":" ? "pun" : "op");
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (/[\w$]/.test(line[j] ?? "")) j += 1;
      const word = line.slice(i, j);
      let role = wordRole(word, lang, line, j, intro, member, prevWord);
      if (tagSlot && exprDepth === 0) {
        role = tagSlot === "name" || member ? "tag" : "attr";
        if (tagSlot === "name") tagSlot = "attr";
      } else if (wantFn && paren === 0 && !isKw(word, lang) && !isSto(word, lang)) {
        role = "fn";
        wantFn = false;
      }
      if ((role === "kw" || role === "sto") && FN_HEAD.has(word)) wantFn = true;
      emit(word, role);
      i = j;
      continue;
    }
    emit(c, "pun");
    i += 1;
  }
  return out;
}

function paintCss(line: string): SynTok[] {
  const out: SynTok[] = [];
  const emit = (text: string, role: SynRole | null) => {
    if (text) out.push({ text, role });
  };
  let i = 0;
  const trimmed = line.trimStart();
  let mode: "sel" | "prop" | "val" | "at" = trimmed.startsWith("@")
    ? "at"
    : /^(?:--|-)?[A-Za-z_][\w-]*\s*:/.test(trimmed)
      ? "prop"
      : "sel";

  while (i < line.length) {
    const c = line[i] ?? "";
    if (c === " " || c === "\t") {
      let j = i + 1;
      while (line[j] === " " || line[j] === "\t") j += 1;
      emit(line.slice(i, j), null);
      i = j;
      continue;
    }
    if (c === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      const j = end < 0 ? line.length : end + 2;
      emit(line.slice(i, j), "com");
      i = j;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") {
      emit(line.slice(i), "com");
      break;
    }
    if (c === '"' || c === "'") {
      const text = readString(line, i);
      emit(text, "str");
      i += text.length;
      continue;
    }
    if (mode === "sel") {
      if (c === "{") {
        emit("{", "pun");
        mode = "prop";
        i += 1;
        continue;
      }
      if (c === "}") {
        emit("}", "pun");
        i += 1;
        continue;
      }
      if (c === ",") {
        emit(",", "pun");
        i += 1;
        continue;
      }
      if (c === "(" || c === ")") {
        emit(c, "pun");
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < line.length && !/[\s,{}()"']/.test(line[j] ?? "")) j += 1;
      emit(line.slice(i, j), "sel");
      i = j;
      continue;
    }
    if (c === "}") {
      emit("}", "pun");
      mode = "sel";
      i += 1;
      continue;
    }
    if (c === "{") {
      emit("{", "pun");
      mode = mode === "at" ? "sel" : "prop";
      i += 1;
      continue;
    }
    if (c === ";") {
      emit(";", "pun");
      mode = "prop";
      i += 1;
      continue;
    }
    if (c === ":") {
      emit(":", "pun");
      mode = "val";
      i += 1;
      continue;
    }
    if (c === "," || c === "(" || c === ")") {
      emit(c, "pun");
      if (c === "(" && mode === "at") mode = "prop";
      i += 1;
      continue;
    }
    if (c === "!" && line.startsWith("!important", i)) {
      emit("!important", "kw");
      i += "!important".length;
      continue;
    }
    if (mode === "val" && c === "#") {
      const hex = readHexColor(line, i);
      if (hex) {
        emit(hex, "num");
        i += hex.length;
        continue;
      }
    }
    if (isNumStart(line, i)) {
      const text = readNumber(line, i, true);
      emit(text, "num");
      i += text.length;
      continue;
    }
    if (c === "@" || c === "-" || /[A-Za-z_*]/.test(c)) {
      if (c === "-" && /[0-9]/.test(line[i + 1] ?? "")) {
        emit("-", "op");
        i += 1;
        continue;
      }
      let j = i + 1;
      while (/[\w-]/.test(line[j] ?? "")) j += 1;
      const word = line.slice(i, j);
      let k = j;
      while (line[k] === " " || line[k] === "\t") k += 1;
      const call = line[k] === "(";
      const colon = line[k] === ":";
      let role: SynRole = "vr";
      if (word.startsWith("@")) role = "kw";
      else if (word.startsWith("--") || colon || mode === "prop") role = "prop";
      else if (call) role = "fn";
      else if (CSS_VALUE.has(word)) role = "cst";
      else if (mode === "at") role = "kw";
      emit(word, role);
      i = j;
      continue;
    }
    emit(c, mode === "val" && "+-*/".includes(c) ? "op" : "pun");
    i += 1;
  }
  return out;
}

function paintShell(line: string): SynTok[] {
  const out: SynTok[] = [];
  const emit = (text: string, role: SynRole | null) => {
    if (text) out.push({ text, role });
  };
  let i = 0;
  let cmd = true;
  while (i < line.length) {
    const c = line[i] ?? "";
    if (c === " " || c === "\t") {
      let j = i + 1;
      while (line[j] === " " || line[j] === "\t") j += 1;
      emit(line.slice(i, j), null);
      i = j;
      continue;
    }
    if (c === "#") {
      emit(line.slice(i), "com");
      break;
    }
    if (c === '"' || c === "'" || c === "`") {
      const text = readString(line, i);
      emit(text, "str");
      cmd = false;
      i += text.length;
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      emit("$(", "op");
      i += 2;
      cmd = true;
      continue;
    }
    if (c === "$") {
      if (line[i + 1] === "{") {
        const end = line.indexOf("}", i + 2);
        const j = end < 0 ? line.length : end + 1;
        emit(line.slice(i, j), "cst");
        cmd = false;
        i = j;
        continue;
      }
      const n1 = line[i + 1] ?? "";
      if (/[0-9*@#!?]/.test(n1)) {
        emit(line.slice(i, i + 2), "cst");
        cmd = false;
        i += 2;
        continue;
      }
      let j = i + 1;
      while (/[\w]/.test(line[j] ?? "")) j += 1;
      if (j > i + 1) {
        emit(line.slice(i, j), "cst");
        cmd = false;
        i = j;
        continue;
      }
    }
    const two = line.slice(i, i + 2);
    if (two === "||" || two === "&&" || two === ">>" || two === "<<") {
      emit(two, "op");
      i += 2;
      if (two === "||" || two === "&&") cmd = true;
      continue;
    }
    if (c === "|" || c === ";" || c === "&") {
      emit(c, "op");
      i += 1;
      cmd = true;
      continue;
    }
    if (c === ">" || c === "<" || c === "=") {
      emit(c, "op");
      i += 1;
      continue;
    }
    if (
      c === "-" &&
      (line[i + 1] === "-"
        ? /[A-Za-z]/.test(line[i + 2] ?? "")
        : /[A-Za-z]/.test(line[i + 1] ?? ""))
    ) {
      let j = i + 1;
      if (line[j] === "-") j += 1;
      while (/[\w-]/.test(line[j] ?? "")) j += 1;
      emit(line.slice(i, j), "attr");
      cmd = false;
      i = j;
      continue;
    }
    if (/[A-Za-z0-9_./]/.test(c)) {
      let j = i + 1;
      while (
        j < line.length &&
        line[j] !== "=" &&
        !/[\s|&;<>$"'`#]/.test(line[j] ?? "")
      )
        j += 1;
      const word = line.slice(i, j);
      if (/^\d/.test(word)) emit(word, "num");
      else if (cmd) emit(word, "fn");
      else if (/^[A-Z][A-Z0-9_]+$/.test(word)) emit(word, "cst");
      else emit(word, "vr");
      cmd = false;
      i = j;
      continue;
    }
    emit(c, "pun");
    i += 1;
  }
  return out;
}
