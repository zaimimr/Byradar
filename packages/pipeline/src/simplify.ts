const EARTH_M_PER_DEG = 111_320;

function perpendicularDistanceSq(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

export function simplifyLonLat(points: ReadonlyArray<readonly [number, number]>, toleranceMeters: number): Array<[number, number]> {
  if (points.length <= 2) return points.map((p) => [p[0], p[1]]);
  const midLat = points[Math.floor(points.length / 2)]![1];
  const lonScale = Math.cos((midLat * Math.PI) / 180);
  const tol = toleranceMeters / EARTH_M_PER_DEG;
  const tolSq = tol * tol;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop()!;
    if (last - first < 2) continue;
    const a = points[first]!;
    const b = points[last]!;
    let maxSq = -1;
    let maxIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const p = points[i]!;
      const d = perpendicularDistanceSq(
        p[0] * lonScale, p[1],
        a[0] * lonScale, a[1],
        b[0] * lonScale, b[1],
      );
      if (d > maxSq) {
        maxSq = d;
        maxIdx = i;
      }
    }
    if (maxSq > tolSq && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([first, maxIdx], [maxIdx, last]);
    }
  }

  const out: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) out.push([points[i]![0], points[i]![1]]);
  }
  return out;
}

export function clipRunsToBbox(
  points: ReadonlyArray<readonly [number, number]>,
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  padDegrees: number,
): Array<Array<[number, number]>> {
  const inside = (lon: number, lat: number): boolean =>
    lat >= bbox.minLat - padDegrees &&
    lat <= bbox.maxLat + padDegrees &&
    lon >= bbox.minLon - padDegrees &&
    lon <= bbox.maxLon + padDegrees;

  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];

  for (let i = 0; i < points.length; i++) {
    const [lon, lat] = points[i]!;
    if (inside(lon, lat)) {
      if (run.length === 0 && i > 0) run.push([points[i - 1]![0], points[i - 1]![1]]);
      run.push([lon, lat]);
    } else if (run.length > 0) {
      run.push([lon, lat]);
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs.filter((r) => r.length > 1);
}
