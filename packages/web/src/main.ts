import { MapboxOverlay } from '@deck.gl/mapbox';
import type { PickingInfo } from '@deck.gl/core';
import type { Map as MapLibreMap } from 'maplibre-gl';

import './analytics.js';

import { DATA_URL, API_URL, WS_URL } from './endpoints.js';
import { locate } from './geo.js';
import type { Fix } from './geo.js';
import { LiveFeed } from './live.js';
import { buildLayers, passesFilters } from './layers.js';
import { calmBasemap, createMap, setBuildingVisibility, setLabelVisibility, supportsBuildings } from './mapbase.js';
import { buildSearchIndex } from './search.js';
import type { SearchIndex, StopGroup } from './search.js';
import { nearestGroups } from './nearby.js';
import { NetworkTiles } from './nettiles.js';
import type { NearbyStop } from './nearby.js';
import { DEFAULT_TARGETS, geocode, placeCommute, placeProfile, targetsNear } from './place.js';
import type { CommuteTarget, GeoHit, PlacePin } from './place.js';
import type { PlaceView } from './placeview.js';
import { NO_DEVIATIONS, deviationRoutes, loadSituations } from './situations.js';
import type { DeviationRoutes } from './situations.js';
import { buildVehicleSprites } from './sprites.js';
import {
  createState,
  hashHasView,
  readHashLineId,
  readHashPlace,
  readHashStopId,
  readHashTargetIds,
  resetFilters,
  syncHash,
} from './state.js';
import type { LineFilter, PunctFilter, SourceFilter } from './state.js';
import { secondsIntoServiceDay } from './time.js';
import { Ui } from './ui.js';
import type { Coverage, DeparturesState, NearbyBoards } from './ui.js';
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
const STOP_REFRESH_MS = 30_000;
const NEARBY_LIMIT = 4;
const NEARBY_MEMBER_FETCH = 2;
const NEARBY_DEPARTURE_LIMIT = 3;
const NEARBY_REFRESH_MS = 60_000;
const SITUATION_REFRESH_MS = 180_000;
const STOP_FLY_ZOOM = 15.4;
const PLACE_FLY_ZOOM = 14.3;
const MAX_TARGETS = 6;
const LONG_PRESS_MS = 520;
const LONG_PRESS_SLOP_PX = 12;
const FOLLOW_ZOOM = 15.2;
const FOLLOW_VIEWPORT_MAX_WAIT_MS = 1500;
const COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;
const VEHICLE_PICK_RADIUS = COARSE_POINTER ? 10 : 5;
const STOP_PICK_RADIUS = COARSE_POINTER ? 14 : 5;
const VEHICLE_LAYER_IDS = ['vehicle-hull', 'vehicle-bubble'];

const DATA = DATA_URL;
const API = API_URL;
const state = createState();
const initialLineId = readHashLineId();
const sprites = buildVehicleSprites();

let network: NetworkPath[] = [];
let networkVersion = 0;
let stops: StopPlace[] = [];
let routes: RouteMeta[] = [];
let searchIndex: SearchIndex | null = null;
let meta: DataMeta | null = null;
let nowSec = 0;
let vehicles: Vehicle[] = [];
let liveById = new Map<number, Vehicle>();
let frame = 0;
let serverSkewMs = 0;
let liveServiceDate: string | null = null;
let stopRefreshTimer: number | undefined;
let nearbyRefreshTimer: number | undefined;
let nearbyToken = 0;
let nearbyBoards: NearbyBoards = new Map();
let deviations: DeviationRoutes = NO_DEVIATIONS;
let placeView: PlaceView | null = null;
let placeToken = 0;
let addressAbort: AbortController | null = null;

function serviceNowSec(): number {
  const serviceDate = liveServiceDate ?? meta?.serviceDate;
  if (!serviceDate) return 0;
  return secondsIntoServiceDay(serviceDate, Date.now() + serverSkewMs);
}

function applyFilters(): void {
  ui.syncState(state);
  syncHash(state);
  refreshFilterSummary();
}

