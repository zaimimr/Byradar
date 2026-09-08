import type { RouteMeta, Situation } from './types.js';

export interface SituationIndex {
  updatedAt: number;
  byLine: Map<string, Situation[]>;
  byStopPlace: Map<string, Situation[]>;
  count: number;
}

export const EMPTY_SITUATION_INDEX: SituationIndex = {
  updatedAt: 0,
  byLine: new Map(),
  byStopPlace: new Map(),
  count: 0,
};

function push(map: Map<string, Situation[]>, key: string, situation: Situation): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(situation);
  else map.set(key, [situation]);
}

export function indexSituations(situations: Situation[], updatedAt: number): SituationIndex {
  const byLine = new Map<string, Situation[]>();
  const byStopPlace = new Map<string, Situation[]>();
  for (const situation of situations) {
    for (const line of situation.lines) push(byLine, line, situation);
    for (const stop of situation.stopPlaces) push(byStopPlace, stop, situation);
  }
  return { updatedAt, byLine, byStopPlace, count: situations.length };
}

export async function loadSituations(api: string): Promise<SituationIndex | null> {
  try {
    const res = await fetch(`${api}/situations`);
    if (!res.ok) return null;
    const body = (await res.json()) as { updatedAt: number; situations: Situation[] };
    if (!Array.isArray(body.situations)) return null;
    return indexSituations(body.situations, body.updatedAt);
  } catch {
    return null;
  }
}

export function situationsFor(
  index: SituationIndex,
  keys: { lines?: Iterable<string>; stopPlaces?: Iterable<string> },
): Situation[] {
  const seen = new Set<string>();
  const hits: Situation[] = [];
  const take = (bucket: Situation[] | undefined): void => {
    for (const situation of bucket ?? []) {
      if (seen.has(situation.id)) continue;
      seen.add(situation.id);
      hits.push(situation);
    }
  };
  for (const line of keys.lines ?? []) take(index.byLine.get(line));
  for (const stop of keys.stopPlaces ?? []) take(index.byStopPlace.get(stop));
  return hits;
}

export interface DeviationRoutes {
  idx: Set<number>;
  keys: Set<string>;
}

export const NO_DEVIATIONS: DeviationRoutes = { idx: new Set(), keys: new Set() };

export function deviationRoutes(index: SituationIndex, routes: RouteMeta[]): DeviationRoutes {
  const idx = new Set<number>();
  const keys = new Set<string>();
  routes.forEach((route, at) => {
    if (!index.byLine.has(route.id)) return;
    idx.add(at);
    keys.add(`${route.mode}|${route.line}`);
  });
  return { idx, keys };
}

export function hasDeviation(
  deviations: DeviationRoutes,
  vehicle: { routeIdx: number; mode: string; line: string },
): boolean {
  if (vehicle.routeIdx >= 0) return deviations.idx.has(vehicle.routeIdx);
  return deviations.keys.has(`${vehicle.mode}|${vehicle.line}`);
}
