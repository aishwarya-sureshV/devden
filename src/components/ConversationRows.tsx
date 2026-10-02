// Timeline row components rendered by Conversation.
import { useRef, useState, useEffect, memo } from "react";
import {
	createThinkingQuips,
	THINKING_QUIP_MS,
	thinkingLineParts,
} from "../lib/thinkingQuips";
import { formatWorkingClock } from "../lib/toolRow";
import { type ContextUsage, compactTokens } from "../lib/sessionMetrics";
import { type SubagentRun, isSubagentTool } from "../lib/subagents";
import type { RewindFilesResult } from "../lib/api";
import { IconHistory, IconPencil, IconFork } from "./icons";
import type { TimelineItem } from "../lib/timeline";
import type { ToolFileView } from "../lib/toolCards";
import { SubagentCard } from "./SubagentCard";
import { ToolCard } from "./ToolCard";
import { CopyButton } from "./CopyButton";
import { RichText } from "./RichText";

export function ThinkingRow({
	resume = false,
	startedAt,
	tools,
	parallel,
}: {
	resume?: boolean;
	startedAt: number;
	tools: number;
	parallel: number;
}) {
	const drawRef = useRef<(() => string) | null>(null);
	if (drawRef.current == null) drawRef.current = createThinkingQuips();
	const [quip, setQuip] = useState(() => drawRef.current!());
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = window.setInterval(() => setNow(Date.now()), 500);
		return () => window.clearInterval(id);
	}, []);
	useEffect(() => {
		if (resume) return;
		const id = window.setInterval(() => {
			setQuip(drawRef.current!());
		}, THINKING_QUIP_MS);
		return () => window.clearInterval(id);
	}, [resume]);
	const label = resume ? "Picking up after restart" : quip;
	const parts = resume ? null : thinkingLineParts(quip);
	return (
		<div className="thinking" aria-label={label}>
			<span key={label} className="thinking__line">
				{parts?.emoji ? (
					<span
						className={`thinking__emoji thinking__emoji--${parts.motion}`}
						aria-hidden="true"
					>
						{parts.emoji}
					</span>
				) : null}
				<span className="thinking__words">
					{parts?.emoji ? parts.text : label}
				</span>
			</span>
			{resume ? null : <span className="thinking__dots" aria-hidden="true" />}
			<span className="thinking__meta">
				{` · ${formatWorkingClock(Math.max(0, now - startedAt))} · ${tools} tool${tools === 1 ? "" : "s"}`}
				{parallel > 1 ? ` · ${parallel} running in parallel` : ""}
			</span>
		</div>
	);
}

function ContextFill({ context }: { context: ContextUsage }) {
	const percent = context.percent ?? 0;
	const nearLimit = percent >= 80;
	const title = context.exact
		? [
				`${context.estimatedTokens.toLocaleString()} of ${context.contextWindow.toLocaleString()} context tokens used (${percent}%)`,
				context.autoCompactAt
					? `Auto-compacts at ${context.autoCompactAt.toLocaleString()}.`
					: "",
				...(context.categories ?? [])
					.slice(0, 6)
					.map((entry) => `${entry.name}: ${compactTokens(entry.tokens)}`),
			]
				.filter(Boolean)
				.join("\n")
		: `Approximately ${context.estimatedTokens.toLocaleString()} of ${context.contextWindow.toLocaleString()} context tokens used (estimated)`;
	return (
		<div
			className={`context-fill${nearLimit ? " is-near-limit" : ""}${context.exact ? " is-exact" : ""}`}
			role="progressbar"
			aria-label={`Context used: ${percent}%${context.exact ? "" : ", estimated"}`}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={percent}
			title={title}
		>
			<span style={{ width: `${Math.min(100, percent)}%` }} />
		</div>
	);
}