const ui = new Ui({
  onToggleMode: (mode: Mode) => {
    if (state.modes.has(mode)) {
      if (state.modes.size > 1) state.modes.delete(mode);
    } else {
      state.modes.add(mode);
    }
    applyFilters();
  },
  onToggleNetwork: () => {
    state.showNetwork = !state.showNetwork;
    applyFilters();
  },
  onToggleStops: () => {
    state.showStops = !state.showStops;
    applyFilters();
  },
  onToggleLabels: () => {
    state.showLabels = !state.showLabels;
    setLabelVisibility(map, state.showLabels);
    applyFilters();
  },
  onToggleBuildings: () => {
    state.showBuildings = !state.showBuildings;
    setBuildingVisibility(map, state.showBuildings);
    applyFilters();
  },
  onSetPunct: (value: PunctFilter) => {
    state.punct = value;
    applyFilters();
  },
  onSetSource: (value: SourceFilter) => {
    state.source = value;
    applyFilters();
  },
  onToggleDeviations: () => {
    state.onlyDeviations = !state.onlyDeviations;
    applyFilters();
  },
  onReset: () => {
    stopFollow();
    resetFilters(state);
    setLabelVisibility(map, state.showLabels);
    setBuildingVisibility(map, state.showBuildings);
    ui.setLineFilter(null);
    ui.clearSearchQuery();
    applyFilters();
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
    applyFilters();
  },
  onPickStop: (hit) => {
    stopFollow();
    map.flyTo({ center: [hit.group.lon, hit.group.lat], zoom: Math.max(map.getZoom(), STOP_FLY_ZOOM), speed: 1.3 });
    void openStop(hit.group);
  },
  onPickNearby: (item: NearbyStop) => {
    stopFollow();
    map.flyTo({
      center: [item.group.lon, item.group.lat],
      zoom: Math.max(map.getZoom(), STOP_FLY_ZOOM),
      speed: 1.3,
    });
    void openStop(item.group);
  },
  onPickAddress: (hit: GeoHit) => {
    void openPlace({
      lat: hit.lat,
      lon: hit.lon,
      label: hit.name,
      detail: [hit.locality, hit.kind].filter(Boolean).join(' · '),
    });
  },
  onPickPlaceStop: (stopId: string) => {
    const group = searchIndex?.groupByStopId.get(stopId);
    if (!group) return;
    stopFollow();
    map.flyTo({ center: [group.lon, group.lat], zoom: Math.max(map.getZoom(), STOP_FLY_ZOOM), speed: 1.3 });
    void openStop(group);
  },
  onAddTarget: (target: CommuteTarget) => addTarget(target),
  searchAddress: (query: string) => lookupAddress(query),
  serviceNow: () => serviceNowSec(),
  onClearLine: () => {
    stopFollow();
    state.line = null;
    ui.setLineFilter(null);
    ui.clearSearchQuery();
    applyFilters();
  },
});

function refreshFilterSummary(): void {
  let shown = 0;
  for (const vehicle of vehicles) {
    if (passesFilters(vehicle, state, deviations)) shown++;
  }
  ui.setFilterSummary(shown, vehicles.length);
}

function closeInspector(): void {
  state.selected = null;
  clearStop();
  clearNearby();
  clearPlace();
  stopFollow();
  ui.hideInspector();
}

function clearPlace(): void {
  placeToken++;
  placeView = null;
  state.place = null;
  state.placeStops = [];
  syncHash(state);
}

async function lookupAddress(query: string): Promise<GeoHit[]> {
  addressAbort?.abort();
  const controller = new AbortController();
  addressAbort = controller;
  const centre = map.getCenter();
  return geocode(query, { lat: centre.lat, lon: centre.lng }, controller.signal);
}

async function loadCommute(token: number, target: CommuteTarget): Promise<void> {
  const view = placeView;
  if (!view) return;
  view.commutes.set(target.id, { phase: 'loading' });
  ui.renderPlace(view);
  const commute = await placeCommute(view.pin, target);
  if (token !== placeToken || placeView !== view) return;
  view.commutes.set(target.id, commute ? { phase: 'ready', commute } : { phase: 'failed' });
  ui.renderPlace(view);
}

