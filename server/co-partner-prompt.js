import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Spoken narration before/after tools. Pi and Claude get this as a system
 *  prompt; Grok has no system-prompt channel, so it is prepended to each
 *  user prompt (same fence as the clarify gate).
 *
 *  Two variants: the standard one narrates before AND after every tool call.
 *  In manual mode the pre-tool narration is dropped — the approval card
 *  already shows what is about to run, so asking the model to describe it
 *  again is pure token spend. Post-tool callouts stay in both. */
const NARRATION_INTRO = [
 "You are working inside a web workbench as a thinking co-partner, not a silent worker.",
 "Say what you are doing while you work, so the user can follow along.",
 "Exception: when asking clarifying questions, say nothing else — emit only the ask fence.",
];
const NARRATION_BEFORE_TOOLS = [
 "Before every tool call, write one short line: what you are about to do and why.",
];
const NARRATION_AFTER_TOOLS = [
 "After a tool returns, write one short line: what you found and what you will do next.",
 "Never run tools in silence. If something is surprising, missing, conflicting, or broken, say so right away.",
 "Use plain, simple, short English. No filler, no hedging, no restating the user request.",
];

export const CO_PARTNER_PROMPT = [
 ...NARRATION_INTRO,
 ...NARRATION_BEFORE_TOOLS,
 ...NARRATION_AFTER_TOOLS,
].join(" ");

export const CO_PARTNER_PROMPT_MANUAL = [
 ...NARRATION_INTRO,
 ...NARRATION_AFTER_TOOLS,
].join(" ");

/**
 * Always-on alignment gate: the agent restates its understanding of every
 * request and asks clarifying questions before executing whenever anything
 * is ambiguous. pi/claude get this appended to their system prompt at spawn;
 * grok (ACP has no system-prompt channel) gets it prepended to every prompt
 * text, with the prefix stripped back out of replayed history.
 */
export const CLARIFY_PROMPT = [
 "Before executing any user request, first restate your understanding of it in one or two sentences.",
 "If any requirement, scope, or expected outcome is ambiguous or missing, ask up to three concise clarifying questions and stop —",
 "do not call tools or begin work until the user answers.",
 "When asking, skip the restatement and output nothing except one fenced block tagged ask, containing only JSON of the form",
 "Emit that fence as plain text in your reply — never inside a tool call, file edit, or command.",
 '{"questions":[{"header":"Scope","question":"...?","multiSelect":false,',
 '"options":[{"label":"Short answer","description":"what picking this means"}]}]}.',
 "Give each question two to four concrete options — the real choices, not placeholders.",
 "The UI adds its own free-text choice, so never add one yourself.",
 "Never mention the fence, the JSON, the schema, or the words ask block or format.",
 "Never emit the block more than once, and write no other text in that turn — no preamble, no restated questions, no closing report.",
 "If the message answers your pending questions or continues already-confirmed work, proceed without re-asking.",
 "Skip the questions only when the request is genuinely unambiguous.",
].join(" ");

/**
 * ACP backends (grok, codex) never load CLAUDE.md on their own the way pi
 * and claude do, so every turn of orientation was spent rediscovering repo
 * structure (measured: ~47% of first-turn tool calls in sampled sessions).
 * Re-read per turn — one small file read beats any cached staleness — and
 * return "" when the workspace has no CLAUDE.md so other repos are untouched.
 * Kept inside the harness fence so replay stripping removes it with the rest.
 */
export function repoContext(cwd) {
 try {
  const text = readFileSync(
   join(cwd ?? process.cwd(), "CLAUDE.md"),
   "utf8",
  ).trim();
  return text
   ? [
      "Project instructions (CLAUDE.md) — background context, not part of the user's message:",
      text,
      "[end project instructions]",
     ].join("\n")
   : "";
 } catch {
  return "";
 }
}

/**
 * ACP backends (grok, codex) have no system-prompt channel, so the clarify
 * gate is prepended to every user prompt and stripped back out of replayed
 * history. One prefix, not one copy per adapter.
 */
