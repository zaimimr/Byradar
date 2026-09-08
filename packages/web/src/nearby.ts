import type { Fix } from './geo.js';
import type { SearchIndex, StopGroup } from './search.js';

const METRES_PER_DEG_LAT = 111_320;
const WALK_METRES_PER_MIN = 75;
const COMFORT_RADIUS_M = 1200;
const FALLBACK_COUNT = 3;

export interface NearbyStop {
  group: StopGroup;
  metres: number;
  walkMin: number;
}

function metresBetween(fix: Fix, lat: number, lon: number): number {
  const dLat = (lat - fix.lat) * METRES_PER_DEG_LAT;
  const dLon = (lon - fix.lon) * METRES_PER_DEG_LAT * Math.cos((fix.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

function nearestMemberMetres(fix: Fix, group: StopGroup): number {
  let best = metresBetween(fix, group.lat, group.lon);
  for (const member of group.members) {
    const metres = metresBetween(fix, member.lat, member.lon);
    if (metres < best) best = metres;
  }
  return best;
}

export function walkMinutes(metres: number): number {
  return Math.max(1, Math.round(metres / WALK_METRES_PER_MIN));
}

export function formatDistance(metres: number): string {
  if (metres < 950) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1).replace('.', ',')} km`;
}

export function nearestGroups(index: SearchIndex, fix: Fix, limit: number): NearbyStop[] {
  const seen = new Set<string>();
  const scored: NearbyStop[] = [];
  for (const indexed of index.stops) {
    const group = indexed.entry.group;
    if (seen.has(group.key)) continue;
    seen.add(group.key);
    const metres = nearestMemberMetres(fix, group);
    scored.push({ group, metres, walkMin: walkMinutes(metres) });
  }
  scored.sort((a, b) => a.metres - b.metres);
  const inRange = scored.filter((item) => item.metres <= COMFORT_RADIUS_M).slice(0, limit);
  return inRange.length ? inRange : scored.slice(0, FALLBACK_COUNT);
}
