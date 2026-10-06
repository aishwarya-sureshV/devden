# devden

A local web workbench for the coding agents already on your machine: **pi**, **Claude Code**, **Grok**, and **Codex**. One browser window, your existing logins, and the session history those tools already keep. `pi` in a terminal stays the classic TUI. `devden` is a separate command.

## Install

macOS or Linux, with [Node.js](https://nodejs.org) 22.13 or newer, `git`, `curl`, and `lsof`. Windows is not supported. The first screen detects your existing agent logins. Choose **Install & connect** for a missing agent or **Connect** to sign in with your subscription. DevDen handles installation without sudo and opens the provider's sign-in link; you approve access in your browser. The same flow is available in Settings → Agents. Pi's subscription chooser requires the current official Pi release (Node.js 22.19 or newer).

```bash
git clone https://github.com/aishwarya-sureshV/devden.git
cd devden
npm ci
npm run build
npm install -g .
devden
```

Once the package is on npm, `npx devden` or `npm install -g devden` will do the same.

That starts a server on `127.0.0.1:4319` and opens the workbench. Run it again later and it reuses the server that is already up.

```bash
devden --backend claude   # new sessions start on Claude Code
devden --backend grok
devden --backend codex
devden --stop
```

On macOS, `node-pty` 1.1.0 installs a prebuilt binary for `darwin-arm64` and `darwin-x64`. A fresh Mac does not need Xcode command-line tools. On Linux that version has no prebuilt binary, so the install compiles it and needs Python, make, and a C++ compiler.

The npm package named `pi-web` is a different project (`ravshansbox/pi-web`). This project's old local data in `~/.pi-web` is still read if `~/.devden` does not exist yet.

## Self-hosted cloud work

Run DevDen and your agents on your own Linux VM so tasks can continue while
your laptop sleeps. Follow the [self-hosting guide](SELF_HOSTING.md) for a
systemd service, agent login, repositories, and the existing `/remote` HTTPS
tunnel. This initial setup uses a temporary tunnel URL.

## Homebrew

The formula is [`packaging/homebrew/devden.rb`](packaging/homebrew/devden.rb). It tracks `main` until the first tagged release.

```bash
brew install --HEAD ./packaging/homebrew/devden.rb
```

A tap (`brew tap aishwarya-sureshV/devden`) needs a separate `homebrew-devden` repository with that file at `Formula/devden.rb`.

## Mac app

The npm command is the normal install. The Mac app is a Dock icon for the same server. It is unsigned, so the first launch trips Gatekeeper: right-click the app, choose Open, then Open again. A paid Apple Developer account removes that step when the warning starts to matter.

While a tool call is waiting for approval, the Dock icon shows how many are waiting.

```bash
cd electron && npm install && npm start
```

Pushing a `v*` tag runs [`.github/workflows/mac-dmg.yml`](.github/workflows/mac-dmg.yml), which builds unsigned arm64 and x64 `.dmg` files. You can also run that workflow by hand. The app uses Node from your `PATH` to run the server, and it opens your home folder.

## What you will not find in other workbenches

**Race the agents on one task.** Battle sends the same prompt to several agents at once. Each one works in its own git worktree, so they cannot overwrite each other. Columns stream live. A scoreboard ticks tokens, files changed, and tests. The same agent can enter twice on two different models. Finished races stay in the browser as a leaderboard.

**Open it on your phone.** Type `/remote` in any conversation. The server downloads `cloudflared` once (~35 MB, cached in `~/.devden/bin`, or the existing `~/.pi-web` folder if that is already there), opens an outbound Cloudflare tunnel, and shows a QR code. Scan it. The link carries a one-time token that becomes a 7-day login cookie, so the phone has nothing to type. Add to Home Screen for a full-screen app. No account, no port forwarding, no phone app. It works over cellular. `/remote off` closes the tunnel and revokes the token. The laptop has to stay awake. The tunnel serves the built UI and builds `dist/` itself if that folder is missing.

**Four agents, one sidebar.** New work can start on pi, Claude Code, Grok, or Codex. Old sessions are read from each tool’s own store (`~/.pi/agent/sessions`, `~/.claude/projects`, `~/.grok/sessions`, and Codex). Claude Code uses your existing Claude.ai login. Ollama models running on this machine are picked up automatically and written into `~/.pi/agent/models.json`.

**It stops and asks.** An ambiguous request becomes a question card with concrete choices before the agent edits anything. In manual mode, every tool call waits on an approval card. Fleet is the page of conversations that have stopped and are waiting on your answer, ordered by who needs you, not by name.

**Fork a turn, rewind a file, refresh without losing the run.** Fork cuts a new session at a message you choose. When the folder is a git repo, that fork can get its own worktree. Edit an earlier message and resend, and the conversation rewinds to that point. Claude sessions can also rewind the files. Refreshing the page does not kill the agent. The browser heartbeats its open conversations, and the new page adopts the process that is still running.

**A board that starts real work.** Each workspace has a kanban. Dispatch a card and it becomes a normal agent session in that folder. Notes sit beside the sessions (text and dropped images, stored in the browser). A trajectory of the turn and a Backend log show the live event stream, including tool calls and the raw JSON.

## Also in the workbench

- Collapsed cards for reads and shell commands. Edits open as a diff with add/delete counts and a full-file view.
- A file tree and editor scoped to the folder you launched in, the open sessions, and any extra roots you set.
- A real terminal in the page. The agent can run a command in a tab you can watch.
- Subagents show up as their own cards while they run.
- Usage for the backends that report it.
- Export a session, including a handoff prompt for the next agent.
- Deploy the project the conversation is working in. Local builds the working tree as it is. Cloud fast-forwards git, installs, and builds. The devden server restarts only when that project is devden itself.
- Light and dark theme.

## Links

Add `?backend=claude`, `?backend=grok`, or `?backend=codex` to start a new session on that agent. Anything else, including no parameter, starts on pi. `?api=` can point the page at another API origin, and only `localhost`, `127.0.0.1`, and `[::1]` are accepted.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `DEVDEN_PORT` | `4319` | API port |
| `DEVDEN_HOST` | `127.0.0.1` | Bind address |
| `DEVDEN_PI_BIN` | `pi` | pi binary to spawn |
| `DEVDEN_CLAUDE_BIN` | `claude` | Claude Code binary to spawn |
| `DEVDEN_TOKEN` | unset | Bearer token. When set, the API, the event stream, and the terminal socket require it. The lock screen trades it for an HttpOnly cookie and a one-time ticket, so the token never lands in a URL or a log line. |
| `DEVDEN_UI_ORIGIN` | unset | Exact origin of a hosted UI that may call this API. Localhost is always allowed. Suffixes such as `*.pages.dev` are not. |
| `DEVDEN_WORKSPACE_ROOTS` | unset | Colon-separated extra directories the explorer may edit. Writes, renames, deletes, copies, moves, and git stay inside these roots plus the launch directory and open session folders. Read-only browsing stays inside your home directory. |
| `DEVDEN_HOME` | `~/.devden` | Where sessions, settings, and snapshots are stored |
| `DEVDEN_LOG` | `$TMPDIR/devden.log` | Launcher log |

## Security

The server binds to loopback and checks the `Origin` header on every request and on the terminal WebSocket. WebSockets ignore CORS, so the server does that check itself.

A `/remote` tunnel is useless without its QR token. The token is minted for that tunnel, accepted once, swapped for a cookie, and revoked when the tunnel stops. While a tunnel is up, requests that are not from this machine need the token even if `DEVDEN_TOKEN` is unset. Traffic from cloudflared arrives on `127.0.0.1`, so the server uses Cloudflare’s `cf-connecting-ip` and `x-forwarded-for` headers to tell it apart from a local browser. Quick tunnels do not support server-sent events, so a page loaded through the tunnel receives events on the `/api/events-ws` WebSocket instead.

## Develop

```bash
npm run dev        # Vite on 5319 (proxies /api) and the API on 4319
npm run build      # production bundle in dist/
npm run preview    # serve the built app from the API server
npm run typecheck
npm test           # node:test
npm run check:grok # grok ACP adapter against the installed CLI
```

Check `http://127.0.0.1:4319/api/health` before starting another server. Port 4319 is the live event stream for anyone using the workbench. Server JavaScript changes apply the next time that process starts. After `npm run build`, the `devden` launcher serves `dist/` and does not need Vite.

`devden` is the `bin` entry in `package.json`. It runs `bin/lib/devden-launcher.sh`. The server spawns each agent by name from `PATH`.

## Uninstall

```bash
devden --stop
npm rm -g devden
rm -rf ~/.devden   # sessions, settings, snapshots (and ~/.pi-web if it exists)
```

Agents keep their own logins and history in `~/.claude`, `~/.codex`, `~/.pi`, and `~/.grok`; DevDen does not remove them. If you used local Ollama models, DevDen added entries to `~/.pi/agent/models.json`.