function addTarget(target: CommuteTarget): void {
  state.chosenTargets = true;
  if (state.targets.some((existing) => existing.id === target.id)) return;
  if (state.targets.length >= MAX_TARGETS) state.targets.splice(DEFAULT_TARGETS.length, 1);
  state.targets.push(target);
  syncHash(state);
  if (!placeView) return;
  ui.renderPlace(placeView);
  void loadCommute(placeToken, target);
}

async function openPlace(pin: PlacePin, fly = true): Promise<void> {
  state.selected = null;
  clearStop();
  clearNearby();
  stopFollow();
  state.place = pin;
  state.placeStops = [];
  if (!state.chosenTargets) state.targets = targetsNear(pin.lat, pin.lon);
  syncHash(state);

  const token = ++placeToken;
  const view: PlaceView = {
    pin,
    profile: { phase: 'loading' },
    targets: state.targets,
    commutes: new Map(),
  };
  placeView = view;
  ui.renderPlace(view);
  if (fly) {
    map.flyTo({ center: [pin.lon, pin.lat], zoom: Math.max(map.getZoom(), PLACE_FLY_ZOOM), speed: 1.3 });
  }

  const profile = await placeProfile(pin);
  if (token !== placeToken || placeView !== view) return;
  if (!profile) {
    view.profile = { phase: 'failed' };
    ui.renderPlace(view);
    return;
  }
  view.profile = { phase: 'ready', profile };
  state.placeStops = profile.stops.map((stop) => ({ lat: stop.lat, lon: stop.lon }));
  ui.renderPlace(view);
  await Promise.all(state.targets.map((target) => loadCommute(token, target)));
}

function clearStop(): void {
  state.selectedStop = null;
  state.stopAnchor = null;
  if (stopRefreshTimer !== undefined) clearTimeout(stopRefreshTimer);
  stopRefreshTimer = undefined;
  syncHash(state);
}

function clearNearby(): void {
  state.nearby = null;
  nearbyToken++;
  if (nearbyRefreshTimer !== undefined) clearTimeout(nearbyRefreshTimer);
  nearbyRefreshTimer = undefined;
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
const overlay = new MapboxOverlay({ interleaved: false, layers: [], pickingRadius: VEHICLE_PICK_RADIUS });

map.on('load', () => {
  map.addControl(overlay);
  calmBasemap(map);
  ui.setBuildingsSupported(supportsBuildings(map));
  if (!state.showLabels) setLabelVisibility(map, false);
  if (state.showBuildings) setBuildingVisibility(map, true);
});

map.on('dragstart', () => stopFollow());

map.on('contextmenu', (event) => {
  checkPoint(event.lngLat.lat, event.lngLat.lng);
});

function checkPoint(lat: number, lon: number): void {
  void openPlace(
    {
      lat,
      lon,
      label: 'Punktet du valgte',
      detail: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    },
    false,
  );
}

let pressTimer: number | undefined;
let pressStart: { x: number; y: number } | null = null;

function cancelPress(): void {
  if (pressTimer !== undefined) clearTimeout(pressTimer);
  pressTimer = undefined;
  pressStart = null;
}

map.on('touchstart', (event) => {
  if (event.points.length !== 1) {
    cancelPress();
    return;
  }
  const point = event.point;
  pressStart = { x: point.x, y: point.y };
  const { lat, lng } = event.lngLat;
  pressTimer = window.setTimeout(() => {
    pressTimer = undefined;
    checkPoint(lat, lng);
  }, LONG_PRESS_MS);
});

map.on('touchmove', (event) => {
  if (!pressStart) return;
  const moved = Math.hypot(event.point.x - pressStart.x, event.point.y - pressStart.y);
  if (moved > LONG_PRESS_SLOP_PX) cancelPress();
});

map.on('touchend', () => cancelPress());
map.on('touchcancel', () => cancelPress());

const feedbackLink = document.getElementById('attrib-feedback') as HTMLAnchorElement | null;

function carryViewToFeedback(): void {
  if (!feedbackLink) return;
  const hash = location.hash.replace(/^#/, '');
  feedbackLink.href = hash ? `/tilbakemelding?kart=${encodeURIComponent(hash)}` : '/tilbakemelding';
}

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
  carryViewToFeedback();
  scheduleViewportReport();
  scheduleTileLoad();
  ui.setCentre(center.lat, center.lng);
});

