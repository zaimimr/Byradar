# Byradar

Live map of Oslo's public transport network: every metro, tram, bus, ferry and train line, with vehicles moving in real time.

Inspired by [openbaarvervoerbelgie.be](https://openbaarvervoerbelgie.be), built on Norwegian open data.

## What it shows

- **Boligsjekk** on any address or map point: a 0-100 score for the transit on offer around it, the stops within walking distance with their weekday-morning frequency, the day's departure rhythm, and door-to-door travel times for a weekday 08:00 departure. Built for house hunting, and the URL carries the point so a check can be sent to someone else
- **Feedback page** at `/tilbakemelding`, carrying the map view you came from so a report says where you were looking
- **206 lines** in the Oslo core, drawn from real route geometry with each operator's own line colours
- **~750-850 vehicles** in motion at peak, drawn two ways: zoomed out, an upright bubble carrying the mode pictogram, the line number and a small arrow for heading; past zoom 16.8, the vehicle's true-scale footprint aligned to the street
- **Punctuality edge** on every vehicle: blue early, green within 3 min, amber 3-7 min late, red beyond
- **Vehicle inspector**: click any vehicle for its line, destination, live deviation and the next stops with scheduled vs. expected times
- **City pulse**: bar height is how many vehicles are running, bar colour is how punctual the network is right now
- **3D buildings** on tilt, extruded from real OSM heights via MapTiler's vector tiles
- **Search** over every line, stop and Norwegian address in one box, folding `æøå` so `majorstua` finds Majorstuen; picking a line filters the map to it, picking a stop opens its board, picking an address opens the boligsjekk
- **Departure boards** on any stop, merging live and scheduled departures across every quay that shares the stop's name
- **Find my position**, with an accuracy circle and a readable message when the fix is denied, unavailable or outside Oslo
- **Follow a vehicle**, which locks the camera to it and isolates its line so only that corridor stays drawn. Ends on a map drag, `Esc`, the button, or when the vehicle leaves traffic, and any line filter you had is put back

## The data problem, and what this does about it

Ruter does not publish vehicle GPS. Their position feed is an operator-only MQTT service, and the `RUT` codespace is absent from Entur's public SIRI-VM and GTFS-RT vehicle-positions feeds entirely.

So vehicles come from two different places, and the interface always says which:

| Badge | Source | Applies to |
|-------|--------|-----------|
| `GPS` | Real reported position via Entur's vehicle-positions API | Vy trains, Flytoget, regional buses |
| `EST` | Position computed along the route's own geometry from the timetable, shifted by live per-stop deviations from GTFS-RT trip-updates | Ruter metro, tram, bus, ferry |

`EST` positions are on-route and delay-accurate: they use `shape_dist_traveled` from the timetable to place a vehicle at the exact metre along its own shape, then interpolate between the adjusted departure of the last stop and adjusted arrival at the next. What they cannot know is where a vehicle sits *between* stop-time reports, so a bus stuck in traffic mid-segment will drift ahead of its true position until the next stop update corrects it.

Measured against the raw feed, the modelled deviations track reality: an independent recompute gave a median of 155 s and mean of 201 s for in-motion Ruter trips where the running engine reported 150 s and 193 s.

### Heading and map rotation

deck.gl draws `IconLayer` icons as screen-space billboards, so `getAngle` and `getPixelOffset` are in **screen** space and are not compensated for map rotation. Passing a world bearing straight through leaves every vehicle off by exactly the map's bearing, which is invisible when testing an unrotated map. Screen angle is therefore `mapBearing - vehicleBearing`, and the arrow's pixel offset is rotated by `-mapBearing`.

Heading itself comes from a least-squares fit of the route geometry over a ~26 m window centred on the vehicle. A short two-point tangent picks up stop lay-bys and lane offsets and tilts the vehicle by 20-30 degrees on a straight street; a long lookahead crosses corners on Kvadraturen's 65 m blocks. The fit averages the noise without reaching past a corner.

Verified by measuring rendered pixels rather than trusting the code: crop each marker, take the principal axis of its pixels, compare with the expected screen angle. Median error is 1.9 degrees unrotated and about 5 degrees at map bearings of 40 and -65.

### Keeping motion continuous

A delay correction must change a vehicle's *velocity*, never its *position*. Every 30 s the `trip-updates` poll lands and the schedule-derived position can shift by hundreds of metres at once; done naively that jolts the whole map in unison. Two mechanisms prevent it:

- **Server-side slew limiting.** Position along the route is rate-limited: normal progress plus at most 14 m/s of catch-up, 7 m/s of drift-back, and a hard reset only past 1.5 km. A 300 m correction dissolves over ~20 s of imperceptibly fast running instead of a one-second lurch.
- **Per-vehicle glide windows.** The browser interpolates each vehicle against its own observed update rate rather than a fixed tick, so Ruter vehicles glide over 1 s and GPS vehicles polled every 8 s glide over 8 s instead of freezing then jumping. Anything faster than 80 m/s for the elapsed window snaps rather than sliding.

Measured over 50 consecutive ticks: median movement holds 5.6-7.0 m/s with no synchronised spike, no tick moves more than one vehicle over 250 m, and the page holds 60 fps in both 2D and tilted 3D.

### Train destinations

Vy never populates `destinationName` on the realtime feed - it is null for every rail vehicle - but each one carries a `serviceJourney` or `datedServiceJourney` id. Destinations resolve in three tiers:

1. `trip_headsign` from the ingested Vy/Flytoget GTFS, keyed by journey id (~1360 journeys, no network call)
2. Journey Planner v3 `datedServiceJourney`/`serviceJourney` lookup for journeys added after the GTFS snapshot, cached in memory with negative caching and request spacing
3. The line's own name as a last resort, so nothing ever reads "unknown destination"

## Feedback

`/tilbakemelding` is the place riders report a bus in the fjord, a missing line or times that do not match. The map's attribution bar links there and carries the current view along, so a report arrives with the exact hash the reporter was looking at.

`POST /feedback` takes `{kind, message, place, contact, view}`, is same-site guarded, capped at 10 posts per 10 minutes per IP, and appends one JSON line to `data/feedback/feedback.jsonl` on the docker volume, which the nightly timetable refresh never touches. A hidden `nettsted` field swallows bots: the post is accepted and thrown away. Nothing else is stored, no IP, no user agent.

Read the inbox as admin, over loopback on the box or with `ADMIN_TOKEN`:

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" 'https://byradar.no/feedback?limit=50'
```

Set `FEEDBACK_WEBHOOK_URL` to also push each entry to a Slack or Discord webhook. `FEEDBACK_DIR`, `FEEDBACK_MAX_BYTES`, `FEEDBACK_RATE_MAX` and `FEEDBACK_RATE_WINDOW_MS` tune the rest.

## Data sources

| Feed | Use | Refresh |
|------|-----|---------|
| Entur GTFS per codespace (`RUT`, `VYG`, `FLT`, `OST`, `NBU`) | Line geometry, timetables, stops | Daily |
| Entur GTFS-RT `trip-updates` | Live per-stop deviations for Ruter | 30 s |
| Entur vehicle-positions GraphQL (`realtime/v2`) | Real GPS in the Oslo bounding box | 8 s |
| Entur Journey Planner v3 | Destination lookup for journeys missing from the GTFS snapshot | on demand, cached |
| MapTiler `dataviz-v4-dark` | Basemap | — |

`RUT` is the only feed used to generate moving vehicles. The others contribute line geometry only, since their vehicles already report real GPS and would otherwise be drawn twice.

One consequence is visible in the UI: only Ruter is ingested with stop times, so 30 rail-only stop places, Oslo S among them, have no timetable behind them at all. Their departure board says so plainly rather than rendering an empty list, and a stop that serves both trains and buses shows its buses alongside a note naming the mode that is missing.

## Running it

```bash
npm install
cp .env.example .env      # add your MAPTILER_KEY
npm run build:data        # downloads GTFS, writes data/web + data/server (~90 s cold)
npm run dev               # server on :8787, web on :5173
```

Without a MapTiler key the basemap falls back to CARTO dark-matter, which needs no key.

### Refreshing the timetable

`data/` is generated and gitignored. Regenerate it daily, after Entur publishes (~06:00 Oslo):

```bash
0 5 * * * cd /path/to/Byradar && npm run build:data && systemctl restart byradar
```

Pass `--force` to bypass the 6-hour zip cache, or `--date=2026-09-14` to build a different service date.

## Deploying

`deploy/` holds a single-box setup: multi-stage Dockerfile, compose file, Caddy for automatic TLS, and a systemd timer that refreshes the timetable nightly. The refresh stages a whole generation into `data/.staging`, verifies all 13 artifacts, keeps the previous one in `data/.previous`, and restarts the server only after a clean swap, so a failed run leaves the box on the timetable it already had.

The image must be built for `linux/amd64`; the compose file pins it so a build on an arm64 Mac cannot silently ship the wrong architecture. See `deploy/README.md` for provisioning and the measured memory budget.

## Layout

```
packages/pipeline   GTFS -> line geometry, stop list, binary timetable index
packages/server     Fastify + WebSocket; polls live feeds, computes positions at 1 Hz
packages/web        MapLibre GL basemap + deck.gl layers, vanilla TS chrome
data/               generated artifacts (web/ is served to the browser, server/ stays local)
```

The server holds the whole service day in memory as typed arrays: 14 849 trips, 380 686 stop calls, 600 shapes. A tick recomputes every active vehicle in 11-14 ms and broadcasts a 16-byte record per vehicle over WebSocket, so the browser receives ~12 KB per update rather than JSON.

### URL state

The hash carries the full view, so any map state is linkable:

```
#lon=10.7522&lat=59.9139&z=12.2&modes=metro,tram,rail&stops=0&pitch=52&buildings=1
```

`modes`, `lines`, `stops`, `labels`, `buildings`, `pitch` and `brg` are all optional. Buildings need a vector basemap that carries a `building` source-layer; the toggle hides itself when the basemap has none.

## Known limitations

- **Tunnel geometry.** Ruter and Vy shapes have no intermediate points inside tunnels, so a 734 m metro tunnel or the 20 km Blix tunnel renders as a straight chord across the map. That is the source data, not a rendering fault, and it is left as-is rather than invented.
- **Shared trunks.** Five metro lines run the same central tunnel, so the trunk reads heavier than a branch. Parallel line offsetting is not implemented.
- **Mode colour vs. line colour.** The mode filter swatches use one colour per mode, but lines are drawn in each operator's real colours, so Vy's red R-lines appear under the green "Tog" swatch.
- **Bandwidth.** `trip-updates` is a 13 MB national feed with no gzip and no working delta polling (`requestorId` is ignored), so a 30 s poll moves ~37 GB/day server-side. Raise `RT_POLL_MS` if that matters.
- **Scope.** Bounding box is the Oslo core, so Lillestrøm, Ski and Asker are cut.

## Attribution

Data from [Entur](https://developer.entur.org) and [Ruter](https://ruter.no) under NLOD. Basemap © [MapTiler](https://www.maptiler.com/copyright/), © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
