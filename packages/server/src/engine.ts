import { pointAtDistance } from './geometry.js';
import { EMPTY_RT, delayAtSeq, isSkipped, type DelaySeries, type RtSnapshot } from './rt.js';
import type { GpsVehicle } from './entur.js';
import type { DestinationResolver } from './destinations.js';
import { CALL_ARR, CALL_DEP, CALL_DIST, CALL_QUAY, CALL_SEQ, type Store } from './store.js';
import { secondsIntoServiceDay } from './time.js';

export type VehicleSource = 'gps' | 'rt' | 'sched';

export interface VehicleState {
  vid: number;
  key: string;
  source: VehicleSource;
  routeIdx: number;
  line: string;
  mode: string;
  color: string;
  headsign: string;
  lat: number;
  lon: number;
  bearing: number;
  delay: number;
  atStop: boolean;
  progress: number;
  nextStop: string;
  tripId: string | null;
}

export interface TickResult {
  added: VehicleState[];
  moved: VehicleState[];
  removed: number[];
  all: VehicleState[];
  nowSec: number;
  stats: TickStats;
}

export interface TickStats {
  active: number;
  bySource: Record<VehicleSource, number>;
  byMode: Record<string, number>;
  computeMs: number;
}

const WINDOW_LEAD_SEC = 120;
const WINDOW_TRAIL_SEC = 3600;
const MAX_MODELLED_DELAY_SEC = 5400;

const CATCH_UP_MPS = 14;
const DRIFT_BACK_MPS = 7;
const PLAUSIBLE_TOP_MPS = 60;
const RESET_GAP_M = 1500;

const GPS_CODESPACE_MODE_COLOR: Record<string, string> = {
  VYG: '#1B7A5A',
  VYX: '#1B7A5A',
  VYB: '#1B7A5A',
  FLT: '#B4145A',
  FLI: '#B4145A',
  OST: '#00778B',
  BRA: '#0F7BBF',
  NBU: '#5C4B9E',
  INN: '#C2571A',
  SKY: '#0F7BBF',
  GOA: '#1B7A5A',
};

const MODE_FALLBACK_COLOR: Record<string, string> = {
  rail: '#1B7A5A',
  metro: '#EC700C',
  tram: '#0B91EF',
  bus: '#E60000',
  ferry: '#354F7F',
  other: '#8892A6',
};

export class Engine {
  private rt: RtSnapshot = EMPTY_RT;
  private gps: GpsVehicle[] = [];
  private gpsFetchedAt = 0;
  private nextVid = 1;
  private vidByKey = new Map<string, number>();
  private current = new Map<number, VehicleState>();
  private track = new Map<string, { dist: number; atMs: number }>();
  private corrections = 0;

  constructor(
    private readonly store: Store,
    private readonly destinations: DestinationResolver,
  ) {}

  get correctionsAbsorbed(): number {
    return this.corrections;
  }

  private slew(tripId: string, target: number, nowMs: number): number {
    const prev = this.track.get(tripId);
    if (!prev) {
      this.track.set(tripId, { dist: target, atMs: nowMs });
      return target;
    }

    const dtSec = Math.max(0.001, (nowMs - prev.atMs) / 1000);
    const gap = target - prev.dist;

    let next: number;
    if (Math.abs(gap) > RESET_GAP_M) {
      next = target;
    } else {
      const maxForward = (PLAUSIBLE_TOP_MPS + CATCH_UP_MPS) * dtSec;
      const maxBackward = DRIFT_BACK_MPS * dtSec;
      const step = Math.min(maxForward, Math.max(-maxBackward, gap));
      next = prev.dist + step;
      if (Math.abs(gap) > maxForward) this.corrections++;
    }

    this.track.set(tripId, { dist: next, atMs: nowMs });
    return next;
  }

  setTripUpdates(snap: RtSnapshot): void {
    this.rt = snap;
  }

  setGpsVehicles(vehicles: GpsVehicle[]): void {
    this.gps = vehicles;
    this.gpsFetchedAt = Date.now();
  }

  get rtInfo(): { trips: number; fetchedAt: number; bytes: number; durationMs: number } {
    return {
      trips: this.rt.byTrip.size,
      fetchedAt: this.rt.fetchedAt,
      bytes: this.rt.bytes,
      durationMs: this.rt.durationMs,
    };
  }

  get gpsInfo(): { count: number; fetchedAt: number } {
    return { count: this.gps.length, fetchedAt: this.gpsFetchedAt };
  }

  snapshot(): VehicleState[] {
    return [...this.current.values()];
  }

  find(vid: number): VehicleState | undefined {
    return this.current.get(vid);
  }

