import type { Engine, VehicleSource } from './engine.js';
import { delayAtSeq, isSkipped } from './rt.js';
import { CALL_DEP, CALL_QUAY, CALL_SEQ, NO_STOP_PLACE, type StopPlaceMeta, type Store } from './store.js';

export class DepartureIndex {
  private constructor(
    private readonly offsets: Int32Array,
    private readonly tripIdx: Int32Array,
    private readonly callIdx: Int32Array,
    private readonly aimed: Int32Array,
    readonly buildMs: number,
  ) {}

  get size(): number {
    return this.tripIdx.length;
  }

  static build(store: Store): DepartureIndex {
    const started = performance.now();
    const places = store.stopPlaces.length;
    const counts = new Int32Array(places);

    for (let t = 0; t < store.trips.length; t++) {
      const calls = store.trips[t]!.n;
      for (let k = 0; k < calls - 1; k++) {
        const place = store.stopPlaceOfQuay(store.call(t, k, CALL_QUAY));
        if (place !== NO_STOP_PLACE) counts[place]!++;
      }
    }

    const offsets = new Int32Array(places + 1);
    for (let p = 0; p < places; p++) offsets[p + 1] = offsets[p]! + counts[p]!;
    const total = offsets[places]!;

    const tripIdx = new Int32Array(total);
    const callIdx = new Int32Array(total);
    const aimed = new Int32Array(total);
    const cursor = offsets.slice(0, places);

    for (let t = 0; t < store.trips.length; t++) {
      const calls = store.trips[t]!.n;
      for (let k = 0; k < calls - 1; k++) {
        const place = store.stopPlaceOfQuay(store.call(t, k, CALL_QUAY));
        if (place === NO_STOP_PLACE) continue;
        const at = cursor[place]!++;
        tripIdx[at] = t;
        callIdx[at] = k;
        aimed[at] = Math.round(store.call(t, k, CALL_DEP));
      }
    }

    const order: number[] = [];
    for (let p = 0; p < places; p++) {
      const start = offsets[p]!;
      const end = offsets[p + 1]!;
      if (end - start < 2) continue;
      order.length = 0;
      for (let i = start; i < end; i++) order.push(i);
      order.sort((a, b) => aimed[a]! - aimed[b]!);
      const trips = order.map((i) => tripIdx[i]!);
      const calls = order.map((i) => callIdx[i]!);
      const times = order.map((i) => aimed[i]!);
      for (let j = 0; j < order.length; j++) {
        tripIdx[start + j] = trips[j]!;
        callIdx[start + j] = calls[j]!;
        aimed[start + j] = times[j]!;
      }
    }

    return new DepartureIndex(offsets, tripIdx, callIdx, aimed, performance.now() - started);
  }

  firstAtOrAfter(place: number, fromSec: number): number {
    let lo = this.offsets[place]!;
    let hi = this.offsets[place + 1]!;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.aimed[mid]! < fromSec) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  endOf(place: number): number {
    return this.offsets[place + 1]!;
  }

  tripAt(i: number): number {
    return this.tripIdx[i]!;
  }

  callAt(i: number): number {
    return this.callIdx[i]!;
  }

  aimedAt(i: number): number {
    return this.aimed[i]!;
  }
}

const LOOKBACK_SEC = 5_400;
const OVERSCAN_FACTOR = 3;

export interface DepartureRow {
  vid: number | null;
  line: string;
  mode: string;
  color: string;
  headsign: string;
  quay: string;
  aimed: number;
  expected: number;
  delay: number;
  source: VehicleSource;
  realtime: boolean;
}

export interface DepartureBoard {
  stop: StopPlaceMeta;
  departures: DepartureRow[];
}

export function buildDepartureBoard(
  store: Store,
  engine: Engine,
  index: DepartureIndex,
  place: number,
  nowSec: number,
  limit: number,
): DepartureBoard {
  const rows: DepartureRow[] = [];
  const end = index.endOf(place);
  const wanted = limit * OVERSCAN_FACTOR;

  for (let i = index.firstAtOrAfter(place, nowSec - LOOKBACK_SEC); i < end && rows.length < wanted; i++) {
    const tripIdx = index.tripAt(i);
    const callIdx = index.callAt(i);
    const trip = store.trips[tripIdx]!;
    const series = engine.seriesForTrip(trip.id);
    if (series?.cancelled) continue;

    const seq = store.call(tripIdx, callIdx, CALL_SEQ);
    if (series && isSkipped(series, seq)) continue;

    const aimed = index.aimedAt(i);
    const delay = series ? delayAtSeq(series, seq, 'dep') : 0;
    const expected = aimed + delay;
    if (expected < nowSec) continue;

    const vehicle = engine.vehicleForTrip(trip.id);
    const source: VehicleSource = vehicle ? vehicle.source : series ? 'rt' : 'sched';
    const route = store.routes[trip.r]!;

    rows.push({
      vid: vehicle?.vid ?? null,
      line: route.line,
      mode: route.mode,
      color: route.color,
      headsign: trip.h,
      quay: store.quayName(store.call(tripIdx, callIdx, CALL_QUAY)),
      aimed,
      expected,
      delay,
      source,
      realtime: source !== 'sched',
    });
  }

  rows.sort((a, b) => a.expected - b.expected);
  return { stop: store.stopPlaces[place]!, departures: rows.slice(0, limit) };
}
