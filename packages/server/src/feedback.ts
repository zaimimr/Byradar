import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const FEEDBACK_KINDS = ['kart', 'tider', 'ide', 'annet'] as const;

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface FeedbackEntry {
  id: string;
  at: string;
  kind: FeedbackKind;
  message: string;
  place?: string;
  contact?: string;
  view?: string;
}

export type FeedbackDraft =
  | { ok: true; entry: FeedbackEntry; spam: boolean }
  | { ok: false; error: string };

const MESSAGE_MIN = 4;
const MESSAGE_MAX = 2000;
const PLACE_MAX = 120;
const CONTACT_MAX = 160;
const VIEW_MAX = 240;
const VIEW_SHAPE = /^[A-Za-z0-9=&,.:_%+-]*$/;
const FILE_NAME = 'feedback.jsonl';

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{C}\n]/gu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max).trim() : cleaned;
}

function isKind(value: unknown): value is FeedbackKind {
  return typeof value === 'string' && (FEEDBACK_KINDS as readonly string[]).includes(value);
}

export function readDraft(body: unknown): FeedbackDraft {
  if (body === null || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const raw = body as Record<string, unknown>;

  if (!isKind(raw.kind)) return { ok: false, error: 'unknown kind' };

  const message = text(raw.message, MESSAGE_MAX);
  if (message.length < MESSAGE_MIN) return { ok: false, error: 'message too short' };

  const place = text(raw.place, PLACE_MAX);
  const contact = text(raw.contact, CONTACT_MAX);
  const view = text(raw.view, VIEW_MAX);

  const entry: FeedbackEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    kind: raw.kind,
    message,
  };
  if (place) entry.place = place;
  if (contact) entry.contact = contact;
  if (view && VIEW_SHAPE.test(view)) entry.view = view;

  return { ok: true, entry, spam: text(raw.nettsted, 40).length > 0 };
}

export class FeedbackStore {
  private bytes: number;
  private entries: number;

  private constructor(
    private readonly file: string,
    private readonly maxBytes: number,
    bytes: number,
    entries: number,
  ) {
    this.bytes = bytes;
    this.entries = entries;
  }

  static async open(dir: string, maxBytes: number): Promise<FeedbackStore> {
    await mkdir(dir, { recursive: true });
    const file = join(dir, FILE_NAME);
    try {
      const info = await stat(file);
      const lines = await readFile(file, 'utf8');
      const count = lines.split('\n').filter((line) => line.trim().length > 0).length;
      return new FeedbackStore(file, maxBytes, info.size, count);
    } catch {
      return new FeedbackStore(file, maxBytes, 0, 0);
    }
  }

  get full(): boolean {
    return this.bytes >= this.maxBytes;
  }

  get stats(): { entries: number; bytes: number; full: boolean } {
    return { entries: this.entries, bytes: this.bytes, full: this.full };
  }

  async append(entry: FeedbackEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    await appendFile(this.file, line, 'utf8');
    this.bytes += Buffer.byteLength(line);
    this.entries += 1;
  }

  async recent(limit: number): Promise<FeedbackEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    const entries: FeedbackEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as FeedbackEntry);
      } catch {
        continue;
      }
    }
    return entries.slice(-limit).reverse();
  }
}

export async function notify(url: string, entry: FeedbackEntry): Promise<void> {
  const lines = [`byradar: ny tilbakemelding (${entry.kind})`, entry.message];
  if (entry.place) lines.push(`Sted: ${entry.place}`);
  if (entry.contact) lines.push(`Svar til: ${entry.contact}`);
  if (entry.view) lines.push(`Kart: https://byradar.no/#${entry.view}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: lines.join('\n'), text: lines.join('\n') }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`webhook answered ${res.status}`);
}
