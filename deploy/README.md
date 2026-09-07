# Deploying OsloMap

One Hetzner CX22 (2 vCPU, 4 GB RAM, 40 GB disk) behind Cloudflare, sized for about
1000 concurrent viewers. Caddy terminates TLS and reverse-proxies a single Node
server that serves the web bundle, the static timetable data and the `/live`
WebSocket.

```
Cloudflare -> Caddy :443 -> server :8787 -> data volume
                                            ^
                                            |
                            pipeline (nightly, one-shot)
```

## Provision

1. Create the CX22 with Ubuntu 24.04, then on the box:

   ```sh
   timedatectl set-timezone Europe/Oslo
   apt-get update && apt-get install -y ca-certificates curl git
   curl -fsSL https://get.docker.com | sh
   ```

   The timezone matters: the nightly timer runs on system local time and the
   pipeline picks its service date from the Oslo calendar day.

2. Clone the repo to `/opt/oslomap` and configure:

   ```sh
   git clone <repo-url> /opt/oslomap
   cd /opt/oslomap/deploy
   cp .env.example .env
   $EDITOR .env
   ```

3. Point an A record at the box. Keep it **DNS only** (grey cloud) until Caddy has
   issued a certificate, then switch it to proxied if you want Cloudflare in front.
   See "Cloudflare" below.

## MapTiler key

`VITE_MAPTILER_KEY` in `deploy/.env` is read at **image build time** and compiled
into the JavaScript bundle. It is public: anyone can read it out of the served
bundle. That is expected for a browser map key, but it means the key must be
restricted in the MapTiler dashboard to the domain in `SITE_ADDRESS` (Account ->
Keys -> Allowed origins), otherwise anyone can spend your tile quota.

Changing the key means rebuilding the image (`docker compose build server`), not
just restarting it.

If the key is empty the web bundle silently falls back to a keyless Carto
basemap, so a missing key looks like a styling bug rather than an error.

## First run

The server reads the timetable once at boot and will crash-loop while
`/app/data/server` is empty, so build the data first:

```sh
cd /opt/oslomap/deploy
docker compose build
docker compose --profile tools run --rm pipeline
docker compose up -d
```

The first pipeline run downloads about 130 MB of GTFS zips and extracts roughly
825 MB into the `cache` volume. Later runs reuse the zips if they are less than
six hours old.

Install the nightly refresh:

```sh
cp systemd/oslomap-refresh.* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now oslomap-refresh.timer
systemctl list-timers oslomap-refresh.timer
```

The timer fires at 03:30 Oslo time with up to 15 minutes of jitter.
`Persistent=true` means a run missed while the box was down happens at the next
boot.

`refresh-data.sh` never lets a failed run reach the live data:

1. The pipeline writes to `data/.staging` (`DATA_DIR` override), not over the
   live files. A crash partway leaves the live generation whole.
2. The swap checks every expected artifact is present and non-empty, moves the
   live generation aside to `data/.previous`, and moves staging into place. If
   either move fails it rolls back on the way out.
3. Only after a clean swap does the server restart.

So a failure at any step leaves the box serving the timetable it already had,
which is a day stale rather than absent. `data/.previous` keeps one generation
for a manual rollback:

```sh
docker compose --profile tools run --rm --no-deps --entrypoint sh pipeline -c \
  'rm -rf /app/data/server /app/data/web && mv /app/data/.previous/* /app/data/'
docker compose restart server
```

## Verify

```sh
curl -s https://$SITE_ADDRESS/health | jq '{serviceDate, counts, clients, vehicles}'

curl -sI https://$SITE_ADDRESS/data/meta.json | grep -i cache-control
# public, max-age=300, s-maxage=3600, stale-while-revalidate=86400

curl -s "https://$SITE_ADDRESS/stops/NSR%3AStopPlace%3A58163/departures?limit=3" | jq

docker compose ps
docker stats --no-stream
journalctl -u oslomap-refresh.service -n 50
```

`serviceDate` in `/health` must be today's Oslo date. If it is yesterday's, the
nightly job did not run or the pipeline failed; check the journal.

## Resource budget

Measured on the real feed:

| Container | Measured peak RSS | Limit | Notes |
|---|---|---|---|
| server | 310 MB idle, 400 MB at 1000 clients | 896 MB | |
| caddy | ~30 MB | 256 MB | |
| pipeline | 764 MB | 1536 MB | one-shot, ~10 s with cached zips |

The pipeline holds the whole merged corpus in memory (23064 trips before
filtering, 380686 kept calls, 2418 shapes) but it streams the CSV files line by
line and shells out to `unzip`, so the 825 MB of extracted GTFS never lands in
the heap. It fits alongside the running server: 896 + 256 + 1536 = 2.6 GB of
limits on a 4 GB box, leaving room for the OS and page cache.

If the pipeline is ever OOM-killed the refresh script exits non-zero and the
server keeps serving the timetable it already has, rather than dying with it.

To watch it while it runs:

```sh
docker stats oslomap-pipeline-run-1
```

## Cloudflare

Caddy's automatic HTTPS uses the HTTP-01 challenge, which needs port 80 to reach
the box. With the record proxied (orange cloud) Cloudflare terminates TLS itself
and challenge pass-through is unreliable, so the simple path is:

1. Set the record to DNS only, `docker compose up -d`, wait for Caddy to issue.
2. Set Cloudflare SSL/TLS mode to **Full (strict)**, then flip the record to proxied.

The more durable option behind Cloudflare is an Origin Certificate, which does not
renew over ACME at all. Create one in the Cloudflare dashboard, put the pair in
`deploy/certs/`, add to the `caddy` service in `docker-compose.yml`:

```yaml
    volumes:
      - ./certs:/certs:ro
```

and replace the `encode` line in the `Caddyfile` site block with:

```
	tls /certs/origin.pem /certs/origin.key
	encode zstd gzip
```

Either way, turn on Cloudflare's WebSocket support (on by default on all plans)
or `/live` will not connect.

Cloudflare caches `/data/*` for an hour (`s-maxage=3600`) and `/assets/*` forever,
which is where most of the egress saving comes from. `/live` and `/health` are not
cacheable and pass through.

## Day-to-day

```sh
docker compose logs -f server
docker compose restart server
./refresh-data.sh                     # rebuild the timetable now
docker compose --profile tools run --rm pipeline npm run -w @oslomap/pipeline start:force
docker compose build && docker compose up -d   # after a git pull
```

`start:force` re-downloads the GTFS zips instead of reusing the cached ones.
`DATA_DIR` sends pipeline output somewhere other than `/app/data`, which is how
`refresh-data.sh` stages a run.
