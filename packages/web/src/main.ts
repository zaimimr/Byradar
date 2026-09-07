import { MapboxOverlay } from '@deck.gl/mapbox';
import type { PickingInfo } from '@deck.gl/core';
import type { Map as MapLibreMap } from 'maplibre-gl';

import { LiveFeed } from './live.js';
import { buildLayers } from './layers.js';
import { calmBasemap, createMap, setBuildingVisibility, setLabelVisibility, supportsBuildings } from './mapbase.js';
import { buildVehicleSprites } from './sprites.js';
import { createState, syncHash } from './state.js';
import { Ui } from './ui.js';
import type { DataMeta, Mode, NetworkPath, StopPlace, Vehicle, VehicleDetail } from './types.js';

const API = __API_URL__;
const state = createState();
const sprites = buildVehicleSprites();

let network: NetworkPath[] = [];
let stops: StopPlace[] = [];
let meta: DataMeta | null = null;
let tickMs = 1000;
let nowSec = 0;
let vehicles: Vehicle[] = [];
let needsRedraw = true;

const ui = new Ui({
  onToggleMode: (mode: Mode) => {
    if (state.modes.has(mode)) {
      if (state.modes.size > 1) state.modes.delete(mode);
    } else {
      state.modes.add(mode);
    }
    ui.syncState(state);
    syncHash(state);
    needsRedraw = true;
  },
  onToggleNetwork: () => {
    state.showNetwork = !state.showNetwork;
    ui.syncState(state);
    syncHash(state);
    needsRedraw = true;
  },
  onToggleStops: () => {
    state.showStops = !state.showStops;
    ui.syncState(state);
    syncHash(state);
    needsRedraw = true;
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
    needsRedraw = true;
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
  needsRedraw = true;
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
  needsRedraw = true;
});

async function loadStatic(): Promise<void> {
  ui.setBoot('laster nettverket');
  const [metaRes, networkRes, stopsRes] = await Promise.all([
    fetch(`${API}/data/meta.json`),
    fetch(`${API}/data/network.json`),
    fetch(`${API}/data/stops.json`),
  ]);
  if (!metaRes.ok || !networkRes.ok || !stopsRes.ok) throw new Error('kunne ikke laste kartdata');
  meta = (await metaRes.json()) as DataMeta;
  network = (await networkRes.json()) as NetworkPath[];
  stops = (await stopsRes.json()) as StopPlace[];
  ui.setMeta(meta);
  needsRedraw = true;
}

const feed = new LiveFeed(__WS_URL__, {
  onHello: (_serverMeta, serverTick) => {
    tickMs = serverTick;
  },
  onFrame: (map_, serverTime) => {
    vehicles = [...map_.values()].filter((v) => v.lat !== 0 || v.lon !== 0);
    nowSec = secondsIntoOsloDay(serverTime);
    ui.setStats(vehicles);
    needsRedraw = true;
    if (state.selected !== null && !map_.has(state.selected)) {
      state.selected = null;
      ui.hideInspector();
    }
  },
  onStatus: (status) => {
    ui.setConnection(status);
    if (status === 'live') ui.setBoot(null);
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
  if (!needsRedraw) return;
  needsRedraw = false;
  overlay.setProps({
    layers: buildLayers({
      state,
      zoom: state.view.zoom,
      network,
      stops,
      vehicles,
      sprites,
      tickMs,
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
    needsRedraw = true;
    return;
  }
  state.selected = vehicle.vid;
  needsRedraw = true;
  try {
    const res = await fetch(`${API}/vehicles/${vehicle.vid}`);
    if (!res.ok) return;
    const detail = (await res.json()) as VehicleDetail;
    if (state.selected === vehicle.vid) ui.renderInspector(detail, nowSec);
  } catch {
    ui.hideInspector();
  }
}

function frame(): void {
  redraw();
  requestAnimationFrame(frame);
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    state.selected = null;
    ui.hideInspector();
    needsRedraw = true;
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
  requestAnimationFrame(frame);
} catch (err) {
  ui.setBoot('kunne ikke laste data – kjører serveren?');
  console.error(err);
}
