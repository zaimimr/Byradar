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

Rebuild the timetable only when the pipeline or its inputs changed:

```sh
ssh root@62.238.4.31 'cd /opt/byradar/deploy && ./refresh-data.sh'
```

The nightly systemd timer already rebuilds the data at 04:45 Oslo time, so a normal code deploy does not need a manual refresh.

## Things to know before touching prod

- Images are pinned to `linux/amd64`. Build on the box, not on the Mac, where it emulates.
- `VITE_MAPTILER_KEY` is baked in at image build time. Changing it means a rebuild, not a restart.
- API routes live at the domain root: `/health`, `/vehicles/:vid`, `/stops/:stopPlaceId/departures`, `/situations`, `/feedback`, `/live`. There is no `/api` prefix.
- Rider feedback lands in `data/feedback/feedback.jsonl` on the `data` volume. Read it with `GET /feedback` as admin (loopback on the box, or `ADMIN_TOKEN` bearer). `refresh-data.sh` only swaps `data/server` and `data/web`, so the file survives a rebuild.
- After midnight Oslo, `serviceDate` trailing the calendar date by one day is correct. Night service belongs to the previous service day.
- `refresh-data.sh` stages a generation and rolls back on failure, so a failed rebuild never reaches live data.
