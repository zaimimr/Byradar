import type { DepartureRow } from './departures.js';
import { ENTUR, ENV } from './env.js';
import { osloMidnightUtcMs } from './time.js';

const CACHE_TTL_MS = 20_000;
const MAX_INFLIGHT = 4;
const REQUEST_TIMEOUT_MS = 2_500;
const TIME_RANGE_SEC = 21_600;
const MAX_DEPARTURES = 20;
const BREAKER_FAILURES = 3;
const BREAKER_PAUSE_MS = 60_000;
const MAX_CACHE_ENTRIES = 300;

const QUERY = `query Board($id: String!, $n: Int!, $range: Int!, $modes: [TransportMode]) {
  stopPlace(id: $id) {
    estimatedCalls(
      numberOfDepartures: $n
      timeRange: $range
      arrivalDeparture: departures
      whiteListedModes: $modes
      includeCancelledTrips: true
    ) {
      aimedDepartureTime
      expectedDepartureTime
      realtime
      cancellation
      quay { name publicCode }
      destinationDisplay { frontText }
      serviceJourney {
        line { id publicCode name transportMode presentation { colour } }
      }
    }
  }
}`;

interface RawCall {
  aimedDepartureTime: string | null;
  expectedDepartureTime: string | null;
  realtime: boolean | null;
  cancellation: boolean | null;
  quay: { name: string | null; publicCode: string | null } | null;
  destinationDisplay: { frontText: string | null } | null;
  serviceJourney: {
    line: {
      id: string | null;
      publicCode: string | null;
      name: string | null;
      transportMode: string | null;
      presentation: { colour: string | null } | null;
    } | null;
  } | null;
}

interface BoardResponse {
  data?: { stopPlace?: { estimatedCalls?: RawCall[] | null } | null };
}

const TRANSPORT_MODES: Record<string, readonly string[]> = {
  rail: ['rail'],
  metro: ['metro'],
  tram: ['tram'],
  bus: ['bus', 'coach'],
  ferry: ['water'],
  other: ['funicular', 'cableway', 'lift'],
};

const MODE_MAP: Record<string, string> = {
  rail: 'rail',
  metro: 'metro',
  tram: 'tram',
  bus: 'bus',
  coach: 'bus',
  water: 'ferry',
  ferry: 'ferry',
  funicular: 'other',
  cableway: 'other',
  lift: 'other',
  air: 'other',
};

const MODE_COLOR: Record<string, string> = {
  metro: '#EC700C',
  tram: '#0B91EF',
  rail: '#1B7A5A',
  bus: '#E60000',
  ferry: '#354F7F',
  other: '#8892A6',
};

const PLATFORM_WORD: Record<string, string> = { rail: 'spor', metro: 'spor', tram: 'spor' };

function modeOf(transportMode: string | null): string {
  return MODE_MAP[(transportMode ?? '').toLowerCase()] ?? 'other';
}

function colorOf(raw: string | null, mode: string): string {
  const hex = (raw ?? '').trim().replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{6}$/.test(hex)) return `#${hex}`;
  return MODE_COLOR[mode] ?? MODE_COLOR.other!;
}

function quayLabel(call: RawCall, mode: string): string {
  const code = call.quay?.publicCode?.trim();
  const name = call.quay?.name?.trim() ?? '';
  if (!code) return name;
  return `${PLATFORM_WORD[mode] ?? 'plattform'} ${code}`;
}

export interface RemoteBoard {
  ok: boolean;
  rows: DepartureRow[];
}

const EMPTY_FAILURE: RemoteBoard = { ok: false, rows: [] };

export class RemoteBoards {
  private readonly cache = new Map<string, { at: number; rows: DepartureRow[] }>();
  private readonly pending = new Map<string, Promise<RemoteBoard>>();
  private inflight = 0;
  private consecutiveFailures = 0;
  private pausedUntil = 0;
  private lookups = 0;
  private failures = 0;
  private served = 0;

  constructor(private readonly serviceDate: string) {}

  get stats(): {
    enabled: boolean;
    cached: number;
    lookups: number;
    failures: number;
    served: number;
    paused: boolean;
  } {
    return {
      enabled: ENV.remoteBoards,
      cached: this.cache.size,
      lookups: this.lookups,
      failures: this.failures,
      served: this.served,
      paused: Date.now() < this.pausedUntil,
    };
  }

