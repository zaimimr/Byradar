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

export const DEFAULT_TARGETS: CommuteTarget[] = [
  { id: 'NSR:StopPlace:337', name: 'Oslo S' },
  { id: 'NSR:StopPlace:4067', name: 'Nationaltheatret' },
  { id: 'NSR:StopPlace:4452', name: 'Majorstuen' },
];

export async function geocode(query: string, signal?: AbortSignal): Promise<GeoHit[]> {
  const text = query.trim();
  if (text.length < GEOCODE_MIN_CHARS) return [];
  try {
    const res = await fetch(`${API_URL}/geocode?q=${encodeURIComponent(text)}`, { signal });
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
