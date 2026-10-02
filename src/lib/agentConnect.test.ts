import assert from "node:assert/strict";
import test from "node:test";
import { loginLink } from "./agentConnect.ts";

test("sign-in links require provider-owned HTTPS hosts", () => {
  assert.equal(loginLink("Open https://auth.openai.com/codex/device."), "https://auth.openai.com/codex/device");
  assert.equal(loginLink("Sign in: https://claude.ai/oauth/authorize?state=example"), "https://claude.ai/oauth/authorize?state=example");
  assert.equal(loginLink("Open https://auth.x.ai/device\nCode: EXAMPLE"), "https://auth.x.ai/device");
  for (const text of ["http://auth.openai.com/login", "javascript:alert(1)", "https://auth.openai.com.evil.example/login", "https://evil@auth.openai.com/", "https://auth.openai.com:8443/login"]) {
    assert.equal(loginLink(text), null);
  }
});
