import { strict as assert } from "node:assert";
import { test } from "node:test";
import { paintLine, syntaxLang, type SyntaxLang } from "./syntaxPaint.ts";

function marked(line: string, lang: SyntaxLang): string[] {
  return paintLine(line, lang)
    .filter((tok) => tok.role && tok.text.trim())
    .map((tok) => `${tok.role}:${tok.text}`);
}

test("syntax language follows the file extension and a language hint", () => {
  assert.equal(syntaxLang("tsx"), "ts");
  assert.equal(syntaxLang("python"), "py");
  assert.equal(syntaxLang("bash", "src/main.py"), "sh");
  assert.equal(syntaxLang(undefined, "src/theme.rs"), "rs");
  assert.equal(syntaxLang("nope", "src/app.css"), "css");
  assert.equal(syntaxLang(undefined, "notes"), "code");
});

test("typescript identifiers are variables, not bare foreground", () => {
  const kinds = marked("const theme = { body: true };", "ts");
  assert.ok(kinds.includes("sto:const"));
  assert.ok(kinds.includes("vr:theme"));
  assert.ok(kinds.includes("op:="));
  assert.ok(kinds.includes("prop:body"));
  assert.ok(kinds.includes("cst:true"));
  assert.equal(kinds.includes("kw:const"), false);
});

test("typescript calls, constructors, jsx, decorators, and comments", () => {
  assert.ok(marked("return new FitAddon();", "ts").includes("typ:FitAddon"));
  assert.ok(marked("return new FitAddon();", "ts").includes("kw:new"));
  const filter = marked("items.filter((x) => x.body)", "ts");
  assert.ok(filter.includes("fn:filter"));
  assert.ok(filter.includes("op:=>"));
  assert.ok(filter.includes("prop:body"));
  assert.ok(marked("if (ok) return;", "ts").includes("kw:if"));
  assert.deepEqual(marked("// note", "ts"), ["com:// note"]);
  assert.ok(marked("const LIMIT = 10_000;", "ts").includes("num:10_000"));
  assert.ok(marked("const LIMIT = 10_000;", "ts").includes("cst:LIMIT"));
  const jsx = marked('<div className="x" />', "ts");
  assert.ok(jsx.includes("tag:div"));
  assert.ok(jsx.includes("attr:className"));
  assert.ok(jsx.includes('str:"x"'));
  assert.deepEqual(marked("@decorator", "ts"), ["attr:@decorator"]);
  const fn = marked("function run(n: number) { return n; }", "ts");
  assert.ok(fn.includes("sto:function"));
  assert.ok(fn.includes("fn:run"));
  assert.ok(fn.includes("prop:n"));
  assert.ok(fn.includes("typ:number"));
  assert.ok(fn.includes("vr:n"));
});

test("css selectors, properties, lengths, and at-rules", () => {
  const sel = marked(".card:hover, :root {", "css");
  assert.ok(sel.includes("sel:.card:hover"));
  assert.ok(sel.includes("sel::root"));
  assert.ok(marked("  color: transparent;", "css").includes("cst:transparent"));
  assert.ok(marked("  color: transparent;", "css").includes("prop:color"));
  assert.ok(marked("  margin: 8px;", "css").includes("num:8px"));
  assert.ok(marked("  background: #fff;", "css").includes("num:#fff"));
  const outline = marked("  outline: 2px solid var(--acc);", "css");
  assert.ok(outline.includes("num:2px"));
  assert.ok(outline.includes("cst:solid"));
  assert.ok(outline.includes("fn:var"));
  assert.ok(outline.includes("prop:--acc"));
  const media = marked("@media (max-width: 800px) {", "css");
  assert.ok(media.includes("kw:@media"));
  assert.ok(media.includes("prop:max-width"));
  assert.ok(media.includes("num:800px"));
  assert.ok(marked("  animation: none !important;", "css").includes("kw:!important"));
});

test("python, rust, go, json, shell, and sql", () => {
  const py = marked("def fit(self, rows):", "py");
  assert.ok(py.includes("kw:def"));
  assert.ok(py.includes("fn:fit"));
  assert.ok(py.includes("cst:self"));
  assert.ok(marked('    return {"n": self.n}', "py").includes('prop:"n"'));
  assert.deepEqual(marked("# note", "py"), ["com:# note"]);

  const rs = marked("pub fn paint(theme: Theme) {", "rs");
  assert.ok(rs.includes("sto:pub"));
  assert.ok(rs.includes("kw:fn"));
  assert.ok(rs.includes("fn:paint"));
  assert.ok(rs.includes("typ:Theme"));
  const macro = marked('    println!("{}", theme.body);', "rs");
  assert.ok(macro.includes("fn:println"));
  assert.ok(macro.includes("prop:body"));
  const path = marked("use crate::Theme;", "rs");
  assert.ok(path.includes("op:::"));
  assert.ok(path.includes("typ:Theme"));
  const some = marked("    let x = Some(1);", "rs");
  assert.ok(some.includes("sto:let"));
  assert.ok(some.includes("typ:Some"));
  const life = marked("fn f<'a>(x: &'a str)", "rs");
  assert.equal(life.some((tok) => tok.startsWith("str:'")), false);
  assert.ok(life.includes("typ:a"));
  assert.ok(life.includes("typ:str"));

  assert.ok(marked("func serve(w *T) {", "go").includes("fn:serve"));
  assert.ok(marked("func (s *Box) Name() {}", "go").includes("fn:Name"));
  const nil = marked("    if err := nil; err != nil {", "go");
  assert.ok(nil.includes("op::="));
  assert.ok(nil.includes("cst:nil"));

  const json = marked('{ "theme": "glass", "n": 1, "ok": true }', "json");
  assert.ok(json.includes('prop:"theme"'));
  assert.ok(json.includes('str:"glass"'));
  assert.ok(json.includes("num:1"));
  assert.ok(json.includes("cst:true"));

  const sh = marked("npm test --filter=syntax | wc -l", "sh");
  assert.ok(sh.includes("fn:npm"));
  assert.ok(sh.includes("vr:test"));
  assert.ok(sh.includes("attr:--filter"));
  assert.ok(sh.includes("fn:wc"));
  assert.ok(sh.includes("attr:-l"));
  assert.ok(marked("echo $HOME", "sh").includes("cst:$HOME"));

  assert.ok(marked("SELECT count(*) FROM theme WHERE ok = 1;", "sql").includes("kw:SELECT"));
  assert.ok(marked("SELECT COUNT(*) FROM t;", "sql").includes("fn:COUNT"));
  assert.ok(marked("SELECT count(*) FROM theme WHERE ok = 1;", "sql").includes("kw:FROM"));
});
