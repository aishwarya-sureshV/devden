import test from "node:test";
import assert from "node:assert/strict";
import { readableAgentError, Timeline } from "./timeline.ts";
import type { AgentEvent } from "./api.ts";

const event = (payload: Record<string, unknown>): AgentEvent =>
  payload as unknown as AgentEvent;

const grokLog = `2026-09-12T12:31:47.251703Z ERROR responses API error status=402 Payment Required error_message=Grok Build usage balance exhausted body_preview={"error":"Grok Build usage balance exhausted"} model_id=grok-4.6
2026-09-12T12:31:47.253246Z ERROR error=Internal error: { "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted", "http_status": 402 }`;

test("readableAgentError pulls the sentence out of a Grok API log", () => {
  assert.equal(
    readableAgentError(grokLog),
    "Grok Build usage balance exhausted",
  );
  assert.equal(
    readableAgentError(
      'Internal error: { "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted", "http_status": 402 }',
    ),
    "Grok Build usage balance exhausted",
  );
  assert.equal(readableAgentError("Internal error"), "");
  assert.equal(readableAgentError("Grok turn failed: Internal error"), "");
});

test("Grok API stderr shows one clean error, not the raw dump", () => {
  const timeline = new Timeline("err-1");
  timeline.handle(event({ type: "stderr", message: grokLog }));
  timeline.handle(
    event({
      type: "notice",
      message: "Grok turn failed: Internal error",
      tone: "error",
    }),
  );
  const notices = timeline.items.filter((item) => item.kind === "notice");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.kind, "notice");
  assert.equal(
    notices[0] && notices[0].kind === "notice" ? notices[0].text : "",
    "Grok Build usage balance exhausted",
  );
  assert.equal(
    notices[0] && notices[0].kind === "notice" ? notices[0].tone : "",
    "error",
  );
});
