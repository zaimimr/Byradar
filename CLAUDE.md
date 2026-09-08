# Byradar

Live transit map for Oslo. Public at https://byradar.no, source at https://github.com/zaimimr/byradar.

## Workflow: no pull requests

This repo overrides the global worktree and PR rules.

- **Never open a pull request.** Commit and push straight to `main`. This is standing approval, so do not ask for it each time.
- **Always deploy after pushing.** A push that is not deployed is not done.
- No worktrees, no feature branches. Work directly on `main`.
- Commit at logical checkpoints so a dead session does not lose work.
- Verify before pushing: typecheck and build the workspaces you touched.

## Deploy

The box is `root@62.238.4.31` (Hetzner CPX12, Helsinki, Ubuntu 24.04), key `~/.ssh/id_ed25519`, source at `/opt/byradar`.

Standard deploy after a push:

```sh
ssh root@62.238.4.31 'cd /opt/byradar && git pull && cd deploy && docker compose build && docker compose up -d'
```

Then confirm the deploy landed:

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
- API routes live at the domain root: `/health`, `/vehicles/:vid`, `/stops/:stopPlaceId/departures`, `/live`. There is no `/api` prefix.
- After midnight Oslo, `serviceDate` trailing the calendar date by one day is correct. Night service belongs to the previous service day.
- `refresh-data.sh` stages a generation and rolls back on failure, so a failed rebuild never reaches live data.
