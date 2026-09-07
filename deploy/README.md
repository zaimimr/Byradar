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

2. Build for **linux/amd64**. The compose file pins it, so building on the box
   itself is a no-op and building on an Apple Silicon Mac emulates rather than
   silently producing an unusable arm64 image.

3. Clone the repo to `/opt/oslomap` and configure:

   ```sh
   git clone <repo-url> /opt/oslomap
   cd /opt/oslomap/deploy
   cp .env.example .env
   $EDITOR .env
   ```

4. Point an A record at the box. Keep it **DNS only** (grey cloud) until Caddy has
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

`docker-compose.yml` pins `linux/amd64` everywhere. Hetzner is x86_64; a build on
an Apple Silicon Mac would otherwise produce an arm64 image that cannot run on
the box. Emulated amd64 builds work on a Mac and are what the numbers below came
from.

| Container | Limit | Measured |
|---|---|---|
| server | 896 MB | 380 MB running in the container on the real feed |
| caddy | 256 MB | ~30 MB |
| pipeline | 1536 MB | completes at a 768 MB limit, dies at 512 MB |

The pipeline number needs explaining, because the obvious measurements disagree
and only one of them is the number you size against.

- `/usr/bin/time -l` on darwin/arm64 reports **764 MB** peak RSS.
- The cgroup reports **1308 MB** peak when given a 1536 MB limit, and **768 MB**
  peak when given 768 MB. It expands to fill whatever it is given.

Both are misleading on their own. `memory.stat` after a run shows `anon 5 MB`,
`file 700 MB`: almost all of that peak is page cache from streaming the GTFS
text files, and the kernel reclaims it under pressure rather than OOM-killing.
So the cgroup peak tracks the limit, not the requirement.

The requirement is what a hard limit actually survives. Measured by bisection on
the real feed:

| Limit | Result |
|---|---|
| 768 MB | completes, all 13 artifacts |
| 512 MB | exit 134, V8 heap abort |
| 384 MB | exit 137, OOM killed |

So the true floor is between 512 and 768 MB, and the 1536 MB limit is roughly
double it. Server, caddy and pipeline together cap at 2.6 GB on a 4 GB box.

These came from emulated amd64 on darwin, so re-check after the first real
nightly run:

```sh
systemd-run --scope -p MemoryAccounting=yes ./refresh-data.sh
```

If the pipeline is ever OOM-killed the refresh script exits non-zero, the swap
never happens, and the server keeps serving the timetable it already has.

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
