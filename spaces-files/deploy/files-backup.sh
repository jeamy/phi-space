#!/usr/bin/env bash
# The daily backup of spaces-files on big (spaces-files/docs/operator-guide.en.md, section 11): the service writes an
# encrypted data backup and an encrypted state backup (section 3; keys FILES_BACKUP_KEY and FILES_STATE_BACKUP_KEY in
# the volume, /srv/files/keys) into /srv/files/outbox, this copies them to FILES_BACKUP_DIR/<UTC time>/ on the host,
# empties the outbox, sends the run to nano and keeps the newest FILES_BACKUP_KEEP runs here (default 14).
# On nano the account files-backup takes them with rrsync, write-only, never deleting or overwriting (its
# authorized_keys pins this host); nano prunes its own copies. ~/.config/files-backup.env may set the variables below.
# By hand: spaces-files/deploy/files-backup.sh
set -euo pipefail
HOME_CHECKOUT="${FILES_BACKUP_HOME:-/media/docker/spaces}"
DIR="${FILES_BACKUP_DIR:-$HOME/phi-backup/spaces-files}"
KEEP="${FILES_BACKUP_KEEP:-14}"
REMOTE="${FILES_BACKUP_REMOTE:-files-backup@nano.eibrain.org}"
SSH_KEY="${FILES_BACKUP_SSH_KEY:-$HOME/.ssh/files-backup-nano}"
C=(docker compose -f "$HOME_CHECKOUT/spaces-files/docker/docker-compose.yml")
OP=("${C[@]}" exec -T files node --no-warnings --experimental-strip-types server/operator.ts)
ts="$(date -u +%Y-%m-%dT%H%MZ)"
RUN="$DIR/$ts"
t0=$(date +%s)
mkdir -p "$RUN"
chmod 700 "$DIR" "$RUN"
"${C[@]}" exec -T files sh -c 'mkdir -p -m 700 /srv/files/outbox && rm -f /srv/files/outbox/*'
"${OP[@]}" backup "/srv/files/outbox/data-$ts.files-backup" > "$RUN/data.json"
"${OP[@]}" backup-state "/srv/files/outbox/state-$ts.files-backup" > "$RUN/state.json"
container="$("${C[@]}" ps -q files)"
docker cp -q "$container:/srv/files/outbox/." "$RUN/"
"${C[@]}" exec -T files sh -c 'rm -f /srv/files/outbox/*'
chmod 600 "$RUN"/*
rsync -a -e "ssh -i $SSH_KEY -o BatchMode=yes -o IdentitiesOnly=yes" "$RUN" "$REMOTE:"
echo "[files-backup] $RUN $(du -sh "$RUN" | cut -f1) in $(( $(date +%s) - t0 )) s, sent to $REMOTE"
ls -1d "$DIR"/20??-??-??T????Z 2>/dev/null | sort | head -n -"$KEEP" | xargs -r rm -rf
