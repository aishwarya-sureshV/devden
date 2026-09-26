import test from "node:test";
import assert from "node:assert/strict";
import {
  exhaustedWindow,
  formatResetAt,
  isUsageLimitError,
  limitResumePrompt,
  limitScope,
  pendingLimitTurn,
} from "./usageLimit.ts";
import type { AgentEvent, ProviderUsage } from "./api.ts";
import { Timeline, type TimelineItem } from "./timeline.ts";

const usage = (windows: ProviderUsage["windows"]): ProviderUsage => ({
  available: true,
  provider: "Test",
  windows,
});

const user = (id: string, text: string): TimelineItem =>
  ({ id, kind: "user", text, timestamp: 1 }) as unknown as TimelineItem;
const notice = (
  id: string,
  text: string,
  tone: "info" | "warning" | "error" = "error",
): TimelineItem =>
  ({ id, kind: "notice", text, tone, timestamp: 2 }) as unknown as TimelineItem;

test("limitScope reads the provider's own labels", () => {
  assert.equal(limitScope("Current session"), "session");
  assert.equal(limitScope("5 hour limit"), "session");
  assert.equal(limitScope("Current week"), "weekly");
  assert.equal(limitScope("7 day limit"), "weekly");
  assert.equal(limitScope(""), "other");
});

// Every string below was extracted from the installed CLI that produces it
// (claude 2.1.270, codex, the pi bundle, and Grok's own 402 body), so this
// test fails if a real backend's exhausted-limit error stops being caught.
test("every backend's exhausted-limit wording is caught", () => {
  const real = [
    // Grok: 402 from the responses API, and the stderr log line carrying it.
    "Grok Build usage balance exhausted",
    "API error (status 402 Payment Required): Grok Build usage balance exhausted",
    // Claude CLI.
    "Usage limit reached · continuing automatically",
    "usage credit limit reached",
    "You've hit your fast limit · resets in 2h 13m",
    "You've hit your monthly limit",
    // Codex CLI.
    "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro)",
    "You've hit your spend cap set by the owner of your workspace.",
    // Pi driving codex, and pi driving the raw provider APIs.
    "You have hit your ChatGPT usage limit (Plus plan). Try again in 3 hours.",
    "Monthly usage limit reached",
    "insufficient_quota",
    "You exceeded your current quota, please check your plan and billing details.",
    "Your credit balance is too low to access the Anthropic API.",
    "You are out of budget",
  ];
  for (const text of real)
    assert.ok(isUsageLimitError(text), `should catch: ${text}`);
});

// Pi's classifier calls these *retryable*, and none of them means the account
// is out of quota — so none may raise the pill.
test("transient and non-quota failures do not raise the pill", () => {
  const notQuota = [
    "429 Too Many Requests",
    "rate limit exceeded, please retry",
    "overloaded_error",
    "context length limit exceeded",
    "Concurrent subagent limit reached. You can run 3 subagents",
    "Agent depth limit reached. Solve the task yourself.",
    "OS file watch limit reached.",
    "Could not read the file",
    "",
  ];
  for (const text of notQuota)
    assert.equal(isUsageLimitError(text), false, `should ignore: ${text}`);
});

test("exhaustedWindow takes the maxed window, soonest reset first", () => {
  assert.equal(
    exhaustedWindow(
      usage([
        { label: "Current session", usedPercent: 100, resetsAt: 5_000 },
        { label: "Current week", usedPercent: 41, resetsAt: 9_000 },
      ]),
    )?.label,
    "Current session",
  );
  // Both maxed: the one coming back first is the one worth showing.
  assert.equal(
    exhaustedWindow(
      usage([
        { label: "Current week", usedPercent: 100, resetsAt: 9_000 },
        { label: "Current session", usedPercent: 100, resetsAt: 5_000 },
      ]),
    )?.label,
    "Current session",
  );
  // Nothing maxed — the fullest is still the best guess at what ran out.
  assert.equal(
    exhaustedWindow(
      usage([
        { label: "Current session", usedPercent: 82 },
        { label: "Current week", usedPercent: 30 },
      ]),
    )?.label,
    "Current session",
  );
  // Providers that stopped reporting a percent (Grok's unified billing) still
  // report the reset instant, which is the one thing the banner needs.
  assert.equal(
    exhaustedWindow(usage([{ label: "Current week", resetsAt: 7_000 }]))?.label,
    "Current week",
  );
  // No numbers at all: no reset line rather than a guessed one.
  assert.equal(exhaustedWindow(usage([{ label: "Credits" }])), undefined);
  assert.equal(exhaustedWindow(null), undefined);
});

test("pendingLimitTurn arms only the newest turn, and only on a limit error", () => {
  assert.deepEqual(
    pendingLimitTurn([
      user("u1", "ship the fix"),
      notice("n1", "Grok Build usage balance exhausted"),
    ]),
    { request: "ship the fix", noticeId: "n1" },
  );
  // A new prompt closes the previous turn: its resume is gone.
  assert.equal(
    pendingLimitTurn([
      user("u1", "ship the fix"),
      notice("n1", "Grok Build usage balance exhausted"),
      user("u2", "actually, revert it"),
    ]),
    undefined,
  );
  // A different failure is not a quota wall, and a local command is not a turn.
  assert.equal(
    pendingLimitTurn([user("u1", "ship it"), notice("n1", "Command failed")]),
    undefined,
  );
  // Only exhausted limits arm it: a transient 429 is not a resume-worthy wall.
  assert.equal(
    pendingLimitTurn([
      user("u1", "ship it"),
      notice("n1", "429 Too Many Requests"),
    ]),
    undefined,
  );
  assert.equal(
    pendingLimitTurn(
      [user("u1", "/compact"), notice("n1", "Claude usage limit reached")],
      (text) => text.startsWith("/"),
    ),
    undefined,
  );
  assert.equal(pendingLimitTurn([]), undefined);
});

