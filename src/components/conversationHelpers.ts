// Pure helpers for Conversation: turn/prompt indexing and review diffs.
import type { TimelineItem } from "../lib/timeline";
import { isAskMessage } from "../lib/askBlock";
import { api } from "../lib/api";
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

export type AgentMode = "standard" | "plan" | "routed" | "manual" | "auto-edit";
