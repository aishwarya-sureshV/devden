import test from "node:test";
import assert from "node:assert/strict";

import { Timeline } from "./timeline.ts";
import { collectSubagentRuns } from "./subagents.ts";
import type { AgentEvent } from "./api.ts";
// @ts-expect-error -- plain JS server module
import { forwardedEvent } from "../../server/prosecutor.js";

/** A prosecutor round renders as its own nested run, and its streamed text
 *  never lands on the executor's reply (same default streamKey). */
test("prosecutor round nests under its card in the executor timeline", async () => {
  const timeline = new Timeline("exec");
  const send = (event: Record<string, unknown>) =>
    timeline.handle(event as AgentEvent);
  const delta = (text: string) => ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  });
  const end = (text: string) => ({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 9, output: 9 } },
  });

  send({ type: "agent_start" });
  send(delta("fixed it"));
  send(end("fixed it"));
  send({ type: "agent_settled" });

  const cardId = "prosecutor-1";
  const seq = { n: 0 };
  send({ type: "tool_execution_start", toolCallId: cardId, toolName: "prosecutor", args: { description: "Round 1" } });
  for (const raw of [
    delta("test fails"),
    end("test fails\nVERDICT: GUILTY"),
    { type: "tool_execution_start", toolCallId: "p-bash", toolName: "bash", args: { command: "npm test" } },
    { type: "tool_execution_end", toolCallId: "p-bash", result: { content: [{ type: "text", text: "1 failing" }] } },
    { type: "agent_end" },
  ]) {
    const forwarded = forwardedEvent(raw, cardId, seq);
    if (forwarded) send(forwarded);
  }
  send({ type: "tool_execution_end", toolCallId: cardId, isError: true, result: { content: [{ type: "text", text: "Guilty" }] } });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const top = timeline.items.filter((item) => !("parentToolUseId" in item && item.parentToolUseId));
  const reply = top.find((item) => item.kind === "assistant");
  assert.equal(reply?.kind === "assistant" && reply.text, "fixed it");

  const runs = collectSubagentRuns(timeline.items);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.id, cardId);
  assert.equal(runs[0]!.status, "error");
  const kinds = runs[0]!.items.map((item) => item.kind).sort();
  assert.deepEqual(kinds, ["assistant", "tool"]);
});
