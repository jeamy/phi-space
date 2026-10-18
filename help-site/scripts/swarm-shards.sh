#!/usr/bin/env bash
# Local two-shard swarm test: hub (shard A, help-site server) + nano-host (shard B)
# over a unix socket — the local stand-in for the big/nano two-host setup.
#
# Usage: help-site/scripts/swarm-shards.sh start|stop|status|logs
# Env:   PORT (hub http, default 3599), SOCKET (unix socket, default
#        /tmp/swarm-b.sock), HUB_DB (sqlite, default /tmp/swarm-a-test.sqlite),
#        NANO_DB (nano shard sqlite, default help-site/.local/swarm-b.sqlite —
#        durable; set SWARM_MEM=1 only for throwaway in-memory runs),
#        PI_SPACES_LLM (unset = auto-on when credentials exist; set 0 to disable),
#        SWARM_RATE (default 5/s), SWARM_AGENTS (default 100),
#        DEV (default 1 — Next dev mode, always current UI;
#        DEV=0 uses the prod .next build, rebuilt automatically when sources are newer).

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# help-site/.env fills unset vars first — the explicit env= prefixes below must see
# SWARM_AGENTS/SWARM_RATE/etc. from there, because exported env beats the .env
# file that server/index.ts only uses as a fallback.
set -a; [ -f "$ROOT/help-site/.env" ] && . "$ROOT/help-site/.env"; set +a
PORT="${PORT:-3599}"
SOCKET="${SOCKET:-/tmp/swarm-b.sock}"
HUB_DB="${HUB_DB:-/tmp/swarm-a-test.sqlite}"
NANO_DB="${NANO_DB:-$ROOT/help-site/.local/swarm-b.sqlite}"
RUN=/tmp/swarm-shards
HUB_PID_FILE=$RUN/hub.pid
NANO_PID_FILE=$RUN/nano.pid

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

build_if_stale() {
  local bid="$ROOT/help-site/.next/BUILD_ID"
  if [ -f "$bid" ] && \
     ! find "$ROOT/help-site/client" "$ROOT/help-site/app" "$ROOT/help-site/server" "$ROOT/help-site/scripts" \
        -type f -newer "$bid" -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  echo "building help-site (npm run build) — log: $RUN/build.log"
  (cd "$ROOT/help-site" && npm run build > "$RUN/build.log" 2>&1) || {
    echo "build failed — see $RUN/build.log"; exit 1
  }
}

start() {
  mkdir -p "$RUN"
  if alive "$NANO_PID_FILE" || alive "$HUB_PID_FILE"; then
    echo "already running (stop first or use status)"; status; exit 1
  fi
  rm -f "$SOCKET"
  # kill whatever still owns the hub port (e.g. a stray manual server/index.ts)
  if command -v fuser >/dev/null && fuser "$PORT"/tcp 2>/dev/null; then
    echo "port $PORT busy — killing stale owner"
    fuser -k "$PORT"/tcp 2>/dev/null; sleep 1
  fi
  cd "$ROOT" || exit 1
  mkdir -p "$(dirname "$NANO_DB")"
  env ${SWARM_MEM:+SWARM_MEM="$SWARM_MEM"} SWARM_DB="$NANO_DB" SWARM_LISTEN="unix:$SOCKET" \
    node --experimental-strip-types --no-warnings help-site/server/nano-host.ts \
    > "$RUN/nano.log" 2>&1 &
  echo $! > "$NANO_PID_FILE"
  sleep 1
  DEV_FLAG=""; if [ "${DEV:-1}" != "0" ]; then DEV_FLAG="--dev"; else build_if_stale; fi
  LLM_ENV=(); [ -n "${PI_SPACES_LLM+x}" ] && LLM_ENV=("PI_SPACES_LLM=$PI_SPACES_LLM")
  env HELP_SQLITE="$HUB_DB" PORT="$PORT" \
    "${LLM_ENV[@]}" SWARM_REMOTE="unix:$SOCKET" \
    SWARM_RATE="${SWARM_RATE:-5}" SWARM_AGENTS="${SWARM_AGENTS:-100}" \
    node --experimental-strip-types --no-warnings help-site/server/index.ts \
    $DEV_FLAG > "$RUN/hub.log" 2>&1 &
  echo $! > "$HUB_PID_FILE"
  sleep 1
  status
  echo "hub:  http://localhost:$PORT/?view=feed  (log: $RUN/hub.log)"
  echo "nano: $SOCKET  (log: $RUN/nano.log)"
}

stop() {
  for f in "$HUB_PID_FILE" "$NANO_PID_FILE"; do
    if alive "$f"; then kill "$(cat "$f")" 2>/dev/null; fi
    rm -f "$f"
  done
  sleep 1
  # fallback: anything still owning the hub port or the shard socket
  if command -v fuser >/dev/null; then
    fuser -k "$PORT"/tcp 2>/dev/null
    [ -S "$SOCKET" ] && fuser -k "$SOCKET" 2>/dev/null
  fi
  rm -f "$SOCKET"
  echo "stopped"
}

status() {
  printf "hub : %s\n" "$(alive "$HUB_PID_FILE" && echo "up (pid $(cat "$HUB_PID_FILE"))" || echo down)"
  printf "nano: %s\n" "$(alive "$NANO_PID_FILE" && echo "up (pid $(cat "$NANO_PID_FILE"))" || echo down)"
}

case "${1:-}" in
  start)  start ;;
  stop)   stop ;;
  restart) stop; start ;;
  status) status ;;
  logs)   tail -n "${2:-40}" "$RUN/hub.log" "$RUN/nano.log" ;;
  *) echo "usage: $0 start|stop|status|logs [lines]"; exit 1 ;;
esac
