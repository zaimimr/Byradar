#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

log() { printf '%s refresh-data: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

in_container() {
	docker compose --profile tools run --rm -T --no-deps --entrypoint sh pipeline -s
}

health() {
	docker compose exec -T server node -e \
		"fetch('http://127.0.0.1:8787/health').then(r => r.json()).then(h => console.log(h.serviceDate))"
}

log "clearing any staging left by an earlier run"
in_container <<'INNER'
rm -rf /app/data/.staging
INNER

log "running pipeline into staging"
if ! docker compose --profile tools run --rm -T --no-deps -e DATA_DIR=/app/data/.staging pipeline; then
	log "pipeline FAILED, live data untouched, server keeps the timetable it has"
	exit 1
fi

log "swapping staging into place"
if ! in_container <<'INNER'; then
set -e
D=/app/data
for f in server/meta.json server/quays.json server/stops.json server/trips-index.json server/trips.bin \
	server/shapes-index.json server/shapes.bin server/routes.json server/journeys.json \
	web/meta.json web/network.json web/routes.json web/stops.json; do
	if [ ! -s "$D/.staging/$f" ]; then
		echo "staging incomplete, missing or empty: $f"
		exit 1
	fi
done

rm -rf "$D/.previous"
mkdir -p "$D/.previous"

restore() {
	for d in server web; do
		if [ -d "$D/.previous/$d" ]; then
			rm -rf "$D/$d"
			mv "$D/.previous/$d" "$D/$d"
		fi
	done
}
trap restore EXIT

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
	log "swap FAILED and was rolled back, live data is the previous generation"
	exit 1
fi

log "restarting server"
docker compose restart server

for _ in $(seq 1 30); do
	sleep 5
	if SERVICE_DATE=$(health 2>/dev/null); then
		log "server healthy on service date ${SERVICE_DATE}"
		exit 0
	fi
done

log "server did not answer /health within 150s of the restart"
exit 1
