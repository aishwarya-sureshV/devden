// Docked composer: turn bar, menus, pending asks/approvals, queue, input form.
import type { AccessMode, AgentMode } from "./conversationHelpers";
// Pure view over Conversation's state -- every value arrives as a prop.
import type * as React from "react";
import { ChangesPanel } from "./ChangesPanel";
import { TurnCompleteBar } from "./TurnCompleteBar";
import { turnStats } from "../lib/turnReview";
import { WorkspacePicker, type WorkspacePickerHandle } from "./WorkspacePicker";
import { RouteSetup } from "./RouteSetup";
import { TodoTracker } from "./TodoTracker";
import { AskCard } from "./AskCard";
import {
	api,
	type AgentBackend,
	type WorkspaceMatch,
	type SlashCommand,
	type QueuedMessage,
	type UsageWindow,
	type ProviderUsage,
} from "../lib/api";
import { LimitBanner } from "./LimitBanner";
import { limitScope } from "../lib/usageLimit";
import type { FormEvent } from "react";
import { IconFile, IconPlus, IconStop, IconArrowUp } from "./icons";
import {
	ModelChip,
	ModeChip,
	UsageChip,
	type ModelOption,
} from "./ComposerChrome";
import { usagePair } from "../lib/backendUsage";
import { type ConversationTab, type Attachment } from "../lib/store";
import { type Timeline, type TimelineItem } from "../lib/timeline";
import type { ToolFileView } from "../lib/toolCards";
import type { SessionRoute } from "../lib/route";
import type { TodoTask } from "../lib/todos";

export type ConversationComposerProps = {
	tight: boolean;
	thin: boolean;
	awaitingRoute: boolean;
	tab: ConversationTab;
	streaming: boolean;
	hasItems: boolean;
	workspacePickerRef: React.RefObject<WorkspacePickerHandle | null>;
	setDraft: React.Dispatch<React.SetStateAction<string>>;
	setConversationWorkspace: (key: string, cwd: string) => void;
	timeline: Timeline;
	openWorkspace: (nextTab?: "files" | "changes" | undefined) => void;
	openFileView: (view: ToolFileView) => void;
	sessionPaths: string[];
	lastAssistantId: string | undefined;
	visibleItems: TimelineItem[];
	reviewStarting: AgentBackend | null;
	startTurnReview: (backend: AgentBackend) => Promise<void>;
	split: boolean;
	configuring: boolean;
	configureSession: (
		nextAccess: AccessMode,
		nextMode: AgentMode,
		nextCwd?: string,
	) => Promise<void>;
	accessMode: AccessMode;
	agentMode: AgentMode;
	isolateSession: () => Promise<void>;
	setupChips: React.JSX.Element;
	route: SessionRoute;
	persistRoute: (next: SessionRoute) => void;
	pickRoute: (template: "plan" | "diagnose" | "fix" | "custom") => void;
	setRoutePicking: React.Dispatch<React.SetStateAction<boolean>>;
	editingMessageId: string | null;
	setEditingMessageId: React.Dispatch<React.SetStateAction<string | null>>;
	mentionOpen: boolean;
	mentionMatches: WorkspaceMatch[];
	mentionIndex: number;
	applyMention: (match: WorkspaceMatch) => void;
	slashOpen: boolean;
	slashMatches: SlashCommand[];
	slashIndex: number;
	setCommandMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	todos: TodoTask[];
	compacting: boolean;
	queued: QueuedMessage[];
	limitVisible: boolean;
	canSteer: boolean;
	limitWindow: UsageWindow | undefined;
	resumeFromLimit: () => Promise<void>;
	send: (
		raw: string,
		seedAttachments?: Attachment[] | undefined,
		opts?: { answersAsk?: boolean | undefined } | undefined,
	) => Promise<void>;
	draft: string;
	fileInputRef: React.RefObject<HTMLInputElement | null>;
	uploadFiles: (files: FileList | File[] | null) => Promise<void>;
	attachments: Attachment[];
	setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
	setViewer: React.Dispatch<React.SetStateAction<ToolFileView | null>>;
	setCaret: React.Dispatch<React.SetStateAction<number>>;
	commandMenuOpen: boolean;
	autoGrow: () => void;
	onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	onPasteImage: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	modelMenuRef: React.RefObject<HTMLDivElement | null>;
	modelSearchRef: React.RefObject<HTMLInputElement | null>;
	modelMenuOpen: boolean;
	browseBackend: AgentBackend;
	backendIds: string[];
	currentModelLabel: string;
	effort: string;
	trackLevels: string[];
	effortHover: number | null;
	visibleOptions: ModelOption[];
	modelIndex: number;
	modelQuery: string;
	currentModel: string;
	setUsageOpen: React.Dispatch<React.SetStateAction<boolean>>;
	setModeMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
	setModelMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
	setPickerBackend: React.Dispatch<React.SetStateAction<AgentBackend | null>>;
	setModelQuery: React.Dispatch<React.SetStateAction<string>>;
	setModelIndex: React.Dispatch<React.SetStateAction<number>>;
	pickListedModel: (option: ModelOption) => void;
	setEffort: (level: string) => void;
	setEffortHover: React.Dispatch<React.SetStateAction<number | null>>;
	onModelMenuKey: (event: React.KeyboardEvent<HTMLDivElement>) => void;
	loadModelMetadata: () => void;
	modeMenuRef: React.RefObject<HTMLDivElement | null>;
	modeMenuOpen: boolean;
	switchAgentMode: (nextMode: AgentMode, silent?: boolean) => Promise<void>;
	dismissRoutePick: () => void;
	usagePopRef: React.RefObject<HTMLDivElement | null>;
	usageOpen: boolean;
	providerUsage: ProviderUsage | null;
	backendUsage: Partial<Record<AgentBackend, ProviderUsage>>;
	currentReset: string | undefined;
	agentBusy: boolean;
};