const tiles = new NetworkTiles(DATA, () => {
  network = tiles.paths;
  networkVersion = tiles.version;
});

let tileTimer: number | undefined;

function loadTilesForView(): void {
  const b = map.getBounds();
  tiles.update(
    { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() },
    map.getZoom(),
  );
}

function scheduleTileLoad(): void {
  if (tileTimer !== undefined) clearTimeout(tileTimer);
  tileTimer = window.setTimeout(loadTilesForView, 220);
}

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
  stops = (await stopsRes.json()) as StopPlace[];
  routes = (await routesRes.json()) as RouteMeta[];
  ui.setMeta(meta);

  tiles.setCore((await networkRes.json()) as NetworkPath[]);
  void tiles.loadIndex().then(loadTilesForView);

  searchIndex = buildSearchIndex(routes, stops);
  ui.setSearchIndex(searchIndex);
  restoreLineFilter();
  restoreStop();
  restorePlace();
  void trackSituations();
}

async function trackSituations(): Promise<void> {
  const index = await loadSituations(API);
  if (index) {
    ui.setSituations(index);
    deviations = deviationRoutes(index, routes);
    ui.setDeviationLines(deviations.idx.size);
    refreshFilterSummary();
  }
  window.setTimeout(() => void trackSituations(), SITUATION_REFRESH_MS);
}

function restoreStop(): void {
  const stopId = readHashStopId();
  if (!stopId || !searchIndex) return;
  const group = searchIndex.groupByStopId.get(stopId);
  if (!group) return;
  if (!hashHasView()) map.jumpTo({ center: [group.lon, group.lat], zoom: STOP_FLY_ZOOM });
  void openStop(group);
}

function restorePlace(): void {
  for (const id of readHashTargetIds()) {
    if (state.targets.some((target) => target.id === id)) continue;
    const group = searchIndex?.groupByStopId.get(id);
    if (group) {
      state.chosenTargets = true;
      state.targets.push({ id, name: group.name });
    }
  }
  const pin = readHashPlace();
  if (!pin) return;
  if (!hashHasView()) map.jumpTo({ center: [pin.lon, pin.lat], zoom: PLACE_FLY_ZOOM });
  void openPlace(pin, false);
}

function restoreLineFilter(): void {
  if (!initialLineId) return;
  const idx = routes.findIndex((r) => r.id === initialLineId);
  if (idx < 0) return;
  state.line = { idx, route: routes[idx]! };
  ui.setLineFilter(state.line);
  ui.syncState(state);
}

async function loadDepartures(
  group: StopGroup,
  limit: number,
  maxMembers: number,
): Promise<DeparturesState> {
  const members = group.members.slice(0, maxMembers);
  const responses = await Promise.all(members.map((member) => fetchDepartures(member.id, limit)));
  const answered = responses.filter((r): r is StopDepartures => r !== null);
  if (!answered.length) return { phase: 'failed' };

  const departures = answered
    .flatMap((r) => r.departures)
    .sort((a, b) => a.expected - b.expected)
    .slice(0, limit);
  return { phase: 'ready', departures, coverage: mergeCoverage(answered) };
}

async function openStop(group: StopGroup): Promise<void> {
  state.selected = null;
  clearNearby();
  state.selectedStop = group.key;
  state.stopAnchor = group.members[0]?.id ?? null;
  syncHash(state);
  ui.renderStop(group, { phase: 'loading' });

  const board = await loadDepartures(group, DEPARTURE_LIMIT, MAX_GROUP_FETCH);
  if (state.selectedStop !== group.key) return;
  ui.renderStop(group, board);
  scheduleStopRefresh(group);
}

function scheduleStopRefresh(group: StopGroup): void {
  if (stopRefreshTimer !== undefined) clearTimeout(stopRefreshTimer);
  stopRefreshTimer = window.setTimeout(() => {
    stopRefreshTimer = undefined;
    if (state.selectedStop !== group.key) return;
    void (async () => {
      const board = await loadDepartures(group, DEPARTURE_LIMIT, MAX_GROUP_FETCH);
      if (state.selectedStop !== group.key) return;
      if (board.phase === 'ready') ui.renderStop(group, board);
      scheduleStopRefresh(group);
    })();
  }, STOP_REFRESH_MS);
}

