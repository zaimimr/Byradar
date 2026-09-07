import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gtfsTimeToSeconds, num, readCsv, str } from './csv.js';
import { fetchAndExtractGtfs } from './download.js';
import {
  GTFS_SOURCES,
  MODE_ORDER,
  MODE_WIDTH,
  OSLO_BBOX,
  inBbox,
  modeOfRouteType,
  type GtfsSource,
  type Mode,
} from './config.js';
import { clipRunsToBbox, simplifyLonLat } from './simplify.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const DATA_DIR = join(REPO_ROOT, 'data');
const CACHE_DIR = join(REPO_ROOT, '.cache', 'gtfs');

const CLIP_PAD_DEGREES = 0.03;
const MAX_VARIANTS_PER_DIRECTION = 2;
const MIN_VARIANT_SHARE = 0.2;

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

interface Args {
  force: boolean;
  date: string;
  maxAgeHours: number;
}

function osloDateStamp(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .replace(/-/g, '');
}

function parseArgs(argv: string[]): Args {
  const force = argv.includes('--force');
  const dateArg = argv.find((a) => a.startsWith('--date='));
  const date = dateArg ? dateArg.slice('--date='.length).replace(/-/g, '') : osloDateStamp(new Date());
  return { force, date, maxAgeHours: force ? 0 : 6 };
}

interface RouteRow {
  id: string;
  codespace: string;
  line: string;
  name: string;
  mode: Mode;
  color: string;
  textColor: string;
}

interface TripRow {
  id: string;
  routeId: string;
  shapeId: string;
  dir: number;
  headsign: string;
  interpolate: boolean;
  calls: number[];
}

interface StopPlaceAcc {
  id: string;
  name: string;
  latSum: number;
  lonSum: number;
  quays: number;
}

function haversineMeters(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[2] - a[2]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function normalizeColor(raw: string, fallback: string): string {
  const hex = raw.trim().replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : fallback;
}

const MODE_DEFAULT_COLOR: Record<Mode, string> = {
  metro: '#EC700C',
  tram: '#0B91EF',
  rail: '#1B7A5A',
  bus: '#E60000',
  ferry: '#354F7F',
  other: '#8892A6',
};

class Corpus {
  readonly routes = new Map<string, RouteRow>();
  readonly trips = new Map<string, TripRow>();
  readonly shapePoints = new Map<string, Array<[number, number, number]>>();
  readonly quayLatLon = new Map<string, [number, number]>();
  readonly quayName = new Map<string, string>();
  readonly quayParent = new Map<string, string>();
  readonly stopPlaces = new Map<string, StopPlaceAcc>();
  readonly quayIds: string[] = [];
  private readonly quayIndex = new Map<string, number>();

  internQuay(id: string): number {
    let i = this.quayIndex.get(id);
    if (i === undefined) {
      i = this.quayIds.length;
      this.quayIds.push(id);
      this.quayIndex.set(id, i);
    }
    return i;
  }
}

const WEEKDAY_COLUMNS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

async function resolveServices(dir: string, date: string): Promise<Set<string>> {
  const services = new Set<string>();
  const weekday = WEEKDAY_COLUMNS[
    new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)))).getUTCDay()
  ]!;

  if (await fileExists(join(dir, 'calendar.txt'))) {
    await readCsv(join(dir, 'calendar.txt'), (row, c) => {
      const start = str(row, c.optional('start_date'));
      const end = str(row, c.optional('end_date'));
      if (start && date < start) return;
      if (end && date > end) return;
      if (str(row, c.optional(weekday)) !== '1') return;
      services.add(str(row, c.index('service_id')));
    });
  }

  if (await fileExists(join(dir, 'calendar_dates.txt'))) {
    await readCsv(join(dir, 'calendar_dates.txt'), (row, c) => {
      if (str(row, c.index('date')) !== date) return;
      const id = str(row, c.index('service_id'));
      const exception = str(row, c.index('exception_type'));
      if (exception === '1') services.add(id);
      else if (exception === '2') services.delete(id);
    });
  }

  return services;
}

