import { MapboxOverlay } from '@deck.gl/mapbox';
import type { PickingInfo } from '@deck.gl/core';
import type { Map as MapLibreMap } from 'maplibre-gl';

import { DATA_URL, API_URL, WS_URL } from './endpoints.js';
import { LiveFeed } from './live.js';
import { buildLayers } from './layers.js';
import { calmBasemap, createMap, setBuildingVisibility, setLabelVisibility, supportsBuildings } from './mapbase.js';
import { buildVehicleSprites } from './sprites.js';
import { createState, syncHash } from './state.js';
import { Ui } from './ui.js';
import type { DataMeta, Mode, NetworkPath, StopPlace, Vehicle, VehicleDetail } from './types.js';

const STALE_AFTER_MS = 8000;

const DATA = DATA_URL;
const API = API_URL;
const state = createState();
const sprites = buildVehicleSprites();

let network: NetworkPath[] = [];
let stops: StopPlace[] = [];
let meta: DataMeta | null = null;
let nowSec = 0;
let vehicles: Vehicle[] = [];
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
  onCloseInspector: () => {
    state.selected = null;
    ui.hideInspector();
  },
});

ui.syncState(state);
ui.setConnection('connecting');

const map: MapLibreMap = createMap(document.getElementById('map')!, state.view);
const overlay = new MapboxOverlay({ interleaved: false, layers: [] });

map.on('load', () => {
  map.addControl(overlay);
  calmBasemap(map);
  ui.setBuildingsSupported(supportsBuildings(map));
  if (!state.showLabels) setLabelVisibility(map, false);
  if (state.showBuildings) setBuildingVisibility(map, true);
});

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

function scheduleViewportReport(): void {
  if (viewportTimer !== undefined) clearTimeout(viewportTimer);
  viewportTimer = window.setTimeout(() => {
    const b = map.getBounds();
    const padLon = (b.getEast() - b.getWest()) * 0.25;
    const padLat = (b.getNorth() - b.getSouth()) * 0.25;
    feed.reportViewport([
      b.getWest() - padLon,
      b.getSouth() - padLat,
      b.getEast() + padLon,
      b.getNorth() + padLat,
    ]);
  }, 260);
}

async function loadStatic(): Promise<void> {
  ui.setBoot('laster nettverket');
  const [metaRes, networkRes, stopsRes] = await Promise.all([
    fetch(`${DATA}/meta.json`),
    fetch(`${DATA}/network.json`),
    fetch(`${DATA}/stops.json`),
  ]);
  if (!metaRes.ok || !networkRes.ok || !stopsRes.ok) throw new Error('kunne ikke laste kartdata');
  meta = (await metaRes.json()) as DataMeta;
  network = (await networkRes.json()) as NetworkPath[];
  stops = (await stopsRes.json()) as StopPlace[];
  ui.setMeta(meta);
}

const feed = new LiveFeed(WS_URL, {
  onHello: () => {},
  onFrame: (map_, serverTime) => {
    const cutoff = Date.now() - STALE_AFTER_MS;
    vehicles = [...map_.values()].filter((v) => v.lastChangeMs > 0 && v.seenAt >= cutoff);
    nowSec = secondsIntoOsloDay(serverTime);
    ui.setStats(vehicles);
    if (state.selected !== null && !map_.has(state.selected)) {
      state.selected = null;
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

function handleHover(info: PickingInfo): void {
  const vehicle = info.object as Vehicle | undefined;
  if (vehicle && info.x !== undefined && info.y !== undefined) {
    ui.showTooltip(vehicle, info.x, info.y);
    map.getCanvas().style.cursor = 'pointer';
  } else {
    ui.hideTooltip();
    map.getCanvas().style.cursor = '';
  }
}

async function handleClick(info: PickingInfo): Promise<void> {
  const vehicle = info.object as Vehicle | undefined;
  if (!vehicle) {
    state.selected = null;
    ui.hideInspector();
    return;
  }
  state.selected = vehicle.vid;
  try {
    const res = await fetch(`${API}/vehicles/${vehicle.vid}`);
    if (!res.ok) return;
    const detail = (await res.json()) as VehicleDetail;
    if (state.selected === vehicle.vid) ui.renderInspector(detail, nowSec);
  } catch {
    ui.hideInspector();
  }
}

function loop(): void {
  feed.sample(Date.now());
  redraw();
  requestAnimationFrame(loop);
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    state.selected = null;
    ui.hideInspector();
  }
});

if (import.meta.env.DEV) {
  Object.defineProperty(window, '__oslomap', {
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
