#!/usr/bin/env bash
# Lifecycle helper for the read-only dashboard daemon (docs/dashboard.md): start, stop, status, logs.
# The daemon runs in the background; its stdout/stderr go to a log file; readiness is probed via /api/spaces.
#
# Usage:  scripts/dashboard.sh start|stop|status|logs [extra flags for src/dashboard.ts]
#         scripts/dashboard.sh start --no-socket        # example: extra flags are passed through
#
# Config via environment, or the DASHBOARD_* lines of the repository's .env (set values win):
#   DASHBOARD_APPS    app spaces to show: id=address[|address…], comma separated (src/dashboard.ts --help)
#   DASHBOARD_DIR     store directory, holds store.sqlite (default: ~/.local/share/phi-spaces/dashboard-store)
#   DASHBOARD_SQLITE  store file; set this instead of DASHBOARD_DIR
#   DASHBOARD_PORT    HTTP port (default 8787)
#   DASHBOARD_BIND    bind address (default 127.0.0.1; loopback only by design)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$root/.env" ]]; then
	while IFS= read -r line || [[ -n "$line" ]]; do
		[[ "$line" =~ ^[[:space:]]*(DASHBOARD_[A-Z_]+)[[:space:]]*=(.*)$ ]] || continue
		key="${BASH_REMATCH[1]}"
		val="$(sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+|[[:space:]]+$//g; s/^["'"'"']|["'"'"']$//g' <<<"${BASH_REMATCH[2]}")"
		if [[ -z "${!key+x}" ]]; then export "$key=$val"; fi
	done <"$root/.env"
fi
store="${DASHBOARD_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/phi-spaces/dashboard-store}"
port="${DASHBOARD_PORT:-8787}"
bind="${DASHBOARD_BIND:-127.0.0.1}"
run="${XDG_RUNTIME_DIR:-/tmp}/phi-spaces-dashboard-$(id -u)"
pidfile="$run/dashboard.pid"
logfile="$run/dashboard.log"
url="http://$bind:$port"

alive() { [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }
probe() { node -e "fetch('$url/api/spaces').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; }

cmd="${1:-start}"
if [[ $# -gt 0 ]]; then shift; fi

case "$cmd" in
	start)
		if alive; then echo "läuft bereits (pid $(cat "$pidfile")): $url"; exit 0; fi
		mkdir -p "$run"
		args=(--port "$port" --bind "$bind")
		if [[ -n "${DASHBOARD_SQLITE:-}" ]]; then
			args+=(--sqlite "$DASHBOARD_SQLITE")
		else
			mkdir -p "$store"
			args+=(--dir "$store")
		fi
		args+=("$@")
		: >"$logfile"
		(cd "$root" && exec nohup node --experimental-strip-types src/dashboard.ts "${args[@]}" >>"$logfile" 2>&1) &
		echo $! >"$pidfile"
		for ((i = 0; i < 25; i++)); do
			if probe; then
				echo "dashboard: $url (pid $(cat "$pidfile"))"
				if [[ -n "${DASHBOARD_SQLITE:-}" ]]; then echo "store:    $DASHBOARD_SQLITE"; else echo "store:    $store"; fi
				echo "log:      $logfile  (scripts/dashboard.sh logs)"
				exit 0
			fi
			sleep 0.2
		done
		echo "Prozess wurde gestartet, aber $url antwortet nicht:" >&2
		tail -n 20 "$logfile" >&2 || true
		exit 1
		;;
	stop)
		if ! alive; then echo "läuft nicht"; rm -f "$pidfile"; exit 0; fi
		pid="$(cat "$pidfile")"
		kill "$pid" 2>/dev/null || true
		for ((i = 0; i < 25; i++)); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
		if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
		rm -f "$pidfile"
		echo "gestoppt (pid $pid)"
		;;
	status)
		if alive; then
			echo "läuft (pid $(cat "$pidfile")): $url"
			node -e "fetch('$url/api/spaces').then(r=>r.json()).then(d=>{const s=(d.spaces||[]).map(x=>x.alias+': '+(x.stats?.entries??'?')+' Entries').join(' · ');console.log(s||'keine Spaces')}).catch(()=>console.log('API nicht erreichbar'))"
		else
			echo "läuft nicht"
			exit 1
		fi
		;;
	logs)
		if [[ ! -f "$logfile" ]]; then echo "kein Log unter $logfile" >&2; exit 1; fi
		lines="${1:--100}"
		exec tail -n "$lines" -f "$logfile"
		;;
	*)
		echo "Usage: scripts/dashboard.sh start|stop|status|logs [extra flags for src/dashboard.ts]" >&2
		exit 2
		;;
esac
