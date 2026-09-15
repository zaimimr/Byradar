# Deploying Byradar

Byradar shares a Hostup XS VPS (2 vCPU, 4 GB RAM, 50 GB disk) with ZHouse.
Caddy binds only the public IPv4 address on ports 80 and 443 and reverse-proxies
the Node server that serves the web bundle, static timetable data and `/live`
WebSocket. ZHouse stays on its private Tailscale routes.

The timetable covers all of Norway, and building it needs more machine than the
box has, so the nightly build runs in GitHub Actions and ships the finished
artifacts over private Tailscale SSH.

```
Public DNS -> Hostup public IP :443 -> Caddy -> server :8787 -> data volume
                                                           ^
                                                           |
                     GitHub Actions "data" workflow over Tailscale (nightly)
                     builds, ships, and apply-data.sh swaps it in
```

## Provision

The shared Hostup installation and cutover are documented in
[`HOSTUP.md`](HOSTUP.md). `provision.sh` remains for a fresh standalone Ubuntu
24.04 VPS with at least 2 GB RAM. It is safe to re-run there:

```sh
curl -fsSL https://raw.githubusercontent.com/zaimimr/byradar/main/deploy/provision.sh -o provision.sh
bash provision.sh          # first run stops and tells you to fill in deploy/.env
$EDITOR /opt/byradar/deploy/.env
bash provision.sh          # second run builds, seeds the data and starts everything
```

It sets the timezone, installs Docker, clones to `/opt/byradar`, refuses to
continue while `.env` still holds placeholder values, builds, runs the pipeline
once only if the data volume is empty, starts the stack, removes the retired
on-box refresh timer and waits for `/health`.

The manual equivalent, if you would rather do it by hand:

1. Create the box with Ubuntu 24.04, then on it:

   ```sh
   timedatectl set-timezone Europe/Oslo
   apt-get update && apt-get install -y ca-certificates curl git
   apt-get install -y docker.io docker-compose-v2
   ```

   The timezone matters: logs and the pipeline's service date both follow the
   Oslo calendar day.

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

4. Point an A record at the public IPv4. Set `PUBLIC_BIND_IP` in `deploy/.env`
   when sharing a machine with private services. If using Cloudflare, keep the
   record DNS only until Caddy has issued a certificate. See "Cloudflare" below.

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

The first pipeline run on the box downloads Entur's national GTFS aggregate,
about 590 MB zipped and 3.4 GB extracted into the `cache` volume, and needs
roughly 1.2 GB of RAM. On a 2 GB box stop the server first. It is usually easier
to skip this entirely and trigger the data workflow instead:

```sh
gh workflow run data
```

## Nightly data

The `data` workflow builds the timetable on a GitHub runner (4 vCPU, 16 GB) and
ships it to the box:

1. `npm run -w @byradar/pipeline start -- --force` writes `data/server` and
   `data/web`, about 145 MB, 45 MB packed.
2. `scp` drops the tarball in `/tmp` on the box.
3. `deploy/apply-data.sh` unpacks it into `/app/data/.staging`, checks every
   expected artifact is present and non-empty, moves the live generation aside to
   `/app/data/.previous`, swaps staging in and restarts the server. If `/health`
   does not come back within 150 s it puts `.previous` back and restarts again.

It fires at **03:15 UTC**, which is 04:15 or 05:15 Oslo depending on the season.

The hour matters and is not arbitrary. GTFS puts trips that run past midnight in
the *previous* service day, as hours 24:00-27:00, and the server loads exactly
one service date. So between midnight and the end of night service the running
vehicles belong to yesterday's build, and rebuilding during that window empties
the map. Building after 04:00 Oslo leaves the night covered by yesterday's
generation and swaps the new day in once night service has ended.

Run it by hand, optionally for a given day:

```sh
gh workflow run data
gh workflow run data -f date=20260914
gh run watch $(gh run list -w data -L1 --json databaseId -q '.[0].databaseId')
```

The old on-box `byradar-refresh.timer` is retired; `provision.sh` removes it.
`refresh-data.sh` still works as an emergency fallback, but it stops the server
for the length of the build and needs the whole box to itself.

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

Neither path lets a failed run reach the live data:

1. The build happens somewhere else entirely, or into `data/.staging` on the box
   (`DATA_DIR` override). A crash partway leaves the live generation whole.
