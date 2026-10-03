// Session header and split-pane chrome for Conversation, including inline
// title renaming.
import type * as React from "react";
import {
  api,
  type SessionState,
  type RunStatus,
} from "../lib/api";
import {
  SessionHeader, SessionTab,
  displayPath,
  type SessionTone,
  type SessionView,
  type PaneTone,
} from "./SessionHeader";
import { createPortal } from "react-dom";
import type { ConversationTab } from "../lib/store";
import type { TimelineItem } from "../lib/timeline";

export type UseSessionChromeArgs = {
  tab: ConversationTab;
  tabHost: HTMLElement | null;
  contextPercent: number | null;
  configuring: boolean;
  onPickWorkspace: (path: string) => Promise<void>;
  setSessionDetailsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  firstUserItem: TimelineItem | undefined;
  setRenameDraft: React.Dispatch<React.SetStateAction<string>>;
  state: SessionState | null;
  setRenaming: React.Dispatch<React.SetStateAction<boolean>>;
  renameDraft: string;
  displayTitle: string;
  split: boolean;
  sessionCount: number;
  onBack: (() => void) | undefined;
  renaming: boolean;
  sessionDetailsOpen: boolean;
  statusLabel: string;
  statusTone: SessionTone;
  branchLabel: string | null;
  contextLabel: string;
  usageLabel: string;
  conversationView: SessionView;
  setConversationView: React.Dispatch<React.SetStateAction<SessionView>>;
  terminalOpen: boolean;
  onTerminalToggle: (() => void) | undefined;
  workspaceShown: boolean;
  workspaceButton: () => void;
  boardOpen: boolean;
  onBoardToggle?: () => void;
  setBoardOpen: React.Dispatch<React.SetStateAction<boolean>>;
  focused: boolean;
  headerHost: HTMLElement | null;
  status: RunStatus;
  paneTone: PaneTone;
  running: boolean;
  onFocus: (() => void) | undefined;
  onClose: (() => void) | undefined;
  currentModelLabel?: string;
  effort?: string | null;
};

export function useSessionChrome({ tabHost, contextPercent, configuring, onPickWorkspace,
  tab,
  setSessionDetailsOpen,
  firstUserItem,
  setRenameDraft,
  state,
  setRenaming,
  renameDraft,
  displayTitle,
  split,
  sessionCount,
  onBack,
  renaming,
  sessionDetailsOpen,
  statusLabel,
  statusTone,
  branchLabel,
  contextLabel,
  usageLabel,
  conversationView,
  setConversationView,
  terminalOpen,
  onTerminalToggle,
  workspaceShown,
  workspaceButton,
  boardOpen,
  setBoardOpen,
  onBoardToggle,
  focused,
  headerHost,
  status,
  paneTone,
  running,
  onFocus,
  onClose,
  currentModelLabel,
  effort,
}: UseSessionChromeArgs) {
  const startRename = () => {
    setSessionDetailsOpen(false);
    const fallback = firstUserItem?.kind === "user" ? firstUserItem.text : "";
    setRenameDraft(state?.sessionName?.trim() || fallback.slice(0, 200));
    setRenaming(true);
  };
  const finishRename = () => {
    setRenaming(false);
    const title = renameDraft.trim();
    if (!title || title === displayTitle) return;
    void api.rename(tab.key, title).then((result) => {
      if (!result.ok && result.error)
        window.alert(`Rename failed: ${result.error}`);
    });
  };
  const sessionHeader = (
    <SessionHeader
      multi={split && sessionCount > 1}
      onBack={onBack}
      title={displayTitle}
      renaming={renaming}
      renameDraft={renameDraft}
      onRenameDraft={setRenameDraft}
      onFinishRename={finishRename}
      onCancelRename={() => setRenaming(false)}
      // Split panes own the dropdown; the toolbar copy must not also listen
      // for outside clicks or it would shut the pane's popover.
      detailsOpen={!(split && sessionCount > 1) && sessionDetailsOpen}
      onDetailsOpen={setSessionDetailsOpen}
      statusLabel={statusLabel}
      statusTone={statusTone}
      pathLabel={displayPath(tab.cwd)}
      branchLabel={branchLabel}
      contextLabel={contextLabel}
      usageLabel={usageLabel}
      sessionId={state?.sessionId}
      onCopyId={() =>
        navigator.clipboard.writeText(state?.sessionId || tab.key)
      }
      logUrl={
        state?.sessionFile ? api.sessionLogUrl(state.sessionFile) : undefined
      }
      view={conversationView}
      onView={setConversationView}
      terminalOpen={terminalOpen}
      onTerminalToggle={onTerminalToggle}
      workspaceOpen={workspaceShown}
      onWorkspaceToggle={tab.cwd ? workspaceButton : undefined}
      boardOpen={boardOpen}
      onBoardToggle={tab.cwd ? onBoardToggle ?? (() => setBoardOpen((open) => !open)) : undefined}
      deployCwd={tab.cwd || undefined}
      modelLabel={currentModelLabel}
      effort={effort}
      backend={tab.backend}
    />
  );
  const sessionChrome = (
    <>
      {focused && headerHost
        ? createPortal(sessionHeader, headerHost)
        : null}
      {/* Split panes carry no title row: the drag grip and ⋯ menu float over them. */}
      {!headerHost ? sessionHeader : null}
      {tabHost && createPortal(<SessionTab active={focused} sessionKey={tab.key} title={displayTitle} cwd={tab.cwd} backend={tab.backend} open={sessionDetailsOpen} onOpen={setSessionDetailsOpen} contextPercent={contextPercent} disabled={configuring} onPickWorkspace={onPickWorkspace} details={{ title: displayTitle, statusLabel, statusTone, pathLabel: displayPath(tab.cwd), branchLabel, contextLabel, usageLabel, sessionId: state?.sessionId, onCopyId: () => navigator.clipboard.writeText(state?.sessionId || tab.key), logUrl: state?.sessionFile ? api.sessionLogUrl(state.sessionFile) : undefined, modelLabel: currentModelLabel, effortText: effort || undefined, view: conversationView, onView: setConversationView }} />, tabHost)}
    </>
  );

  return {
    sessionChrome,
  };
}
