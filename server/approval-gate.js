/**
 * Manual-mode tool approval gate, shared by the backends whose protocols
 * support asking a human mid-turn (claude: can_use_tool control requests,
 * grok: ACP request_permission, codex: execCommandApproval).
 *
 * Flow: the adapter hits a tool the backend wants to run, calls request(),
 * which emits an `approval_request` event to the UI and parks the turn on a
 * promise. The user's pick arrives via POST /api/<key>/approve -> resolve().
 * "Always allow" is remembered per tool name for the process lifetime, so a
 * chatty tool (Bash) does not ask on every call.
 *
 * pi has no tool-approval protocol in RPC mode, so manual mode there simply
 * never gates — the adapters only consult the gate when enabled.
 */
import { randomUUID } from "node:crypto";

const APPROVAL_TIMEOUT_MS = 10 * 60_000;

export const DEFAULT_APPROVAL_OPTIONS = [
  { id: "allow", label: "Allow once" },
  { id: "allow_always", label: "Always allow" },
  { id: "deny", label: "Deny" },
];

export class ApprovalGate {
  /** `agent` needs: emit(event), sessionKey, agentMode. */
  constructor(agent) {
    this.agent = agent;
    this.pending = new Map();
    this.allowedTools = new Set();
  }

  get enabled() {
    const mode = this.agent.agentMode;
    return mode === "manual" || mode === "auto-edit";
  }

  /**
   * Ask the user. Returns { allow, choice } — `allow` is false only for an
   * explicit deny (or timeout). Options carry adapter-specific ids; the gate
   * only interprets "deny" and "allow_always" itself.
   */
  async request({
    toolName,
    title,
    detail,
    options = DEFAULT_APPROVAL_OPTIONS,
    requestId = randomUUID(),
  }) {
    if (!this.enabled) return { allow: true, choice: undefined };
    // Auto-edit applies file changes on its own. Commands and deletes still ask.
    if (
      this.agent.agentMode === "auto-edit" &&
      !/bash|shell|exec|command|terminal|powershell|delete|execute/i.test(
        String(toolName ?? ""),
      )
    ) {
      return { allow: true, choice: undefined };
    }
    if (this.allowedTools.has(toolName))
      return { allow: true, choice: "allow_always" };
    const choice = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.agent.emit({
          type: "notice",
          sessionKey: this.agent.sessionKey,
          message: `No approval for ${toolName} within 10 minutes — denied.`,
          tone: "warning",
        });
        resolve("deny");
      }, APPROVAL_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, toolName, timer, optionIds: options.map((option) => option.id) });
      this.agent.emit({
        type: "approval_request",
        sessionKey: this.agent.sessionKey,
        requestId,
        toolName,
        title,
        detail,
        options,
      });
    });
    return { allow: choice !== "deny", choice };
  }

  resolve(requestId, optionId) {
    const entry = this.pending.get(requestId);
    if (!entry) return { ok: false, error: "no pending approval with that id" };
    if (!entry.optionIds.includes(optionId)) return { ok: false, error: "invalid approval option" };
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    if (optionId === "allow_always") this.allowedTools.add(entry.toolName);
    entry.resolve(optionId);
    this.agent.emit({
      type: "approval_resolved",
      sessionKey: this.agent.sessionKey,
      requestId,
    });
    return { ok: true };
  }

  /** Turn aborted while a prompt was outstanding: deny so the turn can end. */
  denyAll() {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      entry.resolve("deny");
      this.agent.emit({
        type: "approval_resolved",
        sessionKey: this.agent.sessionKey,
        requestId,
      });
      this.agent.emit({
        type: "notice",
        sessionKey: this.agent.sessionKey,
        message: "Approval dismissed — denied.",
        tone: "warning",
      });
    }
  }
}

/** How many tool calls are parked on an approval card, across every pool. */
export function countPendingApprovals(pools) {
  let count = 0;
  const list = Array.isArray(pools) ? pools : Object.values(pools || {});
  for (const pool of list) {
    const agents = pool?.agents;
    if (!agents || typeof agents.values !== "function") continue;
    for (const agent of agents.values()) {
      const size = agent?.approvalGate?.pending?.size;
      if (typeof size === "number") count += size;
    }
  }
  return count;
}
