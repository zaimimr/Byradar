#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/zaimimr/oslomap.git}"
TARGET="${TARGET:-/opt/oslomap}"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'provision: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"

log "timezone"
timedatectl set-timezone Europe/Oslo
timedatectl show --property=Timezone --value

log "base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git jq

if ! command -v docker >/dev/null 2>&1; then
	log "docker"
	curl -fsSL https://get.docker.com | sh
fi
docker --version
docker compose version >/dev/null || die "docker compose plugin missing"

log "source at ${TARGET}"
if [ -d "${TARGET}/.git" ]; then
	git -C "${TARGET}" fetch --quiet origin
	git -C "${TARGET}" reset --hard --quiet origin/main
else
	git clone --quiet "${REPO_URL}" "${TARGET}"
fi
git -C "${TARGET}" log --oneline -1

cd "${TARGET}/deploy"

if [ ! -f .env ]; then
	cp .env.example .env
	die ".env created from the example at ${TARGET}/deploy/.env — fill in SITE_ADDRESS, ACME_EMAIL and VITE_MAPTILER_KEY, then run this again"
fi

for key in SITE_ADDRESS ACME_EMAIL VITE_MAPTILER_KEY ET_CLIENT_NAME; do
	value=$(grep -E "^${key}=" .env | cut -d= -f2- || true)
	[ -n "${value}" ] || die "${key} is empty in ${TARGET}/deploy/.env"
	case "${value}" in
		*example.com*) die "${key} still holds the placeholder value in ${TARGET}/deploy/.env" ;;
	esac
done

log "build"
docker compose build

log "timetable data"
if docker compose --profile tools run --rm -T --no-deps --entrypoint sh pipeline \
	-c '[ -s /app/data/server/meta.json ]' 2>/dev/null; then
	echo "data volume already populated, skipping the first pipeline run"
else
	echo "empty data volume, running the pipeline once (downloads ~130 MB, extracts ~825 MB)"
	docker compose --profile tools run --rm -T --no-deps pipeline
fi

log "up"
docker compose up -d
docker compose ps

log "nightly refresh timer"
install -m 644 systemd/oslomap-refresh.service /etc/systemd/system/
install -m 644 systemd/oslomap-refresh.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now oslomap-refresh.timer
systemctl list-timers oslomap-refresh.timer --no-pager

log "waiting for the server to answer /health"
for _ in $(seq 1 40); do
	if docker compose exec -T server node -e \
		"fetch('http://127.0.0.1:8787/health').then(r=>r.json()).then(h=>{console.log(JSON.stringify({serviceDate:h.serviceDate,vehicles:h.vehicles}));process.exit(0)}).catch(()=>process.exit(1))" 2>/dev/null; then
		log "server is up"
		echo "today in Oslo: $(TZ=Europe/Oslo date +%Y%m%d)"
		echo "if serviceDate above differs, the timetable is stale"
		exit 0
	fi
	sleep 5
done

die "server did not answer /health within 200s — check: docker compose logs server"
