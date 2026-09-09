import { ENTUR, ENV } from './env.js';
import { osloMidnightUtcMs } from './time.js';

const REQUEST_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 900_000;
const MAX_CACHE_ENTRIES = 300;
const MAX_INFLIGHT = 3;
const BREAKER_FAILURES = 3;
const BREAKER_PAUSE_MS = 60_000;
const TRIP_PATTERNS = 4;
const DEPART_HOUR = 8;
const MAX_DAY_SEARCH = 9;
const MIN_LEAD_MS = 900_000;

const OSLO_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Oslo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const QUERY = `query Commute($lat: Float!, $lon: Float!, $to: String!, $at: DateTime!, $n: Int!) {
  trip(
    from: { coordinates: { latitude: $lat, longitude: $lon } }
    to: { place: $to }
    dateTime: $at
    numTripPatterns: $n
  ) {
    tripPatterns {
      duration
      walkDistance
      legs {
        mode
        duration
        fromPlace { name }
        toPlace { name }
        line { publicCode name transportMode presentation { colour } }
      }
    }
  }
}`;

const MODE_MAP: Record<string, string> = {
  rail: 'rail',
  metro: 'metro',
  tram: 'tram',
  bus: 'bus',
  coach: 'bus',
  water: 'ferry',
  ferry: 'ferry',
  foot: 'foot',
  funicular: 'other',
  cableway: 'other',
  lift: 'other',
};

const MODE_COLOR: Record<string, string> = {
  metro: '#EC700C',
  tram: '#0B91EF',
  rail: '#1B7A5A',
  bus: '#E60000',
  ferry: '#354F7F',
  other: '#8892A6',
};

interface RawLeg {
  mode: string | null;
  duration: number | null;
  fromPlace: { name: string | null } | null;
  toPlace: { name: string | null } | null;
  line: {
    publicCode: string | null;
    name: string | null;
    transportMode: string | null;
    presentation: { colour: string | null } | null;
  } | null;
}

interface RawPattern {
  duration: number | null;
  walkDistance: number | null;
  legs: RawLeg[] | null;
}

interface RawResponse {
  data?: { trip?: { tripPatterns?: RawPattern[] | null } | null } | null;
}

export interface CommuteLeg {
  mode: string;
  line: string;
  color: string;
  from: string;
  to: string;
  minutes: number;
}

export interface Commute {
  to: { id: string; name: string };
  departAt: string;
  minutes: number;
  walkMin: number;
  transfers: number;
  walkOnly: boolean;
  legs: CommuteLeg[];
}

function modeOf(raw: string | null): string {
  return MODE_MAP[(raw ?? '').toLowerCase()] ?? 'other';
}

function colorOf(raw: string | null, mode: string): string {
  const hex = (raw ?? '').trim().replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{6}$/.test(hex)) return `#${hex}`;
  return MODE_COLOR[mode] ?? MODE_COLOR.other!;
}

function shiftDate(yyyymmdd: string, days: number): string {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return `${shifted.getUTCFullYear()}${String(shifted.getUTCMonth() + 1).padStart(2, '0')}${String(
    shifted.getUTCDate(),
  ).padStart(2, '0')}`;
}

export function nextWeekdayMorning(nowMs = Date.now()): number {
  const today = OSLO_DATE.format(new Date(nowMs)).replaceAll('-', '');
  for (let offset = 0; offset < MAX_DAY_SEARCH; offset++) {
    const date = shiftDate(today, offset);
    const midnight = osloMidnightUtcMs(date);
    const weekday = new Date(midnight + 12 * 3600_000).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const depart = midnight + DEPART_HOUR * 3600_000;
    if (depart - nowMs < MIN_LEAD_MS) continue;
    return depart;
  }
  return nowMs;
}

export class Commutes {
  private readonly cache = new Map<string, { at: number; commute: Commute }>();
  private readonly pending = new Map<string, Promise<Commute | null>>();
  private inflight = 0;
  private consecutiveFailures = 0;
  private pausedUntil = 0;
  private lookups = 0;
  private failures = 0;

