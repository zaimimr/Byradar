import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { WebSocket } from 'ws';

import { guardHttp, isAdmin, isAllowedOrigin, socketOriginAllowed } from './access.js';
import { buildDepartureBoard, DepartureIndex } from './departures.js';
import { DestinationResolver } from './destinations.js';
import { Engine, type VehicleState } from './engine.js';
import { startGpsPoller } from './entur.js';
import { ENV, REPO_ROOT } from './env.js';
import { startTripUpdatePoller } from './rt.js';
import { Store } from './store.js';
import { secondsIntoServiceDay } from './time.js';
import { encodeAdded, encodePositions } from './wire.js';

const store = await Store.load();
const destinations = new DestinationResolver(store.journeyHeadsigns);
const engine = new Engine(store, destinations);
const departureIndex = DepartureIndex.build(store);

const DATA_CACHE_CONTROL = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HTML_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: (_address, hop) => hop < ENV.proxyHops,
});

await app.register(cors, {
  credentials: false,
  origin: (origin, cb) => cb(null, origin === undefined || isAllowedOrigin(origin)),
});

await app.register(rateLimit, {
  global: true,
  max: ENV.rateLimitMax,
  timeWindow: ENV.rateLimitWindowMs,
  allowList: (req) => req.url === '/health' && isAdmin(req),
});

const GUARDED_PREFIXES = ['/data/', '/stops/', '/vehicles/'];

app.addHook('onRequest', async (req, reply) => {
  if (!GUARDED_PREFIXES.some((prefix) => req.url.startsWith(prefix))) return;
  if (!guardHttp(req, reply)) return reply;
});

await app.register(websocket, { options: { maxPayload: 1 << 22 } });
await app.register(fastifyStatic, {
  root: ENV.webDataDir,
  prefix: '/data/',
  cacheControl: false,
  setHeaders: (res) => res.setHeader('Cache-Control', DATA_CACHE_CONTROL),
});

const WEB_DIST = resolve(REPO_ROOT, 'packages', 'web', 'dist');
const serveWeb = existsSync(resolve(WEB_DIST, 'index.html'));
if (serveWeb) {
  await app.register(fastifyStatic, {
    root: WEB_DIST,
    prefix: '/',
    decorateReply: false,
    cacheControl: false,
    setHeaders: (res, path) =>
      res.setHeader(
        'Cache-Control',
        path.includes(`${sep}assets${sep}`) ? ASSET_CACHE_CONTROL : HTML_CACHE_CONTROL,
      ),
  });
}