async function writeArtifact(path: string, data: string | Buffer): Promise<void> {
  const staged = `${path}.staging`;
  await writeFile(staged, data);
  await rename(staged, path);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ingest(corpus: Corpus, source: GtfsSource, args: Args): Promise<void> {
  const dir = await fetchAndExtractGtfs({
    codespace: source.codespace,
    url: source.url,
    cacheDir: CACHE_DIR,
    maxAgeHours: args.maxAgeHours,
    force: args.force,
    log,
  });

  const services = await resolveServices(dir, args.date);
  if (services.size === 0) {
    log(`${source.codespace}: no services on ${args.date} — skipping feed`);
    return;
  }

  let routeCount = 0;
  await readCsv(join(dir, 'routes.txt'), (row, c) => {
    const routeType = num(row, c.index('route_type'), -1);
    const mode = modeOfRouteType(routeType);
    const id = str(row, c.index('route_id'));
    corpus.routes.set(id, {
      id,
      codespace: source.codespace,
      line: str(row, c.index('route_short_name')),
      name: str(row, c.index('route_long_name')),
      mode,
      color: normalizeColor(str(row, c.optional('route_color')), MODE_DEFAULT_COLOR[mode]),
      textColor: normalizeColor(str(row, c.optional('route_text_color')), '#FFFFFF'),
    });
    routeCount++;
  });

  await readCsv(join(dir, 'stops.txt'), (row, c) => {
    const id = str(row, c.index('stop_id'));
    const lat = num(row, c.index('stop_lat'), NaN);
    const lon = num(row, c.index('stop_lon'), NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    corpus.quayLatLon.set(id, [lat, lon]);
    corpus.quayName.set(id, str(row, c.index('stop_name')));
    const parent = str(row, c.optional('parent_station')) || id;
    corpus.quayParent.set(id, parent);
    if (!inBbox(OSLO_BBOX, lat, lon)) return;
    let sp = corpus.stopPlaces.get(parent);
    if (!sp) {
      sp = { id: parent, name: str(row, c.index('stop_name')), latSum: 0, lonSum: 0, quays: 0 };
      corpus.stopPlaces.set(parent, sp);
    }
    sp.latSum += lat;
    sp.lonSum += lon;
    sp.quays++;
  });

  const localTrips = new Set<string>();
  const neededShapes = new Set<string>();
  await readCsv(join(dir, 'trips.txt'), (row, c) => {
    if (!services.has(str(row, c.index('service_id')))) return;
    const shapeId = str(row, c.index('shape_id'));
    if (!shapeId) return;
    const id = str(row, c.index('trip_id'));
    corpus.trips.set(id, {
      id,
      routeId: str(row, c.index('route_id')),
      shapeId,
      dir: num(row, c.optional('direction_id'), 0),
      headsign: str(row, c.optional('trip_headsign')),
      interpolate: source.interpolate,
      calls: [],
    });
    localTrips.add(id);
    neededShapes.add(shapeId);
  });

  let callRows = 0;
  await readCsv(join(dir, 'stop_times.txt'), (row, c) => {
    const tripId = row[c.index('trip_id')] ?? '';
    if (!localTrips.has(tripId)) return;
    const trip = corpus.trips.get(tripId)!;
    const seq = num(row, c.index('stop_sequence'), -1);
    const dist = num(row, c.optional('shape_dist_traveled'), -1);
    if (seq < 0) return;
    const arr = gtfsTimeToSeconds(str(row, c.index('arrival_time')));
    const dep = gtfsTimeToSeconds(str(row, c.index('departure_time')));
    trip.calls.push(
      seq,
      arr < 0 ? dep : arr,
      dep < 0 ? arr : dep,
      dist,
      corpus.internQuay(str(row, c.index('stop_id'))),
    );
    callRows++;
  });

  await readCsv(join(dir, 'shapes.txt'), (row, c) => {
    const id = row[c.index('shape_id')] ?? '';
    if (!neededShapes.has(id)) return;
    const dist = num(row, c.index('shape_dist_traveled'), -1);
    const lat = num(row, c.index('shape_pt_lat'), NaN);
    const lon = num(row, c.index('shape_pt_lon'), NaN);
    if (dist < 0 || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    let arr = corpus.shapePoints.get(id);
    if (!arr) {
      arr = [];
      corpus.shapePoints.set(id, arr);
    }
    arr.push([dist, lat, lon]);
  });

  log(
    `${source.codespace}: ${routeCount} routes, ${localTrips.size} trips, ${callRows} calls, ${neededShapes.size} shapes${source.interpolate ? '' : ' (geometry only)'}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  log(`service date ${args.date}, bbox ${JSON.stringify(OSLO_BBOX)}`);

  const corpus = new Corpus();
  for (const source of GTFS_SOURCES) {
    await ingest(corpus, source, args);
  }
  for (const pts of corpus.shapePoints.values()) {
    let monotonic = true;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i]![0] < pts[i - 1]![0]) {
        monotonic = false;
        break;
      }
    }
    if (!monotonic) pts.sort((a, b) => a[0] - b[0]);
  }
  log(`merged: ${corpus.routes.size} routes, ${corpus.trips.size} trips, ${corpus.shapePoints.size} shapes`);

  const shapeTouchesBbox = new Map<string, boolean>();
  for (const [id, pts] of corpus.shapePoints) {
    shapeTouchesBbox.set(
      id,
      pts.some(([, lat, lon]) => inBbox(OSLO_BBOX, lat, lon)),
    );
  }

  const keptTrips: TripRow[] = [];
  for (const trip of corpus.trips.values()) {
    if (trip.calls.length < 10) continue;
    if (!shapeTouchesBbox.get(trip.shapeId)) continue;
    if (!corpus.routes.has(trip.routeId)) continue;
    keptTrips.push(trip);
  }
  keptTrips.sort((a, b) => (a.id < b.id ? -1 : 1));
  const interpolatedTrips = keptTrips.filter((t) => {
    if (!t.interpolate) return false;
    for (let i = 3; i < t.calls.length; i += 5) {
      if (t.calls[i]! < 0) return false;
    }
    return true;
  });
  log(`trips touching bbox: ${keptTrips.length} (${interpolatedTrips.length} interpolated)`);

  const routeList = [...new Set(keptTrips.map((t) => t.routeId))]
    .map((id) => corpus.routes.get(id)!)
    .sort((a, b) => MODE_ORDER[b.mode] - MODE_ORDER[a.mode] || a.line.localeCompare(b.line, 'nb', { numeric: true }));
  const routeIndex = new Map(routeList.map((r, i) => [r.id, i] as const));
  log(`routes kept: ${routeList.length}`);

  const variantTrips = new Map<string, Map<string, number>>();
  for (const trip of keptTrips) {
    const key = `${trip.routeId}|${trip.dir}`;
    let byShape = variantTrips.get(key);
    if (!byShape) {
      byShape = new Map();
      variantTrips.set(key, byShape);
    }
    byShape.set(trip.shapeId, (byShape.get(trip.shapeId) ?? 0) + 1);
  }

  const network: Array<{ r: number; d: number; m: Mode; w: number; c: string; trips: number; path: number[] }> = [];
  for (const [key, byShape] of variantTrips) {
    const [routeId, dirRaw] = key.split('|') as [string, string];
    const route = corpus.routes.get(routeId)!;
    const total = [...byShape.values()].reduce((a, b) => a + b, 0);
    const ranked = [...byShape.entries()]
      .sort((a, b) => b[1] - a[1] || corpus.shapePoints.get(b[0])!.length - corpus.shapePoints.get(a[0])!.length)
      .filter(([, n], i) => i === 0 || n / total >= MIN_VARIANT_SHARE)
      .slice(0, MAX_VARIANTS_PER_DIRECTION);

    const tolerance = route.mode === 'bus' ? 5 : 2.5;
    for (const [shapeId, tripCount] of ranked) {
      const raw = corpus.shapePoints.get(shapeId)!.map((p) => [p[2], p[1]] as [number, number]);
      for (const run of clipRunsToBbox(raw, OSLO_BBOX, CLIP_PAD_DEGREES)) {
        const simplified = simplifyLonLat(run, tolerance);
        if (simplified.length < 2) continue;
        const path: number[] = [];
        for (const [lon, lat] of simplified) {
          path.push(Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5);
        }
        network.push({
          r: routeIndex.get(routeId)!,
          d: Number(dirRaw),
          m: route.mode,
          w: MODE_WIDTH[route.mode],
          c: route.color,
          trips: tripCount,
          path,
        });
      }
    }
  }
  network.sort((a, b) => MODE_ORDER[a.m] - MODE_ORDER[b.m] || a.trips - b.trips);
  log(`network paths: ${network.length}, points: ${network.reduce((n, p) => n + p.path.length / 2, 0)}`);

  const servedModes = new Map<string, Set<Mode>>();
  for (const trip of keptTrips) {
    const mode = corpus.routes.get(trip.routeId)!.mode;
    for (let i = 4; i < trip.calls.length; i += 5) {
      const quay = corpus.quayIds[trip.calls[i]!]!;
      const parent = corpus.quayParent.get(quay) ?? quay;
      let set = servedModes.get(parent);
      if (!set) {
        set = new Set();
        servedModes.set(parent, set);
      }
      set.add(mode);
    }
  }

  const stopList: Array<{ id: string; name: string; lat: number; lon: number; modes: Mode[] }> = [];
  for (const sp of corpus.stopPlaces.values()) {
    const modes = servedModes.get(sp.id);
    if (!modes?.size) continue;
    stopList.push({
      id: sp.id,
      name: sp.name,
      lat: Math.round((sp.latSum / sp.quays) * 1e6) / 1e6,
      lon: Math.round((sp.lonSum / sp.quays) * 1e6) / 1e6,
      modes: [...modes].sort((a, b) => MODE_ORDER[b] - MODE_ORDER[a]),
    });
  }
  stopList.sort((a, b) => MODE_ORDER[b.modes[0]!] - MODE_ORDER[a.modes[0]!]);
  log(`stop places served: ${stopList.length}`);

  const journeys: Record<string, string> = {};
  for (const trip of keptTrips) {
    if (trip.interpolate) continue;
    const lastQuay = corpus.quayIds[trip.calls[trip.calls.length - 1]!];
    const fallback = lastQuay ? corpus.quayName.get(lastQuay) ?? '' : '';
    const headsign = trip.headsign || fallback;
    if (headsign) journeys[trip.id] = headsign;
  }
  log(`journey destinations for geometry-only feeds: ${Object.keys(journeys).length}`);

  const shapeOrder = [...new Set(interpolatedTrips.map((t) => t.shapeId))].sort();
  const shapeIndex = new Map(shapeOrder.map((id, i) => [id, i] as const));
  const totalTriples = shapeOrder.reduce((n, id) => n + corpus.shapePoints.get(id)!.length, 0);
  const shapeBuf = new Float64Array(totalTriples * 3);
  const shapeMeta: Array<{ o: number; n: number; len: number }> = [];
  let off = 0;
  for (const id of shapeOrder) {
    const pts = corpus.shapePoints.get(id)!;
    shapeMeta.push({ o: off, n: pts.length, len: pts[pts.length - 1]![0] });
    for (const [dist, lat, lon] of pts) {
      shapeBuf[off * 3] = dist;
      shapeBuf[off * 3 + 1] = lat;
      shapeBuf[off * 3 + 2] = lon;
      off++;
    }
  }

  const totalCalls = interpolatedTrips.reduce((n, t) => n + t.calls.length / 5, 0);
  const tripBuf = new Float64Array(totalCalls * 5);
  const tripMeta: Array<{ id: string; r: number; s: number; d: number; h: string; o: number; n: number }> = [];
  let callOff = 0;
  for (const trip of interpolatedTrips) {
    const n = trip.calls.length / 5;
    tripMeta.push({
      id: trip.id,
      r: routeIndex.get(trip.routeId)!,
      s: shapeIndex.get(trip.shapeId)!,
      d: trip.dir,
      h: trip.headsign,
      o: callOff,
      n,
    });
    for (let i = 0; i < trip.calls.length; i++) tripBuf[callOff * 5 + i] = trip.calls[i]!;
    callOff += n;
  }

  const webDir = join(DATA_DIR, 'web');
  const serverDir = join(DATA_DIR, 'server');
  await mkdir(webDir, { recursive: true });
  await mkdir(serverDir, { recursive: true });

  const meta = {
    generatedAt: new Date().toISOString(),
    serviceDate: args.date,
    bbox: OSLO_BBOX,
    sources: GTFS_SOURCES.map((s) => ({ codespace: s.codespace, interpolate: s.interpolate })),
    counts: {
      routes: routeList.length,
      networkPaths: network.length,
      stopPlaces: stopList.length,
      trips: interpolatedTrips.length,
      shapes: shapeOrder.length,
      calls: totalCalls,
      journeyDestinations: 0,
    },
    modes: [...new Set(routeList.map((r) => r.mode))].sort((a, b) => MODE_ORDER[b] - MODE_ORDER[a]),
  };

  meta.counts.journeyDestinations = Object.keys(journeys).length;

  const webRoutes = routeList.map((r) => ({
    id: r.id,
    line: r.line,
    name: r.name,
    mode: r.mode,
    color: r.color,
    text: r.textColor,
  }));

  await writeArtifact(join(webDir, 'meta.json'), JSON.stringify(meta, null, 2));
  await writeArtifact(join(webDir, 'routes.json'), JSON.stringify(webRoutes));
  await writeArtifact(join(webDir, 'network.json'), JSON.stringify(network));
  await writeArtifact(join(webDir, 'stops.json'), JSON.stringify(stopList));

  await writeArtifact(join(serverDir, 'meta.json'), JSON.stringify(meta, null, 2));
  await writeArtifact(join(serverDir, 'routes.json'), JSON.stringify(webRoutes));
  await writeArtifact(
    join(serverDir, 'quays.json'),
    JSON.stringify({
      ids: corpus.quayIds,
      names: corpus.quayIds.map((q) => corpus.quayName.get(q) ?? ''),
      coords: corpus.quayIds.map((q) => corpus.quayLatLon.get(q) ?? [0, 0]),
      parents: corpus.quayIds.map((q) => corpus.quayParent.get(q) ?? q),
    }),
  );
  await writeArtifact(join(serverDir, 'stops.json'), JSON.stringify(stopList));
  await writeArtifact(join(serverDir, 'journeys.json'), JSON.stringify(journeys));
  await writeArtifact(join(serverDir, 'shapes-index.json'), JSON.stringify(shapeMeta));
  await writeArtifact(join(serverDir, 'shapes.bin'), Buffer.from(shapeBuf.buffer, shapeBuf.byteOffset, shapeBuf.byteLength));
  await writeArtifact(join(serverDir, 'trips-index.json'), JSON.stringify(tripMeta));
  await writeArtifact(join(serverDir, 'trips.bin'), Buffer.from(tripBuf.buffer, tripBuf.byteOffset, tripBuf.byteLength));

  log('artifacts written');
  console.table(meta.counts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
