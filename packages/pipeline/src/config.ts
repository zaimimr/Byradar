export const OSLO_BBOX = {
  minLat: 59.79,
  maxLat: 60.14,
  minLon: 10.45,
  maxLon: 11.0,
} as const;

export type Bbox = typeof OSLO_BBOX;

export interface GtfsSource {
  codespace: string;
  url: string;
  interpolate: boolean;
}

const OUTBOUND = 'https://storage.googleapis.com/marduk-production/outbound/gtfs';

export const GTFS_SOURCES: readonly GtfsSource[] = [
  { codespace: 'RUT', url: `${OUTBOUND}/rb_rut-aggregated-gtfs.zip`, interpolate: true },
  { codespace: 'VYG', url: `${OUTBOUND}/rb_vyg-aggregated-gtfs.zip`, interpolate: false },
  { codespace: 'FLT', url: `${OUTBOUND}/rb_flt-aggregated-gtfs.zip`, interpolate: false },
  { codespace: 'OST', url: `${OUTBOUND}/rb_ost-aggregated-gtfs.zip`, interpolate: false },
  { codespace: 'NBU', url: `${OUTBOUND}/rb_nbu-aggregated-gtfs.zip`, interpolate: false },
];

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
