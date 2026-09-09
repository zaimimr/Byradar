import type { DepartureIndex } from './departures.js';
import type { Store } from './store.js';
import { osloMidnightUtcMs } from './time.js';

const METRES_PER_DEG_LAT = 111_320;
const WALK_METRES_PER_MIN = 75;
const WALK_RADIUS_M = 1200;
const CORE_RADIUS_M = 800;
const GROUP_RADIUS_M = 400;
const PEAK_FROM_SEC = 7 * 3600;
const PEAK_TO_SEC = 9 * 3600;
const PEAK_HOURS = (PEAK_TO_SEC - PEAK_FROM_SEC) / 3600;
const EVENING_FROM_SEC = 23 * 3600;
const MAX_STOPS = 6;
const MAX_LINES_PER_STOP = 8;
const FREQUENT_PER_HOUR = 6;
const NEAR_FULL_M = 300;
const RAIL_NEAR_M = 300;
const FREQUENCY_CAP_PER_HOUR = 60;
const LINE_CAP = 12;
const MODE_CAP = 3;
const EVENING_CAP = 25;
const RAIL_WEIGHT: Record<string, number> = { metro: 1, rail: 0.92, tram: 0.85, ferry: 0.35 };

const FOLD: Record<string, string> = { æ: 'ae', ø: 'o', å: 'a', ä: 'a', ö: 'o', ü: 'u', ß: 'ss' };

const MODE_WORD: Record<string, string> = {
  metro: 'T-bane',
  tram: 'trikk',
  rail: 'tog',
  bus: 'buss',
  ferry: 'båt',
  other: 'annet',
};

export interface PlaceLine {
  line: string;
  mode: string;
  color: string;
  perHour: number;
  day: number;
}

export interface PlaceStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  modes: string[];
  metres: number;
  walkMin: number;
  perHour: number;
  dayTotal: number;
  eveningCount: number;
  firstDep: number | null;
  lastDep: number | null;
  lines: PlaceLine[];
  timetable: 'full' | 'partial' | 'none';
  missingModes: string[];
}

export interface ScorePart {
  key: string;
  label: string;
  score: number;
  max: number;
  note: string;
}

export interface PlaceProfile {
  point: { lat: number; lon: number };
  serviceDate: string;
  weekday: number;
  score: { total: number; grade: string; label: string; parts: ScorePart[] };
  summary: {
    stops: number;
    lines: number;
    modes: string[];
    perHour: number;
    reachPerHour: number;
    nearestWalkMin: number | null;
    railWalkMin: number | null;
    railMode: string | null;
    eveningCount: number;
    lastDep: number | null;
  };
  hourly: number[];
  stops: PlaceStop[];
  coverage: { level: 'full' | 'partial' | 'none'; missing: string[] };
}

interface Bucket {
  line: string;
  mode: string;
  color: string;
  peak: number;
  day: number;
  evening: number;
  first: number;
  last: number;
  hourly: number[];
}

interface Cluster {
  name: string;
  places: number[];
  metres: number;
  lat: number;
  lon: number;
}

