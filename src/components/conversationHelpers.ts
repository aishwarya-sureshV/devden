// Module-level helpers for Conversation: mode types and constants, local
// slash commands, turn/prompt indexing and review diffs.
import { useEffect, useState } from "react";
import { api, type SlashCommand } from "../lib/api";
import { isAskMessage } from "../lib/askBlock";
import { LIVE_TEXT_STALL_MS } from "../lib/thinkingRow";
import type { TimelineItem } from "../lib/timeline";
import { filterDiffToFiles, reviewPathsMatch } from "../lib/turnReview";

/** Newest settled reply, preferring an ask card so a trailing report does not lock it. */
export function lastAnswerableAssistantId(
  items: TimelineItem[],
): string | undefined {
  const tail: Extract<TimelineItem, { kind: "assistant" }>[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "user" || item.kind === "tool") break;
    if (item.kind === "assistant") tail.push(item);
  }
  return (tail.find((item) => isAskMessage(item.text)) ?? tail[0])?.id;
}

export function getResponseActionIds(
  items: TimelineItem[],
  streaming: boolean,
): Set<string> {
  const ids = new Set<string>();
  let segment: TimelineItem[] = [];
  const segments: TimelineItem[][] = [];
  for (const item of items) {
    if (item.kind === "user" && segment.length) {
      segments.push(segment);
      segment = [];
    }
    segment.push(item);
  }
  if (segment.length) segments.push(segment);

  segments.forEach((turn, index) => {
    if (streaming && index === segments.length - 1) return;
    const assistantIndex = turn.reduce(
      (last, item, itemIndex) => (item.kind === "assistant" ? itemIndex : last),
      -1,
    );
    if (assistantIndex < 0) return;
    if (turn.slice(assistantIndex + 1).some((item) => item.kind === "tool"))
      return;
    const response = turn[assistantIndex];
    if (response?.kind === "assistant") ids.add(response.id);
  });
  return ids;
}

/** Harness rows the journal never counts as a user turn. */
function isCountedUserTurn(
  item: Extract<TimelineItem, { kind: "user" }>,
): boolean {
  const text = item.text.trim();
  if (!text) return false;
  return (
    !text.startsWith("<user_info>") &&
    !text.startsWith("<system-reminder>") &&
    !text.startsWith("<session_context>")
  );
}

/** 0-based user-turn index for the assistant reply being forked. */
export function promptIndexAtAssistant(
  items: TimelineItem[],
  assistantId: string,
): number {
  let users = 0;
  for (const item of items) {
    if (item.kind === "user" && isCountedUserTurn(item)) users += 1;
    if (item.id === assistantId) return Math.max(0, users - 1);
  }
  return Math.max(0, users - 1);
}

export function userTextBeforeAssistant(
  items: TimelineItem[],
  assistantId: string,
): string {
  let last = "";
  for (const item of items) {
    if (item.kind === "user" && isCountedUserTurn(item))
      last = item.text.trim();
    if (item.id === assistantId) return last;
  }
  return last;
}

export function capText(text: string, limit = 80_000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (truncated)`;
}

export async function collectReviewDiff(
  key: string,
  cwd: string,
  since: number,
  turnFiles: string[],
): Promise<
  { ok: true; diff: string; reason?: string } | { ok: false; error: string }
> {
  const bulk = await api.gitReviewDiff(key, cwd, since);
  if (bulk.ok && bulk.repo === false)
    return { ok: false, error: "This folder is not a git repository." };
  if (bulk.ok && typeof bulk.diff === "string" && bulk.diff.trim()) {
    const diff =
      bulk.scope === "turn" || turnFiles.length === 0
        ? bulk.diff
        : filterDiffToFiles(bulk.diff, turnFiles, cwd);
    if (diff.trim()) return { ok: true, diff };
  }
  const listed = await api.gitChanges(key, cwd);
  if (!listed.ok)
    return { ok: false, error: listed.error ?? "Could not list git changes." };
  if (listed.repo === false)
    return { ok: false, error: "This folder is not a git repository." };
  const changes = listed.changes ?? [];
  if (changes.length === 0) return { ok: true, diff: "" };
  const matched = turnFiles.length
    ? changes.filter((file) =>
        turnFiles.some((path) => reviewPathsMatch(file.path, path, cwd)),
      )
    : [];
  // Isolation missed (absolute tool paths, old API without snapshot diffs).
  // The working tree is dirty — review that rather than claiming no change.
  const files = matched.length ? matched : changes;
  const pieces = await Promise.all(
    files.map((file) => api.gitFileDiff(key, cwd, file.path)),
  );
  return {
    ok: true,
    diff: pieces
      .map((piece) => piece.diff ?? "")
      .filter((block) => block.trim())
      .join("\n"),
  };
}

export type AccessMode = "workspace-write" | "read-only";

export type AgentMode = "standard" | "plan" | "routed" | "prosecutor" | "manual" | "auto-edit";

export const DESIGN_MODES: AgentMode[] = [
  "manual",
  "auto-edit",
  "plan",
  "standard",
];

export const apiAgentMode = (
  mode: AgentMode,
): "standard" | "plan" | "manual" | "auto-edit" =>
  mode === "plan"
    ? "plan"
    : mode === "manual"
      ? "manual"
      : mode === "auto-edit"
        ? "auto-edit"
        : "standard";

export const USAGE_IDLE_REFRESH_INTERVAL_MS = 30_000;

export const USAGE_RUNNING_REFRESH_INTERVAL_MS = 30_000;

export function isUsageShortcut(value: string): boolean {
  return /^\/(?:grok-cli-usage|grok-usage)$/i.test(value.trim());
}

/** Commands handled entirely in the UI (never sent to the backend). */
export const LOCAL_COMMANDS: SlashCommand[] = [
  {
    name: "clear",
    description: "Wipe the slate and start a fresh session",
    source: "local",
  },
  {
    name: "compact",
    description: "Summarize older history for the model; keep this transcript",
    source: "local",
  },
  {
    name: "context",
    description: "See what is using the context window",
    source: "local",
  },
  {
    name: "cost",
    description: "Check spend and usage for the current model",
    source: "local",
  },
  {
    name: "diff",
    description: "Review every file change in one diff viewer",
    source: "local",
  },
  {
    name: "export",
    description: "Download this conversation as a Markdown transcript",
    source: "local",
  },
  {
    name: "fork",
    description: "Fork the latest reply into a side chat with its own worktree",
    source: "local",
  },
  {
    name: "remote",
    description:
      "Open this workbench on your phone via a secure tunnel + QR (/remote off stops)",
    source: "local",
  },
  {
    name: "skill",
    description:
      "Distill this session into a reusable skill draft (review before saving)",
    source: "local",
  },
  {
    name: "pull",
    description: "Pull the latest changes for this repository",
    source: "local",
  },
  {
    name: "push",
    description: "Push this repository to its remote",
    source: "local",
  },
  {
    name: "usage",
    description: "Check spend and usage for the current model",
    source: "local",
  },
];

export function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () =>
      resolve(String(reader.result ?? "").split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export function useLiveTextStalled(active: boolean, text: string): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!active) {
      setStalled(false);
      return;
    }
    setStalled(false);
    const timer = window.setTimeout(() => setStalled(true), LIVE_TEXT_STALL_MS);
    return () => window.clearTimeout(timer);
  }, [active, text]);
  return active && stalled;
}
