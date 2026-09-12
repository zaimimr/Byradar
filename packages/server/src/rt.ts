import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

import { ENTUR, ENV } from './env.js';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

export interface DelaySeries {
  seq: Int32Array;
  arr: Int32Array;
  dep: Int32Array;
  skipped: Uint8Array;
  cancelled: boolean;
  vehicleLabel: string | null;
}

export interface RtSnapshot {
  byTrip: Map<string, DelaySeries>;
  fetchedAt: number;
  feedTimestamp: number;
  bytes: number;
  durationMs: number;
}

export const EMPTY_RT: RtSnapshot = {
  byTrip: new Map(),
  fetchedAt: 0,
  feedTimestamp: 0,
  bytes: 0,
  durationMs: 0,
};

export function delayAtSeq(series: DelaySeries, seq: number, field: 'arr' | 'dep'): number {
  const values = field === 'arr' ? series.arr : series.dep;
  const seqs = series.seq;
  let lo = 0;
  let hi = seqs.length - 1;
  if (hi < 0) return 0;
  if (seq <= seqs[0]!) return values[0]!;
  if (seq >= seqs[hi]!) return values[hi]!;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (seqs[mid]! < seq) lo = mid + 1;
    else hi = mid;
  }
  if (seqs[lo] === seq) return values[lo]!;
  return values[Math.max(0, lo - 1)]!;
}

export function isSkipped(series: DelaySeries, seq: number): boolean {
  const idx = series.seq.indexOf(seq);
  return idx >= 0 && series.skipped[idx] === 1;
}

export async function fetchTripUpdates(keep: (tripId: string) => boolean): Promise<RtSnapshot> {
  const started = Date.now();
  const res = await fetch(ENTUR.tripUpdates, {
    headers: { 'ET-Client-Name': ENV.clientName },
  });
  if (!res.ok) throw new Error(`trip-updates ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const feed = FeedMessage.decode(buf);

  const byTrip = new Map<string, DelaySeries>();

  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (!tu?.trip?.tripId) continue;
    const tripId = tu.trip.tripId;
    if (!keep(tripId)) continue;

    const updates = tu.stopTimeUpdate ?? [];
    const n = updates.length;
    const seq = new Int32Array(n);
    const arr = new Int32Array(n);
    const dep = new Int32Array(n);
    const skipped = new Uint8Array(n);

    let carried = 0;
    for (let i = 0; i < n; i++) {
      const u = updates[i]!;
      seq[i] = u.stopSequence ?? i + 1;
      const a = u.arrival?.delay ?? null;
      const d = u.departure?.delay ?? null;
      const aVal = a ?? d ?? carried;
      const dVal = d ?? a ?? carried;
      arr[i] = aVal;
      dep[i] = dVal;
      carried = dVal;
      if (u.scheduleRelationship === 1) skipped[i] = 1;
    }

    byTrip.set(tripId, {
      seq,
      arr,
      dep,
      skipped,
      cancelled: tu.trip.scheduleRelationship === 3,
      vehicleLabel: tu.vehicle?.label ?? tu.vehicle?.id ?? null,
    });
  }

  return {
    byTrip,
    fetchedAt: Date.now(),
    feedTimestamp: Number(feed.header?.timestamp ?? 0) * 1000,
    bytes: buf.byteLength,
    durationMs: Date.now() - started,
  };
}

export function startTripUpdatePoller(opts: {
  keep: (tripId: string) => boolean;
  intervalMs: number;
  onSnapshot: (snap: RtSnapshot) => void;
  onError: (err: unknown) => void;
}): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const cycle = async (): Promise<void> => {
    try {
      const snap = await fetchTripUpdates(opts.keep);
      if (!stopped) opts.onSnapshot(snap);
    } catch (err) {
      if (!stopped) opts.onError(err);
    } finally {
      if (!stopped) timer = setTimeout(cycle, opts.intervalMs);
    }
  };

  void cycle();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
