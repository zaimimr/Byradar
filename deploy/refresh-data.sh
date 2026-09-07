#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

log() { printf '%s refresh-data: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

health() {
	docker compose exec -T server node -e \
		"fetch('http://127.0.0.1:8787/health').then(r => r.json()).then(h => console.log(h.serviceDate))"
}

log "running pipeline"
if ! docker compose --profile tools run --rm -T --no-deps pipeline; then
	log "pipeline FAILED, leaving the server on the timetable it already has"
	exit 1
fi

log "pipeline succeeded, restarting server"
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
