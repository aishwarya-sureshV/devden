/**
 * Server-side twin of the client's isAuthError (timeline.ts): recognizes a
 * provider error that means "your sign-in is gone". Narrow on purpose — a
 * false "reconnect" banner is worse than none. When one side gains a pattern,
 * mirror it in the other.
 */
const AUTH_ERROR_RE =
  /\b(401|unauthori[sz]ed|not logged in|please (run )?\/login|log ?in again|invalid (api[ _-]?key|x-api-key|bearer token)|(oauth|access) token (has )?expired|authentication[_ ](failed|error))\b/i;

export function isAuthErrorText(text) {
  return typeof text === "string" && AUTH_ERROR_RE.test(text);
}