/** What the transcript shows in place of the model's babysitting churn: one
 *  steady row for as long as the run is in flight. `attention` replaces it
 *  when the runner reports the child is blocked on a reply — otherwise a
 *  stalled run is indistinguishable from a slow one. */
export function SubagentWaitRow({ runs }: { runs: SubagentRun[] }) {
	const running = runs.filter((run) => run.status === "running");
	if (running.length === 0) return null;
	const blocked = running.find((run) => run.attention);
	const label = blocked?.attention
		? `Subagent needs attention — ${blocked.attention}`
		: running.length > 1
			? `${running.length} background subagents are running — waiting for them to complete`
			: "Background subagent is running — waiting for it to complete";
	return (
		<div
			className={`thinking${blocked ? " thinking--attention" : ""}`}
			aria-label={label}
		>
			<span className="thinking__spinner" />
			<span>{label}</span>
			{blocked ? null : <span className="thinking__dots" aria-hidden="true" />}
		</div>
	);
}

/**
 * Memoized: streaming deltas tick the timeline many times a second, and a
 * long session re-parsing every RichText/diff row per tick froze the main
 * thread — the first paint after sending a prompt lagged for seconds, which
 * read as "nothing happened". Rows whose item and flags are unchanged now
 * skip re-rendering entirely.
 */
/**
 * "Undo the edits made since this message." Claude Code restores from the
 * per-file backups it takes before writing; every other backend restores from
 * the git snapshot the server takes before each turn. It asks for the preview
 * first so the click is never blind — a rewind is not itself undoable.
 */
function RewindFilesButton({
	timestamp,
	disabled,
	onRewindFiles,
}: {
	timestamp: number;
	disabled?: boolean;
	onRewindFiles?: (
		timestamp: number,
		dryRun: boolean,
	) => Promise<RewindFilesResult>;
}) {
	const [preview, setPreview] = useState<RewindFilesResult | null>(null);
	const [busy, setBusy] = useState(false);
	if (!onRewindFiles) return null;

	const ask = async () => {
		setBusy(true);
		try {
			setPreview(await onRewindFiles(timestamp, true));
		} finally {
			setBusy(false);
		}
	};

	const confirm = async () => {
		setBusy(true);
		try {
			const result = await onRewindFiles(timestamp, false);
			setPreview(result.error ? result : null);
		} finally {
			setBusy(false);
		}
	};

	if (preview) {
		const count = preview.filesChanged?.length ?? 0;
		return (
			<span className="rewind">
				{preview.error ? (
					<span className="rewind__error">{preview.error}</span>
				) : (
					<>
						<span className="rewind__summary">
							Restore {count} file{count === 1 ? "" : "s"}
							{preview.insertions === undefined
								? ""
								: ` (+${preview.insertions}/−${preview.deletions ?? 0})`}
							?
						</span>
						<button
							type="button"
							className="rewind__confirm"
							disabled={busy || count === 0}
							onClick={() => void confirm()}
						>
							Restore
						</button>
					</>
				)}
				<button
					type="button"
					className="rewind__cancel"
					onClick={() => setPreview(null)}
				>
					Cancel
				</button>
			</span>
		);
	}

	return (
		<button
			type="button"
			className="user-msg__action"
			aria-label="Restore files to this point"
			title="Restore files to this point"
			disabled={disabled || busy}
			onClick={() => void ask()}
		>
			<IconHistory size={13} />
		</button>
	);
}

/** Notice with expandable content (compaction summary) — one compact line,
 *  click to reveal what was compacted away. */
function CompactedNotice({
	text,
	tone,
	detail,
}: {
	text: string;
	tone: "info" | "warning" | "error";
	detail: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className={`notice notice--${tone}`}>
			<button
				type="button"
				className="notice__summary"
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
			>
				{text}
			</button>
			{open && <pre className="notice__detail">{detail}</pre>}
		</div>
	);
}

