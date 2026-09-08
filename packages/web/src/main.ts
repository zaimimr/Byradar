import { MapboxOverlay } from '@deck.gl/mapbox';
import type { PickingInfo } from '@deck.gl/core';
import type { Map as MapLibreMap } from 'maplibre-gl';

import { DATA_URL, API_URL, WS_URL } from './endpoints.js';
import { locate } from './geo.js';
import { LiveFeed } from './live.js';
import { buildLayers } from './layers.js';
import { calmBasemap, createMap, setBuildingVisibility, setLabelVisibility, supportsBuildings } from './mapbase.js';
import { buildSearchIndex } from './search.js';
import type { SearchIndex, StopGroup } from './search.js';
import { buildVehicleSprites } from './sprites.js';
import { createState, readHashLineId, syncHash } from './state.js';
import type { LineFilter } from './state.js';
import { Ui } from './ui.js';
import type { Coverage } from './ui.js';
import type {
  DataMeta,
  DepartureStop,
  Mode,
  NetworkPath,
  RouteMeta,
  StopDepartures,
  StopPlace,
  Vehicle,
  VehicleDetail,
} from './types.js';

const STALE_AFTER_MS = 8000;
const DEPARTURE_LIMIT = 12;
const MAX_GROUP_FETCH = 12;
const STOP_FLY_ZOOM = 15.4;
const FOLLOW_ZOOM = 15.2;
const FOLLOW_VIEWPORT_MAX_WAIT_MS = 1500;
const PICKING_RADIUS = 5;
const VEHICLE_LAYER_IDS = ['vehicle-hull', 'vehicle-bubble'];

const DATA = DATA_URL;
const API = API_URL;
const state = createState();
const initialLineId = readHashLineId();
const sprites = buildVehicleSprites();

let network: NetworkPath[] = [];
let stops: StopPlace[] = [];
let routes: RouteMeta[] = [];
let searchIndex: SearchIndex | null = null;
let meta: DataMeta | null = null;
let nowSec = 0;
let vehicles: Vehicle[] = [];
let liveById = new Map<number, Vehicle>();
let frame = 0;

const ui = new Ui({
  onToggleMode: (mode: Mode) => {
    if (state.modes.has(mode)) {
      if (state.modes.size > 1) state.modes.delete(mode);
    } else {
      state.modes.add(mode);
    }
    ui.syncState(state);
    syncHash(state);
  },
  onToggleNetwork: () => {
    state.showNetwork = !state.showNetwork;
    ui.syncState(state);
    syncHash(state);
  },
  onToggleStops: () => {
    state.showStops = !state.showStops;
    ui.syncState(state);
    syncHash(state);
  },
  onToggleLabels: () => {
    state.showLabels = !state.showLabels;
    setLabelVisibility(map, state.showLabels);
    ui.syncState(state);
    syncHash(state);
  },
  onToggleBuildings: () => {
    state.showBuildings = !state.showBuildings;
    setBuildingVisibility(map, state.showBuildings);
    ui.syncState(state);
    syncHash(state);
  },
  onCloseInspector: () => closeInspector(),
  onToggleFollow: () => {
    if (state.follow) {
      stopFollow();
      return;
    }
    const vid = state.selected;
    const vehicle = vid === null ? undefined : liveById.get(vid);
    if (vehicle) startFollow(vehicle);
  },
  onStopFollow: () => stopFollow(),
  onLocate: () => void findMe(),
  onPickLine: (hit) => {
    stopFollow();
    state.line = { idx: hit.idx, route: hit.route };
    ui.setLineFilter(state.line);
    syncHash(state);
  },
  onPickStop: (hit) => {
    stopFollow();
    map.flyTo({ center: [hit.group.lon, hit.group.lat], zoom: Math.max(map.getZoom(), STOP_FLY_ZOOM), speed: 1.3 });
    void openStop(hit.group);
  },
  onClearLine: () => {
    stopFollow();
    state.line = null;
    ui.setLineFilter(null);
    ui.clearSearchQuery();
    syncHash(state);
  },
});

function closeInspector(): void {
  state.selected = null;
  state.selectedStop = null;
  stopFollow();
  ui.hideInspector();
}

function lineFilterFor(vehicle: Vehicle): LineFilter | null {
  if (vehicle.routeIdx >= 0) {
    const route = routes[vehicle.routeIdx];
    return route ? { idx: vehicle.routeIdx, route } : null;
  }
  const idx = routes.findIndex((r) => r.line === vehicle.line && r.mode === vehicle.mode);
  return idx >= 0 ? { idx, route: routes[idx]! } : null;
}

function startFollow(vehicle: Vehicle): void {
  const isolate = lineFilterFor(vehicle);
  state.follow = {
    vid: vehicle.vid,
    line: vehicle.line,
    restoreLine: state.line,
    isolated: isolate !== null,
  };
  if (isolate) {
    state.line = isolate;
    ui.setLineFilter(isolate, true);
  }
  map.jumpTo({
    center: [vehicle.lon, vehicle.lat],
    zoom: Math.max(map.getZoom(), FOLLOW_ZOOM),
  });
  ui.setFollowing(state.follow);
  syncHash(state);
}