  async board(stopPlaceId: string, modes: readonly string[], nowSec: number): Promise<RemoteBoard> {
    if (!ENV.remoteBoards || !modes.length) return EMPTY_FAILURE;

    const wanted = [...new Set(modes)].sort();
    const transportModes = wanted.flatMap((mode) => TRANSPORT_MODES[mode] ?? []);
    if (!transportModes.length) return EMPTY_FAILURE;

    const key = `${stopPlaceId}|${wanted.join(',')}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { ok: true, rows: this.select(cached.rows, wanted, nowSec) };
    }

    const existing = this.pending.get(key);
    if (existing) {
      const board = await existing;
      return board.ok ? { ok: true, rows: this.select(board.rows, wanted, nowSec) } : EMPTY_FAILURE;
    }

    if (Date.now() < this.pausedUntil || this.inflight >= MAX_INFLIGHT) return EMPTY_FAILURE;

    const request = this.load(key, stopPlaceId, transportModes);
    this.pending.set(key, request);
    const board = await request;
    if (!board.ok) return EMPTY_FAILURE;
    return { ok: true, rows: this.select(board.rows, wanted, nowSec) };
  }

  private select(rows: readonly DepartureRow[], modes: readonly string[], nowSec: number): DepartureRow[] {
    const wanted = new Set(modes);
    const selected = rows.filter((row) => wanted.has(row.mode) && row.expected >= nowSec);
    this.served += selected.length;
    return selected;
  }

  private async load(key: string, stopPlaceId: string, transportModes: readonly string[]): Promise<RemoteBoard> {
    this.inflight++;
    this.lookups++;
    try {
      const rows = await this.fetchRows(stopPlaceId, transportModes);
      this.cache.set(key, { at: Date.now(), rows });
      this.prune();
      this.consecutiveFailures = 0;
      return { ok: true, rows };
    } catch {
      this.failures++;
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= BREAKER_FAILURES) this.pausedUntil = Date.now() + BREAKER_PAUSE_MS;
      return EMPTY_FAILURE;
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

  private async fetchRows(stopPlaceId: string, transportModes: readonly string[]): Promise<DepartureRow[]> {
    const res = await fetch(ENTUR.journeyPlanner, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ET-Client-Name': ENV.clientName },
      body: JSON.stringify({
        query: QUERY,
        variables: { id: stopPlaceId, n: MAX_DEPARTURES, range: TIME_RANGE_SEC, modes: transportModes },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`journey planner ${res.status}`);

    const json = (await res.json()) as BoardResponse;
    const calls = json.data?.stopPlace?.estimatedCalls;
    if (!calls) throw new Error('journey planner returned no stop place');

    const midnight = osloMidnightUtcMs(this.serviceDate);
    const rows: DepartureRow[] = [];
    for (const call of calls) {
      const cancelled = call.cancellation === true;
      const aimedAt = Date.parse(call.aimedDepartureTime ?? '');
      if (!Number.isFinite(aimedAt)) continue;
      const expectedRaw = call.expectedDepartureTime ? Date.parse(call.expectedDepartureTime) : aimedAt;
      const expectedAt = Number.isFinite(expectedRaw) ? expectedRaw : aimedAt;

      const line = call.serviceJourney?.line;
      const mode = modeOf(line?.transportMode ?? null);
      const aimed = Math.round((aimedAt - midnight) / 1000);
      const expected = cancelled ? aimed : Math.round((expectedAt - midnight) / 1000);
      const realtime = call.realtime === true;

      rows.push({
        vid: null,
        line: line?.publicCode?.trim() || line?.name?.trim() || '',
        lineId: line?.id ?? '',
        mode,
        color: colorOf(line?.presentation?.colour ?? null, mode),
        headsign: call.destinationDisplay?.frontText?.trim() ?? '',
        quay: quayLabel(call, mode),
        aimed,
        expected,
        delay: expected - aimed,
        source: realtime ? 'rt' : 'sched',
        realtime,
        cancelled,
      });
    }
    rows.sort((a, b) => a.expected - b.expected);
    return rows;
  }
}
