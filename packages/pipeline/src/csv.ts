import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

export interface CsvCursor {
  readonly columns: ReadonlyMap<string, number>;
  index(name: string): number;
  optional(name: string): number;
  has(name: string): boolean;
}

export async function readCsv(
  path: string,
  onRow: (row: string[], cursor: CsvCursor) => void,
): Promise<number> {
  const stream = createInterface({ input: createReadStream(path, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  let cursor: CsvCursor | null = null;
  let count = 0;
  for await (const line of stream) {
    if (!line) continue;
    if (!cursor) {
      const header = splitCsvLine(line);
      const columns = new Map(header.map((h, i) => [h.trim(), i] as const));
      cursor = {
        columns,
        index(name) {
          const i = columns.get(name);
          if (i === undefined) throw new Error(`column "${name}" missing in ${path}`);
          return i;
        },
        optional(name) {
          return columns.get(name) ?? -1;
        },
        has(name) {
          return columns.has(name);
        },
      };
      continue;
    }
    onRow(splitCsvLine(line), cursor);
    count++;
  }
  return count;
}

export function num(row: string[], i: number, fallback = 0): number {
  if (i < 0) return fallback;
  const raw = row[i];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

export function str(row: string[], i: number): string {
  return i < 0 ? '' : row[i] ?? '';
}

export function gtfsTimeToSeconds(value: string): number {
  if (!value) return -1;
  const h = Number(value.slice(0, 2));
  const m = Number(value.slice(3, 5));
  const s = Number(value.slice(6, 8));
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return -1;
  return h * 3600 + m * 60 + s;
}
