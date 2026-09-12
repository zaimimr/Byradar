import { API_URL } from './endpoints.js';
import type { Mode } from './types.js';

const GEOCODE_MIN_CHARS = 3;

export interface GeoHit {
  id: string;
  name: string;
  label: string;
  locality: string;
  kind: string;
  lat: number;
  lon: number;
}

export interface PlaceLine {
  line: string;
  mode: Mode;
  color: string;
  perHour: number;
  day: number;
}

export interface PlaceStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  modes: Mode[];
  metres: number;
  walkMin: number;
  perHour: number;
  dayTotal: number;
  eveningCount: number;
  firstDep: number | null;
  lastDep: number | null;
  lines: PlaceLine[];
  timetable: 'full' | 'partial' | 'none';
  missingModes: Mode[];
  liveModes: Mode[];
}

export interface ScorePart {
  key: string;
  label: string;
  score: number;
  max: number;
  note: string;
}

export interface PlaceProfile {
  point: { lat: number; lon: number };
  serviceDate: string;
  weekday: number;
  score: { total: number; grade: string; label: string; parts: ScorePart[] };
  summary: {
    stops: number;
    lines: number;
    modes: Mode[];
    perHour: number;
    reachPerHour: number;
    nearestWalkMin: number | null;
    railWalkMin: number | null;
    railMode: Mode | null;
    eveningCount: number;
    lastDep: number | null;
  };
  hourly: number[];
  stops: PlaceStop[];
  coverage: { level: 'full' | 'partial' | 'none'; missing: Mode[]; live: Mode[] };
}

export interface CommuteLeg {
  mode: Mode | 'foot';
  line: string;
  color: string;
  from: string;
  to: string;
  minutes: number;
}

export interface Commute {
  to: { id: string; name: string };
  departAt: string;
  minutes: number;
  walkMin: number;
  transfers: number;
  walkOnly: boolean;
  legs: CommuteLeg[];
}

export interface PlacePin {
  lat: number;
  lon: number;
  label: string;
  detail: string;
}

export interface CommuteTarget {
  id: string;
  name: string;
}

interface Hub {
  lat: number;
  lon: number;
  targets: CommuteTarget[];
}

const HUBS: Hub[] = [
  {
    lat: 59.911,
    lon: 10.75,
    targets: [
      { id: 'NSR:StopPlace:337', name: 'Oslo S' },
      { id: 'NSR:StopPlace:4067', name: 'Nationaltheatret' },
      { id: 'NSR:StopPlace:4452', name: 'Majorstuen' },
    ],
  },
  {
    lat: 60.391,
    lon: 5.325,
    targets: [
      { id: 'NSR:StopPlace:548', name: 'Bergen stasjon' },
      { id: 'NSR:StopPlace:30810', name: 'Bergen busstasjon' },
      { id: 'NSR:StopPlace:30859', name: 'Byparken' },
    ],
  },
  {
    lat: 63.43,
    lon: 10.395,
    targets: [
      { id: 'NSR:StopPlace:659', name: 'Trondheim S' },
      { id: 'NSR:StopPlace:41613', name: 'Prinsens gate' },
      { id: 'NSR:StopPlace:43292', name: 'Kongens gate' },
    ],
  },
  {
    lat: 58.97,
    lon: 5.733,
    targets: [
      { id: 'NSR:StopPlace:596', name: 'Stavanger stasjon' },
      { id: 'NSR:StopPlace:59858', name: 'Byparken' },
      { id: 'NSR:StopPlace:59855', name: 'Klubbgata' },
    ],
  },
  {
    lat: 58.147,
    lon: 7.996,
    targets: [
      { id: 'NSR:StopPlace:24252', name: 'Kristiansand rutebilstasjon' },
      { id: 'NSR:StopPlace:60797', name: 'Rådhuset' },
      { id: 'NSR:StopPlace:24117', name: 'Tinghuset' },
    ],
  },
  {
    lat: 69.649,
    lon: 18.955,
    targets: [
      { id: 'NSR:StopPlace:52273', name: 'Tromsø Prostneset' },
      { id: 'NSR:StopPlace:55683', name: 'Fr. Langes gate' },
      { id: 'NSR:StopPlace:53207', name: 'Bankgata' },
    ],
  },
  {
    lat: 62.472,
    lon: 6.155,
    targets: [
      { id: 'NSR:StopPlace:63961', name: 'St. Olavs plass' },
      { id: 'NSR:StopPlace:63254', name: 'Korsegata' },
    ],
  },
  {
    lat: 67.285,
    lon: 14.4,
    targets: [{ id: 'NSR:StopPlace:510', name: 'Bodø stasjon' }],
  },
  {
    lat: 59.74,
    lon: 10.205,
    targets: [
      { id: 'NSR:StopPlace:11', name: 'Drammen stasjon' },
      { id: 'NSR:StopPlace:337', name: 'Oslo S' },
    ],
  },
];

export const DEFAULT_TARGETS: CommuteTarget[] = HUBS[0]!.targets;

export const ALL_HUB_TARGETS: CommuteTarget[] = HUBS.flatMap((hub) => hub.targets);

export function targetsNear(lat: number, lon: number): CommuteTarget[] {
  let best = HUBS[0]!;
  let bestDistance = Infinity;
  for (const hub of HUBS) {
    const dLat = (hub.lat - lat) * 111;
    const dLon = (hub.lon - lon) * 111 * Math.cos((lat * Math.PI) / 180);
    const distance = Math.hypot(dLat, dLon);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = hub;
    }
  }
  return [...best.targets];
}

export async function geocode(
  query: string,
  focus: { lat: number; lon: number } | null = null,
  signal?: AbortSignal,
): Promise<GeoHit[]> {
  const text = query.trim();
  if (text.length < GEOCODE_MIN_CHARS) return [];
  try {
    const near = focus ? `&lat=${focus.lat.toFixed(4)}&lon=${focus.lon.toFixed(4)}` : '';
    const res = await fetch(`${API_URL}/geocode?q=${encodeURIComponent(text)}${near}`, { signal });
    if (!res.ok) return [];
    const json = (await res.json()) as { results?: GeoHit[] };
    return json.results ?? [];
  } catch {
    return [];
  }
}

export async function placeProfile(pin: PlacePin): Promise<PlaceProfile | null> {
  try {
    const res = await fetch(`${API_URL}/place?lat=${pin.lat.toFixed(5)}&lon=${pin.lon.toFixed(5)}`);
    if (!res.ok) return null;
    return (await res.json()) as PlaceProfile;
  } catch {
    return null;
  }
}

export async function placeCommute(pin: PlacePin, target: CommuteTarget): Promise<Commute | null> {
  try {
    const query = `lat=${pin.lat.toFixed(5)}&lon=${pin.lon.toFixed(5)}&to=${encodeURIComponent(target.id)}`;
    const res = await fetch(`${API_URL}/place/commute?${query}`);
    if (!res.ok) return null;
    return (await res.json()) as Commute;
  } catch {
    return null;
  }
}
