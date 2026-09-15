#!/bin/sh
set -eu
umask 077

BYRADAR_HOST=${BYRADAR_HOST:-100.113.84.36}
BYRADAR_ACCOUNT=$(id -un)
BYRADAR_ACCOUNT_HOME=$(dscl . -read "/Users/$BYRADAR_ACCOUNT" NFSHomeDirectory | awk '{print $2}')
BYRADAR_DEST="$BYRADAR_ACCOUNT_HOME/.config/byradar/backups"
install -d -m 0700 "$BYRADAR_DEST"

BYRADAR_NAMES=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "root@$BYRADAR_HOST" 'find /var/backups/byradar -maxdepth 1 -type f -name "byradar-*.tar.gz" -printf "%f\n" | sort')
[ -n "$BYRADAR_NAMES" ] || exit 0

for BYRADAR_NAME in $BYRADAR_NAMES; do
  printf '%s\n' "$BYRADAR_NAME" | grep -Eq '^byradar-[0-9]{8}T[0-9]{6}Z\.tar\.gz$' || { printf 'backup pull: invalid archive name\n' >&2; exit 1; }
  BYRADAR_REMOTE_HASH=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "root@$BYRADAR_HOST" "sha256sum /var/backups/byradar/$BYRADAR_NAME" | awk '{print $1}')
  [ -n "$BYRADAR_REMOTE_HASH" ] || { printf 'backup pull: missing remote hash\n' >&2; exit 1; }
  BYRADAR_LOCAL="$BYRADAR_DEST/$BYRADAR_NAME"
  if [ -f "$BYRADAR_LOCAL" ]; then
    BYRADAR_LOCAL_HASH=$(shasum -a 256 "$BYRADAR_LOCAL" | awk '{print $1}')
    [ "$BYRADAR_REMOTE_HASH" = "$BYRADAR_LOCAL_HASH" ] && continue
  fi
  BYRADAR_TEMP=$(mktemp "$BYRADAR_DEST/.byradar-fetch.XXXXXXXX")
  trap 'rm -f "$BYRADAR_TEMP"' EXIT HUP INT TERM
  scp -q "root@$BYRADAR_HOST:/var/backups/byradar/$BYRADAR_NAME" "$BYRADAR_TEMP"
  BYRADAR_FETCH_HASH=$(shasum -a 256 "$BYRADAR_TEMP" | awk '{print $1}')
  [ "$BYRADAR_REMOTE_HASH" = "$BYRADAR_FETCH_HASH" ] || { printf 'backup pull: checksum mismatch\n' >&2; exit 1; }
  chmod 0600 "$BYRADAR_TEMP"
  mv "$BYRADAR_TEMP" "$BYRADAR_LOCAL"
  trap - EXIT HUP INT TERM
done
