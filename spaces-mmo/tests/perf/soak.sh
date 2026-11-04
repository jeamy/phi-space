#!/bin/bash
# A soak of the Rust space servers on this machine (docs/rust-portierung.en.md, R4: a week of operation): the docker:rust
# stack with docker/docker-compose.soak.yml as a compose project of its own, live-load.ts figures in rounds without end,
# and a monitor. Everything it writes goes to SOAK_DIR, never to /tmp: a soak outlives the session that starts it.
#
#   tests/perf/soak.sh start     build nothing, start the stack (image phi-spaces-mmo:rust, `npm run docker:image:rust`),
#                                then the load and the monitor, detached
#   tests/perf/soak.sh status    the processes, the containers and the last lines of the logs
#   tests/perf/soak.sh stop      the load and the monitor, then the stack (its volumes stay)
#   tests/perf/soak.sh compose … docker compose of the soak project, e.g. `compose logs -f space-ost`
#
#   SOAK_DIR=~/phi-soak/<date>-rust   logs and rounds    SOAK_PROJECT=phi-soak-rust   compose project
#   SOAK_BOTS=20 SOAK_ROUND_S=3600    figures, seconds of a round
#   SOAK_GUEST_TTL_MS=7200000         guest lease in the stack    SOAK_EVERY_S=600   seconds between monitor ticks
#
# SOAK_DIR/monitor.log: each tick the memory and CPU of every container, RESTART lines (restart count or a container not
# running), ERRLINE lines (error, panic, fatal, BootBlocked or corrupt in the last tick's logs); every sixth tick COUNTS
# per region: entries, Shell and Character entries, read from the volume read-only (sudo sqlite3, the volume is root's).
# SOAK_DIR/load.log and rounds/<n>/ hold what live-load.ts writes. A load round that ends with an error is logged and the
# next one starts. Never stop these processes with a `pkill -f` pattern: stop uses the PIDs in SOAK_DIR/pids.
set -u
MMO=$(cd "$(dirname "$0")/../.." && pwd)
DIR=${SOAK_DIR:-$HOME/phi-soak/$(date -u +%F)-rust}
PROJECT=${SOAK_PROJECT:-phi-soak-rust}
PORT=3910

compose() {
	cd "$MMO" || exit 1
	NANO_CPUS=2 PORT=$PORT SPACES_MMO_SPACE_BIND=127.0.0.1 SPACES_MMO_ACCOUNTS_PORT=3961 SPACES_MMO_WEST_PORT=3960 SPACES_MMO_NORD_PORT=3962 \
		SPACES_MMO_OST_PORT=3963 SPACES_MMO_SUED_PORT=3964 SPACES_MMO_SPACE=tcp:space-west:3950 SPACES_MMO_ACCOUNTS=tcp:space:3951 \
		SPACES_MMO_WEB_REGIONS=west=tcp:space-west:3950,nord=tcp:space-nord:3950,ost=tcp:space-ost:3950,sued=tcp:space-sued:3950 \
		docker compose --env-file .env -f docker/docker-compose.yml -f docker/docker-compose.rust.yml -f docker/docker-compose.soak.yml \
		-p "$PROJECT" --profile nano --profile big "$@"
}

load() {
	echo "load $$" >> "$DIR/pids"
	cd "$MMO" || exit 1
	local n=0
	while true; do
		n=$((n + 1)); mkdir -p "$DIR/rounds/$n"
		echo "$(date -u +%FT%TZ) round $n" >> "$DIR/load.log"
		LOAD_URL=http://127.0.0.1:$PORT LOAD_BOTS=${SOAK_BOTS:-20} LOAD_SECONDS=${SOAK_ROUND_S:-3600} LOAD_OUT="$DIR/rounds/$n" \
			node --no-warnings --experimental-strip-types tests/perf/live-load.ts >> "$DIR/load.log" 2>&1
		echo "$(date -u +%FT%TZ) round $n ended $?" >> "$DIR/load.log"
		sleep 5
	done
}

monitor() {
	echo "monitor $$" >> "$DIR/pids"
	local i=0 every=${SOAK_EVERY_S:-600}
	while true; do
		{
			echo "== $(date -u +%FT%TZ)"
			docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' $(docker ps -q --filter label=com.docker.compose.project="$PROJECT")
			docker ps -a --filter label=com.docker.compose.project="$PROJECT" --format '{{.Names}}' | while read -r c; do
				r=$(docker inspect -f '{{.RestartCount}} {{.State.Status}}' "$c")
				[ "${r%% *}" != 0 ] || [ "${r#* }" != running ] && echo "RESTART $c $r"
				docker logs --since "${every}s" "$c" 2>&1 | grep -iE 'error|panic|fatal|BootBlocked|corrupt' | head -5 | sed "s/^/ERRLINE $c: /"
			done
			if [ $((i % 6)) = 0 ]; then
				for r in west nord ost sued; do
					f=/var/lib/docker/volumes/${PROJECT}_mmo-space-data/_data/world-$r.sqlite
					echo "COUNTS $r $(sudo -n sqlite3 -readonly "$f" "select count(*), sum(value like '%\"type\":\"Shell\"%'), sum(value like '%\"type\":\"Character\"%') from parts where part='entries';" 2>&1)"
				done
			fi
		} >> "$DIR/monitor.log" 2>&1
		i=$((i + 1)); sleep "$every"
	done
}

running() { [ -f "$DIR/pids" ] && while read -r _ pid; do kill -0 "$pid" 2>/dev/null && return 0; done < "$DIR/pids"; return 1; }

case "${1:-}" in
	start)
		if running; then echo "a soak runs in $DIR already (pids: $(tr '\n' ' ' < "$DIR/pids"))"; exit 1; fi
		mkdir -p "$DIR" && : > "$DIR/pids"
		compose up -d --no-build --remove-orphans || exit 1
		for _ in $(seq 1 60); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 2; done
		setsid "$0" _load < /dev/null > /dev/null 2>&1 &
		setsid "$0" _monitor < /dev/null > /dev/null 2>&1 &
		sleep 2; echo "soak started in $DIR (project $PROJECT, port $PORT)"; cat "$DIR/pids";;
	status)
		[ -f "$DIR/pids" ] && while read -r what pid; do kill -0 "$pid" 2>/dev/null && echo "$what $pid running" || echo "$what $pid gone"; done < "$DIR/pids"
		echo "containers up: $(docker ps -q --filter label=com.docker.compose.project="$PROJECT" | wc -l)"
		grep -E 'RESTART|ERRLINE' "$DIR/monitor.log" 2>/dev/null | tail -5
		grep COUNTS "$DIR/monitor.log" 2>/dev/null | tail -4
		tail -2 "$DIR/load.log" 2>/dev/null;;
	stop)
		[ -f "$DIR/pids" ] && while read -r _ pid; do pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; done < "$DIR/pids"
		compose down;;
	compose) shift; compose "$@";;
	_load) export SOAK_DIR=$DIR; load;;
	_monitor) export SOAK_DIR=$DIR; monitor;;
	*) sed -n 2,22p "$0"; exit 2;;
esac