export function ConversationComposer({
	tight,
	thin,
	awaitingRoute,
	tab,
	streaming,
	hasItems,
	workspacePickerRef,
	setDraft,
	setConversationWorkspace,
	timeline,
	openWorkspace,
	openFileView,
	sessionPaths,
	lastAssistantId,
	visibleItems,
	reviewStarting,
	startTurnReview,
	split,
	configuring,
	configureSession,
	accessMode,
	agentMode,
	isolateSession,
	setupChips,
	route,
	persistRoute,
	pickRoute,
	setRoutePicking,
	editingMessageId,
	setEditingMessageId,
	mentionOpen,
	mentionMatches,
	mentionIndex,
	applyMention,
	slashOpen,
	slashMatches,
	slashIndex,
	setCommandMenuOpen,
	textareaRef,
	todos,
	compacting,
	queued,
	limitVisible,
	canSteer,
	limitWindow,
	resumeFromLimit,
	send,
	draft,
	fileInputRef,
	uploadFiles,
	attachments,
	setAttachments,
	setViewer,
	setCaret,
	commandMenuOpen,
	autoGrow,
	onKeyDown,
	onPasteImage,
	modelMenuRef,
	modelSearchRef,
	modelMenuOpen,
	browseBackend,
	backendIds,
	currentModelLabel,
	effort,
	trackLevels,
	effortHover,
	visibleOptions,
	modelIndex,
	modelQuery,
	currentModel,
	setUsageOpen,
	setModeMenuOpen,
	setModelMenuOpen,
	setPickerBackend,
	setModelQuery,
	setModelIndex,
	pickListedModel,
	setEffort,
	setEffortHover,
	onModelMenuKey,
	loadModelMetadata,
	modeMenuRef,
	modeMenuOpen,
	switchAgentMode,
	dismissRoutePick,
	usagePopRef,
	usageOpen,
	providerUsage,
	backendUsage,
	currentReset,
	agentBusy,
}: ConversationComposerProps) {
	return (
		<div
			className={`composer${tight ? " composer--tight" : ""}${thin ? " composer--thin" : ""}${awaitingRoute ? " is-picking-route" : ""}`}
			data-backend={tab.backend}
		>
			{!streaming && hasItems && tab.cwd && (
				<div className="composer__turn-bar">
					<ChangesPanel
						sessionKey={tab.key}
						cwd={tab.cwd}
						streaming={streaming}
						compact={tight}
						onWorkspaceClick={() => workspacePickerRef.current?.openBrowser()}
						onAskAgent={(prompt) =>
							setDraft((current) =>
								current.trim() ? `${current}\n\n${prompt}` : prompt,
							)
						}
						onLeaveWorktree={(mainPath) => {
							setConversationWorkspace(tab.key, mainPath);
							timeline.appendNotice(
								"Worktree deleted — this session is back on the main checkout.",
								"info",
							);
						}}
						onOpenChanges={() => openWorkspace("changes")}
						onOpenDiff={openFileView}
						sessionPaths={sessionPaths}
						sessionPath={tab.sessionPath}
						actions={
							lastAssistantId && (
								<TurnCompleteBar
									backend={tab.backend}
									stats={turnStats(visibleItems)}
									starting={reviewStarting}
									onReview={(backend) => void startTurnReview(backend)}
								/>
							)
						}
					/>
				</div>
			)}
			{/* The changes card clips its overflow, so the workspace picker's modal
        has to be hosted outside it. Kept mounted (and hidden) so the workspace
        row in the changes branch menu has something to open. Split panes host
        the picker as the header folder chip instead. */}
			{hasItems && tab.cwd && !split && (
				<WorkspacePicker
					ref={workspacePickerRef}
					cwd={tab.cwd}
					backend={tab.backend}
					disabled={configuring}
					hideTrigger
					onPick={(path) => configureSession(accessMode, agentMode, path)}
					onIsolate={isolateSession}
					onViewWorkspace={openWorkspace}
				/>
			)}
			{!hasItems && setupChips}
			{agentMode === "routed" && (
				<RouteSetup
					route={route}
					sessionKey={tab.key}
					sessionBackend={tab.backend}
					picking={awaitingRoute}
					onChange={(next) => persistRoute({ ...next, enabled: true })}
					onPick={pickRoute}
					onChangeRoute={() => setRoutePicking(true)}
				/>
			)}
			{editingMessageId !== null && (
				<div className="composer__editing" role="status">
					<span>Editing message — press Enter to resend, Esc to cancel</span>
					<button
						type="button"
						onClick={() => {
							setEditingMessageId(null);
							setDraft("");
						}}
					>
						Cancel
					</button>
				</div>
			)}
			{mentionOpen && (
				<div className="slash-menu mention-menu">
					{mentionMatches.map((match, index) => (
						<button
							key={match.path}
							type="button"
							className={`slash-menu__item${index === mentionIndex ? " is-active" : ""}`}
							onMouseDown={(event) => {
								event.preventDefault();
								applyMention(match);
							}}
						>
							<code>{match.name}</code>
							<span>{match.relativePath}</span>
						</button>
					))}
				</div>
			)}
			{slashOpen && slashMatches.length > 0 && (
				<div className="slash-menu">
					{slashMatches.map((command, index) => (
						<button
							key={command.name}
							type="button"
							className={`slash-menu__item${index === slashIndex ? " is-active" : ""}`}
							onMouseDown={(e) => {
								e.preventDefault();
								setDraft(`/${command.name} `);
								setCommandMenuOpen(false);
								textareaRef.current?.focus();
							}}
						>
							<code>/{command.name}</code>
							<span>{command.description ?? ""}</span>
							<em>{command.source ?? "pi"}</em>
						</button>
					))}
				</div>
			)}
			{streaming && todos.length > 0 && <TodoTracker tasks={todos} />}
			{timeline.pendingUserInputs.map((request) => (
				<AskCard
					key={request.requestId}
					questions={request.questions}
					onAnswer={async (_text, answers) => {
						const result = await api.answer(
							tab.key,
							request.requestId,
							Object.fromEntries(
								request.questions.map((question, index) => [
									question.id,
									{ answers: answers[index] ?? [] },
								]),
							),
						);
						if (!result.ok)
							throw new Error(result.error ?? "Could not send answers");
					}}
					onDismiss={() => {
						void api.answer(tab.key, request.requestId, {});
					}}
				/>
			))}
			{timeline.pendingApprovals.map((approval) => (
				<div
					className="approval-card"
					key={approval.requestId}
					role="alertdialog"
					aria-label={`Approve ${approval.toolName}`}
				>
					<div className="approval-card__head">
						<span className="approval-card__badge">Approval needed</span>
						<strong>{approval.toolName}</strong>
					</div>
					{approval.detail && (
						<pre className="approval-card__detail">{approval.detail}</pre>
					)}
					<div className="approval-card__options" role="group">
						{approval.options.map((option) => (
							<button
								key={option.id}
								type="button"
								className={
									option.id === "deny" || option.id === "reject_once"
										? "is-danger"
										: undefined
								}
								onClick={() =>
									void api
										.approve(
											tab.key,
											approval.requestId,
											option.id,
											tab.backend,
										)
										.then((result) => {
											if (!result.ok)
												timeline.appendNotice(
													result.error ?? "Could not send approval",
													"error",
												);
										})
								}
							>
								{option.label}
							</button>
						))}
					</div>
				</div>
			))}
			{compacting && (
				<div className="compacting-strip" role="status" aria-live="polite">
					<p className="compacting-strip__hint">
						Compacting the conversation — summarizing older history for the
						model…
					</p>
					<div className="compacting-strip__bar" aria-hidden="true">
						<span className="compacting-strip__fill" />
					</div>
				</div>
			)}
			{queued.length > 0 && (
				<div className="queue-strip" aria-label="Queued messages">
					<p className="queue-strip__hint">
						<span>
							{/* After an interrupt the queue outlives the turn it was
                waiting on: nothing is running, and these are held until
                the user sends them. Saying "waiting for this turn to
                finish" there reads as a hang. A usage-limit wall is the
                opposite: the turn did not finish, so the queue stays. */}
							{limitVisible
								? "Waiting for the cut-off turn to finish."
								: streaming
									? canSteer
										? "Waiting for this turn to finish."
										: "Waiting for this turn to finish — this agent cannot take a message mid-turn."
									: "Queued — nothing is running. These are not sent yet."}
						</span>
						{/* Mid-turn this is steering, which not every agent can do.
              Idle it is just "send it now", which all of them can — and
              without it an interrupted grok queue has no way out.
              While the limit banner is up, sending now would start a new
              prompt and Resume would follow that instead of the cut-off turn. */}
						{!limitVisible && (canSteer || !streaming) && (
							<button
								type="button"
								className="queue-strip__steer"
								title={
									streaming
										? "Send this into the turn that is already running"
										: "Send this now"
								}
								onClick={() => {
									const item = queued[0];
									if (!item) return;
									void api.steerQueued(tab.key, item.id).then((result) => {
										if (!result.ok)
											timeline.appendNotice(
												result.error ?? "Could not steer",
												"error",
											);
									});
								}}
							>
								{streaming ? "Steer now" : "Send now"}
							</button>
						)}
						{queued.length > 1 && (
							<button
								type="button"
								className="queue-strip__clear"
								title="Drop every queued message"
								onClick={() => {
									void api.cancelQueued(tab.key).then((result) => {
										if (!result.ok)
											timeline.appendNotice(
												result.error ?? "Could not clear the queue",
												"error",
											);
									});
								}}
							>
								Clear all
							</button>
						)}
					</p>
					{queued.map((item, index) => (
						<div key={item.id} className="queue-chip">
							<span className="queue-chip__index">{index + 1}</span>
							<span className="queue-chip__text">{item.message}</span>
							<button
								type="button"
								aria-label="Remove from queue"
								title="Remove from queue"
								onClick={() => {
									void api.cancelQueued(tab.key, item.id).then((result) => {
										if (!result.ok)
											timeline.appendNotice(
												result.error ?? "Could not remove that message",
												"error",
											);
									});
								}}
							>
								×
							</button>
						</div>
					))}
				</div>
			)}
			{limitVisible && (
				<LimitBanner
					scope={limitScope(limitWindow?.label ?? "")}
					label={limitWindow?.label}
					resetsAt={limitWindow?.resetsAt}
					busy={streaming}
					onResume={() => void resumeFromLimit()}
				/>
			)}
			<form
				className={`composer__card${awaitingRoute ? " is-awaiting-route" : ""}`}
				onSubmit={(e: FormEvent) => {
					e.preventDefault();
					void send(draft);
				}}
			>
				<input
					ref={fileInputRef}
					className="composer__file-input"
					type="file"
					multiple
					onChange={(event) => {
						void uploadFiles(event.target.files);
						event.target.value = "";
					}}
				/>
				{attachments.length > 0 && (
					<div className="composer__attachments" aria-label="Attached files">
						{attachments.map((attachment) => {
							const removeAttachment = () =>
								setAttachments((current) =>
									current.filter((candidate) => candidate.id !== attachment.id),
								);
							if (attachment.imageData) {
								const src = `data:${attachment.mimeType};base64,${attachment.imageData}`;
								return (
									<span
										className="attachment-chip attachment-chip--image"
										key={attachment.id}
										title={attachment.path}
									>
										<button
											type="button"
											className="attachment-chip__preview"
											aria-label={`Preview ${attachment.name}`}
											onClick={() =>
												setViewer({ title: attachment.name, imageSrc: src })
											}
										>
											<img src={src} alt="" />
											<span>{attachment.name}</span>
										</button>
										<button
											type="button"
											aria-label={`Remove ${attachment.name}`}
											onClick={removeAttachment}
										>
											×
										</button>
									</span>
								);
							}
							return (
								<span
									className="attachment-chip"
									key={attachment.id}
									title={attachment.path}
								>
									<IconFile size={14} />
									<span>{attachment.name}</span>
									<button
										type="button"
										aria-label={`Remove ${attachment.name}`}
										onClick={removeAttachment}
									>
										×
									</button>
								</span>
							);
						})}
					</div>
				)}
				<div className="composer__top">
					<div className="composer__scroll">
						<textarea
							ref={textareaRef}
							className="composer__textarea"
							rows={2}
							disabled={awaitingRoute}
							placeholder={
								awaitingRoute
									? "Pick a route above"
									: editingMessageId === null
										? hasItems
											? streaming
												? tight
													? "Reply…"
													: "Reply, or queue the next step…"
												: "Describe what you want next…"
											: "Describe what you want to build"
										: "Edit your message…"
							}
							value={draft}
							onChange={(e) => {
								setDraft(e.target.value);
								setCaret(e.target.selectionStart ?? e.target.value.length);
								if (commandMenuOpen) setCommandMenuOpen(false);
								autoGrow();
							}}
							onSelect={(e) =>
								setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)
							}
							onKeyDown={onKeyDown}
							onPaste={onPasteImage}
						/>
					</div>
				</div>
				<div className="composer__row">
					<div className="composer__tools">
						<button
							type="button"
							className="composer__add"
							aria-label="Attach files"
							title="Attach files (20 MB max)"
							onClick={() => fileInputRef.current?.click()}
						>
							<IconPlus />
						</button>
						<ModelChip
							menuRef={modelMenuRef}
							searchRef={modelSearchRef}
							open={modelMenuOpen}
							split={split}
							disabled={configuring || streaming}
							backend={tab.backend}
							browseBackend={browseBackend}
							backends={backendIds}
							modelLabel={currentModelLabel}
							effort={effort}
							levels={trackLevels}
							effortHover={effortHover}
							options={visibleOptions}
							highlight={modelIndex}
							query={modelQuery}
							currentModel={currentModel}
							onToggle={() => {
								setUsageOpen(false);
								setModeMenuOpen(false);
								setModelMenuOpen((open) => {
									if (!open) setPickerBackend(tab.backend);
									return !open;
								});
							}}
							onQuery={(value) => {
								setModelQuery(value);
								setModelIndex(0);
							}}
							onHighlight={setModelIndex}
							onBrowse={(backend) => {
								setPickerBackend(backend);
								setModelQuery("");
								setModelIndex(0);
							}}
							onPick={pickListedModel}
							onEffort={setEffort}
							onEffortHover={setEffortHover}
							onKeyDown={onModelMenuKey}
							onWarm={loadModelMetadata}
						/>
						<ModeChip
							menuRef={modeMenuRef}
							open={modeMenuOpen}
							split={split}
							disabled={configuring || streaming}
							mode={agentMode}
							readOnly={accessMode === "read-only"}
							onToggle={() => {
								setModelMenuOpen(false);
								setUsageOpen(false);
								setModeMenuOpen((open) => !open);
							}}
							onPick={(id) => {
								setModeMenuOpen(false);
								if (accessMode === "read-only") {
									void configureSession("workspace-write", id);
									return;
								}
								void switchAgentMode(id);
							}}
						/>
						{agentMode === "routed" && (
							<button
								type="button"
								className={`composer__route-chip${awaitingRoute ? " is-open" : ""}`}
								aria-haspopup="menu"
								aria-expanded={awaitingRoute}
								disabled={configuring || streaming}
								onClick={() =>
									awaitingRoute ? dismissRoutePick() : setRoutePicking(true)
								}
							>
								{awaitingRoute ? "esc" : "/ route"}
							</button>
						)}
					</div>
					<div className="composer__trailing">
						<UsageChip
							popRef={usagePopRef}
							open={usageOpen}
							split={split}
							hour={usagePair(providerUsage ?? undefined).hour}
							week={usagePair(providerUsage ?? undefined).week}
							current={tab.backend}
							usage={backendUsage}
							reset={currentReset}
							onToggle={() => {
								setModelMenuOpen(false);
								setModeMenuOpen(false);
								setUsageOpen((open) => !open);
							}}
						/>
						<span className="composer__rule" aria-hidden="true" />
						{agentBusy ? (
							<button
								type="button"
								className="composer__primary is-stop"
								aria-label="Stop"
								onClick={() => void api.abort(tab.key)}
							>
								<IconStop />
							</button>
						) : (
							<button
								type="submit"
								className="composer__primary"
								aria-label="Send"
								title={"Send"}
								disabled={
									awaitingRoute || (!draft.trim() && attachments.length === 0)
								}
							>
								<IconArrowUp />
							</button>
						)}
					</div>
				</div>
			</form>
		</div>
	);
}