  tick(nowMs = Date.now()): TickResult {
    const started = performance.now();
    const store = this.store;
    const nowSec = secondsIntoServiceDay(store.meta.serviceDate, nowMs);

    const seen = new Set<number>();
    const added: VehicleState[] = [];
    const moved: VehicleState[] = [];
    const bySource: Record<VehicleSource, number> = { gps: 0, rt: 0, sched: 0 };
    const byMode: Record<string, number> = {};

    for (let i = 0; i < store.trips.length; i++) {
      const firstDep = store.window.firstDep[i]!;
      const lastArr = store.window.lastArr[i]!;
      if (nowSec < firstDep - WINDOW_LEAD_SEC) continue;
      if (nowSec > lastArr + WINDOW_TRAIL_SEC + MAX_MODELLED_DELAY_SEC) continue;

      const trip = store.trips[i]!;
      const series = this.rt.byTrip.get(trip.id);
      if (series?.cancelled) continue;

      const placed = this.placeTrip(i, nowSec, series ?? null);
      if (!placed) continue;

      const shape = store.shapes[trip.s];
      if (!shape) continue;

      const smoothed = this.slew(trip.id, placed.dist, nowMs);
      const point = pointAtDistance(store.shapeData, shape, smoothed);
      const totalDist = store.call(i, trip.n - 1, CALL_DIST) || 1;

      const route = store.routes[trip.r]!;
      const key = trip.id;
      const vid = this.vidFor(key);
      seen.add(vid);

      const source: VehicleSource = series ? 'rt' : 'sched';
      const state: VehicleState = {
        vid,
        key,
        source,
        routeIdx: trip.r,
        line: route.line,
        mode: route.mode,
        color: route.color,
        headsign: trip.h,
        lat: point.lat,
        lon: point.lon,
        bearing: point.bearing,
        delay: placed.delay,
        atStop: placed.atStop,
        progress: Math.min(1, Math.max(0, smoothed / totalDist)),
        nextStop: placed.nextStop,
        tripId: trip.id,
      };

      const previous = this.current.get(vid);
      this.current.set(vid, state);
      if (previous) moved.push(state);
      else added.push(state);

      bySource[source]++;
      byMode[route.mode] = (byMode[route.mode] ?? 0) + 1;
    }

    for (const v of this.gps) {
      const vid = this.vidFor(v.key);
      seen.add(vid);
      const color = GPS_CODESPACE_MODE_COLOR[v.codespace] ?? MODE_FALLBACK_COLOR[v.mode] ?? '#8892A6';
      const previous = this.current.get(vid);
      const state: VehicleState = {
        vid,
        key: v.key,
        source: 'gps',
        routeIdx: -1,
        line: v.line,
        mode: v.mode,
        color,
        headsign: this.destinations.resolve(v.journeyId, v.destination || v.lineName || ''),
        lat: v.lat,
        lon: v.lon,
        bearing: v.bearing ?? previous?.bearing ?? 0,
        delay: v.delay,
        atStop: false,
        progress: 0,
        nextStop: '',
        tripId: null,
      };
      this.current.set(vid, state);
      if (previous) moved.push(state);
      else added.push(state);
      bySource.gps++;
      byMode[v.mode] = (byMode[v.mode] ?? 0) + 1;
    }

    const removed: number[] = [];
    for (const vid of this.current.keys()) {
      if (!seen.has(vid)) removed.push(vid);
    }
    for (const vid of removed) {
      const state = this.current.get(vid);
      this.current.delete(vid);
      if (state) {
        this.vidByKey.delete(state.key);
        if (state.tripId) this.track.delete(state.tripId);
      }
    }

    const all = [...this.current.values()];
    return {
      added,
      moved,
      removed,
      all,
      nowSec,
      stats: { active: all.length, bySource, byMode, computeMs: performance.now() - started },
    };
  }

  private vidFor(key: string): number {
    let vid = this.vidByKey.get(key);
    if (vid === undefined) {
      vid = this.nextVid++;
      this.vidByKey.set(key, vid);
    }
    return vid;
  }

  private placeTrip(
    tripIdx: number,
    nowSec: number,
    series: DelaySeries | null,
  ): { dist: number; delay: number; atStop: boolean; nextStop: string } | null {
    const store = this.store;
    const trip = store.trips[tripIdx]!;
    const n = trip.n;
    if (n < 2) return null;

    const adjDep = (k: number): number => {
      const seq = store.call(tripIdx, k, CALL_SEQ);
      const base = store.call(tripIdx, k, CALL_DEP);
      return base + (series ? delayAtSeq(series, seq, 'dep') : 0);
    };
    const adjArr = (k: number): number => {
      const seq = store.call(tripIdx, k, CALL_SEQ);
      const base = store.call(tripIdx, k, CALL_ARR);
      return base + (series ? delayAtSeq(series, seq, 'arr') : 0);
    };

    if (nowSec < adjDep(0) || nowSec > adjArr(n - 1)) return null;

    let dist = -1;
    let atStop = false;
    let segmentStart = 0;
    let delay = 0;

    for (let k = 0; k < n - 1; k++) {
      const depK = adjDep(k);
      const arrK = adjArr(k);
      if (nowSec >= arrK && nowSec <= depK) {
        dist = store.call(tripIdx, k, CALL_DIST);
        atStop = true;
        segmentStart = k;
        delay = adjDep(k) - store.call(tripIdx, k, CALL_DEP);
        break;
      }
      const arrNext = adjArr(k + 1);
      if (nowSec >= depK && nowSec <= arrNext) {
        const d0 = store.call(tripIdx, k, CALL_DIST);
        const d1 = store.call(tripIdx, k + 1, CALL_DIST);
        const span = arrNext - depK;
        const f = span <= 0 ? 1 : (nowSec - depK) / span;
        dist = d0 + f * (d1 - d0);
        segmentStart = k;
        delay = arrNext - store.call(tripIdx, k + 1, CALL_ARR);
        break;
      }
    }

    if (dist < 0) {
      const lastArr = adjArr(n - 1);
      if (nowSec >= adjArr(n - 1) - 1 && nowSec <= lastArr + 1) {
        dist = store.call(tripIdx, n - 1, CALL_DIST);
        segmentStart = n - 1;
      } else {
        return null;
      }
    }

    let nextIdx = Math.min(n - 1, atStop ? segmentStart : segmentStart + 1);
    while (nextIdx < n - 1 && series && isSkipped(series, store.call(tripIdx, nextIdx, CALL_SEQ))) nextIdx++;
    const nextStop = store.quayName(store.call(tripIdx, nextIdx, CALL_QUAY));

    return { dist, delay: Math.round(delay), atStop, nextStop };
  }
}
