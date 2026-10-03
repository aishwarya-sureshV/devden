// Composer surroundings for Conversation: setup chips, drop zone + overlay,
// and the route picker overlay.
import type * as React from "react";
import { WorkspacePicker, type WorkspacePickerHandle } from "./WorkspacePicker";
import { IconCode, IconUpload } from "./icons";
import {
  type RouteTemplate,
  applyTemplate,
  type SessionRoute,
} from "../lib/route";
import type { ConversationTab } from "../lib/store";
import type { AccessMode, AgentMode } from "./conversationHelpers";

export type UseComposerOverlaysArgs = {
  thin: boolean;
  narrow: boolean;
  hasItems: boolean;
  workspacePickerRef: React.RefObject<WorkspacePickerHandle | null>;
  tab: ConversationTab;
  configuring: boolean;
  configureSession: (
    nextAccess: AccessMode,
    nextMode: AgentMode,
    nextCwd?: string,
  ) => Promise<void>;
  accessMode: AccessMode;
  agentMode: AgentMode;
  isolateSession: () => Promise<void>;
  openWorkspace: (nextTab?: "files" | "changes" | undefined) => void;
  split: boolean;
  workspaceShown: boolean;
  workspaceButton: () => void;
  onDragEnter: (event: React.DragEvent<Element>) => void;
  onDragOver: (event: React.DragEvent<Element>) => void;
  onDragLeave: (event: React.DragEvent<Element>) => void;
  onDrop: (event: React.DragEvent<Element>) => void;
  dragActive: boolean;
  route: SessionRoute;
  persistRoute: (next: SessionRoute) => void;
  setRoutePicking: React.Dispatch<React.SetStateAction<boolean>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
};

export function useComposerOverlays({
  thin,
  narrow,
  hasItems,
  workspacePickerRef,
  tab,
  configuring,
  configureSession,
  accessMode,
  agentMode,
  isolateSession,
  openWorkspace,
  split,
  workspaceShown,
  workspaceButton,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  dragActive,
  route,
  persistRoute,
  setRoutePicking,
  textareaRef,
}: UseComposerOverlaysArgs) {
  const tight = thin || narrow;

  const setupChips = (
    <div className="composer__setup">
      <div className="hero__chips">
        <WorkspacePicker
          ref={hasItems ? undefined : workspacePickerRef}
          cwd={tab.cwd}
          backend={tab.backend}
          disabled={configuring}
          onPick={(path) => configureSession(accessMode, agentMode, path)}
          onIsolate={isolateSession}
          onViewWorkspace={openWorkspace}
        />
        {!split && (
          <button
            type="button"
            className={`workspace-picker__trigger${workspaceShown ? " is-active" : ""}`}
            aria-pressed={workspaceShown}
            title={tab.cwd}
            onClick={workspaceButton}
          >
            <IconCode size={15} />
            <span>View workspace</span>
          </button>
        )}
      </div>
    </div>
  );

  const dropZoneProps = {
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  };
  const dropOverlay = dragActive ? (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-overlay__card">
        <IconUpload />
        <span>Drop to attach — 20 MB max</span>
      </div>
    </div>
  ) : null;

  const pickRoute = (template: RouteTemplate) => {
    if (template !== route.template)
      persistRoute(applyTemplate(template, tab.backend));
    setRoutePicking(false);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  return {
    tight,
    setupChips,
    pickRoute,
    dropZoneProps,
    dropOverlay,
  };
}
