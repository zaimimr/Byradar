#!/usr/bin/env bash
set -euo pipefail
umask 077

REPO=${BYRADAR_REPO:-/opt/byradar}
DEST=${BYRADAR_BACKUP_DIR:-/var/backups/byradar}
DATA=$(docker volume inspect byradar_data --format '{{.Mountpoint}}')
CADDY=$(docker volume inspect byradar_caddy_data --format '{{.Mountpoint}}')
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

install -d -m 0700 "$DEST"
exec 9>/var/lock/byradar-data
flock -w 900 9

test -s "$REPO/deploy/.env"
test -s "$DATA/server/meta.json"
test -s "$DATA/web/meta.json"
test -f "$DATA/feedback/feedback.jsonl"
test -d "$CADDY/caddy/certificates"

TEMP=$(mktemp "$DEST/.byradar-backup.XXXXXXXX")
trap 'rm -f "$TEMP"' EXIT
DATA_ENTRIES=(server web feedback)
if [ -d "$DATA/.previous" ]; then
  DATA_ENTRIES+=(.previous)
fi

tar -C "$REPO" -czf "$TEMP" deploy/.env \
  -C "$DATA" "${DATA_ENTRIES[@]}" \
  -C "$CADDY" caddy
tar -tzf "$TEMP" >/dev/null
chmod 0600 "$TEMP"
ARCHIVE="$DEST/byradar-$STAMP.tar.gz"
mv "$TEMP" "$ARCHIVE"
trap - EXIT
printf '%s\n' "$ARCHIVE"
