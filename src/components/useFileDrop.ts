// File input surfaces for Conversation: scroll pinning, drag-and-drop (pane and
// whole window), pasted images.
import type * as React from "react";
import {
  uploadFiles as uploadFilesImpl,
  onDragLeave as onDragLeaveImpl,
  onDrop as onDropImpl,
  onPasteImage as onPasteImageImpl,
} from "./conversationInput";
import {
  type DragEvent,
  type ClipboardEvent,
  useRef,
  useLayoutEffect,
} from "react";
import type { Timeline } from "../lib/timeline";
import type { ConversationTab, Attachment } from "../lib/store";

export type UseFileDropArgs = {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  stickToBottom: React.RefObject<boolean>;
  timeline: Timeline;
  tab: ConversationTab;
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  dragCounterRef: React.RefObject<number>;
  setDragActive: React.Dispatch<React.SetStateAction<boolean>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
};

export function useFileDrop({
  scrollRef,
  stickToBottom,
  timeline,
  tab,
  setAttachments,
  dragCounterRef,
  setDragActive,
  textareaRef,
}: UseFileDropArgs) {
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const uploadFiles = (files: FileList | File[] | null) =>
    uploadFilesImpl({ timeline, tab, setAttachments }, files);

  const dragHasFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = (event: DragEvent) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragCounterRef.current += 1;
    setDragActive(true);
  };

  const onDragOver = (event: DragEvent) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (event: DragEvent) =>
    onDragLeaveImpl({ dragCounterRef, setDragActive }, event);

  const onDrop = (event: DragEvent) =>
    onDropImpl(
      { dragHasFiles, dragCounterRef, setDragActive, uploadFiles, textareaRef },
      event,
    );

  const onPasteImage = (event: ClipboardEvent<HTMLTextAreaElement>) =>
    onPasteImageImpl({ uploadFiles }, event);

  // Keep the document-level drop catcher pointed at the latest upload closure.
  const uploadFilesRef = useRef(uploadFiles);
  useLayoutEffect(() => {
    uploadFilesRef.current = uploadFiles;
  });

  return {
    uploadFilesRef,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    uploadFiles,
    onPasteImage,
    onScroll,
  };
}
