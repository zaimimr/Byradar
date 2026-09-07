import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { WebSocket } from 'ws';

import { DestinationResolver } from './destinations.js';
import { Engine } from './engine.js';
import { startGpsPoller } from './entur.js';
import { ENV } from './env.js';
import { startTripUpdatePoller } from './rt.js';
import { Store } from './store.js';
import { encodeAdded, encodePositions } from './wire.js';

const store = await Store.load();
const destinations = new DestinationResolver(store.journeyHeadsigns);
const engine = new Engine(store, destinations);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.register(cors, { origin: true });
await app.register(websocket, { options: { maxPayload: 1 << 22 } });
await app.register(fastifyStatic, { root: ENV.webDataDir, prefix: '/data/' });

const clients = new Set<WebSocket>();

app.log.info(
  { serviceDate: store.meta.serviceDate, ...store.meta.counts },
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

function broadcast(payload: string | ArrayBuffer): void {
  const data = typeof payload === 'string' ? payload : Buffer.from(payload);
  for (const socket of clients) {
    if (socket.readyState === socket.OPEN) socket.send(data);
  }
}

let lastStatsLog = 0;

const ticker = setInterval(() => {
  const result = engine.tick();
  if (!engine.hasRealtime) return;
  if (clients.size > 0) {
    if (result.added.length) {
      broadcast(JSON.stringify({ t: 'add', v: encodeAdded(result.added) }));
    }
    if (result.removed.length) {
      broadcast(JSON.stringify({ t: 'del', v: result.removed }));
    }
    broadcast(encodePositions(result.all, Date.now()));
  }
  if (Date.now() - lastStatsLog > 30_000) {
    lastStatsLog = Date.now();
    app.log.info(
      { ...result.stats, clients: clients.size, computeMs: +result.stats.computeMs.toFixed(1) },
      'tick',
    );
  }
}, ENV.tickMs);

app.get('/health', async () => ({
  ok: true,
  serviceDate: store.meta.serviceDate,
  generatedAt: store.meta.generatedAt,
  counts: store.meta.counts,
  rt: engine.rtInfo,
  gps: engine.gpsInfo,
  destinations: destinations.stats,
  correctionsAbsorbed: engine.correctionsAbsorbed,
  clients: clients.size,
  vehicles: engine.snapshot().length,
}));

app.get('/vehicles', async () => {
  const all = engine.snapshot();
  return { count: all.length, vehicles: all };
});

app.get<{ Params: { vid: string } }>('/vehicles/:vid', async (req, reply) => {
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

app.get('/live', { websocket: true }, (socket) => {
  clients.add(socket);
  const all = engine.snapshot();
  socket.send(JSON.stringify({ t: 'hello', meta: store.meta, tickMs: ENV.tickMs }));
  socket.send(JSON.stringify({ t: 'add', v: encodeAdded(all) }));
  socket.send(Buffer.from(encodePositions(all, Date.now())));
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

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
