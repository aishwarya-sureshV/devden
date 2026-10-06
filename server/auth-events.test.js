import assert from "node:assert/strict";
import test from "node:test";
import { isAuthErrorText } from "./auth-events.js";

test("auth failures are recognized narrowly", () => {
  for (const text of [
    "Invalid API key · Please run /login",
    "API Error: 401 {\"type\":\"error\"}",
    "OAuth token has expired. Please obtain a new token or refresh your existing token.",
    "Not logged in",
    "authentication_failed (code 401)",
  ])
    assert.equal(isAuthErrorText(text), true, text);
  for (const text of [
    "File not found: login.tsx",
    "rate limit reached",
    "Internal error",
    "exit code 1401",
    "",
    undefined,
    42,
  ])
    assert.equal(isAuthErrorText(text), false, String(text));
});