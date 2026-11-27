#!/usr/bin/env bash
# Daily backup of FORUM on the servers (docs/forum-seite-plan-2026-11-26.en.md, section 13), run by forum-backup.service.
# What a host does is FORUM_BACKUP_ROLE in ~/.config/forum-backup.env:
#   nano: a consistent copy of the space's store while it runs (server/backup.ts in the space container, VACUUM INTO,
#         the newest FORUM_BACKUP_KEEP in the volume at /data/backups), and one copy of it, gzipped, to the folder below
#   big:  a dump of Keycloak's database (the accounts of FORUM and Files) from the phi-idp project, the newest store
#         copy fetched from nano, and the dump sent to nano: each host then holds both
# Folder FORUM_BACKUP_DIR (default ~/phi-backup/forum), the newest FORUM_BACKUP_DAYS days (default 30) kept.
# Restore the store: stop the space container, put the copy (gunzipped) over /data/forum-space.sqlite in the volume
# phi-spaces-forum_forum-space-data and delete its -wal and -shm, start it again. Keycloak: `docker compose -p phi-idp
# stop keycloak`, then `gunzip -c idp-….sql.gz | docker exec -i phi-idp-db-1 psql -U keycloak -d keycloak` into an
# emptied database (dropdb/createdb), start keycloak again.
set -euo pipefail
# the dump holds the clients' secrets and the accounts' password hashes: readable by this user alone
umask 077
ROLE="${FORUM_BACKUP_ROLE:?big or nano, in ~/.config/forum-backup.env}"
DIR="${FORUM_BACKUP_DIR:-$HOME/phi-backup/forum}"
DAYS="${FORUM_BACKUP_DAYS:-30}"
SPACE="${FORUM_SPACE_CONTAINER:-phi-spaces-forum-space-1}"
NOW="$(date -u +%Y-%m-%dT%H%MZ)"
mkdir -p "$DIR"

case "$ROLE" in
nano)
	file=$(docker exec "$SPACE" node --no-warnings --experimental-strip-types server/backup.ts --db /data/forum-space.sqlite --dir /data/backups | sed -n 's/^\[backup\] \(\S*\) .*/\1/p')
	[ -n "$file" ] || { echo "[forum-backup] the space wrote no copy" >&2; exit 1; }
	docker exec "$SPACE" cat "$file" | gzip -q > "$DIR/forum-space-$NOW.sqlite.gz.part"
	mv "$DIR/forum-space-$NOW.sqlite.gz.part" "$DIR/forum-space-$NOW.sqlite.gz"
	echo "[forum-backup] $DIR/forum-space-$NOW.sqlite.gz $(du -h "$DIR/forum-space-$NOW.sqlite.gz" | cut -f1)"
	;;
big)
	docker exec phi-idp-db-1 pg_dump -U keycloak -d keycloak --clean --if-exists | gzip -q > "$DIR/idp-$NOW.sql.gz.part"
	mv "$DIR/idp-$NOW.sql.gz.part" "$DIR/idp-$NOW.sql.gz"
	echo "[forum-backup] $DIR/idp-$NOW.sql.gz $(du -h "$DIR/idp-$NOW.sql.gz" | cut -f1)"
	# the store's newest copy from nano, and the dump to nano (the same folder there)
	newest=$(ssh -o BatchMode=yes nano "ls -1 ~/phi-backup/forum/forum-space-*.sqlite.gz 2>/dev/null | sort | tail -1")
	if [ -n "$newest" ]; then
		scp -q -o BatchMode=yes "nano:$newest" "$DIR/"
		echo "[forum-backup] from nano: $(basename "$newest")"
	else echo "[forum-backup] nano has no copy of the store yet" >&2; fi
	ssh -o BatchMode=yes nano "mkdir -p ~/phi-backup/forum"
	scp -q -o BatchMode=yes "$DIR/idp-$NOW.sql.gz" "nano:phi-backup/forum/"
	;;
*) echo "FORUM_BACKUP_ROLE is big or nano" >&2; exit 1 ;;
esac

find "$DIR" -maxdepth 1 -name '*.gz' -mtime +"$DAYS" -delete
[ "$ROLE" = big ] && ssh -o BatchMode=yes nano "find ~/phi-backup/forum -maxdepth 1 -name 'idp-*.sql.gz' -mtime +$DAYS -delete" || true