2. The swap checks every expected artifact is present and non-empty, moves the
   live generation aside to `data/.previous`, and moves staging into place. If
   either move fails it rolls back on the way out.
3. Only after a clean swap does the server restart, and a server that does not
   come back healthy gets the previous generation put back under it.

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
gh run list -w data -L 5
```

`serviceDate` in `/health` must be today's Oslo date, except between midnight and
04:00 when yesterday's is correct. If it is stale in the middle of the day the
nightly workflow failed; check `gh run list -w data`.

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
`provision.sh`, `refresh-data.sh` and `apply-data.sh` read them over loopback and
need no token.

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

The shared Hostup XS has 2 vCPU, 4 GB RAM, 50 GB disk and 2 TB monthly traffic.
The national timetable fits because the pipeline runs in GitHub Actions. The
server settles around 350 to 450 MB resident, and the VPS never needs to hold
the 3.4 GB extracted feed. Keep the pipeline off this shared machine.

## Resource budget

`docker-compose.yml` pins `linux/amd64` everywhere. Hostup is x86_64; a build on
an Apple Silicon Mac would otherwise produce an arm64 image that cannot run on
the box. Emulated amd64 builds work on a Mac and are what the numbers below came
from.

| Container | Limit | Measured on the national timetable |
|---|---|---|
| server | 896 MB | 313 MB on a weekday build, 344 MB on a Saturday |
| caddy | 256 MB | ~30 MB |
| pipeline | 1700 MB | 1.18 GB peak, weekday, emergency use only |

A weekday national day is 3620 routes, 74 564 trips, 1.85 M stop calls, 4.4 M
shape points after simplification, and 50 259 stop places served. On disk that is
53 MB of `shapes.bin`, 37 MB of `trips.bin` and 36 MB of web data including the
bus tiles. Loading it takes about 4 s and building the departure index 200 ms.

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

The pipeline holds the whole day in memory while it works: every shape point of
every trip that runs, 22.4 M of them before simplification, in flat typed arrays.
`/usr/bin/time -l` on darwin/arm64 reports a 1.18 GB peak footprint on a weekday.
Much of a cgroup's reported peak is page cache from streaming 3.4 GB of GTFS
text, which the kernel reclaims under pressure, so the cgroup number tracks
whatever limit it is given rather than the requirement.

This is why the nightly build moved to a GitHub runner. The box can still do it
in an emergency with the server stopped, which is what `refresh-data.sh` does,
but it leaves almost no margin on 2 GB.

If a run is ever OOM-killed the script exits non-zero, the swap never happens,
and the server keeps serving the timetable it already has.

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
gh workflow run data                  # rebuild the timetable off-box, the normal way
./refresh-data.sh                     # rebuild on the box, emergency only
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
| `DEPLOY_KNOWN_HOSTS` | Hostup's verified SSH host key, prefixed with its Tailscale IP |
| `DEPLOY_HOST` | `100.113.84.36` |
| `DEPLOY_USER` | `root` |
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client ID with `auth_keys` write scope for `tag:ci` |
| `TS_OAUTH_SECRET` | Secret for that OAuth client |

The same key and secrets drive `.github/workflows/data.yml`, which ships the
nightly timetable. The runner joins the tailnet as an ephemeral `tag:ci` node,
which can reach only Hostup's SSH port. Public SSH stays closed.

The key is **not** a general shell key. Its `authorized_keys` entry pins a forced
command, so whatever the client asks for, sshd runs one of two things and nothing
else:

```
command="/usr/local/bin/byradar-ci",restrict ssh-ed25519 AAAA... byradar-ci
```

`byradar-ci` reads `SSH_ORIGINAL_COMMAND`: an empty command or `deploy` rolls the
server, `data` reads a tarball from stdin and hands it to `apply-data.sh`, and
anything else is refused. Shipping data over stdin rather than `scp` keeps the
forced command intact; `scp` would need its own subsystem carve-out.

`restrict` drops port, agent and X11 forwarding, the pty and user rc files. Verify it
by asking for something else and watching a deploy happen instead:

```sh
ssh -o IdentitiesOnly=yes -i ci_deploy root@<ip> id
```

`/usr/local/bin/byradar-deploy` and `/usr/local/bin/byradar-ci` deliberately live
**outside** the git tree. The first copies `deploy/ci-deploy.sh` to a temp file and runs
the copy, so the `git reset --hard` inside the deploy cannot rewrite the script that is
executing. `provision.sh` installs both.

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
