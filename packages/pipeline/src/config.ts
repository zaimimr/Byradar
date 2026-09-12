export const NORWAY_BBOX = {
  minLat: 57.6,
  maxLat: 71.4,
  minLon: 4.0,
  maxLon: 31.6,
} as const;

export type Bbox = typeof NORWAY_BBOX;

export interface GtfsSource {
  id: string;
  url: string;
}

const OUTBOUND = 'https://storage.googleapis.com/marduk-production/outbound/gtfs';

export const GTFS_SOURCES: readonly GtfsSource[] = [
  { id: 'norway', url: `${OUTBOUND}/rb_norway-aggregated-gtfs.zip` },
];

export const TILE_LON = 0.5;
export const TILE_LAT = 0.25;

export const TILED_MODES: ReadonlySet<Mode> = new Set<Mode>(['bus', 'other']);

export const SERVER_SHAPE_TOLERANCE_M = 4;

export const COORD_SCALE = 1e6;

export function tileXOf(lon: number): number {
  return Math.floor((lon - NORWAY_BBOX.minLon) / TILE_LON);
}

export function tileYOf(lat: number): number {
  return Math.floor((lat - NORWAY_BBOX.minLat) / TILE_LAT);
}

export function codespaceOf(id: string): string {
  const at = id.indexOf(':');
  return at > 0 ? id.slice(0, at) : 'UNK';
}

export type Mode = 'metro' | 'tram' | 'rail' | 'bus' | 'ferry' | 'other';

const ROUTE_TYPE_MODE: ReadonlyArray<readonly [number, number, Mode]> = [
  [0, 0, 'tram'],
  [1, 1, 'metro'],
  [2, 2, 'rail'],
  [3, 3, 'bus'],
  [4, 4, 'ferry'],
  [100, 199, 'rail'],
  [200, 299, 'bus'],
  [400, 404, 'metro'],
  [405, 405, 'rail'],
  [700, 799, 'bus'],
  [800, 899, 'bus'],
  [900, 999, 'tram'],
  [1000, 1099, 'ferry'],
  [1200, 1299, 'ferry'],
];

export function modeOfRouteType(routeType: number): Mode {
  for (const [lo, hi, mode] of ROUTE_TYPE_MODE) {
    if (routeType >= lo && routeType <= hi) return mode;
  }
  return 'other';
}

export const MODE_WIDTH: Record<Mode, number> = {
  metro: 3.4,
  rail: 3.0,
  tram: 2.6,
  ferry: 2.0,
  bus: 1.5,
  other: 1.2,
};

export const MODE_ORDER: Record<Mode, number> = {
  bus: 0,
  other: 1,
  ferry: 2,
  tram: 3,
  rail: 4,
  metro: 5,
};

export function inBbox(bbox: Bbox, lat: number, lon: number): boolean {
  return lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon;
}
