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

test("a hidden item between the two errors still suppresses the placeholder", () => {
  // The real shape: grok's stderr lands, then the model streams a little more
  // (a rationale block, hidden unless thinking is on), and only then does the
  // turn settle with a bare "Internal error". Checking the last item alone
  // missed the duplicate and printed both red blocks.
  const timeline = new Timeline("err-2");
  timeline.appendUser("do it");
  timeline.handle(event({ type: "stderr", message: grokLog }));
  timeline.handle(
    event({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "hmm",
      },
    }),
  );
  timeline.handle(
    event({ type: "notice", message: "Internal error", tone: "error" }),
  );
  const notices = timeline.items.filter((item) => item.kind === "notice");
  assert.equal(notices.length, 1);
  assert.equal(
    notices[0] && notices[0].kind === "notice" ? notices[0].text : "",
    "Grok Build usage balance exhausted",
  );
});

test("a placeholder error on its own is still reported", () => {
  // Dropping it outright would leave a failed turn with nothing said at all.
  const timeline = new Timeline("err-3");
  timeline.appendUser("do it");
  timeline.handle(
    event({ type: "notice", message: "Internal error", tone: "error" }),
  );
  const notices = timeline.items.filter((item) => item.kind === "notice");
  assert.equal(notices.length, 1);
  assert.equal(
    notices[0] && notices[0].kind === "notice" ? notices[0].text : "",
    "Internal error",
  );
});

test("the same failure in a later turn is not swallowed", () => {
  const timeline = new Timeline("err-4");
  timeline.appendUser("do it");
  timeline.handle(event({ type: "stderr", message: grokLog }));
  timeline.appendUser("try again");
  timeline.handle(event({ type: "stderr", message: grokLog }));
  const notices = timeline.items.filter((item) => item.kind === "notice");
  assert.equal(notices.length, 2);
});
