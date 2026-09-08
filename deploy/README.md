# Deploying Byradar

One Hetzner CPX22 (2 vCPU, 4 GB RAM, 80 GB disk) behind Cloudflare, sized for about
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

`provision.sh` does all of the below and is safe to re-run. On a fresh CPX22 with
Ubuntu 24.04:

```sh
curl -fsSL https://raw.githubusercontent.com/zaimimr/byradar/main/deploy/provision.sh -o provision.sh
bash provision.sh          # first run stops and tells you to fill in deploy/.env
$EDITOR /opt/byradar/deploy/.env
bash provision.sh          # second run builds, seeds the data and starts everything
```

It sets the timezone, installs Docker, clones to `/opt/byradar`, refuses to
continue while `.env` still holds placeholder values, builds, runs the pipeline
once only if the data volume is empty, starts the stack, installs the nightly
timer and waits for `/health`.

The manual equivalent, if you would rather do it by hand:

1. Create the CPX22 with Ubuntu 24.04, then on the box:

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

3. Clone the repo to `/opt/byradar` and configure:

   ```sh
   git clone <repo-url> /opt/byradar
   cd /opt/byradar/deploy
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
cd /opt/byradar/deploy
docker compose build
docker compose --profile tools run --rm pipeline
docker compose up -d
```

The first pipeline run downloads about 130 MB of GTFS zips and extracts roughly
825 MB into the `cache` volume. Later runs reuse the zips if they are less than
six hours old.

Install the nightly refresh:

```sh
cp systemd/byradar-refresh.* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now byradar-refresh.timer
systemctl list-timers byradar-refresh.timer
```

The timer fires at **04:45** Oslo time with up to 15 minutes of jitter.

The hour matters and is not arbitrary. GTFS puts trips that run past midnight in
the *previous* service day, as hours 24:00-27:00, and the server loads exactly
one service date. So between midnight and the end of night service the running
vehicles belong to yesterday's build, and rebuilding during that window empties
the map: metro and tram disappear entirely and only GPS-sourced vehicles remain.
Rebuilding at 04:45 leaves the night covered by yesterday's generation and swaps
in the new day once night service has ended.

The pipeline picks the service date that is *currently running*, not the
calendar date: before 04:00 Oslo it builds yesterday's, because that is the day
whose 24:00-27:00 trips are on the road right now. So a manual `npm run
build:data` is safe at any hour. `--date=` still overrides it.
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
curl -s https://$SITE_ADDRESS/health | jq
# public callers get {ok, serviceDate, generatedAt} only

docker compose exec -T server node -e \
  "fetch('http://127.0.0.1:8787/health').then(r=>r.json()).then(h=>console.log(JSON.stringify(h,null,2)))"
# from inside the container you get counts, rt, gps, clients, vehicles

curl -sI -H 'Sec-Fetch-Site: same-origin' https://$SITE_ADDRESS/data/meta.json | grep -i cache-control
# public, max-age=300, s-maxage=3600, stale-while-revalidate=86400

curl -s -H 'Sec-Fetch-Site: same-origin' \
  "https://$SITE_ADDRESS/stops/NSR%3AStopPlace%3A58163/departures?limit=3" | jq

curl -s -o /dev/null -w '%{http_code}\n' https://$SITE_ADDRESS/data/meta.json
# 403 - a request with no browser context is refused

