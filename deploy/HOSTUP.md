# Hostup production

Byradar shares the Hostup XS VPS at `136.148.218.183` with ZHouse. Admin SSH
uses the private Tailscale address `100.113.84.36`. Caddy publishes only the
public IPv4 on ports 80 and 443. Nginx, Home Assistant and the ZHouse dashboard
remain on their private Tailscale routes.

The source and configuration are at `/opt/byradar`. `deploy/.env` is mode 600
and sets `PUBLIC_BIND_IP=136.148.218.183`. Docker is installed from Ubuntu's
`docker.io` and `docker-compose-v2` packages. The `byradar_data` volume holds
the current timetable, previous generation and feedback. The
`byradar_caddy_data` volume holds the HTTPS certificates. The Hostup GitHub
deploy key is read only, and the CI SSH key runs only `/usr/local/bin/byradar-ci`.

The `data` GitHub Action builds the timetable each night off the VPS. Both
GitHub Actions join Tailscale as ephemeral `tag:ci` nodes. The tailnet policy
allows this tag to reach only `100.113.84.36` on TCP port 22. Hostup's public
SSH port remains blocked.

## Cutover

1. Confirm the Hostup origin before changing DNS:

   ```sh
   curl --resolve byradar.no:443:136.148.218.183 https://byradar.no/health
   curl --resolve www.byradar.no:443:136.148.218.183 -I https://www.byradar.no/
   ssh root@100.113.84.36 'cd /opt/byradar/deploy && docker compose ps'
   ```

2. Set `DEPLOY_HOST=100.113.84.36` and replace `DEPLOY_KNOWN_HOSTS` with the
   Hostup SSH host key prefixed by `100.113.84.36`. Keep the existing
   `DEPLOY_SSH_KEY` and `DEPLOY_USER=root`. Set `TS_OAUTH_CLIENT_ID` and
   `TS_OAUTH_SECRET` from the Tailscale OAuth credential scoped to `auth_keys`
   write for `tag:ci`.

3. Merge the migration PR. Its `deploy` workflow must reach Hostup through
   Tailscale and pass the origin health check. Run the `data` workflow once and
   confirm its service date on the Hostup origin.

4. In Webhuset DNS, change the A records for `byradar.no` and
   `www.byradar.no` from `62.238.4.31` to `136.148.218.183`. Both current
   records have a 600-second TTL. Check `ns.datacenter.no`,
   `ns2.datacenter.no`, and public resolvers before treating the switch as
   complete.

5. Check the public `/health` route, `/live` WebSocket, map tiles, the
   `www` redirect and the private ZHouse routes. Leave the Hetzner instance
   available for rollback until the next scheduled data refresh succeeds.

## Rollback

Restore both Webhuset A records to `62.238.4.31`. Set `DEPLOY_HOST` and
`DEPLOY_KNOWN_HOSTS` back to the Hetzner values. The previous timetable and
feedback remain on the Hetzner Docker volume while that server stays running.
Avoid cancelling Hetzner until the Hostup instance has passed the first daily
refresh and a backup and restore check.
