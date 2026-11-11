#!/usr/bin/env bash
# Hourly backup of the world Spaces on big (docs/betrieb.en.md, "Backups"): copies every world-<region>.sqlite of the volume
# phi-spaces-mmo_mmo-space-data online (the game keeps running; mmo-backup.mjs in the game image, SQLite's backup API),
# packs each copy and keeps the newest MMO_BACKUP_KEEP runs (default 72, three days of hours) in MMO_BACKUP_DIR
# (default ~/phi-backup/mmo-hourly/<UTC time>/world-<region>.sqlite.gz). Run by mmo-backup.timer; by hand:
#   spaces-mmo/deploy/mmo-backup.sh
# Restore one region: stop its space container, gunzip the copy over world-<region>.sqlite in the volume (and delete that
# file's -wal and -shm), start it again.
set -euo pipefail
DIR="${MMO_BACKUP_DIR:-$HOME/phi-backup/mmo-hourly}"
KEEP="${MMO_BACKUP_KEEP:-72}"
VOLUME="${MMO_BACKUP_VOLUME:-phi-spaces-mmo_mmo-space-data}"
IMAGE="${MMO_BACKUP_IMAGE:-phi-spaces-mmo:prod}"
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN="$DIR/$(date -u +%Y-%m-%dT%H%MZ)"
mkdir -p "$RUN"
t0=$(date +%s)
# root in the container: the volume's files belong to the image's user, the output folder to the one running this
if ! docker run --rm --user 0 -v "$VOLUME:/d" -v "$RUN:/out" -v "$HERE/mmo-backup.mjs:/backup.mjs:ro" \
	--entrypoint node "$IMAGE" --no-warnings /backup.mjs > "$RUN/backup.log" 2>&1; then
	cat "$RUN/backup.log"; mv "$RUN" "$RUN-failed"; echo "[mmo-backup] failed: $RUN-failed" >&2; exit 1
fi
rm -f "$RUN"/*.sqlite-wal "$RUN"/*.sqlite-shm
gzip -q "$RUN"/*.sqlite
cat "$RUN/backup.log"
echo "[mmo-backup] $RUN $(du -sh "$RUN" | cut -f1) in $(( $(date +%s) - t0 )) s"
# the newest KEEP runs stay (failed ones are kept until removed by hand)
ls -1d "$DIR"/20??-??-??T????Z 2>/dev/null | sort | head -n -"$KEEP" | xargs -r rm -rf
