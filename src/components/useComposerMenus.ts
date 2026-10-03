// Composer menus for Conversation: slash commands (local + backend), @-mention
// matching, key handling and textarea auto-grow.
import type * as React from "react";
import { LOCAL_COMMANDS, type AgentMode } from "./conversationHelpers";
import {
  useEffect,
  type KeyboardEvent,
  useCallback,
  useLayoutEffect,
} from "react";
import { api, type WorkspaceMatch, type SlashCommand } from "../lib/api";
import {
  applyMention as applyMentionImpl,
  onKeyDown as onKeyDownImpl,
} from "./conversationInput";
import type { AgentCapabilities } from "../lib/agentCapabilities";
import type { ConversationTab, Attachment } from "../lib/store";

export type UseComposerMenusArgs = {
  caps: AgentCapabilities;
  commands: SlashCommand[];
  draft: string;
  caret: number;
  mentionMatches: WorkspaceMatch[];
  setMentionMatches: React.Dispatch<React.SetStateAction<WorkspaceMatch[]>>;
  tab: ConversationTab;
  setMentionIndex: React.Dispatch<React.SetStateAction<number>>;
  commandMenuOpen: boolean;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setCaret: React.Dispatch<React.SetStateAction<number>>;
  agentMode: AgentMode;
  switchAgentMode: (nextMode: AgentMode, silent?: boolean) => Promise<void>;
  streaming: boolean;
  steerOnceRef: React.RefObject<boolean>;
  canSteer: boolean;
  send: (
    raw: string,
    seedAttachments?: Attachment[] | undefined,
    opts?: { answersAsk?: boolean | undefined } | undefined,
  ) => Promise<void>;
  mentionIndex: number;
  setSlashIndex: React.Dispatch<React.SetStateAction<number>>;
  slashIndex: number;
  setCommandMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  editingMessageId: string | null;
  setEditingMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  thin: boolean;
};

export function useComposerMenus({
  caps,
  commands,
  draft,
  caret,
  mentionMatches,
  setMentionMatches,
  tab,
  setMentionIndex,
  commandMenuOpen,
  setDraft,
  textareaRef,
  setCaret,
  agentMode,
  switchAgentMode,
  streaming,
  steerOnceRef,
  canSteer,
  send,
  mentionIndex,
  setSlashIndex,
  slashIndex,
  setCommandMenuOpen,
  editingMessageId,
  setEditingMessageId,
  thin,
}: UseComposerMenusArgs) {
  // slash filtering for the command menu opened by typing "/"
  const localCommands = LOCAL_COMMANDS.filter((command) => {
    if (command.name === "fork") return caps.fork;
    if (command.name === "compact") return caps.compact;
    return true;
  });
  const localByName = new Map(
    localCommands.map((command) => [command.name, command]),
  );
  const mergedCommands = [
    ...localCommands,
    ...commands.filter((command) => !localByName.has(command.name)),
  ];
  // The "@" token under the caret, if any: an @ that starts a word, followed
  // by anything but whitespace.
  const mentionQuery = (() => {
    const before = draft.slice(0, caret);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
    return match ? match[1] : null;
  })();
  const mentionOpen = mentionQuery !== null && mentionMatches.length > 0;

  // Debounced so a fast typist does not walk the tree on every keystroke.
  // Declared here rather than with the other effects because the dependency
  // array is evaluated during render and mentionQuery is derived just above.
  useEffect(() => {
    if (mentionQuery === null) {
      setMentionMatches([]);
      return;
    }
    const root = tab.cwd;
    if (!root) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .workspaceSearch(root, mentionQuery)
        .then((result) => {
          if (cancelled) return;
          setMentionMatches(result.ok ? (result.matches ?? []) : []);
          setMentionIndex(0);
        })
        .catch(() => {
          if (!cancelled) setMentionMatches([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mentionQuery, tab.cwd]);

  const bareSlashCommand = /^\/([\w:-]*)$/.exec(draft);
  const slashFilter = bareSlashCommand
    ? bareSlashCommand[1].toLowerCase()
    : null;
  const slashMatches =
    slashFilter !== null && slashFilter.length >= 0
      ? mergedCommands
          .filter((c) => c.name.toLowerCase().startsWith(slashFilter))
          .slice(0, 8)
      : mergedCommands.slice(0, 8);
  const slashOpen =
    commandMenuOpen || (slashFilter !== null && slashMatches.length > 0);

  /** Swap the "@token" under the caret for the picked path. */
  const applyMention = (match: WorkspaceMatch) =>
    applyMentionImpl(
      {
        draft,
        caret,
        setDraft,
        setMentionMatches,
        textareaRef,
        setCaret,
        autoGrow,
      },
      match,
    );

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) =>
    onKeyDownImpl(
      {
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
      },
      event,
    );

  // The inline height overrides any CSS, so the thin cap has to live here —
  // a stylesheet rule alone can never shrink the textarea below 48px.
  const textareaMinHeight = 26;
  const textareaMaxHeight = thin ? 26 : 196;
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, textareaMinHeight), textareaMaxHeight)}px`;
  }, [textareaMinHeight, textareaMaxHeight]);
  useLayoutEffect(() => {
    autoGrow();
    // deps: [draft] only — this used to run on every render (no deps array),
    // so any unrelated re-render (a selection change from onSelect, an idle
    // polling tick) re-zeroed the textarea's height and reset its internal
    // scroll to the top, which looked like the caret jumping or the box
    // scrolling up while typing. Content changes always go through setDraft.
  }, [draft, autoGrow]);

  return {
    autoGrow,
    mentionOpen,
    applyMention,
    slashOpen,
    slashMatches,
    onKeyDown,
  };
}
