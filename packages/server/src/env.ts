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

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function hops(name: string, fallback: number): number {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'false' || raw === 'no') return 0;
  if (raw === 'true' || raw === 'yes') return 1;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}

function originList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.includes('://') ? entry : `https://${entry}`))
    .map((entry) => {
      try {
        return new URL(entry).origin;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

export const ENV = {
  port: int('PORT', 8787),
  host: process.env.HOST ?? '0.0.0.0',
  rtPollMs: int('RT_POLL_MS', 60_000),
  vmPollMs: int('VM_POLL_MS', 8_000),
  tickMs: int('TICK_MS', 2_000),
  clientName: process.env.ET_CLIENT_NAME ?? 'byradar-dev',
  dataDir: resolve(REPO_ROOT, 'data', 'server'),
  webDataDir: resolve(REPO_ROOT, 'data', 'web'),
  allowedOrigins: originList('ALLOWED_ORIGINS'),
  allowLocalhostOrigins: bool('ALLOW_LOCALHOST_ORIGINS', process.env.NODE_ENV !== 'production'),
  strictSameSite: bool('STRICT_SAME_SITE', true),
  proxyHops: hops('TRUST_PROXY_HOPS', 1),
  rateLimitMax: int('RATE_LIMIT_MAX', 600),
  rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
  apiRateLimitMax: int('API_RATE_LIMIT_MAX', 90),
  remoteBoards: bool('REMOTE_BOARDS', true),
  situationPollMs: int('SITUATION_POLL_MS', 180_000),
  situationCodespaces: (process.env.SITUATION_CODESPACES ?? 'RUT,VYG,FLT,OST,NBU')
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean),
  maxSocketsPerIp: int('MAX_SOCKETS_PER_IP', 20),
  adminToken: process.env.ADMIN_TOKEN ?? '',
} as const;

export const ENTUR = {
  tripUpdates: 'https://api.entur.io/realtime/v1/gtfs-rt/trip-updates',
  vehiclesGraphql: 'https://api.entur.io/realtime/v2/vehicles/graphql',
  journeyPlanner: 'https://api.entur.io/journey-planner/v3/graphql',
} as const;