interface Scan {
  stop: PlaceStop;
  hourly: number[];
  best: Map<string, Bucket>;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[æøåäöüß]/g, (c) => FOLD[c] ?? c)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function metresBetween(lat: number, lon: number, toLat: number, toLon: number): number {
  const dLat = (toLat - lat) * METRES_PER_DEG_LAT;
  const dLon = (toLon - lon) * METRES_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

function walkMinutes(metres: number): number {
  return Math.max(1, Math.round(metres / WALK_METRES_PER_MIN));
}

function decay(metres: number, full: number, none: number): number {
  if (metres <= full) return 1;
  if (metres >= none) return 0;
  return (none - metres) / (none - full);
}

function modeWord(mode: string): string {
  return MODE_WORD[mode] ?? mode;
}

function clockOf(seconds: number): string {
  const wrapped = ((seconds % 86400) + 86400) % 86400;
  const h = Math.floor(wrapped / 3600);
  const m = Math.floor((wrapped % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function weekdayOf(serviceDate: string): number {
  return new Date(osloMidnightUtcMs(serviceDate) + 12 * 3600_000).getUTCDay();
}

function clustersAround(store: Store, lat: number, lon: number): Cluster[] {
  const byName = new Map<string, Cluster[]>();
  for (let place = 0; place < store.stopPlaces.length; place++) {
    const stop = store.stopPlaces[place]!;
    const metres = metresBetween(lat, lon, stop.lat, stop.lon);
    if (metres > WALK_RADIUS_M) continue;
    const key = normalize(stop.name);
    const bucket = byName.get(key);
    const near = bucket?.find((cluster) => metresBetween(cluster.lat, cluster.lon, stop.lat, stop.lon) <= GROUP_RADIUS_M);
    if (near) {
      near.places.push(place);
      if (metres < near.metres) near.metres = metres;
      continue;
    }
    const cluster: Cluster = { name: stop.name, places: [place], metres, lat: stop.lat, lon: stop.lon };
    if (bucket) bucket.push(cluster);
    else byName.set(key, [cluster]);
  }
  return [...byName.values()].flat();
}

function scanCluster(store: Store, index: DepartureIndex, cluster: Cluster): Scan | null {
  const byDirection = new Map<string, Bucket>();
  const modes = new Set<string>();
  const missing = new Set<string>();
  let timetable: 'full' | 'partial' | 'none' = 'full';

  for (const place of cluster.places) {
    const stop = store.stopPlaces[place]!;
    for (const mode of stop.modes) modes.add(mode);
    const coverage = index.coverageOf(place);
    for (const mode of coverage.missingModes) missing.add(mode);
    if (coverage.timetable === 'none' && timetable !== 'partial') timetable = 'none';
    if (coverage.timetable === 'partial') timetable = 'partial';

    const from = index.startOf(place);
    const to = index.endOf(place);
    for (let i = from; i < to; i++) {
      const aimed = index.aimedAt(i);
      const trip = store.trips[index.tripAt(i)]!;
      const route = store.routes[trip.r]!;
      const key = `${route.mode}|${route.line}|${trip.d}`;
      let bucket = byDirection.get(key);
      if (!bucket) {
        bucket = {
          line: route.line,
          mode: route.mode,
          color: route.color,
          peak: 0,
          day: 0,
          evening: 0,
          first: aimed,
          last: aimed,
          hourly: new Array<number>(24).fill(0),
        };
        byDirection.set(key, bucket);
      }
      bucket.day++;
      if (aimed >= PEAK_FROM_SEC && aimed < PEAK_TO_SEC) bucket.peak++;
      if (aimed >= EVENING_FROM_SEC) bucket.evening++;
      if (aimed < bucket.first) bucket.first = aimed;
      if (aimed > bucket.last) bucket.last = aimed;
      bucket.hourly[Math.floor(aimed / 3600) % 24]!++;
    }
  }

  if (!byDirection.size && !missing.size) return null;

  const best = new Map<string, Bucket>();
  for (const [key, bucket] of byDirection) {
    const lineKey = key.slice(0, key.lastIndexOf('|'));
    const held = best.get(lineKey);
    if (!held || bucket.peak > held.peak || (bucket.peak === held.peak && bucket.day > held.day)) {
      best.set(lineKey, bucket);
    }
  }

  const hourly = new Array<number>(24).fill(0);
  let peak = 0;
  let day = 0;
  let evening = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (const bucket of best.values()) {
    peak += bucket.peak;
    day += bucket.day;
    evening += bucket.evening;
    for (let h = 0; h < 24; h++) hourly[h]! += bucket.hourly[h]!;
    if (first === null || bucket.first < first) first = bucket.first;
    if (last === null || bucket.last > last) last = bucket.last;
  }

  const anchor = store.stopPlaces[cluster.places[0]!]!;
  const lines = [...best.values()]
    .sort((a, b) => b.peak - a.peak || b.day - a.day)
    .slice(0, MAX_LINES_PER_STOP)
    .map((bucket) => ({
      line: bucket.line,
      mode: bucket.mode,
      color: bucket.color,
      perHour: +(bucket.peak / PEAK_HOURS).toFixed(1),
      day: bucket.day,
    }));

  return {
    hourly,
    best,
    stop: {
      id: anchor.id,
      name: cluster.name,
      lat: cluster.lat,
      lon: cluster.lon,
      modes: [...modes],
      metres: Math.round(cluster.metres),
      walkMin: walkMinutes(cluster.metres),
      perHour: +(peak / PEAK_HOURS).toFixed(1),
      dayTotal: day,
      eveningCount: evening,
      firstDep: first,
      lastDep: last,
      lines,
      timetable,
      missingModes: [...missing],
    },
  };
}

function gradeFor(total: number): { grade: string; label: string } {
  if (total >= 85) return { grade: 'A', label: 'toppklasse' };
  if (total >= 72) return { grade: 'B', label: 'veldig bra' };
  if (total >= 58) return { grade: 'C', label: 'bra' };
  if (total >= 44) return { grade: 'D', label: 'greit' };
  if (total >= 28) return { grade: 'E', label: 'tynt' };
  return { grade: 'F', label: 'svakt' };
}

function nearestOf(stops: PlaceStop[]): PlaceStop | null {
  return stops.reduce<PlaceStop | null>(
    (best, stop) => (best === null || stop.metres < best.metres ? stop : best),
    null,
  );
}

function bestRail(stops: PlaceStop[]): { stop: PlaceStop; mode: string; value: number } | null {
  let best: { stop: PlaceStop; mode: string; value: number } | null = null;
  for (const stop of stops) {
    for (const mode of stop.modes) {
      const weight = RAIL_WEIGHT[mode];
      if (weight === undefined) continue;
      const value = weight * decay(stop.metres, RAIL_NEAR_M, WALK_RADIUS_M);
      if (best === null || value > best.value) best = { stop, mode, value };
    }
  }
  return best;
}

function pickStops(found: PlaceStop[], rail: PlaceStop | null): PlaceStop[] {
  const ranked = [...found].sort((a, b) => a.walkMin - b.walkMin || b.perHour - a.perHour);
  const chosen = ranked.slice(0, MAX_STOPS);
  if (rail && !chosen.some((stop) => stop.id === rail.id)) {
    chosen.splice(MAX_STOPS - 1, 1, rail);
    chosen.sort((a, b) => a.walkMin - b.walkMin || b.perHour - a.perHour);
  }
  return chosen;
}

export function profilePlace(
  store: Store,
  index: DepartureIndex,
  lat: number,
  lon: number,
): PlaceProfile {
  const scans: Scan[] = [];
  for (const cluster of clustersAround(store, lat, lon)) {
    const scan = scanCluster(store, index, cluster);
    if (scan) scans.push(scan);
  }

  const found = scans.map((scan) => scan.stop);
  const core = scans.filter((scan) => scan.stop.metres <= CORE_RADIUS_M);

  const hourly = new Array<number>(24).fill(0);
  const byLine = new Map<string, { perHour: number; reach: number; evening: number; mode: string }>();
  let lastDep: number | null = null;

  for (const scan of core) {
    const reachable = decay(scan.stop.metres, NEAR_FULL_M, WALK_RADIUS_M);
    for (let h = 0; h < 24; h++) hourly[h]! += scan.hourly[h]!;
    for (const [lineKey, bucket] of scan.best) {
      const perHour = bucket.peak / PEAK_HOURS;
      const reach = perHour * reachable;
      const held = byLine.get(lineKey);
      if (!held) {
        byLine.set(lineKey, { perHour, reach, evening: bucket.evening, mode: bucket.mode });
        continue;
      }
      if (perHour > held.perHour) held.perHour = perHour;
      if (reach > held.reach) held.reach = reach;
      if (bucket.evening > held.evening) held.evening = bucket.evening;
    }
    const last = scan.stop.lastDep;
    if (last !== null && (lastDep === null || last > lastDep)) lastDep = last;
  }

  let corePerHour = 0;
  let coreReach = 0;
  let coreEvening = 0;
  const coreModes = new Set<string>();
  for (const line of byLine.values()) {
    corePerHour += line.perHour;
    coreReach += line.reach;
    coreEvening += line.evening;
    coreModes.add(line.mode);
  }

  const nearest = nearestOf(found);
  const frequent = nearestOf(found.filter((stop) => stop.perHour >= FREQUENT_PER_HOUR));
  const rail = bestRail(found);

  const anchor = frequent ?? nearest;
  const nearScore = anchor ? 20 * decay(anchor.metres, NEAR_FULL_M, WALK_RADIUS_M) * (frequent ? 1 : 0.6) : 0;
  const freqScore = 30 * Math.min(1, coreReach / FREQUENCY_CAP_PER_HOUR);
  const railScore = rail ? 25 * rail.value : 0;
  const spreadScore =
    7 * Math.min(1, byLine.size / LINE_CAP) +
    3 * Math.min(1, Math.max(0, coreModes.size - 1) / (MODE_CAP - 1));
  const eveningScore = 15 * Math.min(1, coreEvening / EVENING_CAP);

  const total = Math.round(nearScore + freqScore + railScore + spreadScore + eveningScore);
  const { grade, label } = gradeFor(total);

  const advertised = new Set<string>();
  const missing = new Set<string>();
  for (const stop of core.length ? core.map((scan) => scan.stop) : found) {
    for (const mode of stop.modes) advertised.add(mode);
    for (const mode of stop.missingModes) missing.add(mode);
  }
  const level: 'full' | 'partial' | 'none' =
    missing.size === 0 ? 'full' : missing.size >= advertised.size && advertised.size > 0 ? 'none' : 'partial';

  const parts: ScorePart[] = [
    {
      key: 'naerhet',
      label: 'nærhet',
      score: +nearScore.toFixed(1),
      max: 20,
      note: frequent
        ? `${frequent.walkMin} min til ${frequent.name}, ${Math.round(frequent.perHour)} avganger i timen kl. 07–09`
        : nearest
          ? `${nearest.walkMin} min til ${nearest.name}, men ingen stopp med seks avganger i timen innen gangavstand`
          : 'ingen stopp innen 1,2 km',
    },
    {
      key: 'frekvens',
      label: 'frekvens',
      score: +freqScore.toFixed(1),
      max: 30,
      note: byLine.size
        ? `${Math.round(corePerHour)} avganger i timen kl. 07–09, per linje og retning, innen 10 min gange`
        : 'ingen stopp innen 10 min gange',
    },
    {
      key: 'skinne',
      label: 'skinnegang',
      score: +railScore.toFixed(1),
      max: 25,
      note: rail
        ? `${modeWord(rail.mode)} fra ${rail.stop.name}, ${rail.stop.walkMin} min gange`
        : 'ingen T-bane, trikk eller tog innen gangavstand',
    },
    {
      key: 'bredde',
      label: 'bredde',
      score: +spreadScore.toFixed(1),
      max: 10,
      note: byLine.size
        ? `${byLine.size} linjer og ${coreModes.size} transportmidler innen 10 min gange`
        : 'ingen linjer innen 10 min gange',
    },
    {
      key: 'kveld',
      label: 'kveld',
      score: +eveningScore.toFixed(1),
      max: 15,
      note: coreEvening
        ? `${coreEvening} avganger etter kl. 23${lastDep === null ? '' : `, siste ${clockOf(lastDep)}`}`
        : 'ingen avganger etter kl. 23',
    },
  ];

  return {
    point: { lat, lon },
    serviceDate: store.meta.serviceDate,
    weekday: weekdayOf(store.meta.serviceDate),
    score: { total, grade, label, parts },
    summary: {
      stops: found.length,
      lines: byLine.size,
      modes: [...coreModes],
      perHour: +corePerHour.toFixed(1),
      reachPerHour: +coreReach.toFixed(1),
      nearestWalkMin: nearest ? nearest.walkMin : null,
      railWalkMin: rail ? rail.stop.walkMin : null,
      railMode: rail ? rail.mode : null,
      eveningCount: coreEvening,
      lastDep,
    },
    hourly,
    stops: pickStops(found, rail ? rail.stop : null),
    coverage: { level, missing: [...missing] },
  };
}
