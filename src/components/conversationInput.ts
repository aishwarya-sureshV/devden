// Composer input handling for Conversation: keyboard shortcuts, @-mentions,
// file upload, drag-and-drop and pasted images.
import type * as React from "react";
import type { KeyboardEvent, DragEvent, ClipboardEvent } from "react";
import {
  DESIGN_MODES,
  fileAsBase64,
  type AgentMode,
} from "./conversationHelpers";
import { type WorkspaceMatch, api, type SlashCommand } from "../lib/api";
import type { Attachment, ConversationTab } from "../lib/store";
import type { Timeline } from "../lib/timeline";

export type OnKeyDownCtx = {
  mentionOpen: boolean;
  slashOpen: boolean;
  agentMode: AgentMode;
  switchAgentMode: (nextMode: AgentMode, silent?: boolean) => Promise<void>;
  streaming: boolean;
  draft: string;
  steerOnceRef: React.RefObject<boolean>;
  canSteer: boolean;
  send: (
    raw: string,
    seedAttachments?: Attachment[] | undefined,
    opts?: { answersAsk?: boolean | undefined } | undefined,
  ) => Promise<void>;
  setMentionIndex: React.Dispatch<React.SetStateAction<number>>;
  mentionMatches: WorkspaceMatch[];
  applyMention: (match: WorkspaceMatch) => void;
  mentionIndex: number;
  setMentionMatches: React.Dispatch<React.SetStateAction<WorkspaceMatch[]>>;
  slashMatches: SlashCommand[];
  setSlashIndex: React.Dispatch<React.SetStateAction<number>>;
  slashFilter: string | null;
  slashIndex: number;
  setCommandMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  editingMessageId: string | null;
  setEditingMessageId: React.Dispatch<React.SetStateAction<string | null>>;
};

export function onKeyDown(
  ctx: OnKeyDownCtx,
  event: KeyboardEvent<HTMLTextAreaElement>,
) {
  const {
    mentionOpen,
    slashOpen,
    agentMode,
    switchAgentMode,
    streaming,
    draft,
    steerOnceRef,
    canSteer,
    send,
    setMentionIndex,
    mentionMatches,
    applyMention,
    mentionIndex,
    setMentionMatches,
    slashMatches,
    setSlashIndex,
    slashFilter,
    slashIndex,
    setCommandMenuOpen,
    setDraft,
    editingMessageId,
    setEditingMessageId,
  } = ctx;
  if (event.key === "Tab" && event.shiftKey && !mentionOpen && !slashOpen) {
    event.preventDefault();
    const index = DESIGN_MODES.indexOf(agentMode);
    const next = DESIGN_MODES[(index + 1) % DESIGN_MODES.length] ?? "manual";
    void switchAgentMode(next);
    return;
  }
  // Steer the running turn, whatever the mid-turn default is.
  if (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    streaming &&
    draft.trim()
  ) {
    event.preventDefault();
    steerOnceRef.current = canSteer;
    void send(draft);
    return;
  }
  if (mentionOpen) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionIndex((i) => (i + 1) % mentionMatches.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionIndex(
        (i) => (i - 1 + mentionMatches.length) % mentionMatches.length,
      );
      return;
    }
    if (event.key === "Tab" || event.key === "Enter") {
      event.preventDefault();
      applyMention(
        mentionMatches[Math.min(mentionIndex, mentionMatches.length - 1)],
      );
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setMentionMatches([]);
      return;
    }
  }
  if (slashOpen && slashMatches.length > 0) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSlashIndex((i) => (i + 1) % slashMatches.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
      return;
    }
    if (
      event.key === "Tab" ||
      (event.key === "Enter" && slashFilter !== null && draft.length > 1)
    ) {
      event.preventDefault();
      const picked =
        slashMatches[Math.min(slashIndex, slashMatches.length - 1)];
      setCommandMenuOpen(false);
      if (!picked) return;
      // Enter and Tab both insert the command into the draft, same as
      // clicking it: the trailing space closes the menu and keeps the
      // composer open so arguments can follow. The next Enter sends.
      setDraft(`/${picked.name} `);
      return;
    }
    if (event.key === "Escape") {
      setCommandMenuOpen(false);
      return;
    }
  }
  if (event.key === "Escape" && editingMessageId !== null) {
    event.preventDefault();
    setEditingMessageId(null);
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void send(draft);
  }
}

