// Side panels for Conversation: workspace explorer (with add-to-chat), board
// and selection tools.
import type * as React from "react";
import { useCallback } from "react";
import {
  WorkspaceExplorer,
  type WorkspacePlacement,
} from "./WorkspaceExplorer";
import { BoardPanel } from "./BoardPanel";
import { SelectionTools } from "./SelectionTools";
import type { ConversationTab, Attachment } from "../lib/store";

export type UseConversationPanelsArgs = {
  chooseWorkspacePlacement: (next: WorkspacePlacement) => void;
  tab: ConversationTab;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  workspaceMounted: boolean;
  workspaceOpen: boolean;
  workspacePlacement: WorkspacePlacement;
  workspaceTab: "files" | "changes";
  setWorkspaceTab: React.Dispatch<React.SetStateAction<"files" | "changes">>;
  closeWorkspace: () => void;
  boardOpen: boolean;
  setBoardOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

export function useConversationPanels({
  chooseWorkspacePlacement,
  tab,
  setDraft,
  setAttachments,
  textareaRef,
  workspaceMounted,
  workspaceOpen,
  workspacePlacement,
  workspaceTab,
  setWorkspaceTab,
  closeWorkspace,
  boardOpen,
  setBoardOpen,
}: UseConversationPanelsArgs) {
  const addWorkspacePathToChat = useCallback(
    (path: string) => {
      chooseWorkspacePlacement("side");
      const insertion = path.startsWith(`${tab.cwd}/`)
        ? path.slice(tab.cwd.length + 1)
        : path;
      setDraft((current) => {
        if (!current.trim()) return insertion;
        return current.endsWith("\n")
          ? `${current}${insertion}`
          : `${current}\n${insertion}`;
      });
      const name = path.split("/").filter(Boolean).at(-1) ?? path;
      setAttachments((current) =>
        current.some((item) => item.path === path)
          ? current
          : [
              ...current,
              {
                id: crypto.randomUUID(),
                name,
                mimeType: "text/plain",
                size: 0,
                path,
              },
            ],
      );
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    },
    [tab.cwd],
  );

  const workspaceExplorer = workspaceMounted ? (
    <WorkspaceExplorer
      key={tab.cwd}
      sessionKey={tab.key}
      root={tab.cwd}
      visible={workspaceOpen}
      placement={workspacePlacement}
      tab={workspaceTab}
      onTabChange={setWorkspaceTab}
      onPlacementChange={chooseWorkspacePlacement}
      onClose={closeWorkspace}
      onAddToChat={addWorkspacePathToChat}
    />
  ) : null;

  // Remounts per workspace: the board seeds from localStorage on mount only.
  const boardPanel =
    boardOpen && tab.cwd ? (
      <BoardPanel
        key={tab.cwd}
        cwd={tab.cwd}
        sessionPath={tab.sessionPath}
        onClose={() => setBoardOpen(false)}
      />
    ) : null;

  const selectionTools = tab.cwd ? (
    <SelectionTools cwd={tab.cwd} sessionPath={tab.sessionPath} />
  ) : null;

  return {
    workspaceExplorer,
    boardPanel,
    selectionTools,
  };
}
