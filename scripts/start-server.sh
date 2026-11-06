#!/usr/bin/env bash
# Start the ANB orchestrator server in the foreground.
# The Windows launcher keeps the hidden wsl.exe process alive, so the server
# lives as long as this script runs (background "&" jobs die when wsl.exe exits).
# The installed app passes: <server.mjs> <data dir> <log dir> <work folder> <port> [idle] (WSL paths;
# "idle" = exit once the app no longer uses the server, see routes/lifecycle.ts);
# from the repo there are no arguments.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

# nvm is only loaded in interactive shells, so load it here explicitly.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="$HOME/.local/bin:$HOME/.gemini/antigravity-cli/bin:$PATH"

NODE_BIN="$(command -v node || ls -1 "$NVM_DIR"/versions/node/*/bin/node 2>/dev/null | tail -n 1)"
if [ -z "$NODE_BIN" ]; then
  echo "[Nuri] node not found in WSL" >&2
  exit 127
fi

SERVER_JS="${1:-$ROOT/packages/anb-orchestrator/dist/server.js}"
[ -n "$2" ] && export DATA_DIR="$2" && mkdir -p "$2"
LOG_DIR="${3:-$ROOT/logs}"
[ -n "$4" ] && export ANB_WORKSPACE_DIR="$4"
[ -n "$5" ] && export PORT="$5"
[ "$6" = "idle" ] && export ANB_EXIT_WHEN_IDLE=1
mkdir -p "$LOG_DIR"
# Keep the log bounded (rotate at ~5MB).
LOG="$LOG_DIR/server.log"
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 5242880 ]; then mv -f "$LOG" "$LOG.1"; fi
exec "$NODE_BIN" "$SERVER_JS" >>"$LOG" 2>&1
