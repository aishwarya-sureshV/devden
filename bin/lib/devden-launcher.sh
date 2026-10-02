#!/usr/bin/env bash
# Shared launcher helpers for the devden command.
# Sourced by bin/devden; LAUNCHER_NAME must be set by the caller for messages.
set -euo pipefail

PORT="${DEVDEN_PORT:-4319}"
HOST="${DEVDEN_HOST:-127.0.0.1}"
DEVDEN_LOG="${DEVDEN_LOG:-${TMPDIR:-/tmp}/devden.log}"

# Stop the supervisor too, or --stop and build refresh immediately respawn it.
terminate_server() {
  local server_pid="$1" parent_pid parent_command
  # -ww: macOS ps otherwise clips the command to the window width.
  parent_pid="$(ps -p "$server_pid" -o ppid= -ww 2>/dev/null | tr -d '[:space:]')"
  parent_command="$(ps -p "$parent_pid" -o command= -ww 2>/dev/null || true)"
  # npm starts it as `node scripts/supervise.mjs`; the CLI uses an absolute path.
  if [[ "$parent_command" == *"scripts/supervise.mjs"* ]]; then
    kill -TERM "$parent_pid"
  else
    kill -TERM "$server_pid"
  fi
}

health_json() {
  curl -sf --connect-timeout 0.3 --max-time 0.75 "http://$HOST:$PORT/api/health" 2>/dev/null || true
}

health_ready() {
  curl -sf --connect-timeout 0.2 --max-time 0.4 "http://$HOST:$PORT/api/health" >/dev/null 2>&1
}

clear_unresponsive_project_server() {
  local server_pid server_cwd server_command
  server_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [[ -z "$server_pid" ]] && return 0
  server_cwd="$(lsof -a -p "$server_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  server_command="$(ps -p "$server_pid" -o command= 2>/dev/null || true)"
  if [[ "$server_cwd" == "$DEVDEN_ROOT" && "$server_command" == *"server/index.js"* ]]; then
    echo "$LAUNCHER_NAME: recovering an unresponsive local workbench…" >&2
    terminate_server "$server_pid"
    for _ in $(seq 1 20); do
      lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || return 0
      sleep 0.1
    done
    echo "$LAUNCHER_NAME: the previous workbench did not release port $PORT" >&2
    exit 1
  fi
  echo "$LAUNCHER_NAME: port $PORT is in use by another application; set DEVDEN_PORT to use a different port" >&2
  exit 1
}

ensure_build() {
  if [[ ! -f "$DEVDEN_ROOT/package.json" || ! -f "$DEVDEN_ROOT/server/index.js" ]]; then
    echo "$LAUNCHER_NAME: launcher could not find the project at $DEVDEN_ROOT" >&2
    exit 1
  fi
  if [[ ! -d "$DEVDEN_ROOT/dist" ]]; then
    echo "$LAUNCHER_NAME: building web assets (first run)…" >&2
    (cd "$DEVDEN_ROOT" && npm run build) >&2
  fi
}

# A long-running local server may still be serving a previous checkout build.
# Replace only a process that identifies itself as devden through /api/health.
refresh_stale_server() {
  local local_build_id health_json running_build_id stale_pid
  local_build_id="$(shasum -a 256 "$DEVDEN_ROOT/dist/index.html" | awk '{print substr($1, 1, 12)}')"
  health_json="$(health_json)"
  running_build_id="$(printf '%s' "$health_json" | sed -n 's/.*"buildId":"\([^"]*\)".*/\1/p')"
  if [[ -n "$health_json" && "$running_build_id" != "$local_build_id" ]]; then
    stale_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$stale_pid" ]]; then
      echo "$LAUNCHER_NAME: refreshing the running workbench…" >&2
      terminate_server "$stale_pid"
      for _ in $(seq 1 30); do
        health_ready || break
        sleep 0.1
      done
    fi
  fi
}

start_server() {
  if ! health_ready; then
    clear_unresponsive_project_server
    nohup node "$DEVDEN_ROOT/scripts/supervise.mjs" </dev/null >"$DEVDEN_LOG" 2>&1 &
    for _ in $(seq 1 30); do
      health_ready && break
      sleep 0.1
    done
    if ! health_ready; then
      echo "$LAUNCHER_NAME: server failed to start; see $DEVDEN_LOG" >&2
      exit 1
    fi
  fi
}

open_url() {
  local url="$1"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 &
  else
    echo "$LAUNCHER_NAME: open $url"
  fi
}

open_workbench() {
  local query="$1"
  local launch_cwd encoded_cwd qs
  launch_cwd="$(pwd -P)"
  encoded_cwd="$(node -p 'encodeURIComponent(process.argv[1])' "$launch_cwd")"
  qs="cwd=${encoded_cwd}&fresh=$(date +%s)"
  if [[ -n "$query" ]]; then
    qs="${query}&${qs}"
  fi
  open_url "http://$HOST:$PORT/?${qs}"
}
