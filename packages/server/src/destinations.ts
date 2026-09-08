import { ENTUR, ENV } from './env.js';

const NEGATIVE_TTL_MS = 30 * 60_000;
const MAX_INFLIGHT = 4;
const QUERY_SPACING_MS = 400;

const DATED_QUERY = `query Dest($id: String!) {
  datedServiceJourney(id: $id) {
    serviceJourney { id }
    estimatedCalls { destinationDisplay { frontText } quay { name } }
  }
}`;

const PLAIN_QUERY = `query Dest($id: String!) {
  serviceJourney(id: $id) {
    id
    estimatedCalls { destinationDisplay { frontText } quay { name } }
  }
}`;

interface DestinationResponse {
  data?: {
    datedServiceJourney?: {
      serviceJourney?: { id?: string | null } | null;
      estimatedCalls?: Array<{ destinationDisplay?: { frontText?: string | null } | null; quay?: { name?: string | null } | null }> | null;
    } | null;
    serviceJourney?: {
      id?: string | null;
      estimatedCalls?: Array<{ destinationDisplay?: { frontText?: string | null } | null; quay?: { name?: string | null } | null }> | null;
    } | null;
  };
  errors?: unknown;
}

export class DestinationResolver {
  private readonly resolved = new Map<string, string>();
  private readonly failedAt = new Map<string, number>();
  private readonly pending = new Set<string>();
  private readonly queue: string[] = [];
  private inflight = 0;
  private lastQueryAt = 0;
  private lookups = 0;
  private hits = 0;

  constructor(private readonly staticHeadsigns: ReadonlyMap<string, string>) {}

  get stats(): { cached: number; static: number; remoteLookups: number; remoteHits: number; queued: number } {
    return {
      cached: this.resolved.size,
      static: this.staticHeadsigns.size,
      remoteLookups: this.lookups,
      remoteHits: this.hits,
      queued: this.queue.length,
    };
  }

  resolve(journeyId: string | null, fallback: string): string {
    if (!journeyId) return fallback;

    const fromStatic = this.staticHeadsigns.get(journeyId);
    if (fromStatic) return fromStatic;

    const cached = this.resolved.get(journeyId);
    if (cached) return cached;

    this.enqueue(journeyId);
    return fallback;
  }

  private enqueue(journeyId: string): void {
    if (this.pending.has(journeyId)) return;
    const failed = this.failedAt.get(journeyId);
    if (failed !== undefined && Date.now() - failed < NEGATIVE_TTL_MS) return;
    this.pending.add(journeyId);
    this.queue.push(journeyId);
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && this.inflight < MAX_INFLIGHT) {
      const journeyId = this.queue.shift()!;
      this.inflight++;
      const wait = Math.max(0, this.lastQueryAt + QUERY_SPACING_MS - Date.now());
      this.lastQueryAt = Date.now() + wait;
      void (async () => {
        try {
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          const name = await this.lookup(journeyId);
          this.lookups++;
          if (name) {
            this.resolved.set(journeyId, name);
            this.hits++;
          } else {
            this.failedAt.set(journeyId, Date.now());
          }
        } catch {
          this.failedAt.set(journeyId, Date.now());
        } finally {
          this.inflight--;
          this.pending.delete(journeyId);
          if (this.queue.length > 0) void this.drain();
        }
      })();
    }
  }

  private async lookup(journeyId: string): Promise<string | null> {
    const dated = journeyId.includes(':DatedServiceJourney:');
    const body = JSON.stringify({
      query: dated ? DATED_QUERY : PLAIN_QUERY,
      variables: { id: journeyId },
    });

    const res = await fetch(ENTUR.journeyPlanner, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ET-Client-Name': ENV.clientName },
      body,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as DestinationResponse;
    const journey = dated ? json.data?.datedServiceJourney : json.data?.serviceJourney;
    if (!journey) return null;

    const underlying = dated ? (journey as { serviceJourney?: { id?: string | null } }).serviceJourney?.id : null;
    if (underlying) {
      const viaStatic = this.staticHeadsigns.get(underlying);
      if (viaStatic) return viaStatic;
    }

    const calls = journey.estimatedCalls ?? [];
    const frontText = calls[0]?.destinationDisplay?.frontText?.trim();
    if (frontText) return frontText;
    const lastQuay = calls[calls.length - 1]?.quay?.name?.trim();
    return lastQuay ?? null;
  }
}
