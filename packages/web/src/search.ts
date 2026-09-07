import { MODE_RAIL_ORDER } from './palette.js';
import type { Mode, RouteMeta, StopPlace } from './types.js';

const FOLD: Record<string, string> = { æ: 'ae', ø: 'o', å: 'a', ä: 'a', ö: 'o', ü: 'u', ß: 'ss' };

const MAX_LINES = 5;
const MAX_STOPS = 8;
const NEAR_PREFIX_WIDE_TOKEN = 7;
const NEAR_PREFIX_MIN_TOKEN = 4;
const GROUP_RADIUS_M = 400;
const METRES_PER_DEG_LAT = 111_320;

export interface StopGroup {
  key: string;
  name: string;
  lat: number;
  lon: number;
  modes: Mode[];
  members: StopPlace[];
}

export interface LineHit {
  kind: 'line';
  idx: number;
  route: RouteMeta;
}

export interface StopHit {
  kind: 'stop';
  group: StopGroup;
}

export type SearchHit = LineHit | StopHit;

export interface SearchResults {
  lines: LineHit[];
  stops: StopHit[];
}

interface Indexed<T> {
  entry: T;
  words: string[];
  joined: string;
  weight: number;
}

export interface SearchIndex {
  lines: Array<Indexed<LineHit>>;
  stops: Array<Indexed<StopHit>>;
  groupByStopId: Map<string, StopGroup>;
}

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[æøåäöüß]/g, (c) => FOLD[c] ?? c)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function words(value: string): string[] {
  const folded = normalize(value);
  return folded ? folded.split(' ') : [];
}

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function prefixSlack(token: string): number {
  if (token.length >= NEAR_PREFIX_WIDE_TOKEN) return 2;
  if (token.length >= NEAR_PREFIX_MIN_TOKEN) return 1;
  return 0;
}

function wordScore(word: string, token: string): number {
  if (word === token) return 4;
  if (word.startsWith(token)) return 3;
  const slack = prefixSlack(token);
  if (slack && commonPrefix(word, token) >= token.length - slack) return 2;
  if (word.includes(token)) return 1;
  return 0;
}

function scoreEntry<T>(indexed: Indexed<T>, tokens: string[]): number {
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const word of indexed.words) {
      const score = wordScore(word, token);
      if (score > best) best = score;
    }
    if (best === 0 && indexed.joined.includes(token)) best = 1;
    if (best === 0) return 0;
    total += best;
  }
  if (indexed.joined.startsWith(tokens.join(' '))) total += 2;
  return total * 100 + indexed.weight - Math.min(60, indexed.joined.length);
}

function modeRank(mode: Mode): number {
  const at = MODE_RAIL_ORDER.indexOf(mode);
  return at < 0 ? MODE_RAIL_ORDER.length : at;
}

function modeWeight(mode: Mode): number {
  return (MODE_RAIL_ORDER.length - modeRank(mode)) * 4;
}

function metresBetween(from: StopPlace, lat: number, lon: number): number {
  const dLat = (lat - from.lat) * METRES_PER_DEG_LAT;
  const dLon = (lon - from.lon) * METRES_PER_DEG_LAT * Math.cos((from.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

export function groupStops(stops: StopPlace[]): StopGroup[] {
  const byName = new Map<string, StopPlace[]>();
  for (const stop of stops) {
    const key = normalize(stop.name);
    const bucket = byName.get(key);
    if (bucket) bucket.push(stop);
    else byName.set(key, [stop]);
  }

  const groups: StopGroup[] = [];
  for (const [key, bucket] of byName) {
    const ordered = [...bucket].sort(
      (a, b) => modeRank(a.modes[0] ?? 'other') - modeRank(b.modes[0] ?? 'other'),
    );
    const clusters: StopPlace[][] = [];
    for (const stop of ordered) {
      const near = clusters.find((c) => metresBetween(c[0]!, stop.lat, stop.lon) <= GROUP_RADIUS_M);
      if (near) near.push(stop);
      else clusters.push([stop]);
    }
    clusters.forEach((members, i) => {
      const anchor = members[0]!;
      const modes = [...new Set(members.flatMap((m) => m.modes))].sort((a, b) => modeRank(a) - modeRank(b));
      groups.push({
        key: clusters.length > 1 ? `${key}#${i}` : key,
        name: anchor.name,
        lat: anchor.lat,
        lon: anchor.lon,
        modes,
        members,
      });
    });
  }
  return groups;
}

export function buildSearchIndex(routes: RouteMeta[], stops: StopPlace[]): SearchIndex {
  const groups = groupStops(stops);
  const groupByStopId = new Map<string, StopGroup>();
  for (const group of groups) {
    for (const member of group.members) groupByStopId.set(member.id, group);
  }

  return {
    lines: routes.map((route, idx) => {
      const label = `${route.line} ${route.name}`;
      return {
        entry: { kind: 'line', idx, route } as LineHit,
        words: words(label),
        joined: normalize(label),
        weight: modeWeight(route.mode),
      };
    }),
    stops: groups.map((group) => ({
      entry: { kind: 'stop', group } as StopHit,
      words: words(group.name),
      joined: normalize(group.name),
      weight: modeWeight(group.modes[0] ?? 'other') + group.modes.length,
    })),
    groupByStopId,
  };
}

function take<T>(pool: Array<Indexed<T>>, tokens: string[], limit: number): T[] {
  const scored: Array<{ entry: T; score: number }> = [];
  for (const indexed of pool) {
    const score = scoreEntry(indexed, tokens);
    if (score > 0) scored.push({ entry: indexed.entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.entry);
}

export function search(index: SearchIndex, query: string): SearchResults {
  const tokens = normalize(query).split(' ').filter(Boolean);
  if (!tokens.length) return { lines: [], stops: [] };
  return {
    lines: take(index.lines, tokens, MAX_LINES),
    stops: take(index.stops, tokens, MAX_STOPS),
  };
}

export function flatten(results: SearchResults): SearchHit[] {
  return [...results.lines, ...results.stops];
}
