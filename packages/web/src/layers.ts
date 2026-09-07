import { IconLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import type { Layer } from '@deck.gl/core';

import { metresPerPixel, vehicleMesh } from './meshes.js';

import { MODE_DRAW_ORDER, hexToRgb, punctuality } from './palette.js';
import type { SpriteSet } from './sprites.js';
import type { AppState } from './state.js';
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

const VEHICLE_SIZE: Record<Mode, number> = {
  metro: 21,
  rail: 23,
  tram: 19,
  ferry: 18,
  bus: 15,
  other: 14,
};

const RIM_GROWTH = 1.26;

const HALO_DELAY_THRESHOLD = 420;

function zoomScale(zoom: number): number {
  return Math.min(1.9, Math.max(0.55, 0.55 + (zoom - 10.2) * 0.2));
}

function busFade(zoom: number): number {
  if (zoom >= 13) return 1;
  if (zoom <= 10.6) return 0.4;
  return 0.4 + ((zoom - 10.6) / 2.4) * 0.6;
}

const PITCH_FOR_3D = 18;
const MESH_TARGET_PX = 20;
const MESH_MIN_ZOOM = 13;

const VEHICLE_MATERIAL = {
  ambient: 0.5,
  diffuse: 0.65,
  shininess: 28,
  specularColor: [46, 52, 64] as [number, number, number],
};

export interface LayerInput {
  state: AppState;
  zoom: number;
  pitch: number;
  latitude: number;
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

export function buildLayers(input: LayerInput): Layer[] {
  const { state, zoom, pitch, latitude, network, stops, vehicles, sprites, frame } = input;
  const layers: Layer[] = [];

  if (state.showNetwork) {
    for (const mode of MODE_DRAW_ORDER) {
      if (!state.modes.has(mode)) continue;
      const paths = network.filter((p) => p.m === mode);
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
          getPosition: (d) => [d.lon, d.lat],
          getRadius: (d) => (d.modes[0] === 'bus' ? 11 : 24),
          radiusUnits: 'meters',
          radiusMinPixels: 1.6,
          radiusMaxPixels: 5.5,
          stroked: true,
          filled: true,
          getFillColor: [10, 13, 18, 235],
          getLineColor: (d) => [...rgb(mixStopColor(d.modes[0] ?? 'other')), 210] as [number, number, number, number],
          lineWidthUnits: 'pixels',
          getLineWidth: 1.1,
          lineWidthMinPixels: 0.9,
          parameters: { depthCompare: 'always' },
        }),
      );
    }
  }

  const shown = vehicles.filter((v) => state.modes.has(v.mode));
  const scale = zoomScale(zoom);
  const struggling = shown.filter((v) => v.delay >= HALO_DELAY_THRESHOLD);

  if (struggling.length) {
    layers.push(
      new ScatterplotLayer<Vehicle>({
        id: 'vehicle-halo',
        data: struggling,
        getPosition: (d) => [d.lon, d.lat],
        getRadius: (d) => VEHICLE_SIZE[d.mode] * scale * 0.72,
        radiusUnits: 'pixels',
        getFillColor: (d) => [...rgb(punctuality(d.delay).hex), 42] as [number, number, number, number],
        stroked: false,
        filled: true,
        updateTriggers: { getFillColor: frame, getRadius: [frame, scale] },
        parameters: { depthCompare: 'always' },
      }),
    );
  }

  const fixed = shown.filter((v) => v.source === 'gps');
  if (fixed.length) {
    layers.push(
      new ScatterplotLayer<Vehicle>({
        id: 'vehicle-fix-ring',
        data: fixed,
        getPosition: (d) => [d.lon, d.lat],
        getRadius: (d) => VEHICLE_SIZE[d.mode] * scale * 0.78,
        radiusUnits: 'pixels',
        stroked: true,
        filled: false,
        getLineColor: (d) => [...rgb(punctuality(d.delay).hex), 150] as [number, number, number, number],
        lineWidthUnits: 'pixels',
        getLineWidth: 1,
        updateTriggers: { getLineColor: frame, getRadius: [frame, scale] },
        parameters: { depthCompare: 'always' },
      }),
    );
  }

  const use3d = pitch >= PITCH_FOR_3D && zoom >= MESH_MIN_ZOOM;

  if (use3d) {
    const sizeScale = metresPerPixel(latitude, zoom) * MESH_TARGET_PX;
    layers.push(
      new ScatterplotLayer<Vehicle>({
        id: 'vehicle-ground',
        data: shown,
        getPosition: (d) => [d.lon, d.lat],
        getRadius: (d) => VEHICLE_SIZE[d.mode] * scale * 0.62,
        radiusUnits: 'pixels',
        stroked: true,
        filled: true,
        getFillColor: (d) => [...rgb(punctuality(d.delay).hex), 34] as [number, number, number, number],
        getLineColor: (d) => [...rgb(punctuality(d.delay).hex), 190] as [number, number, number, number],
        lineWidthUnits: 'pixels',
        getLineWidth: 1.2,
        updateTriggers: {
          getFillColor: frame,
          getLineColor: frame,
          getPosition: frame,
          getRadius: [frame, scale],
        },
      }),
    );
    for (const mode of MODE_DRAW_ORDER) {
      const forMode = shown.filter((v) => v.mode === mode);
      if (!forMode.length) continue;
      layers.push(
        new SimpleMeshLayer<Vehicle>({
          id: `vehicle-mesh-${mode}`,
          data: forMode,
          pickable: true,
          mesh: vehicleMesh(mode),
          getPosition: (d) => [d.lon, d.lat],
          getOrientation: (d) => [0, -d.bearing, 0],
          getColor: (d) =>
            [...rgb(d.color), d.source === 'gps' ? 255 : 226] as [number, number, number, number],
          getScale: (d) => {
            const s = state.selected === d.vid ? 1.4 : 1;
            return [s, s, s];
          },
          sizeScale,
          material: VEHICLE_MATERIAL,
          updateTriggers: {
            getPosition: frame,
            getOrientation: frame,
            getColor: frame,
            getScale: [frame, state.selected],
          },
        }),
      );
    }
  } else {
    layers.push(
      new IconLayer<Vehicle>({
        id: 'vehicle-rim',
        data: shown,
        iconAtlas: sprites.atlas,
        iconMapping: sprites.mapping,
        getIcon: (d) => `${d.mode}-rim`,
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) =>
          VEHICLE_SIZE[d.mode] * scale * RIM_GROWTH * (state.selected === d.vid ? 1.5 : 1),
        sizeUnits: 'pixels',
        getAngle: (d) => -d.bearing,
        getColor: (d) => [...rgb(punctuality(d.delay).hex), 236] as [number, number, number, number],
        updateTriggers: {
          getColor: frame,
          getIcon: frame,
          getAngle: frame,
          getPosition: frame,
          getSize: [frame, state.selected, scale],
        },
        parameters: { depthCompare: 'always' },
      }),
    );
    layers.push(
      new IconLayer<Vehicle>({
        id: 'vehicle-body',
        data: shown,
        pickable: true,
        iconAtlas: sprites.atlas,
        iconMapping: sprites.mapping,
        getIcon: (d) => d.mode,
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => VEHICLE_SIZE[d.mode] * scale * (state.selected === d.vid ? 1.5 : 1),
        sizeUnits: 'pixels',
        getAngle: (d) => -d.bearing,
        getColor: (d) =>
          [...rgb(d.color), d.source === 'gps' ? 255 : 224] as [number, number, number, number],
        updateTriggers: {
          getColor: frame,
          getIcon: frame,
          getAngle: frame,
          getPosition: frame,
          getSize: [frame, state.selected, scale],
        },
        parameters: { depthCompare: 'always' },
      }),
    );
  }

  return layers;
}

function mixStopColor(mode: Mode): string {
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
