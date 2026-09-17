import test from "node:test";
import assert from "node:assert/strict";

import { Timeline } from "./timeline.ts";
import type { AgentEvent, SessionState } from "./api.ts";

/**
 * Repro for "reload mid-turn loses the thinking/working indicators": an
 * adopted run's carried runtime log opens with pre-run bookkeeping events
 * (__status / trailing state / command responses) before the turn's
 * agent_start. replayLiveTurn must find the in-flight turn and keep the
 * timeline streaming instead of reporting a torn buffer.
 */
test("replay of an adopted mid-run log keeps streaming", () => {
  // Shaped like a real carried log: process-start noise, then the in-flight
  // turn, with no agent_end yet.
  const entries = [
    {
      id: "a",
      timestamp: 1,
      source: "pi",
      payload: { type: "__status", status: "ready" },
    },
    {
      id: "b",
      timestamp: 2,
      source: "pi",
      payload: { type: "state", state: { isStreaming: false } },
    },
    { id: "c", timestamp: 3, source: "pi", payload: { type: "agent_start" } },
    {
      id: "d",
      timestamp: 4,
      source: "pi",
      payload: {
        type: "message_start",
        message: { role: "user", content: "do it" },
      },
    },
    {
      id: "e",
      timestamp: 5,
      source: "pi",
      payload: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "working on it" },
      },
    },
  ] as unknown as Parameters<Timeline["replayLiveTurn"]>[0];

  const timeline = new Timeline("conv-repro");
  const state: SessionState = {
    model: null,
    thinkingLevel: "off",
    isStreaming: true,
    sessionId: "s",
    sessionFile: "/tmp/fake.jsonl",
    messageCount: 0,
    pendingMessageCount: 0,
  };
  // What resumeConversation does on adoption: state first, then replay.
  timeline.setState(state);
  timeline.handle({ type: "message_update" } as unknown as AgentEvent); // noop warm-up, mirrors live page
  const outcome = timeline.replayLiveTurn(entries);
  assert.equal(outcome, "live", "an in-flight turn must replay as live");
  assert.equal(timeline.status, "working");
  assert.equal(timeline.state?.isStreaming, true);
  assert.ok(
    timeline.items.some(
      (item) => item.kind === "user" && item.text === "do it",
    ),
    "the in-flight user message must be restored",
  );
});

test("replay keeps the restart-resume notice in front of the live turn", () => {
  const entries = [
    {
      id: "n",
      timestamp: 1,
      source: "server",
      payload: {
        type: "notice",
        message:
          "The workbench restarted mid-turn — picking this conversation back up where it stopped.",
      },
    },
    {
      id: "s",
      timestamp: 2,
      source: "grok",
      payload: { type: "agent_start" },
    },
    {
      id: "t",
      timestamp: 3,
      source: "grok",
      payload: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "checking" },
      },
    },
  ] as unknown as Parameters<Timeline["replayLiveTurn"]>[0];

  const timeline = new Timeline("conv-resume");
  timeline.setState({
    model: null,
    thinkingLevel: "off",
    isStreaming: true,
    sessionId: "s",
    sessionFile: "/tmp/fake.jsonl",
    messageCount: 0,
    pendingMessageCount: 0,
  });
  const outcome = timeline.replayLiveTurn(entries);
  assert.equal(outcome, "live");
  assert.ok(
    timeline.items.some(
      (item) =>
        item.kind === "notice" &&
        item.text.includes("picking this conversation back up"),
    ),
    "the resume banner must survive a reload",
  );
});

/**
 * A server notice is published after the turn settles so it sits at the
 * bottom of the final output -- which puts it outside every replay window,
 * since those start after the last agent_end. restoreLiveTurn then re-reads the
 * session file, and a notice was never in it. It must not vanish on refresh.
 */
test("a settled run's trailing notice survives the session-file re-read", () => {
  const entries = [
    { id: "s", timestamp: 1, source: "pi", payload: { type: "agent_start" } },
    { id: "e", timestamp: 2, source: "pi", payload: { type: "agent_end" } },
    {
      id: "z",
      timestamp: 3,
      source: "pi",
      payload: { type: "agent_settled" },
    },
    {
      id: "n",
      timestamp: 4,
      source: "server",
      payload: {
        type: "notice",
        message: "Context compacted — summary replaces the older transcript",
      },
    },
  ] as unknown as Parameters<Timeline["replayLiveTurn"]>[0];

  const state: SessionState = {
    model: null,
    thinkingLevel: "off",
    isStreaming: false,
    sessionId: "s",
    sessionFile: "/tmp/fake.jsonl",
    messageCount: 1,
    pendingMessageCount: 0,
  };
  const timeline = new Timeline("conv-settled");
  timeline.setState(state);
  assert.equal(timeline.replayLiveTurn(entries), "settled");

  // What restoreLiveTurn does next: re-read the session file and re-hydrate,
  // which rebuilds items from scratch.
  timeline.hydrate([{ role: "user", content: "hello", timestamp: 1 }], state);

  const last = timeline.items.at(-1);
  assert.ok(
    last?.kind === "notice" && last.text.includes("Context compacted"),
    "the trailing notice must still be the last item after re-hydrating",
  );
});
