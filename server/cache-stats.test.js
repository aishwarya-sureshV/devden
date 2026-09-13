import { strict as assert } from "node:assert";
import test from "node:test";

import { cacheMissNotice, formatMiss, detectMiss } from "./cache-stats.js";
import { usageFrom as grokUsageFrom } from "./grok-agent.js";

const MINUTE = 60_000;

/** pi/Codex camelCase usage. */
function piMessage({ input, cacheRead, cacheWrite = 0, at, model = "opus" }) {
  return {
    role: "assistant",
    provider: "anthropic",
    model,
    timestamp: at,
    usage: { input, output: 10, cacheRead, cacheWrite },
  };
}

/** Claude's raw Anthropic-API snake_case usage. */
function claudeMessage({ input, cacheRead, at }) {
  return {
    role: "assistant",
    provider: "anthropic",
    model: "opus",
    timestamp: at,
    usage: {
      input_tokens: input,
      output_tokens: 10,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: 0,
    },
  };
}

const end = (message) => ({ type: "message_end", message });
/** Every adapter emits one of these when the turn's output is complete. */
const settle = () => ({ type: "agent_settled" });

test("first turn of a session never counts", () => {
  assert.equal(
    cacheMissNotice(
      "s1",
      end(piMessage({ input: 50_000, cacheRead: 0, at: 0 })),
    ),
    undefined,
  );
});

test("a re-billed prompt after an idle gap is reported at the turn's end", () => {
  cacheMissNotice(
    "s2",
    end(piMessage({ input: 100, cacheRead: 50_000, at: 0 })),
  );
  // Nothing where the miss happened: the notice belongs at the bottom of the
  // turn's output, not between its tool calls.
  assert.equal(
    cacheMissNotice(
      "s2",
      end(piMessage({ input: 50_100, cacheRead: 0, at: 10 * MINUTE })),
    ),
    undefined,
  );
  assert.match(
    cacheMissNotice("s2", settle()),
    /^Cache miss after 10m idle — 50,100 tokens re-billed$/,
  );
  // Consumed once: a second settle has nothing left to report.
  assert.equal(cacheMissNotice("s2", settle()), undefined);
});

test("a turn's several misses are summed into one notice", () => {
  cacheMissNotice(
    "s2b",
    end(piMessage({ input: 100, cacheRead: 50_000, at: 0 })),
  );
  assert.equal(
    cacheMissNotice(
      "s2b",
      end(piMessage({ input: 50_100, cacheRead: 0, at: 10 * MINUTE })),
    ),
    undefined,
  );
  assert.equal(
    cacheMissNotice(
      "s2b",
      end(piMessage({ input: 60_000, cacheRead: 0, at: 11 * MINUTE })),
    ),
    undefined,
  );
  // Two re-billings of 50,100 each, one line.
  assert.match(
    cacheMissNotice("s2b", settle()),
    /^Cache miss after 10m idle — 100,200 tokens re-billed$/,
  );
});

test("a turn that ends on an error still reports its misses", () => {
  cacheMissNotice(
    "s2c",
    end(piMessage({ input: 100, cacheRead: 50_000, at: 0 })),
  );
  cacheMissNotice(
    "s2c",
    end(piMessage({ input: 50_100, cacheRead: 0, at: 10 * MINUTE })),
  );
  assert.match(
    cacheMissNotice("s2c", { type: "__status", status: "error" }),
    /50,100 tokens re-billed/,
  );
});

test("a model switch is named as the reason", () => {
  cacheMissNotice(
    "s3",
    end(piMessage({ input: 100, cacheRead: 50_000, at: 0 })),
  );
  cacheMissNotice(
    "s3",
    end(piMessage({ input: 50_100, cacheRead: 0, at: 1000, model: "sonnet" })),
  );
  assert.match(cacheMissNotice("s3", settle()), /model changed/);
});

test("a clean cache hit is silent", () => {
  cacheMissNotice(
    "s4",
    end(piMessage({ input: 100, cacheRead: 50_000, at: 0 })),
  );
  assert.equal(
    cacheMissNotice(
      "s4",
      end(piMessage({ input: 200, cacheRead: 50_100, at: 1000 })),
    ),
    undefined,
  );
  assert.equal(cacheMissNotice("s4", settle()), undefined);
});

test("misses at breakpoint granularity stay below the noise floor", () => {
  cacheMissNotice(
    "s5",
    end(piMessage({ input: 100, cacheRead: 50_000, at: 0 })),
  );
  assert.equal(
    cacheMissNotice(
      "s5",
      end(piMessage({ input: 1000, cacheRead: 49_500, at: 1000 })),
    ),
    undefined,
  );
});

