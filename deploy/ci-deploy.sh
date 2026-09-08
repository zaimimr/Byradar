#!/usr/bin/env bash
set -euo pipefail

REPO=${BYRADAR_REPO:-/opt/byradar}
BRANCH=${BYRADAR_BRANCH:-main}
HEALTH_ATTEMPTS=${BYRADAR_HEALTH_ATTEMPTS:-40}

log() { printf '%s ci-deploy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

health() {
	docker compose exec -T server node -e \
		"fetch('http://127.0.0.1:8787/health').then(r => r.json()).then(h => { if (!h.ok) process.exit(1); console.log(h.serviceDate); })"
}

cd "$REPO"

PREVIOUS=$(git rev-parse HEAD)
log "at ${PREVIOUS:0:8}, fetching origin/${BRANCH}"
git fetch --quiet origin "$BRANCH"
git reset --quiet --hard "origin/${BRANCH}"
TARGET=$(git rev-parse HEAD)

if [ "$TARGET" = "$PREVIOUS" ]; then
	log "already at ${TARGET:0:8}, nothing to pull"
else
	log "moved ${PREVIOUS:0:8} to ${TARGET:0:8}: $(git log -1 --pretty=%s)"
fi

cd "$REPO/deploy"

log "building the image"
docker compose build

log "rolling the server"
docker compose up -d

log "reloading the caddy config"
if ! docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
	log "caddy reload failed, restarting the container instead"
	docker compose restart caddy
fi

rollback() {
	log "ROLLING BACK to ${PREVIOUS:0:8}"
	cd "$REPO"
	git reset --quiet --hard "$PREVIOUS"
	cd "$REPO/deploy"
	docker compose build
	docker compose up -d
	docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile ||
		docker compose restart caddy
	for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
		sleep 5
		if health >/dev/null 2>&1; then
			log "rollback healthy, live on ${PREVIOUS:0:8}"
			return 0
		fi
	done
	log "rollback did NOT come back healthy, the box needs a look"
	return 1
}

for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
	sleep 5
	if SERVICE_DATE=$(health 2>/dev/null); then
		log "healthy on ${TARGET:0:8}, service date ${SERVICE_DATE}"
		docker image prune -f >/dev/null
		exit 0
	fi
done

log "no healthy /health within $((HEALTH_ATTEMPTS * 5))s"
docker compose logs --tail 60 server || true
rollback || true
exit 1
