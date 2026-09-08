import type { FastifyReply, FastifyRequest } from 'fastify';

import { ENV } from './env.js';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function selfOrigin(req: FastifyRequest): string | null {
  const host = req.headers.host;
  if (!host) return null;
  return originOf(`${req.protocol}://${host}`);
}

export function isAllowedOrigin(origin: string, req?: FastifyRequest): boolean {
  const normalised = originOf(origin);
  if (normalised === null) return false;
  if (ENV.allowedOrigins.includes(normalised)) return true;
  if (req && normalised === selfOrigin(req)) return true;
  if (ENV.allowLocalhostOrigins) {
    const host = hostnameOf(normalised);
    if (host !== null && LOCAL_HOSTNAMES.has(host)) return true;
  }
  return false;
}

export function isLoopback(req: FastifyRequest): boolean {
  const peer = req.socket.remoteAddress ?? '';
  return LOOPBACK_ADDRESSES.has(peer);
}

export function isAdmin(req: FastifyRequest): boolean {
  if (isLoopback(req)) return true;
  if (!ENV.adminToken) return false;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${ENV.adminToken}`;
}

function refererAllowed(req: FastifyRequest): boolean {
  const referer = originOf(req.headers.referer);
  return referer !== null && isAllowedOrigin(referer, req);
}

function browserRequestAllowed(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin, req)) return true;
  const site = req.headers['sec-fetch-site'];
  if (site === 'same-origin' || site === 'same-site') return true;
  if (typeof site === 'string') return false;
  return !origin && refererAllowed(req);
}

export function guardHttp(req: FastifyRequest, reply: FastifyReply): boolean {
  reply.header('Vary', 'Origin, Sec-Fetch-Site');
  if (!ENV.strictSameSite || isLoopback(req)) return true;
  if (browserRequestAllowed(req)) return true;
  reply.code(403).send({ error: 'forbidden' });
  return false;
}

export function socketOriginAllowed(req: FastifyRequest): boolean {
  if (!ENV.strictSameSite || isLoopback(req)) return true;
  const origin = req.headers.origin;
  return typeof origin === 'string' && isAllowedOrigin(origin, req);
}
