import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ageHours(path: string): Promise<number> {
  const s = await stat(path);
  return (Date.now() - s.mtimeMs) / 3_600_000;
}

export async function fetchAndExtractGtfs(opts: {
  id: string;
  url: string;
  cacheDir: string;
  maxAgeHours: number;
  force: boolean;
  log: (msg: string) => void;
}): Promise<string> {
  const { id, url, cacheDir, maxAgeHours, force, log } = opts;
  const zipPath = join(cacheDir, `${id}.zip`);
  const outDir = join(cacheDir, id);
  await mkdir(cacheDir, { recursive: true });

  const cached = !force && (await exists(zipPath)) && (await ageHours(zipPath)) < maxAgeHours;
  if (cached) {
    log(`${id}: using cached zip (${(await ageHours(zipPath)).toFixed(1)}h old)`);
  } else {
    log(`${id}: downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`${id}: GTFS download failed ${res.status} ${res.statusText}`);
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(zipPath));
    log(`${id}: downloaded ${((await stat(zipPath)).size / 1e6).toFixed(1)} MB`);
    await rm(outDir, { recursive: true, force: true });
  }

  if (!(await exists(join(outDir, 'stop_times.txt')))) {
    await mkdir(outDir, { recursive: true });
    log(`${id}: extracting`);
    try {
      await run('unzip', ['-o', '-q', zipPath, '-d', outDir], { maxBuffer: 1 << 24 });
    } catch (err) {
      throw new Error(`${id}: unzip failed. Is the "unzip" binary available? ${String(err)}`);
    }
  }
  return outDir;
}