test("a limit wall delivered by any backend path arms the pill", () => {
  // Three routes carry a failed turn to the client: an SSE notice, the
  // __status error, and the stderr log line -- and each backend leans on a
  // different one. All three must leave something the pill can stand on.
  const deliveries: Array<[string, Record<string, unknown>]> = [
    [
      "claude via SSE notice",
      {
        type: "notice",
        message: "Usage limit reached · continuing automatically",
        tone: "error",
      },
    ],
    [
      "codex via __status",
      {
        type: "__status",
        status: "ready",
        error: "You've hit your usage limit. Upgrade to Pro",
      },
    ],
    [
      "pi via __status",
      {
        type: "__status",
        status: "ready",
        error: "You have hit your ChatGPT usage limit (Plus plan).",
      },
    ],
    [
      "grok via stderr",
      {
        type: "stderr",
        message:
          "2026-09-12T12:31:47.251703Z ERROR responses API error status=402 Payment Required error_message=Grok Build usage balance exhausted",
      },
    ],
    [
      // Plain stderr, no timestamp: lands as a warning, still a quota wall.
      "unwrapped stderr",
      { type: "stderr", message: "Monthly usage limit reached" },
    ],
  ];
  for (const [label, payload] of deliveries) {
    const timeline = new Timeline(`t-${label}`);
    timeline.appendUser("do the thing");
    timeline.handle(payload as unknown as AgentEvent);
    const turn = pendingLimitTurn(timeline.items, (text) =>
      text.startsWith("/"),
    );
    assert.ok(turn, `${label} should arm the pill`);
    assert.equal(turn?.request, "do the thing", label);
  }
});

test("a wall the agent carried on past does not arm the pill", () => {
  // Claude's "continuing automatically" waits the window out and finishes the
  // turn. Nothing was cut off, so there is nothing to resume.
  const carriedOn = [
    user("u1", "do the thing"),
    notice("n1", "Usage limit reached · continuing automatically"),
    { id: "a1", kind: "assistant", text: "done", timestamp: 3 },
  ] as unknown as TimelineItem[];
  assert.equal(pendingLimitTurn(carriedOn), undefined);
  // ...but a second wall after that work is the one that stopped it.
  assert.equal(
    pendingLimitTurn([
      ...carriedOn,
      notice("n2", "Monthly usage limit reached"),
    ])?.noticeId,
    "n2",
  );
});

test("a follow-up sent into an exhausted limit resumes the cut-off turn", () => {
  const assistant = (id: string, text: string): TimelineItem =>
    ({ id, kind: "assistant", text, timestamp: 2 }) as unknown as TimelineItem;
  // The queued prompt was released because the wall settled the turn. It
  // never got model work, so Resume still belongs to the turn that was cut off.
  assert.deepEqual(
    pendingLimitTurn([
      user("u1", "animate the todos"),
      assistant("a1", "halfway through the todos"),
      notice("n1", "you have reached your session usage limit"),
      user("u2", "and todos must not be static"),
      notice("n2", "you have reached your session usage limit"),
    ]),
    { request: "animate the todos", noticeId: "n1" },
  );
  // The follow-up actually started. That turn is the one to resume.
  assert.equal(
    pendingLimitTurn([
      user("u1", "animate the todos"),
      assistant("a1", "halfway through the todos"),
      notice("n1", "you have reached your session usage limit"),
      user("u2", "and todos must not be static"),
      assistant("a2", "started the follow-up"),
      notice("n2", "you have reached your session usage limit"),
    ])?.request,
    "and todos must not be static",
  );
});

test("a clean turn after a wall does not arm the pill", () => {
  const timeline = new Timeline("t-clean");
  timeline.appendUser("do the thing");
  timeline.handle({
    type: "__status",
    status: "ready",
  } as unknown as AgentEvent);
  assert.equal(
    pendingLimitTurn(timeline.items, () => false),
    undefined,
  );
});

test("formatResetAt drops the weekday for a same-day reset", () => {
  const at = new Date(2026, 0, 5, 18, 50).getTime();
  const time = new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  assert.equal(formatResetAt(at, at), time);
  const later = new Date(2026, 0, 12, 9, 0).getTime();
  assert.equal(
    formatResetAt(later, at),
    // Mirror the locale-aware time (en-US gives "9:00 AM", en-IN "9:00 am").
    `${new Date(later).toLocaleDateString(undefined, { weekday: "short" })} ${new Date(later).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`,
  );
  assert.equal(formatResetAt(Number.NaN), "");
});

test("limitResumePrompt carries the request without re-asking the user", () => {
  const prompt = limitResumePrompt("add the reset banner", "weekly");
  assert.match(prompt, /add the reset banner/);
  assert.match(prompt, /weekly limit/);
  assert.match(prompt, /Do not start over/);
});
