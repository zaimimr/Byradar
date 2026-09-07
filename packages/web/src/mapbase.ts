import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { ViewState } from './state.js';

const CARTO_FALLBACK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export function styleUrl(): string {
  if (!__MAPTILER_KEY__) return CARTO_FALLBACK;
  return `https://api.maptiler.com/maps/${__MAPTILER_STYLE__}/style.json?key=${__MAPTILER_KEY__}`;
}

export function createMap(container: HTMLElement, view: ViewState): MapLibreMap {
  return new maplibregl.Map({
    container,
    style: styleUrl(),
    center: [view.longitude, view.latitude],
    zoom: view.zoom,
    pitch: view.pitch,
    bearing: view.bearing,
    maxPitch: 72,
    minZoom: 8.5,
    maxZoom: 21,
    attributionControl: false,
    antialias: true,
    dragRotate: true,
    fadeDuration: 120,
  });
}

export function firstSymbolLayerId(map: MapLibreMap): string | undefined {
  const style = map.getStyle() as StyleSpecification | undefined;
  return style?.layers?.find((layer) => layer.type === 'symbol')?.id;
}

export function symbolLayerIds(map: MapLibreMap): string[] {
  const style = map.getStyle() as StyleSpecification | undefined;
  return (style?.layers ?? []).filter((l) => l.type === 'symbol').map((l) => l.id);
}

export function setLabelVisibility(map: MapLibreMap, visible: boolean): void {
  for (const id of symbolLayerIds(map)) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

export function calmBasemap(map: MapLibreMap): void {
  const style = map.getStyle() as StyleSpecification | undefined;
  for (const layer of style?.layers ?? []) {
    if (!map.getLayer(layer.id)) continue;
    if (layer.type === 'symbol') {
      try {
        map.setPaintProperty(layer.id, 'text-opacity', 0.62);
      } catch {
        continue;
      }
    }
  }
}

const BUILDING_LAYER_ID = 'byradar-buildings';

interface BuildingSourceInfo {
  source: string;
  flatLayerIds: string[];
}

function findBuildingSource(map: MapLibreMap): BuildingSourceInfo | null {
  const style = map.getStyle() as StyleSpecification | undefined;
  const layers = style?.layers ?? [];
  const flatLayerIds: string[] = [];
  let source: string | null = null;
  for (const layer of layers) {
    if (!('source-layer' in layer) || layer['source-layer'] !== 'building') continue;
    if (layer.id === BUILDING_LAYER_ID) continue;
    flatLayerIds.push(layer.id);
    if (!source && 'source' in layer && typeof layer.source === 'string') source = layer.source;
  }
  return source ? { source, flatLayerIds } : null;
}

export function supportsBuildings(map: MapLibreMap): boolean {
  return findBuildingSource(map) !== null;
}

export function setBuildingVisibility(map: MapLibreMap, visible: boolean): void {
  const info = findBuildingSource(map);
  if (!info) return;

  if (visible && !map.getLayer(BUILDING_LAYER_ID)) {
    map.addLayer(
      {
        id: BUILDING_LAYER_ID,
        type: 'fill-extrusion',
        source: info.source,
        'source-layer': 'building',
        minzoom: 13.4,
        paint: {
          'fill-extrusion-color': [
            'interpolate',
            ['linear'],
            ['coalesce', ['get', 'height'], ['get', 'render_height'], 8],
            0,
            '#151920',
            25,
            '#1c222b',
            70,
            '#252d38',
            160,
            '#313a48',
          ],
          'fill-extrusion-height': ['coalesce', ['get', 'height'], ['get', 'render_height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'height_min'], ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.88,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      firstSymbolLayerId(map),
    );
  }

  if (map.getLayer(BUILDING_LAYER_ID)) {
    map.setLayoutProperty(BUILDING_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
  }
  for (const id of info.flatLayerIds) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'none' : 'visible');
  }
}
