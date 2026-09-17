## Development workflow

- Typecheck: `npm run typecheck` (tsc --noEmit)
- Build: `npm run build`
- Development server: `npm run dev` (runs server + vite concurrently)
- Check ports before starting another server.
- Prefer reusing an existing healthy development server.
- Main conversation UI: `src/components/Conversation.tsx`
- Conversation styling: `src/styles/conversation.css`

## Repo map

Hand-maintained orientation: the files a session usually needs first.
Keep this current when subsystems move — it saves every backend the
initial `ls`/`grep` round-trips (measured: ~47% of first-turn tool calls).

- `server/index.js` — API entry: routes, SSE (`/api/events`), static serving. Fan-out hub for the server.
- `server/agent-registry.js` / `agent-pool.js` / `agent-queue.js` — session registry, process pool, and queued-message handling for running agents.
- `server/agent-subagent.js` + `pi-subagent.js` / `claude-subagent` / `grok-subagent` — subagent spawn/follow plumbing per backend.
- `server/pi-agent.js`, `claude-agent.js`, `grok-agent.js`, `codex-agent.js` — the four backend adapters (process spawn, RPC/ACP wiring, system-prompt assembly).
- `server/co-partner-prompt.js` — shared harness prompts (narration, clarify gate, report).
- `server/host-guard.js` — agent PATH/SHELL wrappers that refuse host-kill and uncapped `/api/events` curls.
- `server/sessions.js`, `inflight.js`, `snapshots.js`, `display-history.js` — session persistence, interrupted-turn recovery, per-chunk revert, display log.
- `server/session-route.js` — saved composer route (roles/backends); no chain yet. `src/lib/route.ts` is the client shape.
- `server/remote-tunnel.js` — mobile/remote access via tunnel binary; token auth (`server/env.js` for config).
- `server/workspace-search.js` / `workspace-paths.js` — repo file search; `catalog.js` — skills/extensions catalog + skill authoring.
- `src/App.tsx` + `src/lib/navigation.ts` — route shell; `store.tsx` — global state (biggest fan-in in the client).
- `src/components/Conversation.tsx` — main chat UI; `timeline.ts` + `toolCards.ts` — event model and tool-card rendering.
- `src/lib/api.ts` — typed client for all `/api/*` endpoints; add new endpoints here too.
- Session exports: `src/lib/exportSession.ts`; ask blocks: `askBlock.ts`; usage display: `UsageDisplay.tsx` + `server/codex-usage.js` / `grok-usage.js`.

## Ports

- API server: `4319` (`PI_WEB_PORT`), vite dev server: `5319` (proxies `/api` → 4319).
- Health check: `curl -sf http://127.0.0.1:4319/api/health`.
- The process on `4319` is this conversation's SSE transport. Server JS changes take effect on the next natural restart.
- **Test servers & scripts**: use a scratch port, `trap 'kill $PID' EXIT` cleanup,
  and `--max-time` on every curl. `/api/events` never closes. Verify a port is
  free with `lsof` before binding.

## Debugging

- **Form the hypothesis before the first Read.** Name the file *and* the symbol
  *and* the mechanism. A candidate you can't name a mechanism for isn't one.
- Keep commits small and self-contained.
