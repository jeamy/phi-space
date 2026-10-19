#!/usr/bin/env bash
# Local two-host test: hub (big: Next.js server) + nano-host (judge shard) over a unix socket — the local stand-in for
# the big/nano setup.
#
# Usage: codemode-chat/scripts/codemode-shards.sh start|stop|status|logs
# Env:   PORT (hub http, default 3799), SOCKET (default /tmp/codemode-b.sock), HUB_DB (sqlite, default
#        /tmp/codemode-a-test.sqlite), NANO_DB (default codemode-chat/.local/codemode-b.sqlite; CODEMODE_MEM=1 = throwaway),
#        CODEMODE_CHAT_LLM (default 0), DEV (default 1 = Next dev mode; DEV=0 uses the production build, built when stale).

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/codemode-chat"
set -a; [ -f "$APP/.env" ] && . "$APP/.env"; set +a
PORT="${PORT:-3799}"
SOCKET="${SOCKET:-/tmp/codemode-b.sock}"
HUB_DB="${HUB_DB:-/tmp/codemode-a-test.sqlite}"
NANO_DB="${NANO_DB:-$APP/.local/codemode-b.sqlite}"
RUN=/tmp/codemode-shards
HUB_PID_FILE=$RUN/hub.pid
NANO_PID_FILE=$RUN/nano.pid

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

build_if_stale() {
  local bid="$APP/.next/BUILD_ID"
  if [ -f "$bid" ] && ! find "$APP/client" "$APP/app" "$APP/server" -type f -newer "$bid" -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  echo "building codemode-chat (npm run build) — log: $RUN/build.log"
  (cd "$APP" && npm run build > "$RUN/build.log" 2>&1) || { echo "build failed — see $RUN/build.log"; exit 1; }
}

start() {
  mkdir -p "$RUN"
  if alive "$NANO_PID_FILE" || alive "$HUB_PID_FILE"; then echo "already running (stop first or use status)"; status; exit 1; fi
  rm -f "$SOCKET"
  if command -v fuser >/dev/null && fuser "$PORT"/tcp 2>/dev/null; then
    echo "port $PORT busy — killing stale owner"; fuser -k "$PORT"/tcp 2>/dev/null; sleep 1
  fi
  cd "$APP" || exit 1
  mkdir -p "$(dirname "$NANO_DB")"
  env ${CODEMODE_MEM:+CODEMODE_MEM="$CODEMODE_MEM"} CODEMODE_DB="$NANO_DB" CODEMODE_LISTEN="unix:$SOCKET" CODEMODE_HOST_NAME="${NANO_NAME:-nano}" \
    node --experimental-strip-types --no-warnings server/nano-host.ts > "$RUN/nano.log" 2>&1 &
  echo $! > "$NANO_PID_FILE"
  for _ in $(seq 1 50); do [ -S "$SOCKET" ] && break; sleep 0.2; done
  [ "${DEV:-1}" = "1" ] || build_if_stale
  env PORT="$PORT" CODEMODE_BIND="${CODEMODE_BIND:-127.0.0.1}" CODEMODE_SQLITE="$HUB_DB" CODEMODE_REMOTE="unix:$SOCKET" CODEMODE_HOST_NAME="${HUB_NAME:-big}" \
    CODEMODE_CHAT_LLM="${CODEMODE_CHAT_LLM:-0}" \
    node --experimental-strip-types --no-warnings server/index.ts $([ "${DEV:-1}" = "1" ] && echo --dev) > "$RUN/hub.log" 2>&1 &
  echo $! > "$HUB_PID_FILE"
  echo "started: hub http://127.0.0.1:$PORT (pid $(cat "$HUB_PID_FILE")), nano on $SOCKET (pid $(cat "$NANO_PID_FILE")); logs: $RUN"
}

stop() {
  for f in "$HUB_PID_FILE" "$NANO_PID_FILE"; do
    if alive "$f"; then kill "$(cat "$f")" 2>/dev/null; fi
    rm -f "$f"
  done
  rm -f "$SOCKET"
  echo "stopped"
}

status() {
  alive "$HUB_PID_FILE" && echo "hub:  running (pid $(cat "$HUB_PID_FILE")) http://127.0.0.1:$PORT" || echo "hub:  not running"
  alive "$NANO_PID_FILE" && echo "nano: running (pid $(cat "$NANO_PID_FILE")) $SOCKET" || echo "nano: not running"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  logs) tail -n 50 -f "$RUN/hub.log" "$RUN/nano.log" ;;
  *) echo "usage: $0 start|stop|status|logs"; exit 2 ;;
esac
