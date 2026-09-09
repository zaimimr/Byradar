import { ENTUR, ENV } from './env.js';
import { osloMidnightUtcMs } from './time.js';

const REQUEST_TIMEOUT_MS = 3_500;
const CACHE_TTL_MS = 6 * 3600_000;
const MAX_CACHE_ENTRIES = 200;
const MAX_INFLIGHT = 3;
const BREAKER_FAILURES = 3;
const BREAKER_PAUSE_MS = 120_000;
const WINDOW_FROM_SEC = 4 * 3600;
const WINDOW_RANGE_SEC = 22 * 3600;
const MAX_CALLS = 400;
const PEAK_FROM_SEC = 7 * 3600;
const PEAK_TO_SEC = 9 * 3600;
const PEAK_HOURS = (PEAK_TO_SEC - PEAK_FROM_SEC) / 3600;
const EVENING_FROM_SEC = 23 * 3600;
const LATE_WINDOW_TO_SEC = 26 * 3600 + 1800;
const DAY_SEARCH = 8;

const OSLO_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Oslo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const QUERY = `query RailBoard($id: String!, $start: DateTime!, $range: Int!, $n: Int!) {
  stopPlace(id: $id) {
    estimatedCalls(
      startTime: $start
      timeRange: $range
      numberOfDepartures: $n
      arrivalDeparture: departures
      whiteListedModes: [rail]
    ) {
      aimedDepartureTime
      quay { id publicCode }
      serviceJourney {
        line { publicCode name presentation { colour } }
      }
    }
  }
}`;

interface RawCall {
  aimedDepartureTime: string | null;
  quay: { id: string | null; publicCode: string | null } | null;
  serviceJourney: {
    line: { publicCode: string | null; name: string | null; presentation: { colour: string | null } | null } | null;
  } | null;
}

interface RawResponse {
  data?: { stopPlace?: { estimatedCalls?: RawCall[] | null } | null } | null;
}

export interface RailLine {
  line: string;
  color: string;
  peak: number;
  day: number;
  evening: number;
  first: number;
  last: number;
  hourly: number[];
}

export interface RailScan {
  lines: RailLine[];
  truncated: boolean;
  coveredToSec: number;
}

const RAIL_COLOR = '#1B7A5A';

