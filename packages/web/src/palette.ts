import type { Mode } from './types.js';

export const MODE_LABEL: Record<Mode, string> = {
  metro: 'T-bane',
  tram: 'Trikk',
  rail: 'Tog',
  bus: 'Buss',
  ferry: 'Båt',
  other: 'Annet',
};

export const MODE_SWATCH: Record<Mode, string> = {
  metro: '#EC700C',
  tram: '#0B91EF',
  rail: '#1B7A5A',
  bus: '#E60000',
  ferry: '#354F7F',
  other: '#8892A6',
};

export const MODE_DRAW_ORDER: Mode[] = ['bus', 'other', 'ferry', 'rail', 'tram', 'metro'];

export const MODE_RAIL_ORDER: Mode[] = ['metro', 'tram', 'rail', 'bus', 'ferry', 'other'];

export const PUNCTUALITY = [
  { limit: -60, key: 'early', label: 'før tiden', hex: '#58B6DD' },
  { limit: 180, key: 'ontime', label: 'innenfor 3 min', hex: '#3FC796' },
  { limit: 420, key: 'late', label: '3–7 min sen', hex: '#E9A63F' },
  { limit: Infinity, key: 'verylate', label: 'over 7 min sen', hex: '#E0533C' },
] as const;

export function punctuality(delaySeconds: number): (typeof PUNCTUALITY)[number] {
  for (const step of PUNCTUALITY) {
    if (delaySeconds <= step.limit) return step;
  }
  return PUNCTUALITY[PUNCTUALITY.length - 1]!;
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

export function formatDelay(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(seconds));
  if (abs < 60) return `${sign}${abs}s`;
  const mins = Math.floor(abs / 60);
  const rest = abs % 60;
  return rest === 0 ? `${sign}${mins}m` : `${sign}${mins}m ${String(rest).padStart(2, '0')}s`;
}

export function formatServiceTime(seconds: number): string {
  const wrapped = ((seconds % 86400) + 86400) % 86400;
  const h = Math.floor(wrapped / 3600);
  const m = Math.floor((wrapped % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
