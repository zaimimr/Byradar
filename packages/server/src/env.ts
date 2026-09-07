import { config } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../..');

config({ path: resolve(REPO_ROOT, '.env'), quiet: true });

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const ENV = {
  port: int('PORT', 8787),
  host: process.env.HOST ?? '0.0.0.0',
  rtPollMs: int('RT_POLL_MS', 30_000),
  vmPollMs: int('VM_POLL_MS', 8_000),
  tickMs: int('TICK_MS', 1_000),
  clientName: process.env.ET_CLIENT_NAME ?? 'oslomap-dev',
  dataDir: resolve(REPO_ROOT, 'data', 'server'),
  webDataDir: resolve(REPO_ROOT, 'data', 'web'),
} as const;

export const ENTUR = {
  tripUpdates: 'https://api.entur.io/realtime/v1/gtfs-rt/trip-updates',
  vehiclesGraphql: 'https://api.entur.io/realtime/v2/vehicles/graphql',
} as const;
