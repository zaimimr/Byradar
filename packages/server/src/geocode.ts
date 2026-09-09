import { ENV } from './env.js';
import type { DataMeta } from './store.js';

const AUTOCOMPLETE = 'https://api.entur.io/geocoder/v1/autocomplete';
const LAYERS = 'address,street,venue';
const REQUEST_SIZE = 20;
const MAX_HITS = 6;
const MIN_QUERY_CHARS = 3;
const MAX_QUERY_CHARS = 120;
const REQUEST_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 600_000;
const MAX_CACHE_ENTRIES = 400;
const MAX_INFLIGHT = 4;
const BREAKER_FAILURES = 3;
const BREAKER_PAUSE_MS = 60_000;

const CATEGORY_WORD: Record<string, string> = {
  address: 'adresse',
  street: 'gate',
  venue: 'sted',
};

export interface GeoHit {
  id: string;
  name: string;
  label: string;
  locality: string;
  kind: string;
  lat: number;
  lon: number;
}

interface RawFeature {
  geometry?: { coordinates?: [number, number] | null } | null;
  properties?: {
    id?: string | null;
    gid?: string | null;
    layer?: string | null;
    name?: string | null;
    label?: string | null;
    locality?: string | null;
    borough?: string | null;
    postalcode?: string | null;
  } | null;
}

interface RawResponse {
  features?: RawFeature[] | null;
}

export class Geocoder {
  private readonly cache = new Map<string, { at: number; hits: GeoHit[] }>();
  private readonly pending = new Map<string, Promise<GeoHit[] | null>>();
  private inflight = 0;
  private consecutiveFailures = 0;
  private pausedUntil = 0;
  private lookups = 0;
  private failures = 0;

  constructor(private readonly bbox: DataMeta['bbox']) {}

  get stats(): { cached: number; lookups: number; failures: number; paused: boolean } {
    return {
      cached: this.cache.size,
      lookups: this.lookups,
      failures: this.failures,
      paused: Date.now() < this.pausedUntil,
    };
  }

  async lookup(query: string): Promise<GeoHit[] | null> {
    const text = query.trim().slice(0, MAX_QUERY_CHARS);
    if (text.length < MIN_QUERY_CHARS) return [];

    const key = text.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.hits;

    const existing = this.pending.get(key);
    if (existing) return existing;

    if (Date.now() < this.pausedUntil || this.inflight >= MAX_INFLIGHT) return null;

    const request = this.load(key, text);
    this.pending.set(key, request);
    return request;
  }

  private async load(key: string, text: string): Promise<GeoHit[] | null> {
    this.inflight++;
    this.lookups++;
    try {
      const hits = await this.fetchHits(text);
      this.cache.set(key, { at: Date.now(), hits });
      this.prune();
      this.consecutiveFailures = 0;
      return hits;
    } catch {
      this.failures++;
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= BREAKER_FAILURES) this.pausedUntil = Date.now() + BREAKER_PAUSE_MS;
      return null;
    } finally {
      this.inflight--;
      this.pending.delete(key);
    }
  }

  private prune(): void {
    if (this.cache.size <= MAX_CACHE_ENTRIES) return;
    const stale = Date.now() - CACHE_TTL_MS;
    for (const [key, entry] of this.cache) {
      if (entry.at < stale) this.cache.delete(key);
    }
    for (const key of this.cache.keys()) {
      if (this.cache.size <= MAX_CACHE_ENTRIES) break;
      this.cache.delete(key);
    }
  }

  private inside(lat: number, lon: number): boolean {
    return (
      lat >= this.bbox.minLat && lat <= this.bbox.maxLat && lon >= this.bbox.minLon && lon <= this.bbox.maxLon
    );
  }

  private async fetchHits(text: string): Promise<GeoHit[]> {
    const centreLat = (this.bbox.minLat + this.bbox.maxLat) / 2;
    const centreLon = (this.bbox.minLon + this.bbox.maxLon) / 2;
    const url = new URL(AUTOCOMPLETE);
    url.searchParams.set('text', text);
    url.searchParams.set('size', String(REQUEST_SIZE));
    url.searchParams.set('lang', 'no');
    url.searchParams.set('layers', LAYERS);
    url.searchParams.set('focus.point.lat', centreLat.toFixed(4));
    url.searchParams.set('focus.point.lon', centreLon.toFixed(4));

    const res = await fetch(url, {
      headers: { 'ET-Client-Name': ENV.clientName },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`geocoder ${res.status}`);

    const json = (await res.json()) as RawResponse;
    const features = json.features ?? [];
    const hits: GeoHit[] = [];
    const seen = new Set<string>();

    for (const feature of features) {
      const coords = feature.geometry?.coordinates;
      const props = feature.properties;
      if (!coords || !props) continue;
      const [lon, lat] = coords;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !this.inside(lat, lon)) continue;

      const name = (props.name ?? '').trim();
      if (!name) continue;
      const locality = (props.borough ?? props.locality ?? '').trim();
      const dedupe = `${name.toLowerCase()}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);

      const layer = (props.layer ?? '').trim();
      hits.push({
        id: props.gid ?? props.id ?? dedupe,
        name,
        label: (props.label ?? name).trim(),
        locality,
        kind: CATEGORY_WORD[layer] ?? layer,
        lat,
        lon,
      });
      if (hits.length >= MAX_HITS) break;
    }

    return hits;
  }
}
