/**
 * Manual-mode tool approval for pi, loaded by devden with `pi -e <this file>`
 * only when a session runs in manual mode.
 *
 * Categorized like Claude Code's prompts: read-only tools (read, grep, find,
 * ls) run without asking; everything else (bash, edit, write, MCP/custom
 * tools) goes through ctx.ui.select. In RPC mode that becomes an
 * `extension_ui_request` on stdout; devden answers with an
 * `extension_ui_response`, so the user's pick arrives over the wire. The
 * detail rides inside the title (pi's select has no detail field); devden
 * splits it back off at the first newline.
 *
 * For file edits the detail shows the proposed change, not raw JSON, so the
 * approval card reads like Claude Code's edit preview.
 *
 * "Always allow" is remembered per tool name for the process lifetime —
 * mode switches restart the process, so the set resets exactly when it
 * should.
 */

/** Minimal structural slice of pi's extension API — devden does not depend
 *  on the pi package, and jiti strips types when the CLI loads this file. */
interface ManualApproveToolCallEvent {
  toolName: string;
  input?: unknown;
}
interface ManualApproveUi {
  select(title: string, options: string[]): Promise<string | undefined>;
}
interface ManualApproveContext {
  ui: ManualApproveUi;
}
interface ManualApproveApi {
  on(
    eventName: "tool_call",
    handler: (
      event: ManualApproveToolCallEvent,
      ctx: ManualApproveContext,
    ) => Promise<{ block: true; reason?: string } | void> | void,
  ): void;
}

export default function manualApprove(pi: ManualApproveApi) {
  const allowed = new Set();
  const OPTIONS = ["Allow once", "Always allow", "Deny"];
  // Read-only tools never prompt, matching Claude Code: asking before every
  // read made manual mode unusable. Edit/execute still ask.
  const READ_ONLY = new Set(["read", "grep", "find", "ls"]);

  const truncate = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max)}…` : text;

  /** Human-readable detail per tool: the change being proposed, not JSON. */
  const describe = (toolName: string, input: unknown): string => {
    const record = (input ?? {}) as Record<string, unknown>;
    if (toolName === "edit") {
      const path = String(record.path ?? "");
      const edits = Array.isArray(record.edits)
        ? record.edits
        : [
            {
              oldText: record.oldText,
              newText: record.newText,
            },
          ];
      const parts = (edits as { oldText?: unknown; newText?: unknown }[]).map(
        (edit) =>
          [
            `- ${String(edit.oldText ?? "").trim()}`,
            `+ ${String(edit.newText ?? "").trim()}`,
          ].join("\n"),
      );
      return `${path}\n${parts.join("\n---\n")}`;
    }
    if (toolName === "write") {
      const path = String(record.path ?? "");
      return `${path}\n${String(record.content ?? "")}`;
    }
    try {
      return JSON.stringify(input ?? {}, null, 2) ?? "";
    } catch {
      return String(input ?? "");
    }
  };

  pi.on("tool_call", async (event, ctx) => {
    if (allowed.has(event.toolName)) return;
    if (READ_ONLY.has(event.toolName)) return;
    // Auto-edit applies edits and writes. Commands and deletes still ask.
    if (
      process.env.DEVDEN_AGENT_MODE === "auto-edit" &&
      !/bash|shell|exec|command|terminal|powershell|delete/i.test(event.toolName)
    )
      return;
    const detail = truncate(describe(event.toolName, event.input), 800);
    const choice = await ctx.ui.select(
      `Allow ${event.toolName}\n${detail}`,
      OPTIONS,
    );
    if (choice === "Always allow") {
      allowed.add(event.toolName);
      return;
    }
    if (choice === "Allow once") return;
    return {
      block: true,
      reason: choice === "Deny" ? "Denied by user" : "No approval given",
    };
  });
}
