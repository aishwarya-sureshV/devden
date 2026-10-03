// Workspace explorer pane for Conversation: open/close/toggle, placement, and
// following the shared split-view pane.
import type * as React from "react";
import { useCallback, useEffect } from "react";
import type { WorkspacePlacement } from "./WorkspaceExplorer";
import type { ConversationTab } from "../lib/store";

export type UseWorkspacePaneArgs = {
  setWorkspaceTab: React.Dispatch<React.SetStateAction<"files" | "changes">>;
  setWorkspaceMounted: React.Dispatch<React.SetStateAction<boolean>>;
  setWorkspaceOpen: React.Dispatch<React.SetStateAction<boolean>>;
  workspaceReveal: { key: string; nonce: number } | null;
  tab: ConversationTab;
  setWorkspacePlacement: React.Dispatch<
    React.SetStateAction<WorkspacePlacement>
  >;
  split: boolean;
  onSharedWorkspaceToggle: (() => void) | undefined;
  onSharedWorkspaceOpen?: (tab?: "files" | "changes") => void;
  sharedWorkspaceOpen: boolean;
  workspaceOpen: boolean;
  draft: string;
  commandMenuOpen: boolean;
  loadCommands: () => void;
};

export function useWorkspacePane({
  setWorkspaceTab,
  setWorkspaceMounted,
  setWorkspaceOpen,
  workspaceReveal,
  tab,
  setWorkspacePlacement,
  split,
  onSharedWorkspaceToggle,
  onSharedWorkspaceOpen,
  sharedWorkspaceOpen,
  workspaceOpen,
  draft,
  commandMenuOpen,
  loadCommands,
}: UseWorkspacePaneArgs) {
  const openWorkspace = useCallback((nextTab?: "files" | "changes") => {
    if (onSharedWorkspaceOpen) { onSharedWorkspaceOpen(nextTab); return; }
    if (nextTab) setWorkspaceTab(nextTab);
    setWorkspaceMounted(true);
    setWorkspaceOpen(true);
  }, [onSharedWorkspaceOpen]);

  useEffect(() => {
    if (workspaceReveal?.key === tab.key) openWorkspace();
  }, [openWorkspace, tab.key, workspaceReveal]);

  const chooseWorkspacePlacement = useCallback(
    (next: WorkspacePlacement) => {
      setWorkspacePlacement(next);
      openWorkspace();
    },
    [openWorkspace],
  );

  const closeWorkspace = useCallback(() => setWorkspaceOpen(false), []);

  // A session opening beside this one halves the pane; a docked explorer
  // would crush the chat. Close it — the toggle reopens it as usual.
  useEffect(() => {
    if (split) setWorkspaceOpen(false);
  }, [split]);

  const toggleWorkspace = () => {
    setWorkspaceOpen((open) => {
      if (!open) setWorkspaceMounted(true);
      return !open;
    });
  };
  // In a split the workspace buttons drive the grid's shared right pane.
  const workspaceShown = onSharedWorkspaceToggle
    ? sharedWorkspaceOpen
    : workspaceOpen;
  const workspaceButton = onSharedWorkspaceToggle ?? toggleWorkspace;

  useEffect(() => {
    if (draft.startsWith("/") || commandMenuOpen) loadCommands();
  }, [commandMenuOpen, draft, loadCommands]);

  return {
    openWorkspace,
    workspaceShown,
    workspaceButton,
    chooseWorkspacePlacement,
    closeWorkspace,
  };
}