docker compose ps
docker stats --no-stream
journalctl -u byradar-refresh.service -n 50
```

`serviceDate` in `/health` must be today's Oslo date. If it is yesterday's, the
nightly job did not run or the pipeline failed; check the journal.

## Access control

`/data/*`, `/stops/*`, `/vehicles/*` and `/live` are for the site's own frontend,
not for other callers. What enforces that:

| Control | Env | Default |
| --- | --- | --- |
| CORS allowlist (no more origin reflection) | `ALLOWED_ORIGINS` | own origin + localhost in dev |
| Same-site gate on data and API routes | `STRICT_SAME_SITE` | `true` |
| `/live` refuses a handshake without an allowed `Origin` | `STRICT_SAME_SITE` | `true` |
| Requests per IP per minute, all routes | `RATE_LIMIT_MAX` | 600 |
| Requests per IP per minute, departures and vehicle detail | `API_RATE_LIMIT_MAX` | 90 |
| Live sockets per IP | `MAX_SOCKETS_PER_IP` | 20 |
| Client IP taken from the proxy, one hop | `TRUST_PROXY_HOPS` | 1 |
| Full `/health` for loopback or a bearer token | `ADMIN_TOKEN` | unset (loopback only) |
| Journey Planner fallback for stops with no local timetable | `REMOTE_BOARDS` | `true` |

`ALLOWED_ORIGINS` is a comma-separated list; a bare hostname is read as `https://`.
Leave it empty when the frontend is served from the same origin as the API, which
is the case in this compose file: the request's own origin always passes.

Set `ADMIN_TOKEN` only if you want `/health` diagnostics from outside the box;
`provision.sh` and `refresh-data.sh` read them over loopback and need no token.

What this does and does not buy:

- Other websites can no longer call the API or open `/live`. The browser sets
  `Origin` and `Sec-Fetch-Site`, and page JavaScript cannot forge them.
- Bulk scraping now costs a rate limit and a socket cap per IP.
- It does **not** stop someone who copies the headers into `curl` or drives a
  headless browser. The app is public, so its data is reachable by anyone
  willing to imitate a browser. Treat these controls as a cost, not a wall.

`STRICT_SAME_SITE=false` turns the gate off if a client turns out to send none of
`Sec-Fetch-Site`, `Origin` or `Referer`. CORS and the rate limits stay on.

## Choosing the machine

Hetzner's Cost-Optimized line (CX) reads "Currently not available" and is greyed
out in every location, so CPX is what you can actually buy. Prices in the console
include Norwegian VAT:

| Type | vCPU | RAM | Disk | Traffic | Price incl. VAT |
|---|---|---|---|---|---|
| CPX12 | 1 | 2 GB | 40 GB | 20 TB | €14.36/mo |
| CPX22 | 2 | 4 GB | 80 GB | 20 TB | €24.36/mo |
| CPX32 | 4 | 8 GB | 160 GB | 20 TB | €44.36/mo |

Plus €0.63/mo for the IPv4.

CPX22 is the drop-in: the limits below add to 2.6 GB and fit its 4 GB. CPX12's
2 GB cannot hold the server and the pipeline at the same time, so on that plan
the nightly refresh has to stop the server first, trading a few seconds of
restart for about two minutes of downtime.

## Resource budget

`docker-compose.yml` pins `linux/amd64` everywhere. Hetzner is x86_64; a build on
an Apple Silicon Mac would otherwise produce an arm64 image that cannot run on
the box. Emulated amd64 builds work on a Mac and are what the numbers below came
from.

| Container | Limit | Measured |
|---|---|---|
| server | 896 MB | 335 MB running in the container on the real feed |
| caddy | 256 MB | ~30 MB |
| pipeline | 1536 MB | completes at a 768 MB limit, dies at 512 MB |

Image size, since the available commands disagree and it is worth knowing which
is which:

```sh
docker images --format '{{.Size}}' byradar:latest   # 441 MB, sum of layer sizes
docker run --rm --entrypoint sh byradar:latest -c 'du -sx -m /'   # 320 MB on disk
```

Read `docker images` immediately after a build and it can report a much smaller
number, because the layers are not materialised yet. Take the reading after the
image has been run at least once.

The runtime stage installs only the server and pipeline workspaces. The web
bundle is prebuilt, so deck.gl and maplibre have no business in the image:
including them cost 119 MB of `node_modules` for code that is never loaded.

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

and replace the `encode` line in `caddy/Caddyfile`'s site block with:

```
	tls /certs/origin.pem /certs/origin.key
	encode zstd gzip
```

Either way, turn on Cloudflare's WebSocket support (on by default on all plans)
or `/live` will not connect.

Cloudflare caches `/data/*` for an hour (`s-maxage=3600`) and `/assets/*` forever,
which is where most of the egress saving comes from. `/live` and `/health` are not
cacheable and pass through.

Guarded responses carry `Vary: Origin, Sec-Fetch-Site` so a cached copy is not
handed to a request the origin would have refused. Cloudflare only honours `Vary`
on `Accept-Encoding` for free plans, so on a free plan a cached `/data/*` file is
served to any caller regardless of headers. The gate still protects `/live` and
the API routes, which are never cached.

## Day-to-day

```sh
docker compose logs -f server
docker compose restart server
./refresh-data.sh                     # rebuild the timetable now
docker compose --profile tools run --rm pipeline npm run -w @byradar/pipeline start:force
docker compose build && docker compose up -d   # after a git pull
```

`start:force` re-downloads the GTFS zips instead of reusing the cached ones.
`DATA_DIR` sends pipeline output somewhere other than `/app/data`, which is how
`refresh-data.sh` stages a run.

## Deploying from GitHub Actions

`.github/workflows/deploy.yml` runs on every push to `main` and on `workflow_dispatch`.
It does no building of its own: it SSHes in and lets the box do the work, which takes
about 15 seconds of Vite build plus a container roll.

Repository secrets it needs:

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_KEY` | private half of a deploy-only ed25519 key |
| `DEPLOY_KNOWN_HOSTS` | `<ip> ssh-ed25519 AAAA...` from `ssh-keyscan -t ed25519 <ip>` |
| `DEPLOY_HOST` | the box's IP |
| `DEPLOY_USER` | `root` |

The key is **not** a general shell key. Its `authorized_keys` entry pins a forced
command, so whatever the client asks for, sshd runs the deploy and nothing else:

```
command="/usr/local/bin/byradar-deploy",restrict ssh-ed25519 AAAA... byradar-ci-deploy
```

`restrict` drops port, agent and X11 forwarding, the pty and user rc files. Verify it
by asking for something else and watching a deploy happen instead:

```sh
ssh -o IdentitiesOnly=yes -i ci_deploy root@<ip> id
```

`/usr/local/bin/byradar-deploy` deliberately lives **outside** the git tree. It copies
`deploy/ci-deploy.sh` to a temp file and runs the copy, so the `git reset --hard` inside
the deploy cannot rewrite the script that is executing. `provision.sh` installs it.

Rotating the key: `ssh-keygen -t ed25519 -N '' -f ci_deploy`, replace the line in
`~/.ssh/authorized_keys` on the box, then `gh secret set DEPLOY_SSH_KEY < ci_deploy`.

### Why the Caddyfile is in a directory

`deploy/caddy/Caddyfile` is mounted as `./caddy:/etc/caddy:ro`, a **directory**, not a
single file. A single-file bind mount pins the container to that file's inode, and
`git reset --hard` writes a replacement file with a new inode, so the container keeps
serving the old config and `caddy reload` cheerfully reloads the stale copy. Mounting
the directory means the deploy's reload actually sees the new config.

### What the deploy guarantees

`ci-deploy.sh` records the commit it started from. If `/health` does not answer `ok`
within 200 seconds of the roll, it prints the last 60 lines of server logs, resets to
that commit, rebuilds and rolls back. So a broken commit costs a restart, not the site.

It does **not** rebuild the timetable. Data comes from the nightly 04:45 timer, or from
`./refresh-data.sh` when the pipeline itself changed.
