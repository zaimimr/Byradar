# Oslo Kollektiv

Live map of Oslo's public transport network: every metro, tram, bus, ferry and train line, with vehicles moving in real time.

Inspired by [openbaarvervoerbelgie.be](https://openbaarvervoerbelgie.be), built on Norwegian open data.

## What it shows

- **206 lines** in the Oslo core, drawn from real route geometry with each operator's own line colours
- **~750-800 vehicles** in motion at peak, each a chevron pointing the way it is travelling
- **Punctuality ring** around every vehicle: blue early, green within 3 min, amber 3-7 min late, red beyond
- **Vehicle inspector**: click any vehicle for its line, destination, live deviation and the next stops with scheduled vs. expected times
- **City pulse**: bar height is how many vehicles are running, bar colour is how punctual the network is right now
- **3D buildings** on tilt, extruded from real OSM heights via MapTiler's vector tiles

## The data problem, and what this does about it

Ruter does not publish vehicle GPS. Their position feed is an operator-only MQTT service, and the `RUT` codespace is absent from Entur's public SIRI-VM and GTFS-RT vehicle-positions feeds entirely.

So vehicles come from two different places, and the interface always says which:

| Badge | Source | Applies to |
|-------|--------|-----------|
| `GPS` | Real reported position via Entur's vehicle-positions API | Vy trains, Flytoget, regional buses |
| `EST` | Position computed along the route's own geometry from the timetable, shifted by live per-stop deviations from GTFS-RT trip-updates | Ruter metro, tram, bus, ferry |

`EST` positions are on-route and delay-accurate: they use `shape_dist_traveled` from the timetable to place a vehicle at the exact metre along its own shape, then interpolate between the adjusted departure of the last stop and adjusted arrival at the next. What they cannot know is where a vehicle sits *between* stop-time reports, so a bus stuck in traffic mid-segment will drift ahead of its true position until the next stop update corrects it.

Measured against the raw feed, the modelled deviations track reality: an independent recompute gave a median of 155 s and mean of 201 s for in-motion Ruter trips where the running engine reported 150 s and 193 s.

## Data sources

| Feed | Use | Refresh |
|------|-----|---------|
| Entur GTFS per codespace (`RUT`, `VYG`, `FLT`, `OST`, `NBU`) | Line geometry, timetables, stops | Daily |
| Entur GTFS-RT `trip-updates` | Live per-stop deviations for Ruter | 30 s |
| Entur vehicle-positions GraphQL (`realtime/v2`) | Real GPS in the Oslo bounding box | 8 s |
| MapTiler `dataviz-v4-dark` | Basemap | — |

`RUT` is the only feed used to generate moving vehicles. The others contribute line geometry only, since their vehicles already report real GPS and would otherwise be drawn twice.

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
0 5 * * * cd /path/to/OsloMap && npm run build:data && systemctl restart oslomap
```

Pass `--force` to bypass the 6-hour zip cache, or `--date=2026-09-14` to build a different service date.

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
