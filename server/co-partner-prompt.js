/**
 * devden no longer injects any prompt text into a backend. Sessions recorded
 * before that still carry "[devden harness instruction ...]" fences in their
 * user messages; this strips them back out on replay.
 */
export function stripClarifyPrefix(text) {
 if (typeof text !== "string") return text;
 const end = "[end devden harness instruction]";
 let rest = text;
 while (rest.startsWith("[devden harness instruction")) {
  const at = rest.indexOf(end);
  if (at === -1) return rest;
  rest = rest.slice(at + end.length).replace(/^\n/, "");
 }
 return rest;
}
