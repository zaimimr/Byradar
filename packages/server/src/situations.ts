import { ENTUR, ENV } from './env.js';

const REQUEST_TIMEOUT_MS = 8_000;
const LANGUAGE_ORDER = ['no', 'nb', 'nn', 'en'];

const QUERY = `query Situations($codespaces: [String]) {
  situations(codespaces: $codespaces) {
    id
    situationNumber
    severity
    reportType
    validityPeriod { startTime endTime }
    summary { language value }
    description { language value }
    advice { language value }
    infoLinks { uri label }
    affects {
      __typename
      ... on AffectedLine { line { id } }
      ... on AffectedStopPlace { stopPlace { id } }
      ... on AffectedStopPlaceOnLine { stopPlace { id } line { id } }
      ... on AffectedStopPlaceOnServiceJourney { stopPlace { id } serviceJourney { line { id } } }
      ... on AffectedServiceJourney { serviceJourney { line { id } } }
    }
  }
}`;

interface RawText {
  language: string | null;
  value: string | null;
}

interface RawAffect {
  __typename: string;
  line?: { id: string | null } | null;
  stopPlace?: { id: string | null } | null;
  serviceJourney?: { line?: { id: string | null } | null } | null;
}

interface RawSituation {
  id: string;
  situationNumber: string | null;
  severity: string | null;
  reportType: string | null;
  validityPeriod: { startTime: string | null; endTime: string | null } | null;
  summary: RawText[] | null;
  description: RawText[] | null;
  advice: RawText[] | null;
  infoLinks: Array<{ uri: string | null; label: string | null }> | null;
  affects: RawAffect[] | null;
}

export interface Situation {
  id: string;
  severity: string;
  reportType: string;
  summary: string;
  description: string;
  advice: string;
  url: string | null;
  lines: string[];
  stopPlaces: string[];
  from: number | null;
  to: number | null;
}

export interface SituationSnapshot {
  updatedAt: number;
  situations: Situation[];
}

export const EMPTY_SITUATIONS: SituationSnapshot = { updatedAt: 0, situations: [] };

function pickText(texts: RawText[] | null): string {
  if (!texts?.length) return '';
  for (const language of LANGUAGE_ORDER) {
    const hit = texts.find((t) => t.language === language && t.value?.trim());
    if (hit?.value) return hit.value.trim();
  }
  return texts.find((t) => t.value?.trim())?.value?.trim() ?? '';
}

function timeOf(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
}

export interface SituationScope {
  knownLine: (id: string) => boolean;
  knownStopPlace: (id: string) => boolean;
}

export async function fetchSituations(
  codespaces: readonly string[],
  scope: SituationScope,
): Promise<SituationSnapshot> {
  const res = await fetch(ENTUR.journeyPlanner, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'ET-Client-Name': ENV.clientName },
    body: JSON.stringify({ query: QUERY, variables: { codespaces: [...codespaces] } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`situations ${res.status}`);

  const json = (await res.json()) as { data?: { situations?: RawSituation[] | null } };
  const raw = json.data?.situations;
  if (!raw) throw new Error('situations returned no data');

  const now = Date.now();
  const situations: Situation[] = [];

  for (const entry of raw) {
    const from = timeOf(entry.validityPeriod?.startTime);
    const to = timeOf(entry.validityPeriod?.endTime);
    if (to !== null && to < now) continue;

    const lines = new Set<string>();
    const stopPlaces = new Set<string>();
    for (const affect of entry.affects ?? []) {
      const lineId = affect.line?.id ?? affect.serviceJourney?.line?.id ?? null;
      if (lineId && scope.knownLine(lineId)) lines.add(lineId);
      const stopId = affect.stopPlace?.id ?? null;
      if (stopId && scope.knownStopPlace(stopId)) stopPlaces.add(stopId);
    }
    if (!lines.size && !stopPlaces.size) continue;

    const summary = pickText(entry.summary);
    const description = pickText(entry.description);
    if (!summary && !description) continue;

    situations.push({
      id: entry.situationNumber ?? entry.id,
      severity: entry.severity ?? 'unknown',
      reportType: entry.reportType ?? 'general',
      summary,
      description,
      advice: pickText(entry.advice),
      url: entry.infoLinks?.find((link) => link.uri)?.uri ?? null,
      lines: [...lines],
      stopPlaces: [...stopPlaces],
      from,
      to,
    });
  }

  situations.sort((a, b) => (b.from ?? 0) - (a.from ?? 0));
  return { updatedAt: now, situations };
}

export function startSituationPoller(opts: {
  codespaces: readonly string[];
  scope: SituationScope;
  intervalMs: number;
  onSnapshot: (snapshot: SituationSnapshot) => void;
  onError: (err: unknown) => void;
}): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const cycle = async (): Promise<void> => {
    try {
      const snapshot = await fetchSituations(opts.codespaces, opts.scope);
      if (!stopped) opts.onSnapshot(snapshot);
    } catch (err) {
      if (!stopped) opts.onError(err);
    } finally {
      if (!stopped) timer = setTimeout(cycle, opts.intervalMs);
    }
  };

  void cycle();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
