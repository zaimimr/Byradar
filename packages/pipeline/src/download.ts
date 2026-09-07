import { execFile } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
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
  codespace: string;
  url: string;
  cacheDir: string;
  maxAgeHours: number;
  force: boolean;
  log: (msg: string) => void;
}): Promise<string> {
  const { codespace, url, cacheDir, maxAgeHours, force, log } = opts;
  const zipPath = join(cacheDir, `${codespace}.zip`);
  const outDir = join(cacheDir, codespace);
  await mkdir(cacheDir, { recursive: true });

  const cached = !force && (await exists(zipPath)) && (await ageHours(zipPath)) < maxAgeHours;
  if (cached) {
    log(`${codespace}: using cached zip (${(await ageHours(zipPath)).toFixed(1)}h old)`);
  } else {
    log(`${codespace}: downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${codespace}: GTFS download failed ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(zipPath, buf);
    log(`${codespace}: downloaded ${(buf.byteLength / 1e6).toFixed(1)} MB`);
    await rm(outDir, { recursive: true, force: true });
  }

  if (!(await exists(join(outDir, 'stop_times.txt')))) {
    await mkdir(outDir, { recursive: true });
    log(`${codespace}: extracting`);
    try {
      await run('unzip', ['-o', '-q', zipPath, '-d', outDir], { maxBuffer: 1 << 24 });
    } catch (err) {
      throw new Error(`${codespace}: unzip failed. Is the "unzip" binary available? ${String(err)}`);
    }
  }
  return outDir;
}