interface Viewport {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

const clients = new Map<WebSocket, Viewport | null>();
const socketsPerIp = new Map<string, number>();

function socketsFor(ip: string): number {
  return socketsPerIp.get(ip) ?? 0;
}

function trackSocket(ip: string): void {
  socketsPerIp.set(ip, socketsFor(ip) + 1);
}

function untrackSocket(ip: string): void {
  const next = socketsFor(ip) - 1;
  if (next > 0) socketsPerIp.set(ip, next);
  else socketsPerIp.delete(ip);
}

function inViewport(view: Viewport | null, lon: number, lat: number): boolean {
  if (!view) return true;
  return lon >= view.minLon && lon <= view.maxLon && lat >= view.minLat && lat <= view.maxLat;
}

app.log.info(
  {
    serviceDate: store.meta.serviceDate,
    ...store.meta.counts,
    departureIndex: departureIndex.size,
    departureIndexMs: +departureIndex.buildMs.toFixed(1),
  },
  'static network loaded',
);

const stopRt = startTripUpdatePoller({
  codespacePrefix: 'RUT',
  intervalMs: ENV.rtPollMs,
  onSnapshot: (snap) => {
    engine.setTripUpdates(snap);
    app.log.info(
      { trips: snap.byTrip.size, mb: +(snap.bytes / 1e6).toFixed(1), ms: snap.durationMs },
      'trip-updates',
    );
  },
  onError: (err) => app.log.error({ err }, 'trip-updates poll failed'),
});

const stopGps = startGpsPoller({
  bbox: store.meta.bbox,
  intervalMs: ENV.vmPollMs,
  onSnapshot: (vehicles) => engine.setGpsVehicles(vehicles),
  onError: (err) => app.log.error({ err }, 'gps poll failed'),
});

const HELLO_PAYLOAD = JSON.stringify({ t: 'hello', meta: store.meta, tickMs: ENV.tickMs });

let addAllPayload: string | null = null;
let positionsPayload = Buffer.from(encodePositions([], Date.now()));

function snapshotAddPayload(): string {
  if (addAllPayload === null) {
    addAllPayload = JSON.stringify({ t: 'add', v: encodeAdded(engine.snapshot()) });
  }
  return addAllPayload;
}

function broadcast(payload: string): void {
  for (const socket of clients.keys()) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

function broadcastPositions(all: VehicleState[], nowMs: number): void {
  for (const [socket, view] of clients) {
    if (socket.readyState !== socket.OPEN) continue;
    if (!view) {
      socket.send(positionsPayload);
      continue;
    }
    socket.send(Buffer.from(encodePositions(all.filter((v) => inViewport(view, v.lon, v.lat)), nowMs)));
  }
}

let lastStatsLog = 0;

const ticker = setInterval(() => {
  const result = engine.tick();
  if (result.added.length || result.removed.length) addAllPayload = null;
  if (!engine.hasRealtime) return;
  const nowMs = Date.now();
  positionsPayload = Buffer.from(encodePositions(result.all, nowMs));
  if (clients.size > 0) {
    if (result.added.length) {
      broadcast(JSON.stringify({ t: 'add', v: encodeAdded(result.added) }));
    }
    if (result.removed.length) {
      broadcast(JSON.stringify({ t: 'del', v: result.removed }));
    }
    broadcastPositions(result.all, nowMs);
  }
  if (Date.now() - lastStatsLog > 30_000) {
    lastStatsLog = Date.now();
    app.log.info(
      { ...result.stats, clients: clients.size, computeMs: +result.stats.computeMs.toFixed(1) },
      'tick',
    );
  }
}, ENV.tickMs);

app.get('/health', async (req) => {
  const summary = {
    ok: true,
    serviceDate: store.meta.serviceDate,
    generatedAt: store.meta.generatedAt,
  };
  if (!isAdmin(req)) return summary;
  return {
    ...summary,
    counts: store.meta.counts,
    rt: engine.rtInfo,
    gps: engine.gpsInfo,
    destinations: destinations.stats,
    correctionsAbsorbed: engine.correctionsAbsorbed,
    clients: clients.size,
    vehicles: engine.snapshot().length,
  };
});

app.get<{ Params: { vid: string } }>('/vehicles/:vid', {
  config: { rateLimit: { max: ENV.apiRateLimitMax, timeWindow: ENV.rateLimitWindowMs } },
}, async (req, reply) => {
  const vehicle = engine.find(Number(req.params.vid));
  if (!vehicle) return reply.code(404).send({ error: 'unknown vehicle' });
  const trip = vehicle.tripId ? store.tripById.get(vehicle.tripId) : undefined;
  if (trip === undefined) return { vehicle, calls: [] };
  const meta = store.trips[trip]!;
  const calls = [];
  for (let k = 0; k < meta.n; k++) {
    calls.push({
      seq: store.call(trip, k, 0),
      arrival: store.call(trip, k, 1),
      departure: store.call(trip, k, 2),
      distance: store.call(trip, k, 3),
      name: store.quayName(store.call(trip, k, 4)),
    });
  }
  return { vehicle, route: store.routes[meta.r], calls };
});

const DEFAULT_DEPARTURE_LIMIT = 12;
const MAX_DEPARTURE_LIMIT = 50;

app.get<{ Params: { stopPlaceId: string }; Querystring: { limit?: string } }>(
  '/stops/:stopPlaceId/departures',
  { config: { rateLimit: { max: ENV.apiRateLimitMax, timeWindow: ENV.rateLimitWindowMs } } },
  async (req, reply) => {
    const place = store.stopPlaceIdxById.get(req.params.stopPlaceId);
    if (place === undefined) return reply.code(404).send({ error: 'unknown stop' });
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested)
      ? Math.min(MAX_DEPARTURE_LIMIT, Math.max(1, Math.trunc(requested)))
      : DEFAULT_DEPARTURE_LIMIT;
    const nowSec = secondsIntoServiceDay(store.meta.serviceDate);
    return buildDepartureBoard(store, engine, departureIndex, place, nowSec, limit);
  },
);

app.get('/live', {
  websocket: true,
  onRequest: async (req, reply) => {
    if (!socketOriginAllowed(req)) return reply.code(403).send({ error: 'forbidden' });
    if (socketsFor(req.ip) >= ENV.maxSocketsPerIp) {
      return reply.code(429).send({ error: 'too many connections' });
    }
  },
}, (socket, req) => {
  const ip = req.ip;
  trackSocket(ip);
  clients.set(socket, null);
  socket.send(HELLO_PAYLOAD);
  socket.send(snapshotAddPayload());
  socket.send(positionsPayload);

  socket.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as { t?: string; b?: number[] };
      if (msg.t !== 'view' || !Array.isArray(msg.b) || msg.b.length !== 4) return;
      const [minLon, minLat, maxLon, maxLat] = msg.b as [number, number, number, number];
      if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return;
      clients.set(socket, { minLon, minLat, maxLon, maxLat });
    } catch {
      clients.set(socket, clients.get(socket) ?? null);
    }
  });

  const drop = (): void => {
    if (clients.delete(socket)) untrackSocket(ip);
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

if (serveWeb) {
  app.setNotFoundHandler((req, reply) => {
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    if (req.method !== 'GET' || !wantsHtml || req.url.startsWith('/data/')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html', WEB_DIST);
  });
}

const shutdown = async (): Promise<void> => {
  clearInterval(ticker);
  stopRt();
  stopGps();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: ENV.port, host: ENV.host });