export type ApplyMentionCtx = {
  draft: string;
  caret: number;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setMentionMatches: React.Dispatch<React.SetStateAction<WorkspaceMatch[]>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setCaret: React.Dispatch<React.SetStateAction<number>>;
  autoGrow: () => void;
};

/** Swap the "@token" under the caret for the picked path. */
export function applyMention(ctx: ApplyMentionCtx, match: WorkspaceMatch) {
  const {
    draft,
    caret,
    setDraft,
    setMentionMatches,
    textareaRef,
    setCaret,
    autoGrow,
  } = ctx;
  const before = draft.slice(0, caret);
  const start = before.search(/(?:^|\s)@[^\s@]*$/);
  const at = before.indexOf("@", start === -1 ? 0 : start);
  if (at === -1) return;
  const next = `${draft.slice(0, at)}@${match.relativePath} ${draft.slice(caret)}`;
  setDraft(next);
  setMentionMatches([]);
  const caretAfter = at + match.relativePath.length + 2;
  window.setTimeout(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(caretAfter, caretAfter);
    setCaret(caretAfter);
    autoGrow();
  }, 0);
}

export type UploadFilesCtx = {
  timeline: Timeline;
  tab: ConversationTab;
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
};

export async function uploadFiles(
  ctx: UploadFilesCtx,
  files: FileList | File[] | null,
) {
  const { timeline, tab, setAttachments } = ctx;
  if (!files?.length) return;
  for (const file of Array.from(files)) {
    if (file.size > 20 * 1024 * 1024) {
      timeline.appendNotice(
        `${file.name} is larger than the 20 MB upload limit.`,
        "error",
      );
      continue;
    }
    try {
      const data = await fileAsBase64(file);
      const result = await api.upload(
        tab.key,
        file.name,
        file.type || "application/octet-stream",
        data,
      );
      if (!result.ok || !result.path) {
        timeline.appendNotice(
          result.error ?? `Could not upload ${file.name}`,
          "error",
        );
        continue;
      }
      setAttachments((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          path: result.path!,
          ...(file.type.startsWith("image/") ? { imageData: data } : {}),
        },
      ]);
    } catch (error) {
      timeline.appendNotice(
        error instanceof Error
          ? error.message
          : `Could not upload ${file.name}`,
        "error",
      );
    }
  }
}

export type OnDragLeaveCtx = {
  dragCounterRef: React.RefObject<number>;
  setDragActive: React.Dispatch<React.SetStateAction<boolean>>;
};

export function onDragLeave(ctx: OnDragLeaveCtx, event: DragEvent) {
  const { dragCounterRef, setDragActive } = ctx;
  dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
  // relatedTarget is null only when the drag leaves the window/DOM entirely —
  // reset fully so a cancelled drag can never leave the overlay stuck on.
  if (dragCounterRef.current === 0 || event.relatedTarget === null) {
    dragCounterRef.current = 0;
    setDragActive(false);
  }
}

export type OnDropCtx = {
  dragHasFiles: (event: React.DragEvent<Element>) => boolean;
  dragCounterRef: React.RefObject<number>;
  setDragActive: React.Dispatch<React.SetStateAction<boolean>>;
  uploadFiles: (files: FileList | File[] | null) => Promise<void>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
};

export function onDrop(ctx: OnDropCtx, event: DragEvent) {
  const {
    dragHasFiles,
    dragCounterRef,
    setDragActive,
    uploadFiles,
    textareaRef,
  } = ctx;
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  dragCounterRef.current = 0;
  setDragActive(false);
  void uploadFiles(event.dataTransfer?.files ?? null);
  textareaRef.current?.focus();
}

export type OnPasteImageCtx = {
  uploadFiles: (files: FileList | File[] | null) => Promise<void>;
};

export function onPasteImage(
  ctx: OnPasteImageCtx,
  event: ClipboardEvent<HTMLTextAreaElement>,
) {
  const { uploadFiles } = ctx;
  const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
    file.type.startsWith("image/"),
  );
  if (files.length === 0) return;
  event.preventDefault();
  // macOS screenshots copied to the clipboard arrive unnamed; give them a
  // recognizable, sortable name before they hit the upload path.
  const stamp = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const base = `screenshot-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  const named = files.map((file, index) => {
    const extension = file.type.split("/")[1] ?? "png";
    const suffix = files.length > 1 ? `-${index + 1}` : "";
    return file.name && file.name !== "image.png"
      ? file
      : new File([file], `${base}${suffix}.${extension}`, {
          type: file.type,
        });
  });
  void uploadFiles(named);
}
