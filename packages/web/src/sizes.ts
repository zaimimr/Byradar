import type { Mode } from './types.js';

const REAL_LENGTH_M: Record<Mode, number> = {
  bus: 12,
  tram: 33,
  metro: 54,
  rail: 70,
  ferry: 25,
  other: 10,
};

export const FOOTPRINT_ZOOM = 16.8;

export function metresPerPixel(latitude: number, zoom: number): number {
  return (156_543.033_92 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
}

export function realLengthPx(mode: Mode, metresPerPx: number): number {
  return (REAL_LENGTH_M[mode] ?? REAL_LENGTH_M.other) / metresPerPx;
}

export function lighten(rgb: readonly [number, number, number], amount: number): [number, number, number] {
  return [
    Math.round(rgb[0] + (255 - rgb[0]) * amount),
    Math.round(rgb[1] + (255 - rgb[1]) * amount),
    Math.round(rgb[2] + (255 - rgb[2]) * amount),
  ];
}

export function isLight(rgb: readonly [number, number, number]): boolean {
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.62;
}
