import type { Vehicle, VehicleSource } from './types.js';
import type { Mode } from './types.js';

const MAGIC = 0x4f534c31;
const RECORD_BYTES = 16;
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

export class LiveFeed {
  private socket: WebSocket | null = null;
  private readonly vehicles = new Map<number, Vehicle>();
  private retryMs = 800;
  private closed = false;

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
        });
      }
      return;
    }
    for (const vid of msg.v) this.vehicles.delete(vid);
  }

  private handleBinary(buf: ArrayBuffer): void {
    const view = new DataView(buf);
    if (view.byteLength < 12 || view.getUint32(0, false) !== MAGIC) return;
    const serverTime = view.getFloat64(4, true);
    const count = Math.floor((view.byteLength - 12) / RECORD_BYTES);

    for (let i = 0; i < count; i++) {
      const o = 12 + i * RECORD_BYTES;
      const vid = view.getUint32(o, true);
      const vehicle = this.vehicles.get(vid);
      if (!vehicle) continue;
      vehicle.lat = view.getFloat32(o + 4, true);
      vehicle.lon = view.getFloat32(o + 8, true);
      vehicle.bearing = view.getUint16(o + 12, true);
      vehicle.delay = view.getInt16(o + 14, true);
      vehicle.seenAt = Date.now();
    }

    this.handlers.onFrame(this.vehicles, serverTime);
  }
}
