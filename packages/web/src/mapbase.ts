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
    maxZoom: 18,
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
