/**
 * Shared subagent follow for backends whose spawn tool is `subagent`
 * (the pi-subagents extension): pi, Claude, Codex.
 *
 * Live child work lives in PiSubagentFollows (server/pi-subagent.js). Attach
 * it to those agent processes so a new backend that emits a `subagent` tool
 * call gets the same panel without copying the follower.
 *
 * Grok's native tool is `spawn_subagent` and its children are sibling session
 * folders (updates.jsonl / output.json), not the extension's asyncDir. That
 * follow lives on GrokAgentProcess — do not attach this follower there.
 * Claude's parent_tool_use_id hydration is a log-replay adapter, also
 * separate from this live follower.
 */
import {
  PiSubagentFollows,
  isPiSubagentTool,
  isSpawnArgs,
  resolveAsyncDir,
  receiptTextOf,
} from "./pi-subagent.js";

export {
  PiSubagentFollows,
  isPiSubagentTool,
  isSpawnArgs,
  resolveAsyncDir,
  receiptTextOf,
};

/** Task / Agent / spawn_subagent / subagent — every backend's spawn tool. */
export function isSubagentToolName(name) {
  const n = String(name ?? "")
    .toLowerCase()
    .replace(/[-\s]/g, "_");
  return (
    n === "task" || n === "agent" || n === "spawn_subagent" || n === "subagent"
  );
}

/**
 * Is live child work the only thing still running?
 *
 * The composer counts a running subagent as streaming, so Enter queues. If
 * the backend's isBusy disagrees the message is sent straight through and
 * renders as an ordinary transcript bubble instead of a queue chip — the
 * exact mismatch grok never had, because its isBusy already counts follows.
 */
export function subagentBusy(agent) {
  return (
    (agent?.subagents?.size ?? 0) > 0 ||
    (agent?.pendingBackgroundAgents?.size ?? 0) > 0 ||
    (agent?.openSubagents?.size ?? 0) > 0
  );
}

/** Install the shared follower on an agent process. Idempotent. */
export function attachSubagentFollows(agent) {
  if (agent.subagents instanceof PiSubagentFollows) return agent;
  agent.subagents = new PiSubagentFollows((event) => {
    agent.emit({ ...event, sessionKey: agent.sessionKey });
    // The turn that queued this is long over; the child finishing is the
    // only "now idle" signal a queued message will ever get.
    if (event.type === "tool_execution_end" && !agent.isBusy?.())
      agent.sendNextQueued?.();
  });
  if (!agent.pendingSpawnIds) agent.pendingSpawnIds = new Set();
  return agent;
}

/**
 * Handle a tool_execution_start / tool_execution_end in the shared event
 * vocabulary. Returns `{ holdEnd: true }` when the caller must not emit the
 * spawn's end yet — the follower will emit it when the child actually
 * finishes.
 */
export function noteSubagentToolEvent(agent, event) {
  if (!agent?.subagents) return { holdEnd: false };
  if (
    event.type === "tool_execution_start" &&
    isPiSubagentTool(event.toolName) &&
    isSpawnArgs(event.args)
  ) {
    agent.emit({
      type: "subagent_start",
      sessionKey: agent.sessionKey,
      parentToolUseId: event.toolCallId,
    });
    agent.pendingSpawnIds.add(event.toolCallId);
    agent.subagents.expect(event.toolCallId, agent.cwd, Date.now());
    return { holdEnd: false };
  }
  if (
    event.type === "tool_execution_end" &&
    agent.pendingSpawnIds?.delete(event.toolCallId)
  ) {
    const dir = resolveAsyncDir(event.result);
    if (dir)
      agent.subagents.start(
        event.toolCallId,
        dir,
        receiptTextOf(event.result),
      );
    if (agent.subagents.isFollowing(event.toolCallId)) return { holdEnd: true };
  }
  return { holdEnd: false };
}