  get stats(): { cached: number; lookups: number; failures: number; paused: boolean } {
    return {
      cached: this.cache.size,
      lookups: this.lookups,
      failures: this.failures,
      paused: Date.now() < this.pausedUntil,
    };
  }

  async trip(lat: number, lon: number, to: { id: string; name: string }): Promise<Commute | null> {
    const departMs = nextWeekdayMorning();
    const departAt = new Date(departMs).toISOString();
    const key = `${lat.toFixed(4)}|${lon.toFixed(4)}|${to.id}|${departAt}`;

    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.commute;

    const existing = this.pending.get(key);
    if (existing) return existing;

    if (Date.now() < this.pausedUntil || this.inflight >= MAX_INFLIGHT) return null;

    const request = this.load(key, lat, lon, to, departAt);
    this.pending.set(key, request);
    return request;
  }

  private async load(
    key: string,
    lat: number,
    lon: number,
    to: { id: string; name: string },
    departAt: string,
  ): Promise<Commute | null> {
    this.inflight++;
    this.lookups++;
    try {
      const commute = await this.fetchTrip(lat, lon, to, departAt);
      this.cache.set(key, { at: Date.now(), commute });
      this.prune();
      this.consecutiveFailures = 0;
      return commute;
    } catch {
      this.failures++;
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= BREAKER_FAILURES) this.pausedUntil = Date.now() + BREAKER_PAUSE_MS;
      return null;
    } finally {
      this.inflight--;
      this.pending.delete(key);
    }
  }

  private prune(): void {
    if (this.cache.size <= MAX_CACHE_ENTRIES) return;
    const stale = Date.now() - CACHE_TTL_MS;
    for (const [key, entry] of this.cache) {
      if (entry.at < stale) this.cache.delete(key);
    }
    for (const key of this.cache.keys()) {
      if (this.cache.size <= MAX_CACHE_ENTRIES) break;
      this.cache.delete(key);
    }
  }

  private async fetchTrip(
    lat: number,
    lon: number,
    to: { id: string; name: string },
    departAt: string,
  ): Promise<Commute> {
    const res = await fetch(ENTUR.journeyPlanner, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ET-Client-Name': ENV.clientName },
      body: JSON.stringify({
        query: QUERY,
        variables: { lat, lon, to: to.id, at: departAt, n: TRIP_PATTERNS },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`journey planner ${res.status}`);

    const json = (await res.json()) as RawResponse;
    const patterns = json.data?.trip?.tripPatterns ?? [];
    if (!patterns.length) throw new Error('journey planner returned no trip');

    const shaped = patterns.map((pattern) => {
      const legs = (pattern.legs ?? []).map((leg) => {
        const mode = modeOf(leg.mode);
        return {
          mode,
          line: (leg.line?.publicCode ?? leg.line?.name ?? '').trim(),
          color: colorOf(leg.line?.presentation?.colour ?? null, mode),
          from: leg.fromPlace?.name?.trim() ?? '',
          to: leg.toPlace?.name?.trim() ?? '',
          minutes: Math.max(1, Math.round((leg.duration ?? 0) / 60)),
        } satisfies CommuteLeg;
      });
      const rides = legs.filter((leg) => leg.mode !== 'foot');
      const walkMin = legs
        .filter((leg) => leg.mode === 'foot')
        .reduce((sum, leg) => sum + leg.minutes, 0);
      return {
        to,
        departAt,
        minutes: Math.max(1, Math.round((pattern.duration ?? 0) / 60)),
        walkMin,
        transfers: Math.max(0, rides.length - 1),
        walkOnly: rides.length === 0,
        legs,
      } satisfies Commute;
    });

    const withTransit = shaped.filter((pattern) => !pattern.walkOnly);
    const pool = withTransit.length ? withTransit : shaped;
    return pool.reduce((best, pattern) => (pattern.minutes < best.minutes ? pattern : best));
  }
}
