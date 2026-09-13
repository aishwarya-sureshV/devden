## Development workflow

- Typecheck: `npm run typecheck` (tsc --noEmit)
- Build: `npm run build`
- Development server: `npm run dev` (runs server + vite concurrently)
- Check ports before starting another server.
- Prefer reusing an existing healthy development server.
- Main conversation UI: `src/components/Conversation.tsx`
- Conversation styling: `src/styles/conversation.css`

## Ports

- API server: `4319` (`PI_WEB_PORT`), vite dev server: `5319` (proxies `/api` → 4319).
- Health check: `curl -sf http://127.0.0.1:4319/api/health`.
- Never SIGTERM/kill/restart the process on `4319` from inside a session — that is this conversation's SSE transport and hanging the in-flight tool is the result. Server JS changes wait for the next natural restart; say so, don't bounce it.
- **Test servers & scripts**: use a scratch port, `trap 'kill $PID' EXIT` cleanup,
  and `--max-time` on every curl — never curl a streaming endpoint (`/api/events`)
  without `--max-time`; it never closes. Never assume a port is free because the
  last command exited — verify with `lsof` first.

## Debugging

- **Form the hypothesis before the first Read.** Name the file *and* the symbol
  *and* the mechanism. A candidate you can't name a mechanism for isn't one.
- Keep commits small and self-contained.