function colorOf(raw: string | null): string {
  const hex = (raw ?? '').trim().replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : RAIL_COLOR;
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

function weekdayOf(yyyymmdd: string): number {
  return new Date(osloMidnightUtcMs(yyyymmdd) + 12 * 3600_000).getUTCDay();
}

export function sameWeekdayWindow(serviceDate: string, nowMs = Date.now()): { date: string; startMs: number } {
  const wanted = weekdayOf(serviceDate);
  const today = OSLO_DATE.format(new Date(nowMs)).replaceAll('-', '');
  for (let offset = 0; offset < DAY_SEARCH; offset++) {
    const date = shiftDate(today, offset);
    if (weekdayOf(date) !== wanted) continue;
    const startMs = osloMidnightUtcMs(date) + WINDOW_FROM_SEC * 1000;
    if (startMs <= nowMs) continue;
    return { date, startMs };
  }
  const date = shiftDate(today, 1);
  return { date, startMs: osloMidnightUtcMs(date) + WINDOW_FROM_SEC * 1000 };
}

export class RailBoards {
  private readonly cache = new Map<string, { at: number; scan: RailScan }>();
  private readonly pending = new Map<string, Promise<RailScan | null>>();
  private inflight = 0;
  private consecutiveFailures = 0;
  private pausedUntil = 0;
  private lookups = 0;
  private failures = 0;

  constructor(private readonly serviceDate: string) {}

  get stats(): { cached: number; lookups: number; failures: number; paused: boolean } {
    return {
      cached: this.cache.size,
      lookups: this.lookups,
      failures: this.failures,
      paused: Date.now() < this.pausedUntil,
    };
  }

  async scan(stopPlaceId: string): Promise<RailScan | null> {
    const window = sameWeekdayWindow(this.serviceDate);
    const key = `${stopPlaceId}|${window.date}`;

    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.scan;

    const existing = this.pending.get(key);
    if (existing) return existing;

    if (Date.now() < this.pausedUntil || this.inflight >= MAX_INFLIGHT) return null;

    const request = this.load(key, stopPlaceId, window);
    this.pending.set(key, request);
    return request;
  }

  private async load(
    key: string,
    stopPlaceId: string,
    window: { date: string; startMs: number },
  ): Promise<RailScan | null> {
    this.inflight++;
    this.lookups++;
    try {
      const scan = await this.fetchScan(stopPlaceId, window);
      this.cache.set(key, { at: Date.now(), scan });
      this.prune();
      this.consecutiveFailures = 0;
      return scan;
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

  private async fetchScan(stopPlaceId: string, window: { date: string; startMs: number }): Promise<RailScan> {
    const midnight = osloMidnightUtcMs(window.date);
    const byDirection = new Map<string, RailLine>();

    const first = await this.fetchCalls(stopPlaceId, window.startMs, WINDOW_RANGE_SEC);
    let coveredToSec = absorb(first.calls, midnight, byDirection, WINDOW_FROM_SEC);
    const truncated = first.truncated;

    if (truncated && coveredToSec < LATE_WINDOW_TO_SEC) {
      const fromSec = Math.max(EVENING_FROM_SEC - 3600, coveredToSec + 60);
      const range = LATE_WINDOW_TO_SEC - fromSec;
      if (range > 0) {
        const late = await this.fetchCalls(stopPlaceId, midnight + fromSec * 1000, range);
        coveredToSec = absorb(late.calls, midnight, byDirection, coveredToSec);
      }
    }

    const best = new Map<string, RailLine>();
    for (const [key, bucket] of byDirection) {
      const line = key.slice(0, key.lastIndexOf('|'));
      const held = best.get(line);
      if (!held || bucket.peak > held.peak || (bucket.peak === held.peak && bucket.day > held.day)) {
        best.set(line, bucket);
      }
    }

    return {
      lines: [...best.values()].sort((a, b) => b.peak - a.peak || b.day - a.day),
      truncated,
      coveredToSec,
    };
  }

  private async fetchCalls(
    stopPlaceId: string,
    startMs: number,
    rangeSec: number,
  ): Promise<{ calls: RawCall[]; truncated: boolean }> {
    const res = await fetch(ENTUR.journeyPlanner, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ET-Client-Name': ENV.clientName },
      body: JSON.stringify({
        query: QUERY,
        variables: {
          id: stopPlaceId,
          start: new Date(startMs).toISOString(),
          range: rangeSec,
          n: MAX_CALLS,
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`journey planner ${res.status}`);

    const json = (await res.json()) as RawResponse;
    const calls = json.data?.stopPlace?.estimatedCalls;
    if (!calls) throw new Error('journey planner returned no stop place');
    return { calls, truncated: calls.length >= MAX_CALLS };
  }
}

function absorb(
  calls: RawCall[],
  midnight: number,
  byDirection: Map<string, RailLine>,
  coveredFrom: number,
): number {
  let coveredToSec = coveredFrom;
  for (const call of calls) {
    const aimedAt = Date.parse(call.aimedDepartureTime ?? '');
    if (!Number.isFinite(aimedAt)) continue;
    const aimed = Math.round((aimedAt - midnight) / 1000);
    if (aimed > coveredToSec) coveredToSec = aimed;

    const raw = call.serviceJourney?.line;
    const line = (raw?.publicCode ?? raw?.name ?? '').trim();
    if (!line) continue;
    const track = call.quay?.publicCode?.trim() || call.quay?.id?.trim() || '';
    const key = `${line}|${track}`;

    const bucket = byDirection.get(key);
    if (!bucket) {
      byDirection.set(key, {
        line,
        color: colorOf(raw?.presentation?.colour ?? null),
        peak: aimed >= PEAK_FROM_SEC && aimed < PEAK_TO_SEC ? 1 : 0,
        day: 1,
        evening: aimed >= EVENING_FROM_SEC ? 1 : 0,
        first: aimed,
        last: aimed,
        hourly: hourlyWith(aimed),
      });
      continue;
    }
    bucket.day++;
    if (aimed >= PEAK_FROM_SEC && aimed < PEAK_TO_SEC) bucket.peak++;
    if (aimed >= EVENING_FROM_SEC) bucket.evening++;
    if (aimed < bucket.first) bucket.first = aimed;
    if (aimed > bucket.last) bucket.last = aimed;
    bucket.hourly[Math.floor(aimed / 3600) % 24]!++;
  }
  return coveredToSec;
}

function hourlyWith(aimed: number): number[] {
  const hourly = new Array<number>(24).fill(0);
  hourly[Math.floor(aimed / 3600) % 24]!++;
  return hourly;
}