function stopFollow(note?: string): void {
  const follow = state.follow;
  if (!follow) return;
  state.follow = null;
  if (follow.isolated) {
    state.line = follow.restoreLine;
    ui.setLineFilter(follow.restoreLine);
  }
  ui.setFollowing(null, note);
  syncHash(state);
}

function trackFollowed(): void {
  const follow = state.follow;
  if (!follow) return;
  const target = liveById.get(follow.vid);
  if (!target) return;
  map.jumpTo({ center: [target.lon, target.lat] });
}

ui.syncState(state);
ui.setConnection('connecting');

const map: MapLibreMap = createMap(document.getElementById('map')!, state.view);
const overlay = new MapboxOverlay({ interleaved: false, layers: [], pickingRadius: PICKING_RADIUS });

map.on('load', () => {
  map.addControl(overlay);
  calmBasemap(map);
  ui.setBuildingsSupported(supportsBuildings(map));
  if (!state.showLabels) setLabelVisibility(map, false);
  if (state.showBuildings) setBuildingVisibility(map, true);
});

map.on('dragstart', () => stopFollow());

map.on('move', () => {
  const center = map.getCenter();
  state.view = {
    longitude: center.lng,
    latitude: center.lat,
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
  syncHash(state);
  scheduleViewportReport();
});

let viewportTimer: number | undefined;
let lastViewportSentMs = 0;

function sendViewport(): void {
  lastViewportSentMs = Date.now();
  if (viewportTimer !== undefined) clearTimeout(viewportTimer);
  viewportTimer = undefined;
  const b = map.getBounds();
  const padLon = (b.getEast() - b.getWest()) * 0.25;
  const padLat = (b.getNorth() - b.getSouth()) * 0.25;
  feed.reportViewport([
    b.getWest() - padLon,
    b.getSouth() - padLat,
    b.getEast() + padLon,
    b.getNorth() + padLat,
  ]);
}

function scheduleViewportReport(): void {
  if (Date.now() - lastViewportSentMs >= FOLLOW_VIEWPORT_MAX_WAIT_MS) {
    sendViewport();
    return;
  }
  if (viewportTimer !== undefined) clearTimeout(viewportTimer);
  viewportTimer = window.setTimeout(sendViewport, 260);
}

async function loadStatic(): Promise<void> {
  ui.setBoot('laster nettverket');
  const [metaRes, networkRes, stopsRes, routesRes] = await Promise.all([
    fetch(`${DATA}/meta.json`),
    fetch(`${DATA}/network.json`),
    fetch(`${DATA}/stops.json`),
    fetch(`${DATA}/routes.json`),
  ]);
  if (!metaRes.ok || !networkRes.ok || !stopsRes.ok || !routesRes.ok) {
    throw new Error('kunne ikke laste kartdata');
  }
  meta = (await metaRes.json()) as DataMeta;
  network = (await networkRes.json()) as NetworkPath[];
  stops = (await stopsRes.json()) as StopPlace[];
  routes = (await routesRes.json()) as RouteMeta[];
  ui.setMeta(meta);

  searchIndex = buildSearchIndex(routes, stops);
  ui.setSearchIndex(searchIndex);
  restoreLineFilter();
}

function restoreLineFilter(): void {
  if (!initialLineId) return;
  const idx = routes.findIndex((r) => r.id === initialLineId);
  if (idx < 0) return;
  state.line = { idx, route: routes[idx]! };
  ui.setLineFilter(state.line);
}

async function openStop(group: StopGroup): Promise<void> {
  state.selected = null;
  state.selectedStop = group.key;
  ui.renderStop(group, { phase: 'loading' });

  const members = group.members.slice(0, MAX_GROUP_FETCH);
  const responses = await Promise.all(members.map((member) => fetchDepartures(member.id)));
  if (state.selectedStop !== group.key) return;

  const answered = responses.filter((r): r is StopDepartures => r !== null);
  if (!answered.length) {
    ui.renderStop(group, { phase: 'failed' });
    return;
  }

  const departures = answered
    .flatMap((r) => r.departures)
    .sort((a, b) => a.expected - b.expected)
    .slice(0, DEPARTURE_LIMIT);
  ui.renderStop(group, { phase: 'ready', departures, coverage: mergeCoverage(answered) });
}

function missingModesOf(stop: DepartureStop): Mode[] {
  if (stop.missingModes) return stop.missingModes;
  return stop.timetable === 'none' ? stop.modes : [];
}

function mergeCoverage(answered: StopDepartures[]): Coverage {
  const advertised = new Set<Mode>();
  const served = new Set<Mode>();
  for (const response of answered) {
    const missing = new Set(missingModesOf(response.stop));
    for (const mode of response.stop.modes) {
      advertised.add(mode);
      if (!missing.has(mode)) served.add(mode);
    }
  }
  const missing = [...advertised].filter((mode) => !served.has(mode));
  if (!missing.length) return { level: 'full', missing };
  return { level: missing.length === advertised.size ? 'none' : 'partial', missing };
}

async function fetchDepartures(stopId: string): Promise<StopDepartures | null> {
  try {
    const res = await fetch(`${API}/stops/${encodeURIComponent(stopId)}/departures?limit=${DEPARTURE_LIMIT}`);
    if (!res.ok) return null;
    return (await res.json()) as StopDepartures;
  } catch {
    return null;
  }
}

async function findMe(): Promise<void> {
  ui.setLocateState('busy');
  ui.setFlash(null);
  const outcome = await locate(meta?.bbox ?? null);
  if (!outcome.ok) {
    state.fix = null;
    ui.setLocateState('idle');
    ui.setFlash(outcome.message);
    return;
  }
  state.fix = outcome.fix;
  ui.setLocateState('active');
  map.flyTo({ center: [outcome.fix.lon, outcome.fix.lat], zoom: Math.max(map.getZoom(), STOP_FLY_ZOOM), speed: 1.3 });
}

const feed = new LiveFeed(WS_URL, {
  onHello: () => {},
  onFrame: (map_, serverTime) => {
    const cutoff = Date.now() - STALE_AFTER_MS;
    liveById = map_;
    vehicles = [...map_.values()].filter((v) => v.lastChangeMs > 0 && v.seenAt >= cutoff);
    nowSec = secondsIntoOsloDay(serverTime);
    ui.setStats(vehicles);
    if (state.follow && !map_.has(state.follow.vid)) {
      const gone = state.follow.line || 'kjøretøyet';
      stopFollow(`linje ${gone} er ute av trafikk`);
    }
    if (state.selected !== null && !map_.has(state.selected)) {
      state.selected = null;
      stopFollow();
      ui.hideInspector();
    }
  },
  onStatus: (status) => {
    ui.setConnection(status);
    if (status === 'live') {
      ui.setBoot(null);
      scheduleViewportReport();
    }
  },
});

function secondsIntoOsloDay(atMs: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(atMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (get('hour') % 24) * 3600 + get('minute') * 60 + get('second');
}

function redraw(): void {
  frame++;
  overlay.setProps({
    layers: buildLayers({
      state,
      zoom: state.view.zoom,
      latitude: state.view.latitude,
      mapBearing: state.view.bearing,
      network,
      stops,
      vehicles,
      sprites,
      frame,
    }),
    getTooltip: null,
    onHover: handleHover,
    onClick: handleClick,
  });
}

function pickVehicle(x: number, y: number): Vehicle | null {
  const info = overlay.pickObject({ x, y, radius: PICKING_RADIUS, layerIds: VEHICLE_LAYER_IDS });
  return (info?.object as Vehicle | undefined) ?? null;
}

function pickStopGroup(x: number, y: number): StopGroup | null {
  const info = overlay.pickObject({ x, y, radius: PICKING_RADIUS, layerIds: ['stops'] });
  const stop = info?.object as StopPlace | undefined;
  if (!stop) return null;
  return searchIndex?.groupByStopId.get(stop.id) ?? null;
}

function handleHover(info: PickingInfo): void {
  if (info.x === undefined || info.y === undefined) {
    ui.hideTooltip();
    map.getCanvas().style.cursor = '';
    return;
  }
  const vehicle = pickVehicle(info.x, info.y);
  if (vehicle) {
    ui.showTooltip(vehicle, info.x, info.y);
    map.getCanvas().style.cursor = 'pointer';
    return;
  }
  ui.hideTooltip();
  map.getCanvas().style.cursor = pickStopGroup(info.x, info.y) ? 'pointer' : '';
}

async function handleClick(info: PickingInfo): Promise<void> {
  if (info.x === undefined || info.y === undefined) return;
  const vehicle = pickVehicle(info.x, info.y);
  if (vehicle) {
    await selectVehicle(vehicle);
    return;
  }
  const group = pickStopGroup(info.x, info.y);
  if (group) {
    await openStop(group);
    return;
  }
  closeInspector();
}

async function selectVehicle(vehicle: Vehicle): Promise<void> {
  state.selectedStop = null;
  if (state.follow && state.follow.vid !== vehicle.vid) stopFollow();
  state.selected = vehicle.vid;
  try {
    const res = await fetch(`${API}/vehicles/${vehicle.vid}`);
    if (!res.ok) return;
    const detail = (await res.json()) as VehicleDetail;
    if (state.selected === vehicle.vid) {
      ui.renderInspector(detail, nowSec);
      ui.setFollowing(state.follow);
    }
  } catch {
    ui.hideInspector();
  }
}

function loop(): void {
  feed.sample(Date.now());
  trackFollowed();
  redraw();
  requestAnimationFrame(loop);
}

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (state.follow) {
    stopFollow();
    return;
  }
  closeInspector();
});

if (import.meta.env.DEV) {
  Object.defineProperty(window, '__byradar', {
    value: {
      get map() {
        return map;
      },
      get state() {
        return state;
      },
      get vehicles() {
        return vehicles;
      },
      get routes() {
        return routes;
      },
      get overlay() {
        return overlay;
      },
    },
  });
}

try {
  await loadStatic();
  feed.start();
  requestAnimationFrame(loop);
} catch (err) {
  ui.setBoot('kunne ikke laste data – kjører serveren?');
  console.error(err);
}
