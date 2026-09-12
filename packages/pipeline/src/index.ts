import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gtfsTimeToSeconds, num, readCsv, str } from './csv.js';
import { fetchAndExtractGtfs } from './download.js';
import {
  COORD_SCALE,
  GTFS_SOURCES,
  MODE_ORDER,
  MODE_WIDTH,
  NORWAY_BBOX,
  SERVER_SHAPE_TOLERANCE_M,
  TILED_MODES,
  TILE_LAT,
  TILE_LON,
  codespaceOf,
  inBbox,
  modeOfRouteType,
  tileXOf,
  tileYOf,
  type GtfsSource,
  type Mode,
} from './config.js';
import { simplifyLonLat, simplifyTriples, splitByCell } from './simplify.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(REPO_ROOT, 'data');
const CACHE_DIR = process.env.GTFS_CACHE_DIR
  ? resolve(process.env.GTFS_CACHE_DIR)
  : join(REPO_ROOT, '.cache', 'gtfs');

const MAX_VARIANTS_PER_DIRECTION = 2;
const MIN_VARIANT_SHARE = 0.2;

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

interface Args {
  force: boolean;
  date: string;
  maxAgeHours: number;
}

const SERVICE_DAY_START_HOUR = 4;

function osloParts(now: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${get('year')}${get('month')}${get('day')}`, hour: Number(get('hour')) % 24 };
}

function osloDateStamp(now: Date): string {
  const { date, hour } = osloParts(now);
  if (hour >= SERVICE_DAY_START_HOUR) return date;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(4, 6));
  const d = Number(date.slice(6, 8));
  const previous = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
  return previous.toISOString().slice(0, 10).replace(/-/g, '');
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
  calls: number[];
}

interface StopPlaceAcc {
  id: string;
  name: string;
  latSum: number;
  lonSum: number;
  quays: number;
}

interface ShapeSpan {
  o: number;
  n: number;
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

class ShapeStore {
  private readonly counts = new Map<string, number>();
  private readonly spans = new Map<string, ShapeSpan>();
  private readonly cursor = new Map<string, number>();
  data = new Float64Array(0);

  count(id: string): void {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
  }

  allocate(): number {
    let total = 0;
    for (const [id, n] of this.counts) {
      this.spans.set(id, { o: total, n });
      this.cursor.set(id, 0);
      total += n;
    }
    this.counts.clear();
    this.data = new Float64Array(total * 3);
    return total;
  }

  put(id: string, dist: number, lat: number, lon: number): void {
    const span = this.spans.get(id);
    if (!span) return;
    const at = this.cursor.get(id)!;
    if (at >= span.n) return;
    const base = (span.o + at) * 3;
    this.data[base] = dist;
    this.data[base + 1] = lat;
    this.data[base + 2] = lon;
    this.cursor.set(id, at + 1);
  }

  span(id: string): ShapeSpan | undefined {
    return this.spans.get(id);
  }

  get size(): number {
    return this.spans.size;
  }

  dist(span: ShapeSpan, i: number): number {
    return this.data[(span.o + i) * 3]!;
  }

  lat(span: ShapeSpan, i: number): number {
    return this.data[(span.o + i) * 3 + 1]!;
  }

  lon(span: ShapeSpan, i: number): number {
    return this.data[(span.o + i) * 3 + 2]!;
  }

  lonLatPath(span: ShapeSpan): Array<[number, number]> {
    const out: Array<[number, number]> = new Array(span.n);
    for (let i = 0; i < span.n; i++) out[i] = [this.lon(span, i), this.lat(span, i)];
    return out;
  }

  sortByDistance(span: ShapeSpan): void {
    let monotonic = true;
    for (let i = 1; i < span.n; i++) {
      if (this.dist(span, i) < this.dist(span, i - 1)) {
        monotonic = false;
        break;
      }
    }
    if (monotonic) return;
    const triples: Array<[number, number, number]> = new Array(span.n);
    for (let i = 0; i < span.n; i++) {
      triples[i] = [this.dist(span, i), this.lat(span, i), this.lon(span, i)];
    }
    triples.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < span.n; i++) {
      const base = (span.o + i) * 3;
      this.data[base] = triples[i]![0];
      this.data[base + 1] = triples[i]![1];
      this.data[base + 2] = triples[i]![2];
    }
  }

  touchesBbox(span: ShapeSpan): boolean {
    for (let i = 0; i < span.n; i++) {
      if (inBbox(NORWAY_BBOX, this.lat(span, i), this.lon(span, i))) return true;
    }
    return false;
  }
}

class Corpus {
  readonly routes = new Map<string, RouteRow>();
  readonly trips = new Map<string, TripRow>();
  readonly shapes = new ShapeStore();
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
    id: source.id,
    url: source.url,
    cacheDir: CACHE_DIR,
    maxAgeHours: args.maxAgeHours,
    force: args.force,
    log,
  });

  const services = await resolveServices(dir, args.date);
  if (services.size === 0) {
    log(`${source.id}: no services on ${args.date} — skipping feed`);
    return;
  }
  log(`${source.id}: ${services.size} services on ${args.date}`);

  let routeCount = 0;
  await readCsv(join(dir, 'routes.txt'), (row, c) => {
    const routeType = num(row, c.index('route_type'), -1);
    const mode = modeOfRouteType(routeType);
    const id = str(row, c.index('route_id'));
    corpus.routes.set(id, {
      id,
      codespace: codespaceOf(id),
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
    if (!inBbox(NORWAY_BBOX, lat, lon)) return;
    let sp = corpus.stopPlaces.get(parent);
    if (!sp) {
      sp = { id: parent, name: str(row, c.index('stop_name')), latSum: 0, lonSum: 0, quays: 0 };
      corpus.stopPlaces.set(parent, sp);
    }
    sp.latSum += lat;
    sp.lonSum += lon;
    sp.quays++;
  });
  log(`${source.id}: ${corpus.quayLatLon.size} quays, ${corpus.stopPlaces.size} stop places`);

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
      calls: [],
    });
    localTrips.add(id);
    neededShapes.add(shapeId);
  });
  log(`${source.id}: ${localTrips.size} trips, ${neededShapes.size} shapes needed`);

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
  log(`${source.id}: ${callRows} calls`);

  const shapesFile = join(dir, 'shapes.txt');
  await readCsv(shapesFile, (row, c) => {
    const id = row[c.index('shape_id')] ?? '';
    if (neededShapes.has(id)) corpus.shapes.count(id);
  });
  const points = corpus.shapes.allocate();
  log(`${source.id}: ${points} shape points, filling`);

  await readCsv(shapesFile, (row, c) => {
    const id = row[c.index('shape_id')] ?? '';
    if (!neededShapes.has(id)) return;
    const dist = num(row, c.index('shape_dist_traveled'), -1);
    const lat = num(row, c.index('shape_pt_lat'), NaN);
    const lon = num(row, c.index('shape_pt_lon'), NaN);
    if (dist < 0 || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    corpus.shapes.put(id, dist, lat, lon);
  });

  log(`${source.id}: ${routeCount} routes, ${localTrips.size} trips, ${callRows} calls, ${corpus.shapes.size} shapes`);
}

interface NetworkPath {
  r: number;
  d: number;
  m: Mode;
  w: number;
  c: string;
  trips: number;
  path: number[];
}

function roundPath(points: ReadonlyArray<readonly [number, number]>): number[] {
  const path: number[] = [];
  for (const [lon, lat] of points) {
    path.push(Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5);
  }
  return path;
}

function byDrawOrder(a: NetworkPath, b: NetworkPath): number {
  return MODE_ORDER[a.m] - MODE_ORDER[b.m] || a.trips - b.trips;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  log(`service date ${args.date}, bbox ${JSON.stringify(NORWAY_BBOX)}`);

  const corpus = new Corpus();
  for (const source of GTFS_SOURCES) {
    await ingest(corpus, source, args);
  }
  log(`merged: ${corpus.routes.size} routes, ${corpus.trips.size} trips, ${corpus.shapes.size} shapes`);

  const keptTrips: TripRow[] = [];
  for (const trip of corpus.trips.values()) {
    if (trip.calls.length < 10) continue;
    const span = corpus.shapes.span(trip.shapeId);
    if (!span || span.n < 2) continue;
    if (!corpus.routes.has(trip.routeId)) continue;
    keptTrips.push(trip);
  }
  keptTrips.sort((a, b) => (a.id < b.id ? -1 : 1));

  const usedShapes = new Set(keptTrips.map((t) => t.shapeId));
  for (const id of usedShapes) {
    const span = corpus.shapes.span(id)!;
    corpus.shapes.sortByDistance(span);
  }
  for (const id of usedShapes) {
    if (!corpus.shapes.touchesBbox(corpus.shapes.span(id)!)) usedShapes.delete(id);
  }
  const inCountry = keptTrips.filter((t) => usedShapes.has(t.shapeId));

  const interpolatedTrips = inCountry.filter((t) => {
    for (let i = 3; i < t.calls.length; i += 5) {
      if (t.calls[i]! < 0) return false;
    }
    return true;
  });
  log(`trips kept: ${inCountry.length} (${interpolatedTrips.length} interpolated)`);

  const routeList = [...new Set(inCountry.map((t) => t.routeId))]
    .map((id) => corpus.routes.get(id)!)
    .sort((a, b) => MODE_ORDER[b.mode] - MODE_ORDER[a.mode] || a.line.localeCompare(b.line, 'nb', { numeric: true }));
  const routeIndex = new Map(routeList.map((r, i) => [r.id, i] as const));
  log(`routes kept: ${routeList.length}`);

  const variantTrips = new Map<string, Map<string, number>>();
  for (const trip of inCountry) {
    const key = `${trip.routeId}|${trip.dir}`;
    let byShape = variantTrips.get(key);
    if (!byShape) {
      byShape = new Map();
      variantTrips.set(key, byShape);
    }
    byShape.set(trip.shapeId, (byShape.get(trip.shapeId) ?? 0) + 1);
  }

  const core: NetworkPath[] = [];
  const tiles = new Map<string, NetworkPath[]>();
  const cellKey = (lon: number, lat: number): number => tileXOf(lon) * 1024 + tileYOf(lat);
  const cellName = (packed: number): string => `${Math.floor(packed / 1024)}-${packed % 1024}`;

  for (const [key, byShape] of variantTrips) {
    const [routeId, dirRaw] = key.split('|') as [string, string];
    const route = corpus.routes.get(routeId)!;
    const total = [...byShape.values()].reduce((a, b) => a + b, 0);
    const ranked = [...byShape.entries()]
      .sort((a, b) => b[1] - a[1] || corpus.shapes.span(b[0])!.n - corpus.shapes.span(a[0])!.n)
      .filter(([, n], i) => i === 0 || n / total >= MIN_VARIANT_SHARE)
      .slice(0, MAX_VARIANTS_PER_DIRECTION);

    const tolerance = route.mode === 'bus' ? 5 : 2.5;
    for (const [shapeId, tripCount] of ranked) {
      const span = corpus.shapes.span(shapeId);
      if (!span) continue;
      const simplified = simplifyLonLat(corpus.shapes.lonLatPath(span), tolerance);
      if (simplified.length < 2) continue;
      const base = {
        r: routeIndex.get(routeId)!,
        d: Number(dirRaw),
        m: route.mode,
        w: MODE_WIDTH[route.mode],
        c: route.color,
        trips: tripCount,
      };
      if (!TILED_MODES.has(route.mode)) {
        core.push({ ...base, path: roundPath(simplified) });
        continue;
      }
      for (const [packed, runs] of splitByCell(simplified, cellKey)) {
        const name = cellName(packed);
        let bucket = tiles.get(name);
        if (!bucket) {
          bucket = [];
          tiles.set(name, bucket);
        }
        for (const run of runs) bucket.push({ ...base, path: roundPath(run) });
      }
    }
  }

  core.sort(byDrawOrder);
  for (const bucket of tiles.values()) bucket.sort(byDrawOrder);
  const tiledPaths = [...tiles.values()].reduce((n, b) => n + b.length, 0);
  const corePoints = core.reduce((n, p) => n + p.path.length / 2, 0);
  const tiledPoints = [...tiles.values()].reduce(
    (n, b) => n + b.reduce((m, p) => m + p.path.length / 2, 0),
    0,
  );
  log(
    `network: ${core.length} core paths (${corePoints} points), ${tiledPaths} tiled paths in ${tiles.size} cells (${tiledPoints} points)`,
  );

  const servedModes = new Map<string, Set<Mode>>();
  for (const trip of inCountry) {
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

  const interpolated = new Set(interpolatedTrips.map((t) => t.id));
  const journeys: Record<string, string> = {};
  for (const trip of inCountry) {
    if (interpolated.has(trip.id)) continue;
    const lastQuay = corpus.quayIds[trip.calls[trip.calls.length - 1]!];
    const fallback = lastQuay ? corpus.quayName.get(lastQuay) ?? '' : '';
    const headsign = trip.headsign || fallback;
    if (headsign) journeys[trip.id] = headsign;
  }
  log(`journey destinations for trips we cannot interpolate: ${Object.keys(journeys).length}`);

  const shapeOrder = [...new Set(interpolatedTrips.map((t) => t.shapeId))].sort();
  const shapeIndex = new Map(shapeOrder.map((id, i) => [id, i] as const));

  const keptPoints: Uint8Array[] = [];
  let serverPoints = 0;
  let rawPoints = 0;
  for (const id of shapeOrder) {
    const span = corpus.shapes.span(id)!;
    const keep = simplifyTriples(corpus.shapes.data, span.o, span.n, SERVER_SHAPE_TOLERANCE_M);
    let kept = 0;
    for (let i = 0; i < span.n; i++) kept += keep[i]!;
    keptPoints.push(keep);
    serverPoints += kept;
    rawPoints += span.n;
  }

  const shapeBuf = new Int32Array(serverPoints * 3);
  const shapeMeta: Array<{ o: number; n: number; len: number }> = [];
  let off = 0;
  for (let s = 0; s < shapeOrder.length; s++) {
    const span = corpus.shapes.span(shapeOrder[s]!)!;
    const keep = keptPoints[s]!;
    const start = off;
    for (let i = 0; i < span.n; i++) {
      if (!keep[i]) continue;
      shapeBuf[off * 3] = Math.round(corpus.shapes.dist(span, i));
      shapeBuf[off * 3 + 1] = Math.round(corpus.shapes.lat(span, i) * COORD_SCALE);
      shapeBuf[off * 3 + 2] = Math.round(corpus.shapes.lon(span, i) * COORD_SCALE);
      off++;
    }
    shapeMeta.push({ o: start, n: off - start, len: Math.round(corpus.shapes.dist(span, span.n - 1)) });
  }
  log(
    `shapes for the server: ${shapeOrder.length} shapes, ${serverPoints} of ${rawPoints} points kept at ${SERVER_SHAPE_TOLERANCE_M} m`,
  );

  const totalCalls = interpolatedTrips.reduce((n, t) => n + t.calls.length / 5, 0);
  const tripBuf = new Int32Array(totalCalls * 5);
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
    for (let i = 0; i < trip.calls.length; i++) tripBuf[callOff * 5 + i] = Math.round(trip.calls[i]!);
    callOff += n;
  }

  const webDir = join(DATA_DIR, 'web');
  const serverDir = join(DATA_DIR, 'server');
  const netDir = join(webDir, 'net');
  await mkdir(webDir, { recursive: true });
  await mkdir(serverDir, { recursive: true });
  await rm(netDir, { recursive: true, force: true });
  await mkdir(netDir, { recursive: true });

  const tileIndex = {
    minLon: NORWAY_BBOX.minLon,
    minLat: NORWAY_BBOX.minLat,
    lonStep: TILE_LON,
    latStep: TILE_LAT,
    cells: [...tiles.keys()].sort(),
  };

  const meta = {
    generatedAt: new Date().toISOString(),
    serviceDate: args.date,
    bbox: NORWAY_BBOX,
    encoding: 'int32' as const,
    coordScale: COORD_SCALE,
    sources: GTFS_SOURCES.map((s) => ({ id: s.id })),
    counts: {
      routes: routeList.length,
      networkPaths: core.length + tiledPaths,
      networkCells: tiles.size,
      stopPlaces: stopList.length,
      trips: interpolatedTrips.length,
      shapes: shapeOrder.length,
      shapePoints: serverPoints,
      calls: totalCalls,
      journeyDestinations: Object.keys(journeys).length,
    },
    modes: [...new Set(routeList.map((r) => r.mode))].sort((a, b) => MODE_ORDER[b] - MODE_ORDER[a]),
  };

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
  await writeArtifact(join(webDir, 'network.json'), JSON.stringify(core));
  await writeArtifact(join(webDir, 'stops.json'), JSON.stringify(stopList));
  await writeArtifact(join(netDir, 'index.json'), JSON.stringify(tileIndex));
  for (const [name, paths] of tiles) {
    await writeArtifact(join(netDir, `${name}.json`), JSON.stringify(paths));
  }

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
