export type Mode = 'metro' | 'tram' | 'rail' | 'bus' | 'ferry' | 'other';

export interface RouteMeta {
  id: string;
  line: string;
  name: string;
  mode: Mode;
  color: string;
  text: string;
}

export interface NetworkPath {
  r: number;
  d: number;
  m: Mode;
  w: number;
  c: string;
  trips: number;
  path: number[];
}

export interface StopPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  modes: Mode[];
}

export interface DataMeta {
  generatedAt: string;
  serviceDate: string;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  counts: Record<string, number>;
  modes: Mode[];
}

export type VehicleSource = 'rt' | 'sched' | 'gps';

export interface Vehicle {
  vid: number;
  source: VehicleSource;
  mode: Mode;
  line: string;
  color: string;
  headsign: string;
  routeIdx: number;
  lat: number;
  lon: number;
  bearing: number;
  delay: number;
  seenAt: number;
}

export interface TripCall {
  seq: number;
  arrival: number;
  departure: number;
  distance: number;
  name: string;
}

export interface VehicleDetail {
  vehicle: {
    vid: number;
    line: string;
    mode: Mode;
    color: string;
    headsign: string;
    delay: number;
    atStop: boolean;
    progress: number;
    nextStop: string;
    source: VehicleSource;
    tripId: string | null;
  };
  route?: RouteMeta;
  calls: TripCall[];
}
