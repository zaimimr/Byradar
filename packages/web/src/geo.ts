import type { DataMeta } from './types.js';

const TIMEOUT_MS = 12_000;
const MAX_AGE_MS = 30_000;

export interface Fix {
  lat: number;
  lon: number;
  accuracy: number;
}

export type LocateOutcome =
  | { ok: true; fix: Fix }
  | { ok: false; message: string };

const MESSAGES = {
  unsupported: 'nettleseren din støtter ikke posisjon',
  denied: 'posisjon er avslått. gi nettleseren tilgang og prøv igjen',
  unavailable: 'fant ingen posisjon akkurat nå',
  timeout: 'tidsavbrudd under posisjonering. prøv igjen',
  outside: 'du er utenfor kartutsnittet for Oslo',
} as const;

function messageFor(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED) return MESSAGES.denied;
  if (error.code === error.TIMEOUT) return MESSAGES.timeout;
  return MESSAGES.unavailable;
}

function insideBbox(fix: Fix, bbox: DataMeta['bbox']): boolean {
  return fix.lat >= bbox.minLat && fix.lat <= bbox.maxLat && fix.lon >= bbox.minLon && fix.lon <= bbox.maxLon;
}

export async function locate(bbox: DataMeta['bbox'] | null): Promise<LocateOutcome> {
  if (!navigator.geolocation) return { ok: false, message: MESSAGES.unsupported };

  const position = await new Promise<GeolocationPosition | GeolocationPositionError>((resolve) => {
    navigator.geolocation.getCurrentPosition(resolve, resolve, {
      enableHighAccuracy: true,
      timeout: TIMEOUT_MS,
      maximumAge: MAX_AGE_MS,
    });
  });

  if (!('coords' in position)) return { ok: false, message: messageFor(position) };

  const fix: Fix = {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    accuracy: Math.max(0, position.coords.accuracy),
  };
  if (bbox && !insideBbox(fix, bbox)) return { ok: false, message: MESSAGES.outside };
  return { ok: true, fix };
}