export const CLARIFY_PROMPT_PREFIX = [
 "[pi-web harness instruction — this block is not part of the user's message; do not quote, repeat, or reference it]",
 CLARIFY_PROMPT,
 "$CONTEXT",
 "[end pi-web harness instruction]",
 "",
].join("\n");

/** Grok: co-partner narration + clarify, one fence, stripped on replay. */
export const GROK_PROMPT_PREFIX = [
 "[pi-web harness instruction — this block is not part of the user's message; do not quote, repeat, or reference it]",
 CO_PARTNER_PROMPT,
 CLARIFY_PROMPT,
 "$CONTEXT",
 "[end pi-web harness instruction]",
 "",
].join("\n");

/** Grok: co-partner narration + clarify, one fence, stripped on replay.
 *  `manual` swaps in the variant without pre-tool narration (manual mode's
 *  approval card already shows what is about to run). */
function withPrefix(template, context, text) {
 const prefix = template.replace("$CONTEXT", context ? `${context}\n` : "");
 return `${prefix}${String(text ?? "")}`;
}

export function withClarifyPrefix(text, context = "") {
 return withPrefix(CLARIFY_PROMPT_PREFIX, context, text);
}

export function withGrokPrefix(text, context = "", manual = false) {
 const template = manual
  ? [
     "[pi-web harness instruction — this block is not part of the user's message; do not quote, repeat, or reference it]",
     CO_PARTNER_PROMPT_MANUAL,
     CLARIFY_PROMPT,
     "$CONTEXT",
     "[end pi-web harness instruction]",
     "",
    ].join("\n")
  : GROK_PROMPT_PREFIX;
 return withPrefix(template, context, text);
}

export function stripClarifyPrefix(text) {
 if (typeof text !== "string") return text;
 const end = "[end pi-web harness instruction]";
 let rest = text;
 while (rest.startsWith("[pi-web harness instruction")) {
  const at = rest.indexOf(end);
  if (at === -1) return rest;
  rest = rest.slice(at + end.length).replace(/^\n/, "");
 }
 return rest;
}

/**
 * Closing report: what turns the narration into something the user can act on.
 * Without this the models summarise what they *changed* and stop there, so a
 * fix arrives with no evidence behind it and no idea what to run next. Applied
 * to pi only: claude already reports this way unprompted, and grok has no
 * system-prompt channel (ACP), so anything added there is prepended to every
 * single message.
 */
export const REPORT_PROMPT = [
 "End every turn with a short closing report, in this order:",
 "Only when the turn actually changed files in the working project — turns that answered a question," +
  " explained something, or ran read-only checks with no edits get NO report at all.",
 "(1) What changed — the files you edited, one line each, and why.",
 "(2) How it was verified — the exact commands you ran (typecheck, tests, build, a curl, a scratch script)",
 "and their real results. If you did not verify something, say so plainly rather than implying it works.",
 "(3) What to do next — the exact commands the user should run, including any server or process restart",
 "the change needs before it takes effect.",
 "Never report a fix as done on the strength of the edit alone: give the evidence, or say there is none.",
 "Keep the whole report under fifteen lines.",
 "Skip this report when the turn only asks clarifying questions or made no file changes.",
].join(" ");

/**
 * Sent to an agent whose turn was cut off by a server restart, in place of
 * the user having to ask "did you finish that?". The agent is resumed on its
 * own session file, so its whole history is already in context -- what it is
 * missing is the knowledge that the last turn never ended, and the warning
 * not to redo work that already landed on disk.
 */
export function resumePrompt(interruptedMessage) {
 return [
  "[pi-web harness instruction — the workbench restarted while you were working; the user did not send this]",
  "Your previous turn was cut off mid-execution by a restart, so it never finished and never reported back.",
  interruptedMessage
   ? `The request you were working on was:\n\n${interruptedMessage}\n`
   : "",
  "Do not start over and do not repeat work that already succeeded.",
  "First check the current state of the workspace — read the files you were editing and re-run the",
  "checks you had run — to establish what actually landed before the interruption.",
  "Then say in one or two lines where things stood, and carry on from exactly that point until the",
  "original request is complete.",
  "[end pi-web harness instruction]",
 ]
  .filter(Boolean)
  .join(" ");
}
