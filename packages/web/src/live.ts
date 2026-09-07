import type { Vehicle, VehicleSource } from './types.js';
import type { Mode } from './types.js';

const MAGIC = 0x4f534c31;
const RECORD_BYTES = 16;
const METRES_PER_DEG_LAT = 111_320;
const PLAUSIBLE_TOP_MPS = 80;
const MIN_WINDOW_MS = 250;
const MAX_WINDOW_MS = 12_000;
const SOURCE_BY_CODE: VehicleSource[] = ['rt', 'sched', 'gps'];

interface AddWire {
  i: number;
  s: number;
  m: Mode;
  l: string;
  c: string;
  h: string;
  r: number;
}

export interface LiveHandlers {
  onHello: (meta: unknown, tickMs: number) => void;
  onFrame: (vehicles: Map<number, Vehicle>, serverTime: number) => void;
  onStatus: (state: 'connecting' | 'live' | 'lost') => void;
}

function shortestTurn(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function roughMetres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * METRES_PER_DEG_LAT;
  const dLon = (bLon - aLon) * METRES_PER_DEG_LAT * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

export class LiveFeed {
  private socket: WebSocket | null = null;
  private readonly vehicles = new Map<number, Vehicle>();
  private retryMs = 800;
  private closed = false;
  private tickMs = 1000;

  constructor(private readonly url: string, private readonly handlers: LiveHandlers) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.socket?.close();
  }

  get current(): Map<number, Vehicle> {
    return this.vehicles;
  }

  private connect(): void {
    this.handlers.onStatus('connecting');
    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.retryMs = 800;
      this.handlers.onStatus('live');
    };

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') this.handleJson(event.data);
      else this.handleBinary(event.data as ArrayBuffer);
    };

    socket.onclose = () => {
      if (this.closed) return;
      this.handlers.onStatus('lost');
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 1.7, 12_000);
    };

    socket.onerror = () => socket.close();
  }

  private handleJson(raw: string): void {
    const msg = JSON.parse(raw) as
      | { t: 'hello'; meta: unknown; tickMs: number }
      | { t: 'add'; v: AddWire[] }
      | { t: 'del'; v: number[] };

    if (msg.t === 'hello') {
      this.tickMs = msg.tickMs;
      this.handlers.onHello(msg.meta, msg.tickMs);
      return;
    }
    if (msg.t === 'add') {
      for (const a of msg.v) {
        const existing = this.vehicles.get(a.i);
        this.vehicles.set(a.i, {
          vid: a.i,
          source: SOURCE_BY_CODE[a.s] ?? 'sched',
          mode: a.m,
          line: a.l,
          color: a.c,
          headsign: a.h,
          routeIdx: a.r,
          lat: existing?.lat ?? 0,
          lon: existing?.lon ?? 0,
          bearing: existing?.bearing ?? 0,
          delay: existing?.delay ?? 0,
          seenAt: Date.now(),
          fromLat: existing?.fromLat ?? 0,
          fromLon: existing?.fromLon ?? 0,
          fromBearing: existing?.fromBearing ?? 0,
          toLat: existing?.toLat ?? 0,
          toLon: existing?.toLon ?? 0,
          toBearing: existing?.toBearing ?? 0,
          startMs: existing?.startMs ?? 0,
          endMs: existing?.endMs ?? 0,
          lastChangeMs: existing?.lastChangeMs ?? 0,
        });
      }
      return;
    }
    for (const vid of msg.v) this.vehicles.delete(vid);
  }

  sample(nowMs: number): void {
    for (const vehicle of this.vehicles.values()) {
      if (vehicle.lastChangeMs === 0) continue;
      const span = vehicle.endMs - vehicle.startMs;
      const f = span <= 0 ? 1 : Math.min(1, Math.max(0, (nowMs - vehicle.startMs) / span));
      vehicle.lat = vehicle.fromLat + (vehicle.toLat - vehicle.fromLat) * f;
      vehicle.lon = vehicle.fromLon + (vehicle.toLon - vehicle.fromLon) * f;
      vehicle.bearing =
        (vehicle.fromBearing + shortestTurn(vehicle.fromBearing, vehicle.toBearing) * f + 360) % 360;
    }
  }

  private handleBinary(buf: ArrayBuffer): void {
    const view = new DataView(buf);
    if (view.byteLength < 12 || view.getUint32(0, false) !== MAGIC) return;
    const serverTime = view.getFloat64(4, true);
    const count = Math.floor((view.byteLength - 12) / RECORD_BYTES);
    const now = Date.now();

    for (let i = 0; i < count; i++) {
      const o = 12 + i * RECORD_BYTES;
      const vid = view.getUint32(o, true);
      const vehicle = this.vehicles.get(vid);
      if (!vehicle) continue;
      const lat = view.getFloat32(o + 4, true);
      const lon = view.getFloat32(o + 8, true);
      const bearing = view.getUint16(o + 12, true);
      vehicle.delay = view.getInt16(o + 14, true);
      vehicle.seenAt = now;

      const fresh = vehicle.lastChangeMs === 0;
      if (!fresh && lat === vehicle.toLat && lon === vehicle.toLon) continue;

      const window = fresh
        ? this.tickMs
        : Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, now - vehicle.lastChangeMs));
      const travelled = fresh ? 0 : roughMetres(vehicle.toLat, vehicle.toLon, lat, lon);
      const implausible = travelled > (window / 1000) * PLAUSIBLE_TOP_MPS;

      if (fresh || implausible) {
        vehicle.fromLat = lat;
        vehicle.fromLon = lon;
        vehicle.fromBearing = bearing;
      } else {
        vehicle.fromLat = vehicle.lat;
        vehicle.fromLon = vehicle.lon;
        vehicle.fromBearing = vehicle.bearing;
      }

      vehicle.toLat = lat;
      vehicle.toLon = lon;
      vehicle.toBearing = bearing;
      vehicle.startMs = now;
      vehicle.endMs = now + window;
      vehicle.lastChangeMs = now;
    }

    this.sample(now);
    this.handlers.onFrame(this.vehicles, serverTime);
  }
}
