import type { VehicleState, VehicleSource } from './engine.js';

const SOURCE_CODE: Record<VehicleSource, number> = { rt: 0, sched: 1, gps: 2 };

export const POS_RECORD_BYTES = 16;

export function encodePositions(vehicles: VehicleState[], nowMs: number): ArrayBuffer {
  const buf = new ArrayBuffer(12 + vehicles.length * POS_RECORD_BYTES);
  const view = new DataView(buf);
  view.setUint32(0, 0x4f534c31, false);
  view.setFloat64(4, nowMs, true);
  const countOffset = 12;
  let offset = countOffset;
  let written = 0;
  for (const v of vehicles) {
    view.setUint32(offset, v.vid, true);
    view.setFloat32(offset + 4, v.lat, true);
    view.setFloat32(offset + 8, v.lon, true);
    view.setUint16(offset + 12, Math.round(v.bearing) % 360, true);
    view.setInt16(offset + 14, clampDelay(v.delay), true);
    offset += POS_RECORD_BYTES;
    written++;
  }
  return written === vehicles.length ? buf : buf.slice(0, countOffset + written * POS_RECORD_BYTES);
}

function clampDelay(delay: number): number {
  const rounded = Math.round(delay);
  if (rounded > 32_000) return 32_000;
  if (rounded < -32_000) return -32_000;
  return rounded;
}

export interface AddedWire {
  i: number;
  s: number;
  m: string;
  l: string;
  c: string;
  h: string;
  r: number;
}

export function encodeAdded(vehicles: VehicleState[]): AddedWire[] {
  return vehicles.map((v) => ({
    i: v.vid,
    s: SOURCE_CODE[v.source],
    m: v.mode,
    l: v.line,
    c: v.color,
    h: v.headsign,
    r: v.routeIdx,
  }));
}
