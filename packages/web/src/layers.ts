import { IconLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';

import { MODE_DRAW_ORDER, hexToRgb, punctuality } from './palette.js';
import { FOOTPRINT_ZOOM, isLight, lighten, metresPerPixel, realLengthPx } from './sizes.js';
import type { SpriteSet } from './sprites.js';
import type { AppState, LineFilter } from './state.js';
import type { Mode, NetworkPath, StopPlace, Vehicle } from './types.js';

const CASING: [number, number, number, number] = [6, 8, 12, 190];

const MODE_ALPHA: Record<Mode, number> = {
  metro: 238,
  tram: 228,
  rail: 210,
  ferry: 165,
  bus: 142,
  other: 122,
};

const STOP_MIN_ZOOM: Record<Mode, number> = {
  metro: 11,
  rail: 11,
  tram: 12.6,
  ferry: 12.6,
  bus: 14.4,
  other: 15,
};

const BUBBLE_RADIUS_PX = 11;
const GLYPH_PX = 16;
const ARROW_PX = 9.5;
const LABEL_ZOOM = 14.2;
const HALO_DELAY = 420;
const FIX_COLOR: [number, number, number] = [88, 182, 221];
const FIX_MIN_ACCURACY_M = 12;

export interface LayerInput {
  state: AppState;
  zoom: number;
  latitude: number;
  mapBearing: number;
  network: NetworkPath[];
  stops: StopPlace[];
  vehicles: Vehicle[];
  sprites: SpriteSet;
  frame: number;
}

const colorCache = new Map<string, [number, number, number]>();

function rgb(hex: string): [number, number, number] {
  let cached = colorCache.get(hex);
  if (!cached) {
    cached = hexToRgb(hex);
    colorCache.set(hex, cached);
  }
  return cached;
}

function pathWeight(mode: Mode, zoom: number): number {
  const zoomBoost = Math.max(0, zoom - 11) * 0.26;
  const base: Record<Mode, number> = {
    metro: 1.95,
    rail: 1.75,
    tram: 1.65,
    ferry: 1.15,
    bus: 0.8,
    other: 0.72,
  };
  return base[mode] + zoomBoost * (mode === 'bus' ? 0.5 : 1);
}

function busFade(zoom: number): number {
  if (zoom >= 13) return 1;
  if (zoom <= 10.6) return 0.4;
  return 0.4 + ((zoom - 10.6) / 2.4) * 0.6;
}

function stopColor(mode: Mode): string {
  const map: Record<Mode, string> = {
    metro: '#EC700C',
    tram: '#0B91EF',
    rail: '#1B7A5A',
    bus: '#98A3B4',
    ferry: '#5C7CB8',
    other: '#7C869A',
  };
  return map[mode] ?? '#8892A6';
}

export function onLine(vehicle: Vehicle, filter: LineFilter): boolean {
  if (vehicle.routeIdx >= 0) return vehicle.routeIdx === filter.idx;
  return vehicle.line === filter.route.line && vehicle.mode === filter.route.mode;
}

export function buildLayers(input: LayerInput): Layer[] {
  const layers = buildMapLayers(input);
  appendFixLayers(layers, input.state);
  return layers;
}

function appendFixLayers(layers: Layer[], state: AppState): void {
  const fix = state.fix;
  if (!fix) return;

  layers.push(
    new ScatterplotLayer<typeof fix>({
      id: 'fix-accuracy',
      data: [fix],
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => Math.max(FIX_MIN_ACCURACY_M, d.accuracy),
      radiusUnits: 'meters',
      radiusMinPixels: 14,
      stroked: true,
      filled: true,
      getFillColor: [...FIX_COLOR, 28] as [number, number, number, number],
      getLineColor: [...FIX_COLOR, 110] as [number, number, number, number],
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
      updateTriggers: { getRadius: fix.accuracy, getPosition: [fix.lat, fix.lon] },
      parameters: { depthCompare: 'always' },
    }),
  );

  layers.push(
    new ScatterplotLayer<typeof fix>({
      id: 'fix-glow',
      data: [fix],
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 13,
      radiusUnits: 'pixels',
      stroked: false,
      filled: true,
      getFillColor: [...FIX_COLOR, 70] as [number, number, number, number],
      updateTriggers: { getPosition: [fix.lat, fix.lon] },
      parameters: { depthCompare: 'always' },
    }),
  );

  layers.push(
    new ScatterplotLayer<typeof fix>({
      id: 'fix-point',
      data: [fix],
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 6.5,
      radiusUnits: 'pixels',
      stroked: true,
      filled: true,
      getFillColor: [...FIX_COLOR, 255] as [number, number, number, number],
      getLineColor: [255, 255, 255, 240],
      lineWidthUnits: 'pixels',
      getLineWidth: 2.2,
      updateTriggers: { getPosition: [fix.lat, fix.lon] },
      parameters: { depthCompare: 'always' },
    }),
  );
}

function buildMapLayers(input: LayerInput): Layer[] {
  const { state, zoom, latitude, mapBearing, network, stops, vehicles, sprites, frame } = input;
  const layers: Layer[] = [];
  const lineFilter = state.line;

  if (state.showNetwork) {
    for (const mode of MODE_DRAW_ORDER) {
      if (!state.modes.has(mode)) continue;
      const paths = network.filter((p) => p.m === mode && (!lineFilter || p.r === lineFilter.idx));
      if (!paths.length) continue;
      const weight = pathWeight(mode, zoom);

      if ((mode === 'metro' || mode === 'tram') && zoom >= 11.4) {
        layers.push(
          new PathLayer<NetworkPath>({
            id: `casing-${mode}`,
            data: paths,
            positionFormat: 'XY',
            getPath: (d) => d.path,
            getColor: CASING,
            getWidth: weight + 1.3,
            widthUnits: 'pixels',
            widthMinPixels: 1.4,
            capRounded: true,
            jointRounded: true,
            parameters: { depthCompare: 'always' },
          }),
        );
      }

      layers.push(
        new PathLayer<NetworkPath>({
          id: `network-${mode}`,
          data: paths,
          positionFormat: 'XY',
          getPath: (d) => d.path,
          getColor: (d) =>
            [
              ...rgb(d.c),
              Math.round(MODE_ALPHA[mode] * (mode === 'bus' || mode === 'other' ? busFade(zoom) : 1)),
            ] as [number, number, number, number],
          getWidth: weight,
          widthUnits: 'pixels',
          widthMinPixels: 0.9,
          capRounded: true,
          jointRounded: true,
          parameters: { depthCompare: 'always' },
        }),
      );
    }
  }

  if (state.showStops) {
    const visible = stops.filter((s) => {
      const primary = s.modes[0];
      if (!primary || !state.modes.has(primary)) return false;
      return zoom >= STOP_MIN_ZOOM[primary];
    });
    if (visible.length) {
      layers.push(
        new ScatterplotLayer<StopPlace>({
          id: 'stops',
          data: visible,
          pickable: true,
          autoHighlight: true,
          highlightColor: [88, 182, 221, 90],
          getPosition: (d) => [d.lon, d.lat],
          getRadius: (d) => (d.modes[0] === 'bus' ? 11 : 24),
          radiusUnits: 'meters',
          radiusMinPixels: 1.6,
          radiusMaxPixels: 5.5,
          stroked: true,
          filled: true,
          getFillColor: [10, 13, 18, 235],
          getLineColor: (d) => [...rgb(stopColor(d.modes[0] ?? 'other')), 210] as [number, number, number, number],
          lineWidthUnits: 'pixels',
          getLineWidth: 1.1,
          lineWidthMinPixels: 0.9,
          parameters: { depthCompare: 'always' },
        }),
      );
    }
  }

  const shown = vehicles.filter(
    (v) => state.modes.has(v.mode) && (!lineFilter || onLine(v, lineFilter)),
  );
  if (!shown.length) return layers;

  const mpp = metresPerPixel(latitude, zoom);
  const asFootprint = zoom >= FOOTPRINT_ZOOM;
  const screenAngle = (d: Vehicle): number => mapBearing - d.bearing;
  const struggling = shown.filter((v) => v.delay >= HALO_DELAY);

  if (struggling.length) {
    layers.push(
      new ScatterplotLayer<Vehicle>({
        id: 'vehicle-halo',
        data: struggling,
        getPosition: (d) => [d.lon, d.lat],
        getRadius: asFootprint ? (d) => realLengthPx(d.mode, mpp) * 0.6 : BUBBLE_RADIUS_PX * 1.7,
        radiusUnits: 'pixels',
        getFillColor: (d) => [...rgb(punctuality(d.delay).hex), 34] as [number, number, number, number],
        stroked: false,
        filled: true,
        updateTriggers: { getFillColor: frame, getRadius: [frame, mpp] },
        parameters: { depthCompare: 'always' },
      }),
    );
  }

  if (asFootprint) {
    layers.push(
      new IconLayer<Vehicle>({
        id: 'vehicle-hull-rim',
        data: shown,
        iconAtlas: sprites.atlas,
        iconMapping: sprites.mapping,
        getIcon: (d) => `hull-${d.mode}-rim`,
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => realLengthPx(d.mode, mpp),
        sizeUnits: 'pixels',
        getAngle: screenAngle,
        getColor: (d) => [...rgb(punctuality(d.delay).hex), 225] as [number, number, number, number],
        updateTriggers: { getColor: frame, getIcon: frame, getAngle: [frame, mapBearing], getPosition: frame, getSize: mpp },
        parameters: { depthCompare: 'always' },
      }),
    );

    layers.push(
      new IconLayer<Vehicle>({
        id: 'vehicle-hull',
        data: shown,
        pickable: true,
        iconAtlas: sprites.atlas,
        iconMapping: sprites.mapping,
        getIcon: (d) => `hull-${d.mode}`,
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => realLengthPx(d.mode, mpp),
        sizeUnits: 'pixels',
        getAngle: screenAngle,
        getColor: (d) =>
          [...lighten(rgb(d.color), 0.62), d.source === 'gps' ? 255 : 232] as [number, number, number, number],
        updateTriggers: { getColor: frame, getIcon: frame, getAngle: [frame, mapBearing], getPosition: frame, getSize: mpp },
        parameters: { depthCompare: 'always' },
      }),
    );
  } else {
    layers.push(
      new ScatterplotLayer<Vehicle>({
        id: 'vehicle-bubble',
        data: shown,
        pickable: true,
        getPosition: (d) => [d.lon, d.lat],
        getRadius: BUBBLE_RADIUS_PX,
        radiusUnits: 'pixels',
        stroked: true,
        filled: true,
        getFillColor: (d) => [...rgb(d.color), d.source === 'gps' ? 255 : 236] as [number, number, number, number],
        getLineColor: (d) => [...rgb(punctuality(d.delay).hex), 255] as [number, number, number, number],
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        updateTriggers: { getFillColor: frame, getLineColor: frame, getPosition: frame },
        parameters: { depthCompare: 'always' },
      }),
    );

    layers.push(
      new IconLayer<Vehicle>({
        id: 'vehicle-arrow',
        data: shown,
        iconAtlas: sprites.atlas,
        iconMapping: sprites.mapping,
        getIcon: () => 'arrow',
        getPosition: (d) => [d.lon, d.lat],
        getSize: ARROW_PX,
        sizeUnits: 'pixels',
        getAngle: screenAngle,
        getPixelOffset: (d) => {
          const rad = ((d.bearing - mapBearing) * Math.PI) / 180;
          const r = BUBBLE_RADIUS_PX + 5.5;
          return [Math.sin(rad) * r, -Math.cos(rad) * r];
        },
        getColor: (d) => [...rgb(punctuality(d.delay).hex), 255] as [number, number, number, number],
        updateTriggers: { getAngle: [frame, mapBearing], getPixelOffset: [frame, mapBearing], getColor: frame, getPosition: frame },
        parameters: { depthCompare: 'always' },
      }),
    );

    layers.push(
      new IconLayer<Vehicle>({
        id: 'vehicle-glyph',
        data: shown,
        iconAtlas: sprites.atlas,
        iconMapping: sprites.mapping,
        getIcon: (d) => `glyph-${d.mode}`,
        getPosition: (d) => [d.lon, d.lat],
        getSize: GLYPH_PX,
        sizeUnits: 'pixels',
        getColor: (d) =>
          (isLight(rgb(d.color)) ? [12, 15, 21, 255] : [255, 255, 255, 246]) as [number, number, number, number],
        updateTriggers: { getIcon: frame, getColor: frame, getPosition: frame },
        parameters: { depthCompare: 'always' },
      }),
    );
  }

  if (zoom >= LABEL_ZOOM) {
    const offset = asFootprint ? -16 : -(BUBBLE_RADIUS_PX + 12);
    layers.push(
      new TextLayer<Vehicle>({
        id: 'vehicle-label',
        data: shown,
        getPosition: (d) => [d.lon, d.lat],
        getText: (d) => d.line,
        getSize: 11,
        sizeUnits: 'pixels',
        getPixelOffset: [0, offset],
        getColor: [236, 241, 249, 245],
        outlineColor: [8, 10, 14, 235],
        outlineWidth: 3,
        fontFamily: "'Martian Mono', ui-monospace, monospace",
        fontWeight: 500,
        fontSettings: { sdf: true, fontSize: 48, buffer: 6 },
        characterSet: 'auto',
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        updateTriggers: { getText: frame, getPosition: frame, getPixelOffset: asFootprint },
        parameters: { depthCompare: 'always' },
      }),
    );
  }

  return layers;
}
