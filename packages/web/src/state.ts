import { MODE_RAIL_ORDER } from './palette.js';
import type { Fix } from './geo.js';
import { DEFAULT_TARGETS } from './place.js';
import type { CommuteTarget, PlacePin } from './place.js';
import type { Mode, RouteMeta } from './types.js';

export interface ViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface LineFilter {
  idx: number;
  route: RouteMeta;
}

export type PunctFilter = 'all' | 'ontime' | 'late';
export type SourceFilter = 'all' | 'gps' | 'est';

export interface FollowState {
  vid: number;
  line: string;
  restoreLine: LineFilter | null;
  isolated: boolean;
}

export interface AppState {
  view: ViewState;
  modes: Set<Mode>;
  showStops: boolean;
  showNetwork: boolean;
  showLabels: boolean;
  showBuildings: boolean;
  punct: PunctFilter;
  source: SourceFilter;
  onlyDeviations: boolean;
  selected: number | null;
  selectedStop: string | null;
  stopAnchor: string | null;
  nearby: Fix | null;
  place: PlacePin | null;
  placeStops: Array<{ lat: number; lon: number }>;
  targets: CommuteTarget[];
  line: LineFilter | null;
  follow: FollowState | null;
  fix: Fix | null;
}

const PHONE_QUERY = '(max-width: 620px)';
const PHONE_ZOOM = 13.3;

const DEFAULT_VIEW: ViewState = {
  longitude: 10.7522,
  latitude: 59.9139,
  zoom: 12.2,
  pitch: 0,
  bearing: 0,
};

function defaultView(): ViewState {
  const onPhone = typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches;
  return onPhone ? { ...DEFAULT_VIEW, zoom: PHONE_ZOOM } : { ...DEFAULT_VIEW };
}

function parseModes(raw: string | undefined): Set<Mode> {
  if (!raw) return new Set(MODE_RAIL_ORDER);
  const wanted = raw.split(',').filter((m): m is Mode => (MODE_RAIL_ORDER as string[]).includes(m));
  return wanted.length ? new Set(wanted) : new Set(MODE_RAIL_ORDER);
}

function parsePunct(raw: string | null): PunctFilter {
  return raw === 'ontime' || raw === 'late' ? raw : 'all';
}

function parseSource(raw: string | null): SourceFilter {
  return raw === 'gps' || raw === 'est' ? raw : 'all';
}

function readHash(): Partial<AppState> {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return {};
  const params = new URLSearchParams(hash);
  const numberOr = (key: string, fallback: number): number => {
    const v = Number(params.get(key));
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    view: {
      longitude: numberOr('lon', DEFAULT_VIEW.longitude),
      latitude: numberOr('lat', DEFAULT_VIEW.latitude),
      zoom: numberOr('z', DEFAULT_VIEW.zoom),
      pitch: numberOr('pitch', DEFAULT_VIEW.pitch),
      bearing: numberOr('brg', DEFAULT_VIEW.bearing),
    },
    modes: parseModes(params.get('modes') ?? undefined),
    showStops: params.get('stops') !== '0',
    showNetwork: params.get('lines') !== '0',
    showLabels: params.get('labels') !== '0',
    showBuildings: params.get('buildings') === '1',
    punct: parsePunct(params.get('punct')),
    source: parseSource(params.get('src')),
    onlyDeviations: params.get('dev') === '1',
  };
}

export function readHashPlace(): PlacePin | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const raw = params.get('p');
  if (!raw) return null;
  const [lat, lon] = raw.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const label = params.get('pn')?.trim();
  return { lat: lat!, lon: lon!, label: label || 'valgt punkt', detail: '' };
}

export function readHashTargetIds(): string[] {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const raw = params.get('to');
  if (!raw) return [];
  return raw.split(',').map((id) => id.trim()).filter(Boolean).slice(0, 6);
}

export function readHashLineId(): string | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return params.get('line');
}

export function readHashStopId(): string | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return params.get('stop');
}

export function hashHasView(): boolean {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return params.has('lat') && params.has('lon');
}

export function createState(): AppState {
  const fromHash = readHash();
  return {
    view: fromHash.view ?? defaultView(),
    modes: fromHash.modes ?? new Set(MODE_RAIL_ORDER),
    showStops: fromHash.showStops ?? true,
    showNetwork: fromHash.showNetwork ?? true,
    showLabels: fromHash.showLabels ?? true,
    showBuildings: fromHash.showBuildings ?? false,
    punct: fromHash.punct ?? 'all',
    source: fromHash.source ?? 'all',
    onlyDeviations: fromHash.onlyDeviations ?? false,
    selected: null,
    selectedStop: null,
    stopAnchor: null,
    nearby: null,
    place: null,
    placeStops: [],
    targets: [...DEFAULT_TARGETS],
    line: null,
    follow: null,
    fix: null,
  };
}

let hashTimer: number | undefined;

export function syncHash(state: AppState): void {
  if (hashTimer !== undefined) clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => {
    const params = new URLSearchParams();
    params.set('lon', state.view.longitude.toFixed(4));
    params.set('lat', state.view.latitude.toFixed(4));
    params.set('z', state.view.zoom.toFixed(2));
    if (state.view.pitch) params.set('pitch', state.view.pitch.toFixed(0));
    if (state.view.bearing) params.set('brg', state.view.bearing.toFixed(0));
    if (state.modes.size !== MODE_RAIL_ORDER.length) {
      params.set('modes', MODE_RAIL_ORDER.filter((m) => state.modes.has(m)).join(','));
    }
    if (!state.showStops) params.set('stops', '0');
    if (!state.showNetwork) params.set('lines', '0');
    if (!state.showLabels) params.set('labels', '0');
    if (state.showBuildings) params.set('buildings', '1');
    if (state.punct !== 'all') params.set('punct', state.punct);
    if (state.source !== 'all') params.set('src', state.source);
    if (state.onlyDeviations) params.set('dev', '1');
    if (state.line) params.set('line', state.line.route.id);
    if (state.stopAnchor) params.set('stop', state.stopAnchor);
    if (state.place) {
      params.set('p', `${state.place.lat.toFixed(5)},${state.place.lon.toFixed(5)}`);
      if (state.place.label) params.set('pn', state.place.label);
    }
    const extra = state.targets.filter((target) => !DEFAULT_TARGETS.some((base) => base.id === target.id));
    if (extra.length) params.set('to', extra.map((target) => target.id).join(','));
    history.replaceState(null, '', `#${params.toString()}`);
  }, 220);
}

export function filtersDirty(state: AppState): boolean {
  return (
    state.modes.size !== MODE_RAIL_ORDER.length ||
    !state.showStops ||
    !state.showNetwork ||
    !state.showLabels ||
    state.showBuildings ||
    state.punct !== 'all' ||
    state.source !== 'all' ||
    state.onlyDeviations ||
    state.line !== null
  );
}

export function resetFilters(state: AppState): void {
  state.modes = new Set(MODE_RAIL_ORDER);
  state.showStops = true;
  state.showNetwork = true;
  state.showLabels = true;
  state.showBuildings = false;
  state.punct = 'all';
  state.source = 'all';
  state.onlyDeviations = false;
  state.line = null;
}
