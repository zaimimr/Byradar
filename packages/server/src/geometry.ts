import { SHAPE_STRIDE, type ShapeMeta } from './store.js';

const DEG = Math.PI / 180;

export interface PointOnShape {
  lat: number;
  lon: number;
  bearing: number;
}

function bearingBetween(lat0: number, lon0: number, lat1: number, lon1: number): number {
  const phi0 = lat0 * DEG;
  const phi1 = lat1 * DEG;
  const dLambda = (lon1 - lon0) * DEG;
  const y = Math.sin(dLambda) * Math.cos(phi1);
  const x = Math.cos(phi0) * Math.sin(phi1) - Math.sin(phi0) * Math.cos(phi1) * Math.cos(dLambda);
  const deg = Math.atan2(y, x) / DEG;
  return (deg + 360) % 360;
}

export function pointAtDistance(
  shapeData: Float64Array,
  shape: ShapeMeta,
  distance: number,
): PointOnShape {
  const base = shape.o * SHAPE_STRIDE;
  const last = shape.n - 1;

  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (shapeData[base + mid * SHAPE_STRIDE]! < distance) lo = mid + 1;
    else hi = mid;
  }

  const i1 = lo === 0 ? 1 : lo;
  const i0 = i1 - 1;
  const d0 = shapeData[base + i0 * SHAPE_STRIDE]!;
  const d1 = shapeData[base + i1 * SHAPE_STRIDE]!;
  const la0 = shapeData[base + i0 * SHAPE_STRIDE + 1]!;
  const lo0 = shapeData[base + i0 * SHAPE_STRIDE + 2]!;
  const la1 = shapeData[base + i1 * SHAPE_STRIDE + 1]!;
  const lo1 = shapeData[base + i1 * SHAPE_STRIDE + 2]!;

  const span = d1 - d0;
  const f = span <= 0 ? 0 : Math.min(1, Math.max(0, (distance - d0) / span));

  return {
    lat: la0 + f * (la1 - la0),
    lon: lo0 + f * (lo1 - lo0),
    bearing: bearingBetween(la0, lo0, la1, lo1),
  };
}