export function turnStartedAt(turn: TimelineItem[] | undefined): number {
	if (!turn) return Date.now();
	const user = turn.find((item) => item.kind === "user");
	if (user?.kind === "user") return user.timestamp;
	const tool = turn.find((item) => item.kind === "tool");
	if (tool?.kind === "tool") return tool.startedAt;
	return Date.now();
}

export const TimelineRow = memo(function TimelineRow({
	item,
	onOpenFile,
	onFork,
	forking,
	canFork = true,
	canTruncate = false,
	showActions,
	showModelTag,
	editingId,
	streaming,
	onEditMessage,
	onCancelEdit,
	onVersionChange,
	onRewindFiles,
	onAnswer,
	subagentChildren,
	onOpenSubagent,
	onBackgroundSubagent,
	onStopTerminal,
	cwd = "",
	repeat = 1,
	expandDiff = false,
	dockTitle = null,
	dockWord = "In panel",
}: {
	item: TimelineItem;
	onOpenFile: (view: ToolFileView) => void;
	cwd?: string;
	repeat?: number;
	expandDiff?: boolean;
	dockTitle?: string | null;
	dockWord?: string;
	onFork: (item: Extract<TimelineItem, { kind: "assistant" }>) => void;
	forking: boolean;
	canFork?: boolean;
	canTruncate?: boolean;
	showActions: boolean;
	showModelTag: boolean;
	editingId?: string | null;
	streaming?: boolean;
	onEditMessage?: (item: Extract<TimelineItem, { kind: "user" }>) => void;
	onCancelEdit?: () => void;
	onVersionChange?: (
		item: Extract<TimelineItem, { kind: "user" }>,
		index: number,
	) => void;
	onRewindFiles?: (
		timestamp: number,
		dryRun: boolean,
	) => Promise<RewindFilesResult>;
	/** Present only on the newest settled reply — see AskCard. */
	onAnswer?: (text: string) => void;
	subagentChildren?: Map<string, Extract<TimelineItem, { kind: "tool" }>[]>;
	onOpenSubagent?: (id: string) => void;
	onBackgroundSubagent?: (id: string) => void;
	/** Stop a running server-owned terminal tab (its card's Stop button). */
	onStopTerminal?: (tabId: string) => void;
}) {
	if (item.kind === "tool" && isSubagentTool(item.name))
		return (
			<SubagentCard
				item={item}
				children={subagentChildren?.get(item.id) ?? []}
				onOpenFile={onOpenFile}
				onOpenSubagent={onOpenSubagent}
				onBackground={onBackgroundSubagent}
				cwd={cwd}
			/>
		);
	if (item.kind === "tool")
		return (
			<ToolCard
				item={item}
				onOpenFile={onOpenFile}
				onOpenSubagent={onOpenSubagent}
				children={subagentChildren?.get(item.id) ?? []}
				cwd={cwd}
				repeat={repeat}
				expandDiff={expandDiff}
				dockTitle={dockTitle}
				dockWord={dockWord}
			/>
		);
	if (item.kind === "notice")
		return item.detail ? (
			<CompactedNotice text={item.text} tone={item.tone} detail={item.detail} />
		) : (
			<div className={`notice notice--${item.tone}`}>{item.text}</div>
		);
	if (item.kind === "terminal")
		return (
			<div className="terminal-card">
				<div className="terminal-card__header">
					<span
						className={`terminal-card__dot${
							item.status === "running" ? " is-running" : ""
						}`}
					/>
					<span className="terminal-card__title" title={item.command}>
						{item.title}
					</span>
					<span className="terminal-card__status">
						{item.status === "exited"
							? `exit ${item.exitCode ?? "?"}`
							: "running"}
					</span>
					{item.status === "running" && onStopTerminal && (
						<button
							type="button"
							className="terminal-card__stop"
							onClick={() => onStopTerminal(item.tabId)}
						>
							Stop
						</button>
					)}
				</div>
				<pre className="terminal-card__output">{item.output}</pre>
			</div>
		);
	if (item.kind === "user") {
		const versions = item.versions;
		const versionIndex = item.versionIndex ?? 0;
		return (
			<article className="tl tl--user">
				<span className="tl__node" />
				<div className="tl--user__stack">
					{item.images?.length ? (
						<div className="user-msg__images">
							{item.images.map((src, index) => (
								<a key={index} href={src} target="_blank" rel="noreferrer">
									<img src={src} alt={`Attached image ${index + 1}`} />
								</a>
							))}
						</div>
					) : null}
					{item.text && (
						<div
							className={`user-msg${editingId === item.id ? " is-editing" : ""}`}
						>
							{item.text}
						</div>
					)}
					<div className="user-msg__actions">
						<CopyButton
							text={item.text}
							label="Copy message"
							className="user-msg__action"
						/>
						{canTruncate ? (
							<button
								type="button"
								className="user-msg__action"
								aria-label="Edit and resend"
								title="Edit and resend"
								disabled={streaming}
								onClick={() => {
									if (editingId === item.id) {
										onCancelEdit?.();
										return;
									}
									onEditMessage?.(item);
								}}
							>
								<IconPencil size={13} />
							</button>
						) : null}
						<RewindFilesButton
							timestamp={item.timestamp}
							disabled={streaming}
							onRewindFiles={onRewindFiles}
						/>
					</div>
					{canTruncate && versions && versions.length > 1 && (
						<div
							className="user-msg__versions"
							role="group"
							aria-label="Message versions"
						>
							<button
								type="button"
								aria-label="Previous version"
								disabled={versionIndex === 0}
								onClick={() => onVersionChange?.(item, versionIndex - 1)}
							>
								‹
							</button>
							<span>
								{versionIndex + 1}/{versions.length}
							</span>
							<button
								type="button"
								aria-label="Next version"
								disabled={versionIndex >= versions.length - 1}
								onClick={() => onVersionChange?.(item, versionIndex + 1)}
							>
								›
							</button>
						</div>
					)}
				</div>
			</article>
		);
	}
	return (
		<article
			className={`tl tl--assistant${item.kind === "rationale" ? " tl--rationale" : ""}`}
		>
			<span className={`tl__node${item.live ? " is-live" : ""}`} />
			<div>
				<RichText
					text={item.text
						.replace(/\s*\[DONE:\d+\]\s*/gi, " ")
						// Models end turns with trailing newlines and pre-wrap renders
						// them as real blank lines — the phantom gap between prose and
						// the rows below.
						.replace(/\s+$/, "")
						.replace(/^\s+/, "")}
					live={item.live}
					skillBackend={
						item.kind === "assistant" && item.provider === "codex"
							? "codex"
							: "pi"
					}
					onAnswer={onAnswer}
				/>
			</div>
			{item.kind === "assistant" &&
				!item.live &&
				showModelTag &&
				(item.provider || item.modelId) && (
					<div
						className="response-model-tag"
						title="Model that generated this reply, as tracked by the backend — not the model's own self-report."
					>
						{item.provider}
						{item.provider && item.modelId ? "/" : ""}
						{item.modelId}
					</div>
				)}
			{item.kind === "assistant" && !item.live && showActions && (
				<div
					className="response-actions"
					aria-label="Response actions"
					onMouseDown={(event) => event.stopPropagation()}
					onClick={(event) => event.stopPropagation()}
				>
					<CopyButton
						text={item.text.replace(/\s*\[DONE:\d+\]\s*/gi, " ")}
						label="Copy response"
						iconOnly
					/>
					{canFork ? (
						<button
							type="button"
							className={forking ? "is-busy" : undefined}
							aria-label="Fork response"
							title={forking ? "Forking response" : "Fork response"}
							disabled={forking}
							onClick={() => onFork(item)}
						>
							<IconFork />
						</button>
					) : null}
				</div>
			)}
		</article>
	);
});
