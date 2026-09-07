import { ENTUR, ENV } from './env.js';

export interface GpsVehicle {
  key: string;
  codespace: string;
  mode: string;
  line: string;
  lineRef: string;
  destination: string;
  lineName: string;
  journeyId: string | null;
  lat: number;
  lon: number;
  bearing: number | null;
  delay: number;
  updatedAt: number;
}

const QUERY = `query OsloVehicles($bbox: BoundingBox!) {
  vehicles(boundingBox: $bbox, monitored: true) {
    vehicleId
    mode
    bearing
    delay
    lastUpdatedEpochSecond
    destinationName
    serviceJourney { id }
    datedServiceJourney { id }
    codespace { codespaceId }
    line { lineRef publicCode lineName }
    location { latitude longitude }
  }
}`;

interface RawVehicle {
  vehicleId: string | null;
  mode: string | null;
  bearing: number | null;
  delay: number | null;
  lastUpdatedEpochSecond: number | null;
  destinationName: string | null;
  serviceJourney: { id: string | null } | null;
  datedServiceJourney: { id: string | null } | null;
  codespace: { codespaceId: string | null } | null;
  line: { lineRef: string | null; publicCode: string | null; lineName: string | null } | null;
  location: { latitude: number | null; longitude: number | null } | null;
}

const MODE_MAP: Record<string, string> = {
  RAIL: 'rail',
  METRO: 'metro',
  TRAM: 'tram',
  BUS: 'bus',
  COACH: 'bus',
  FERRY: 'ferry',
  WATER: 'ferry',
  AIR: 'other',
};

export async function fetchGpsVehicles(bbox: {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}): Promise<GpsVehicle[]> {
  const res = await fetch(ENTUR.vehiclesGraphql, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ET-Client-Name': ENV.clientName,
    },
    body: JSON.stringify({ query: QUERY, variables: { bbox } }),
  });
  if (!res.ok) throw new Error(`vehicles graphql ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { data?: { vehicles?: RawVehicle[] }; errors?: unknown };
  if (json.errors) throw new Error(`vehicles graphql errors: ${JSON.stringify(json.errors)}`);

  const out: GpsVehicle[] = [];
  for (const v of json.data?.vehicles ?? []) {
    const lat = v.location?.latitude;
    const lon = v.location?.longitude;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    const codespace = v.codespace?.codespaceId ?? 'UNK';
    out.push({
      key: `gps:${codespace}:${v.vehicleId ?? `${lat},${lon}`}`,
      codespace,
      mode: MODE_MAP[v.mode ?? ''] ?? 'other',
      line: v.line?.publicCode ?? v.line?.lineName ?? '',
      lineRef: v.line?.lineRef ?? '',
      destination: v.destinationName ?? '',
      lineName: v.line?.lineName ?? '',
      journeyId: v.serviceJourney?.id ?? v.datedServiceJourney?.id ?? null,
      lat,
      lon,
      bearing: typeof v.bearing === 'number' ? v.bearing : null,
      delay: Math.round(v.delay ?? 0),
      updatedAt: (v.lastUpdatedEpochSecond ?? 0) * 1000,
    });
  }
  return out;
}

export function startGpsPoller(opts: {
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  intervalMs: number;
  onSnapshot: (vehicles: GpsVehicle[]) => void;
  onError: (err: unknown) => void;
}): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const cycle = async (): Promise<void> => {
    try {
      const vehicles = await fetchGpsVehicles(opts.bbox);
      if (!stopped) opts.onSnapshot(vehicles);
    } catch (err) {
      if (!stopped) opts.onError(err);
    } finally {
      if (!stopped) timer = setTimeout(cycle, opts.intervalMs);
    }
  };

  void cycle();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