async function openNearby(fix: Fix, refresh = false): Promise<void> {
  if (!searchIndex) return;
  if (!refresh) {
    state.selected = null;
    clearStop();
  }
  clearNearby();
  state.nearby = fix;

  const items = nearestGroups(searchIndex, fix, NEARBY_LIMIT);
  const token = ++nearbyToken;
  const boards: NearbyBoards = new Map(
    items.map((item) => [
      item.group.key,
      (refresh ? nearbyBoards.get(item.group.key) : undefined) ?? { phase: 'loading' },
    ]),
  );
  nearbyBoards = boards;
  ui.renderNearby(items, boards);
  if (!items.length) return;

  await Promise.all(
    items.map(async (item) => {
      const board = await loadDepartures(item.group, NEARBY_DEPARTURE_LIMIT, NEARBY_MEMBER_FETCH);
      if (token !== nearbyToken) return;
      if (board.phase === 'failed' && boards.get(item.group.key)?.phase === 'ready') return;
      boards.set(item.group.key, board);
      ui.renderNearby(items, boards);
    }),
  );
  if (token !== nearbyToken) return;
  nearbyRefreshTimer = window.setTimeout(() => void openNearby(fix, true), NEARBY_REFRESH_MS);
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

async function fetchDepartures(stopId: string, limit: number): Promise<StopDepartures | null> {
  try {
    const res = await fetch(`${API}/stops/${encodeURIComponent(stopId)}/departures?limit=${limit}`);
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
  stopFollow();
  await openNearby(outcome.fix);
}

const feed = new LiveFeed(WS_URL, {
  onHello: (helloMeta) => {
    const serviceDate = (helloMeta as Partial<DataMeta> | null)?.serviceDate;
    if (typeof serviceDate === 'string' && serviceDate.length === 8) liveServiceDate = serviceDate;
  },
  onFrame: (map_, serverTime) => {
    const cutoff = Date.now() - STALE_AFTER_MS;
    liveById = map_;
    vehicles = [...map_.values()].filter((v) => v.lastChangeMs > 0 && v.seenAt >= cutoff);
    serverSkewMs = serverTime - Date.now();
    nowSec = serviceNowSec();
    ui.setStats(vehicles);
    refreshFilterSummary();
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

function redraw(): void {
  frame++;
  overlay.setProps({
    layers: buildLayers({
      state,
      zoom: state.view.zoom,
      latitude: state.view.latitude,
      mapBearing: state.view.bearing,
      network,
      networkVersion,
      stops,
      vehicles,
      sprites,
      frame,
      deviations,
    }),
    getTooltip: null,
    onHover: handleHover,
    onClick: handleClick,
  });
}

function pickVehicle(x: number, y: number): Vehicle | null {
  const info = overlay.pickObject({ x, y, radius: VEHICLE_PICK_RADIUS, layerIds: VEHICLE_LAYER_IDS });
  return (info?.object as Vehicle | undefined) ?? null;
}

function pickStopGroup(x: number, y: number): StopGroup | null {
  const info = overlay.pickObject({ x, y, radius: STOP_PICK_RADIUS, layerIds: ['stops'] });
  const stop = info?.object as StopPlace | undefined;
  if (!stop) return null;
  return searchIndex?.groupByStopId.get(stop.id) ?? null;
}

function pickPlacePin(x: number, y: number): boolean {
  if (!state.place) return false;
  return overlay.pickObject({ x, y, radius: STOP_PICK_RADIUS, layerIds: ['place-pin'] }) !== null;
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
  const overStop = pickStopGroup(info.x, info.y) !== null || pickPlacePin(info.x, info.y);
  map.getCanvas().style.cursor = overStop ? 'pointer' : '';
}

async function handleClick(info: PickingInfo): Promise<void> {
  if (info.x === undefined || info.y === undefined) return;
  if (pickPlacePin(info.x, info.y)) {
    if (placeView) ui.renderPlace(placeView);
    return;
  }
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
  clearStop();
  clearNearby();
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

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
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
