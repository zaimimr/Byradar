#!/usr/bin/env bash
set -euo pipefail

TARBALL=${1:-}

if [ -z "$TARBALL" ] || [ ! -s "$TARBALL" ]; then
	echo "apply-data: usage: apply-data.sh /path/to/byradar-data.tgz" >&2
	exit 1
fi

TARBALL=$(readlink -f "$TARBALL")
chmod a+r "$TARBALL" 2>/dev/null || true
cd "$(dirname "$(readlink -f "$0")")"

log() { printf '%s apply-data: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

exec 9>/var/lock/byradar-data
if ! flock -w 900 9; then
	echo "apply-data: another data swap held the lock for 15 minutes" >&2
	exit 1
fi

in_volume() {
	docker compose --profile tools run --rm -T --no-deps \
		-v "$TARBALL:/incoming/data.tgz:ro" --entrypoint sh pipeline -s
}

health() {
	docker compose exec -T server node -e \
		"fetch('http://127.0.0.1:8787/health').then(r => r.json()).then(h => console.log(h.serviceDate))"
}

log "unpacking $(du -h "$TARBALL" | cut -f1) into staging"
in_volume <<'INNER'
set -e
D=/app/data
rm -rf "$D/.staging"
mkdir -p "$D/.staging"
tar xzf /incoming/data.tgz -C "$D/.staging"

for f in server/meta.json server/quays.json server/stops.json server/trips-index.json server/trips.bin \
	server/shapes-index.json server/shapes.bin server/routes.json server/journeys.json \
	web/meta.json web/network.json web/routes.json web/stops.json web/net/index.json; do
	if [ ! -s "$D/.staging/$f" ]; then
		echo "staging incomplete, missing or empty: $f"
		exit 1
	fi
done
INNER

log "swapping staging into place"
in_volume <<'INNER'
set -e
D=/app/data

restore() {
	for d in server web; do
		if [ -d "$D/.previous/$d" ]; then
			rm -rf "$D/$d"
			mv "$D/.previous/$d" "$D/$d"
		fi
	done
}
trap restore EXIT

rm -rf "$D/.previous"
mkdir -p "$D/.previous"

for d in server web; do
	if [ -d "$D/$d" ]; then
		mv "$D/$d" "$D/.previous/$d"
	fi
	mv "$D/.staging/$d" "$D/$d"
done

trap - EXIT
rmdir "$D/.staging" 2>/dev/null || true
echo "swap complete, previous generation kept in $D/.previous"
INNER

log "restarting the server on the new timetable"
docker compose restart server

for _ in $(seq 1 30); do
	sleep 5
	if SERVICE_DATE=$(health 2>/dev/null); then
		log "server healthy on service date ${SERVICE_DATE}"
		exit 0
	fi
done

log "server did not answer /health within 150s, rolling back to the previous generation"
in_volume <<'INNER'
set -e
D=/app/data
for d in server web; do
	if [ -d "$D/.previous/$d" ]; then
		rm -rf "$D/$d"
		mv "$D/.previous/$d" "$D/$d"
	fi
done
INNER
docker compose restart server
exit 1
