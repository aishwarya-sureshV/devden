## Development workflow

- Typecheck: `npm run typecheck` (tsc --noEmit)
- Build: `npm run build`
- Development server: `npm run dev` (runs server + vite concurrently)
- Check ports before starting another server.
- Prefer reusing an existing healthy development server.
- Main conversation UI: `src/components/Conversation.tsx` is the wiring
  (~760 lines): it calls the hooks below in order and lays out the JSX.
  Find a concern by file name instead of reading Conversation.tsx:
  - state: `useConversationState.ts` (every useState/useRef), derived values
    `useSessionView.ts`, header/status `useSessionStatus.ts` + `useSessionChrome.tsx`
  - composer: `useComposerMenus.ts`, `useModelPicker.ts`, `useModelMetadata.ts`,
    `useComposerOverlays.tsx`, `useFileDrop.ts`
  - timeline: `useTimelineRows.tsx`, `ConversationPane.tsx`, `ConversationRows.tsx`
  - other effects: `useUsageRefresh.ts`, `useSessionSync.ts`,
    `useWorkspacePane.ts`, `useConversationPanels.tsx`
  - handlers (plain functions taking a typed `ctx`): `conversationSend.ts`
    (send/resend/versions), `conversationModel.ts`, `conversationInput.ts`,
    `conversationReview.ts`, `conversationSession.ts`
  - view: `ConversationComposer.tsx`; pure helpers + mode types: `conversationHelpers.ts`
  Hook calls are order-sensitive (effects run in call order): add a new hook
  at the point its inputs exist; don't reorder existing calls.
- Conversation styling: `src/styles/conversation/*.css`, one file per
  feature (composer, timeline, tool-cards, explorer, ...). `conversation.css`
  only imports them in cascade order -- append new files, never reorder.
- Typecheck once when edits are done, not after every edit.

## Reading cost

Every file read stays in context for the rest of the session.
- Big files (`Conversation.tsx`, `server/index.js`, `app.css`, the larger
  `conversation/*.css`): `grep -n` the symbol/selector, then read ~40 lines
  around it. Never read them whole.
- Screenshots: verify with DOM state, computed styles or a file compare.
  Read an image only to diagnose a visible bug, and shrink it first:
  `sips -Z 800 shot.png`.
- `git diff` without a path dumps the whole dirty tree: use `--stat` or a path.
- Never `find /` or search outside the repo.

## Repo map

Hand-maintained orientation: the files a session usually needs first.
Keep this current when subsystems move — it saves every backend the
initial `ls`/`grep` round-trips (measured: ~47% of first-turn tool calls).

- `server/index.js` — API entry: routes, SSE (`/api/events`), static serving. Fan-out hub for the server.
- `server/agent-registry.js` / `agent-pool.js` / `agent-queue.js` — session registry, process pool, and queued-message handling for running agents.
- `server/agent-subagent.js` + `pi-subagent.js` / `claude-subagent` / `grok-subagent` — subagent spawn/follow plumbing per backend.
- `server/pi-agent.js`, `claude-agent.js`, `grok-agent.js`, `codex-agent.js` — the four backend adapters (process spawn, RPC/ACP wiring, system-prompt assembly). `server/acp-agent.js` is the ACP stdio opener grok launches through.
- First-run setup: `src/components/Onboarding.tsx` + `src/styles/onboarding.css`. Detection (path, version, auth) is `server/agent-detect.js`.
- `server/pi-extensions/` — pi extensions loaded via `-e`: `manual-approve.ts` (manual mode), `background-tasks.ts` (bash_background/task_output/task_stop + run_in_terminal/read_terminal). `server/terminal-tabs.js` — server-owned terminal tabs those tools drive.
- `server/co-partner-prompt.js` — shared harness prompts (narration, clarify gate, report).
- `server/host-guard.js` — agent PATH/SHELL wrappers that refuse host-kill and uncapped `/api/events` curls.
- `server/context-guard.js` — post-compaction context X-ray: dropped-instruction detection, auto re-assertion helpers, session-file compaction parser (`/api/xray`).
- `server/sessions.js`, `inflight.js`, `snapshots.js`, `display-history.js` — session persistence, interrupted-turn recovery, per-chunk revert, display log.
- `server/session-route.js` — saved composer route (roles/backends); no chain yet. `src/lib/route.ts` is the client shape.
- `server/remote-tunnel.js` — mobile/remote access via tunnel binary; token auth (`server/env.js` for config).
- `server/workspace-search.js` / `workspace-paths.js` — repo file search; `catalog.js` — skills/extensions catalog + skill authoring.
- `src/App.tsx` + `src/lib/navigation.ts` — route shell; `store.tsx` — global state (biggest fan-in in the client).
- `src/components/BattlePage.tsx` + `src/lib/race.ts` — battle mode: one task → N backends in isolated worktrees, side-by-side live columns + ticking scoreboard (tokens/edits/tests), finished races persisted to localStorage as the leaderboard.
- `src/components/Conversation.tsx` — main chat UI; `timeline.ts` + `toolCards.ts` — event model and tool-card rendering.
- `src/lib/api.ts` — typed client for all `/api/*` endpoints; add new endpoints here too.
- Session exports: `src/lib/exportSession.ts`; ask blocks: `askBlock.ts`; usage display: `UsageDisplay.tsx` + `server/codex-usage.js` / `grok-usage.js`; context X-ray gauge/panel: `src/components/ContextXray.tsx` + `src/lib/contextXray.ts`.

## Ports

- API server: `4319` (`DEVDEN_PORT`), vite dev server: `5319` (proxies `/api` → 4319).
- Health check: `curl -sf http://127.0.0.1:4319/api/health`.
- The process on `4319` is this conversation's SSE transport. Server JS changes take effect on the next natural restart.
- **Test servers & scripts**: use a scratch port, `trap 'kill $PID' EXIT` cleanup,
  and `--max-time` on every curl. `/api/events` never closes. Verify a port is
  free with `lsof` before binding.

## Debugging

- **Form the hypothesis before the first Read.** Name the file *and* the symbol
  *and* the mechanism. A candidate you can't name a mechanism for isn't one.
- Keep commits small and self-contained.
