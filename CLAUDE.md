# Byradar

Live transit map for Oslo. Public at https://byradar.no. The GitHub repo is private, so nothing on the site should point at it.

## Workflow: no pull requests

This repo overrides the global worktree and PR rules.

- **Never open a pull request.** Commit and push straight to `main`. This is standing approval, so do not ask for it each time.
- **Pushing to `main` is the deploy.** The `deploy` GitHub Action builds and rolls the server on every push. Do not deploy by hand.
- After pushing, watch the run and confirm it went green: `gh run watch $(gh run list -w deploy -L1 --json databaseId -q '.[0].databaseId')`.
- No worktrees, no feature branches. Work directly on `main`.
- Commit at logical checkpoints so a dead session does not lose work.
- Verify before pushing: typecheck and build the workspaces you touched.

## Deploy

The box is `root@62.238.4.31` (Hetzner CPX12, Helsinki, Ubuntu 24.04), key `~/.ssh/id_ed25519`, source at `/opt/byradar`.

CI runs `/usr/local/bin/byradar-deploy`, which runs `deploy/ci-deploy.sh`: fetch `origin/main`, `git reset --hard`, `docker compose build`, `docker compose up -d`, then poll `/health`. A build that comes up unhealthy is rolled back to the previous commit automatically. One deploy at a time, held by `flock`.

Re-run a deploy without a new commit: `gh workflow run deploy`.

Manual fallback if Actions is down:

```sh
ssh root@62.238.4.31 byradar-deploy
```

Then confirm:

```sh
curl -s https://byradar.no/health
```

## Timetable data

The timetable covers all of Norway and is built **off the box**. The `data` GitHub Action runs the pipeline on a runner nightly at 03:15 UTC, pipes the artifacts over SSH, and `deploy/apply-data.sh` swaps them in and restarts the server. A normal code deploy does not touch the data.

```sh
gh workflow run data                  # rebuild now
gh workflow run data -f date=20260914 # rebuild a specific service day
gh run watch $(gh run list -w data -L1 --json databaseId -q '.[0].databaseId')
```

`deploy/refresh-data.sh` still builds on the box, but it needs ~1.2 GB of RAM and stops the server for the duration. Emergency use only.

## Things to know before touching prod

- Images are pinned to `linux/amd64`. Build on the box, not on the Mac, where it emulates.
- The box is 1 vCPU / 2 GB. The server holds the national day in about 350 MB; do not add work to the 2 s tick without measuring.
- `VITE_MAPTILER_KEY` is baked in at image build time. Changing it means a rebuild, not a restart.
- API routes live at the domain root: `/health`, `/vehicles/:vid`, `/stops/:stopPlaceId/departures`, `/situations`, `/feedback`, `/live`, `/geocode`, `/place`, `/place/commute`. There is no `/api` prefix.
- `/geocode` proxies Enturs geocoder and `/place/commute` proxies Journey Planner, both with their own cache and circuit breaker. `/place` is local computation over the ingested timetable, plus one Journey Planner board per nearby rail stop place (Ruter stop times carry no train departures). Those rail boards are cached for six hours per stop place and day, so a warm `/place` answers in single-digit milliseconds and a cold one with a station nearby takes 100-250 ms. All three routes are same-origin guarded and rate limited to 30 requests per minute per IP.
- Rider feedback lands in `data/feedback/feedback.jsonl` on the `data` volume. Read it with `GET /feedback` as admin (loopback on the box, or `ADMIN_TOKEN` bearer). `refresh-data.sh` only swaps `data/server` and `data/web`, so the file survives a rebuild.
- After midnight Oslo, `serviceDate` trailing the calendar date by one day is correct. Night service belongs to the previous service day.
- Drawn bus lines are tiled: `data/web/net/<x>-<y>.json` plus an index, fetched per viewport from zoom 9.5. Rail, metro, tram and ferry ship whole in `network.json`.
- Live vehicles and modelled trips are deduped on the journey id, and vehicles are keyed by journey: several operators reuse `vehicleId` across journeys.
- `refresh-data.sh` stages a generation and rolls back on failure, so a failed rebuild never reaches live data.