test("Claude's snake_case usage is read the same as pi's", () => {
  cacheMissNotice(
    "s6",
    end(claudeMessage({ input: 100, cacheRead: 50_000, at: 0 })),
  );
  cacheMissNotice(
    "s6",
    end(claudeMessage({ input: 50_100, cacheRead: 0, at: 6 * MINUTE })),
  );
  assert.match(cacheMissNotice("s6", settle()), /50,100 tokens re-billed/);
});

// Real payload shape, copied from a grok turn_completed in ~/.grok/sessions.
// inputTokens is INCLUSIVE of cachedReadTokens (totalTokens is exactly
// inputTokens + outputTokens), which is why usageFrom re-bases it.
test("grok's inclusive inputTokens is re-based, not double-counted", () => {
  const usage = grokUsageFrom({
    inputTokens: 46_380,
    outputTokens: 213,
    totalTokens: 46_593,
    cachedReadTokens: 23_040,
    cacheCreationTokens: 0,
    reasoningTokens: 103,
  });
  assert.equal(usage.input, 23_340);
  assert.equal(usage.cacheRead, 23_040);
  // The shared convention: prompt tokens are input + cacheRead + cacheWrite.
  assert.equal(usage.input + usage.cacheRead + usage.cacheWrite, 46_380);
});

test("a grok turn that loses its cache is reported", () => {
  const grokMessage = (raw, at) => ({
    role: "assistant",
    provider: "grok-sdk",
    model: "grok-4.6",
    timestamp: at,
    usage: grokUsageFrom(raw),
  });
  cacheMissNotice(
    "s7",
    end(grokMessage({ inputTokens: 46_380, cachedReadTokens: 23_040 }, 0)),
  );
  cacheMissNotice(
    "s7",
    end(grokMessage({ inputTokens: 46_380, cachedReadTokens: 0 }, 8 * MINUTE)),
  );
  assert.match(
    cacheMissNotice("s7", settle()),
    /^Cache miss after 8m idle — 46,380 tokens re-billed$/,
  );
});

test("a backend that reports no cache fields at all stays silent", () => {
  const zero = (at) => ({
    role: "assistant",
    provider: "ollama",
    model: "qwen3",
    timestamp: at,
    usage: { input: 5000, output: 10, cacheRead: 0, cacheWrite: 0 },
  });
  cacheMissNotice("s7b", end(zero(0)));
  assert.equal(cacheMissNotice("s7b", end(zero(MINUTE))), undefined);
});

test("the same message on two event types is only counted once", () => {
  cacheMissNotice(
    "s8",
    end(piMessage({ input: 100, cacheRead: 50_000, at: 0 })),
  );
  const message = piMessage({ input: 50_100, cacheRead: 0, at: 10 * MINUTE });
  cacheMissNotice("s8", { type: "message_end", message });
  cacheMissNotice("s8", { type: "turn_end", message });
  // The exact total is the assertion: a second count would read 100,200.
  assert.match(
    cacheMissNotice("s8", settle()),
    /^Cache miss after 10m idle — 50,100 tokens re-billed$/,
  );
});

test("sessions are tracked independently", () => {
  cacheMissNotice(
    "a",
    end(piMessage({ input: 100, cacheRead: 50_000, at: 0 })),
  );
  assert.equal(
    cacheMissNotice(
      "b",
      end(piMessage({ input: 50_100, cacheRead: 0, at: MINUTE })),
    ),
    undefined,
  );
});

test("cost is shown only when the backend reports a cost breakdown", () => {
  const miss = detectMiss(
    {
      promptTokens: 50_000,
      modelKey: "anthropic/opus",
      timestamp: 0,
      reportedCache: true,
    },
    {
      provider: "anthropic",
      model: "opus",
      timestamp: 1000,
      usage: {
        input: 50_000,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0.75, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    },
  );
  assert.match(formatMiss(miss), /\(~\$0\.75\)$/);
});

test("a subagent's own request is not the parent's cache miss", () => {
  const parent = {
    type: "message_end",
    message: piMessage({ input: 200, cacheRead: 120_000, at: 0 }),
  };
  const child = {
    type: "message_end",
    parentToolUseId: "toolu_01ABC",
    message: piMessage({ input: 8_000, cacheRead: 0, at: MINUTE }),
  };
  assert.equal(cacheMissNotice("sub", parent), undefined);
  // Its small uncached prompt is a different prefix, not a re-billed one.
  assert.equal(cacheMissNotice("sub", child), undefined);
  // ...and it must not have displaced the parent's chain either.
  cacheMissNotice("sub", {
    type: "message_end",
    message: piMessage({ input: 120_200, cacheRead: 0, at: 12 * MINUTE }),
  });
  assert.match(cacheMissNotice("sub", settle()), /120,200 tokens re-billed/);
});
