import { MODE_RAIL_ORDER } from './palette.js';
import type { Mode } from './types.js';

export interface ViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface AppState {
  view: ViewState;
  modes: Set<Mode>;
  showStops: boolean;
  showNetwork: boolean;
  showLabels: boolean;
  selected: number | null;
}

const DEFAULT_VIEW: ViewState = {
  longitude: 10.7522,
  latitude: 59.9139,
  zoom: 12.2,
  pitch: 0,
  bearing: 0,
};

function parseModes(raw: string | undefined): Set<Mode> {
  if (!raw) return new Set(MODE_RAIL_ORDER);
  const wanted = raw.split(',').filter((m): m is Mode => (MODE_RAIL_ORDER as string[]).includes(m));
  return wanted.length ? new Set(wanted) : new Set(MODE_RAIL_ORDER);
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
  };
}

export function createState(): AppState {
  const fromHash = readHash();
  return {
    view: fromHash.view ?? { ...DEFAULT_VIEW },
    modes: fromHash.modes ?? new Set(MODE_RAIL_ORDER),
    showStops: fromHash.showStops ?? true,
    showNetwork: fromHash.showNetwork ?? true,
    showLabels: fromHash.showLabels ?? true,
    selected: null,
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
    history.replaceState(null, '', `#${params.toString()}`);
  }, 220);
}
