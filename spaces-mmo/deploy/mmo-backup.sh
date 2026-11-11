#!/usr/bin/env bash
# Hourly backup of the game's SQLite files (docs/betrieb.en.md, "Backups"): for each `volume=regex` of MMO_BACKUP_VOLUMES
# the matching files of that volume are copied online (the game keeps running; mmo-backup.mjs in the game image, SQLite's
# backup API) to MMO_BACKUP_DIR/<UTC time>/<volume>/<path>, packed, and the newest MMO_BACKUP_KEEP runs (default 72, three
# days of hours) kept. Each host says what it holds in ~/.config/mmo-backup.env (read by mmo-backup.service):
#   big:  MMO_BACKUP_VOLUMES="phi-spaces-mmo_mmo-space-data=^world-[a-z]+\.sqlite$ phi-spaces-mmo_mmo-agent-data=^npc-agents/[^/]+/[a-z]+\.sqlite$"
#   nano: MMO_BACKUP_VOLUMES="phi-spaces-mmo_mmo-space-data=^accounts\.sqlite$"
# Without it: the world Spaces of big. By hand: spaces-mmo/deploy/mmo-backup.sh
# Restore one file: stop the container that holds it, unpack the copy over the file in the volume (and delete its -wal
# and -shm), start it again.
set -euo pipefail
DIR="${MMO_BACKUP_DIR:-$HOME/phi-backup/mmo-hourly}"
KEEP="${MMO_BACKUP_KEEP:-72}"
VOLUMES="${MMO_BACKUP_VOLUMES:-phi-spaces-mmo_mmo-space-data=^world-[a-z]+\.sqlite\$}"
IMAGE="${MMO_BACKUP_IMAGE:-phi-spaces-mmo:prod}"
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN="$DIR/$(date -u +%Y-%m-%dT%H%MZ)"
mkdir -p "$RUN"
t0=$(date +%s)
failed=0
for set in $VOLUMES; do
	volume="${set%%=*}" match="${set#*=}"
	out="$RUN/${volume#phi-spaces-mmo_}"
	mkdir -p "$out"
	# root in the container: the volume's files belong to the image's user, the output folder to the one running this
	if docker run --rm --user 0 -e MATCH="$match" -v "$volume:/d" -v "$out:/out" -v "$HERE/mmo-backup.mjs:/backup.mjs:ro" \
		--entrypoint node "$IMAGE" --no-warnings /backup.mjs > "$out/backup.log" 2>&1; then
		find "$out" \( -name '*.sqlite-wal' -o -name '*.sqlite-shm' \) -delete
		find "$out" -name '*.sqlite' -exec gzip -q {} +
	else failed=1; fi
	sed "s|^|${volume#phi-spaces-mmo_}: |" "$out/backup.log"
done
if [ "$failed" = 1 ]; then mv "$RUN" "$RUN-failed"; echo "[mmo-backup] failed: $RUN-failed" >&2; exit 1; fi
echo "[mmo-backup] $RUN $(du -sh "$RUN" | cut -f1) in $(( $(date +%s) - t0 )) s"
# the newest KEEP runs stay (failed ones are kept until removed by hand)
ls -1d "$DIR"/20??-??-??T????Z 2>/dev/null | sort | head -n -"$KEEP" | xargs -r rm -rf
