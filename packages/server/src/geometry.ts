import { SHAPE_STRIDE, type ShapeMeta } from './store.js';

const DEG = Math.PI / 180;
const TANGENT_BEHIND_M = 11;
const TANGENT_AHEAD_M = 15;
const METRES_PER_DEG = 111_320;

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

function sampleAt(
  shapeData: Float64Array,
  shape: ShapeMeta,
  distance: number,
): { lat: number; lon: number } {
  const base = shape.o * SHAPE_STRIDE;
  const last = shape.n - 1;

  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (shapeData[base + mid * SHAPE_STRIDE]! < distance) lo = mid + 1;
    else hi = mid;
  }

  const i1 = lo === 0 ? Math.min(1, last) : lo;
  const i0 = Math.max(0, i1 - 1);
  const d0 = shapeData[base + i0 * SHAPE_STRIDE]!;
  const d1 = shapeData[base + i1 * SHAPE_STRIDE]!;
  const la0 = shapeData[base + i0 * SHAPE_STRIDE + 1]!;
  const lo0 = shapeData[base + i0 * SHAPE_STRIDE + 2]!;
  const la1 = shapeData[base + i1 * SHAPE_STRIDE + 1]!;
  const lo1 = shapeData[base + i1 * SHAPE_STRIDE + 2]!;

  const span = d1 - d0;
  const f = span <= 0 ? 0 : Math.min(1, Math.max(0, (distance - d0) / span));
  return { lat: la0 + f * (la1 - la0), lon: lo0 + f * (lo1 - lo0) };
}

export function pointAtDistance(
  shapeData: Float64Array,
  shape: ShapeMeta,
  distance: number,
): PointOnShape {
  const base = shape.o * SHAPE_STRIDE;
  const last = shape.n - 1;
  const end = shapeData[base + last * SHAPE_STRIDE]!;
  const clamped = Math.min(end, Math.max(0, distance));

  const here = sampleAt(shapeData, shape, clamped);
  const from = Math.max(0, clamped - TANGENT_BEHIND_M);
  const to = Math.min(end, clamped + TANGENT_AHEAD_M);
  const behind = sampleAt(shapeData, shape, from);
  const ahead = sampleAt(shapeData, shape, to);

  if (behind.lat === ahead.lat && behind.lon === ahead.lon) {
    const first = sampleAt(shapeData, shape, 0);
    const final = sampleAt(shapeData, shape, end);
    return { lat: here.lat, lon: here.lon, bearing: bearingBetween(first.lat, first.lon, final.lat, final.lon) };
  }

  const fitted = fitTangent(shapeData, shape, from, to, behind, ahead, here.lat);
  return { lat: here.lat, lon: here.lon, bearing: fitted };
}

function fitTangent(
  shapeData: Float64Array,
  shape: ShapeMeta,
  from: number,
  to: number,
  behind: { lat: number; lon: number },
  ahead: { lat: number; lon: number },
  refLat: number,
): number {
  const base = shape.o * SHAPE_STRIDE;
  const lonScale = Math.cos(refLat * DEG) * METRES_PER_DEG;

  let n = 0;
  let sumX = 0;
  let sumY = 0;
  const xs: number[] = [];
  const ys: number[] = [];

  const add = (lat: number, lon: number): void => {
    const x = lon * lonScale;
    const y = lat * METRES_PER_DEG;
    xs.push(x);
    ys.push(y);
    sumX += x;
    sumY += y;
    n++;
  };

  add(behind.lat, behind.lon);
  for (let i = 0; i < shape.n; i++) {
    const d = shapeData[base + i * SHAPE_STRIDE]!;
    if (d <= from) continue;
    if (d >= to) break;
    add(shapeData[base + i * SHAPE_STRIDE + 1]!, shapeData[base + i * SHAPE_STRIDE + 2]!);
  }
  add(ahead.lat, ahead.lon);

  if (n < 3) return bearingBetween(behind.lat, behind.lon, ahead.lat, ahead.lon);

  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let vx = Math.cos(theta);
  let vy = Math.sin(theta);

  const travelX = ahead.lon * lonScale - behind.lon * lonScale;
  const travelY = (ahead.lat - behind.lat) * METRES_PER_DEG;
  if (vx * travelX + vy * travelY < 0) {
    vx = -vx;
    vy = -vy;
  }

  return (Math.atan2(vx, vy) / DEG + 360) % 360;
}
