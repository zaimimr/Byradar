import type { NetworkPath } from './types.js';

export const BUS_TILE_MIN_ZOOM = 9.5;

const MAX_TILES = 24;
const MAX_CELLS_PER_VIEW = 16;
const VIEW_PAD = 0.15;

interface TileIndex {
  minLon: number;
  minLat: number;
  lonStep: number;
  latStep: number;
  cells: string[];
}

export interface Bounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export class NetworkTiles {
  private index: TileIndex | null = null;
  private available = new Set<string>();
  private readonly loaded = new Map<string, NetworkPath[]>();
  private readonly inflight = new Set<string>();
  private core: NetworkPath[] = [];
  private failures = 0;
  private combined: NetworkPath[] = [];

  version = 0;

  constructor(
    private readonly dataUrl: string,
    private readonly onChange: () => void,
  ) {}

  setCore(core: NetworkPath[]): void {
    this.core = core;
    this.rebuild();
  }

  get paths(): NetworkPath[] {
    return this.combined;
  }

  get stats(): { loaded: number; available: number; failures: number } {
    return { loaded: this.loaded.size, available: this.available.size, failures: this.failures };
  }

  async loadIndex(): Promise<void> {
    try {
      const res = await fetch(`${this.dataUrl}/net/index.json`);
      if (!res.ok) return;
      this.index = (await res.json()) as TileIndex;
      this.available = new Set(this.index.cells);
    } catch {
      this.index = null;
    }
  }

  update(bounds: Bounds, zoom: number): void {
    const index = this.index;
    if (!index || zoom < BUS_TILE_MIN_ZOOM) return;

    const wanted = this.cellsFor(index, bounds);
    if (!wanted.length) return;

    for (const cell of wanted) {
      if (this.loaded.has(cell) || this.inflight.has(cell)) continue;
      void this.fetchCell(cell);
    }
    this.evict(wanted);
  }

  private cellsFor(index: TileIndex, bounds: Bounds): string[] {
    const padLon = (bounds.maxLon - bounds.minLon) * VIEW_PAD;
    const padLat = (bounds.maxLat - bounds.minLat) * VIEW_PAD;
    const x0 = Math.floor((bounds.minLon - padLon - index.minLon) / index.lonStep);
    const x1 = Math.floor((bounds.maxLon + padLon - index.minLon) / index.lonStep);
    const y0 = Math.floor((bounds.minLat - padLat - index.minLat) / index.latStep);
    const y1 = Math.floor((bounds.maxLat + padLat - index.minLat) / index.latStep);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_VIEW) return [];

    const cells: string[] = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const cell = `${x}-${y}`;
        if (this.available.has(cell)) cells.push(cell);
      }
    }
    return cells;
  }

  private async fetchCell(cell: string): Promise<void> {
    this.inflight.add(cell);
    try {
      const res = await fetch(`${this.dataUrl}/net/${cell}.json`);
      if (!res.ok) {
        this.available.delete(cell);
        return;
      }
      this.loaded.set(cell, (await res.json()) as NetworkPath[]);
      this.rebuild();
    } catch {
      this.failures++;
    } finally {
      this.inflight.delete(cell);
    }
  }

  private evict(keep: string[]): void {
    if (this.loaded.size <= MAX_TILES) return;
    const protectedCells = new Set(keep);
    let dropped = false;
    for (const cell of this.loaded.keys()) {
      if (this.loaded.size <= MAX_TILES) break;
      if (protectedCells.has(cell)) continue;
      this.loaded.delete(cell);
      dropped = true;
    }
    if (dropped) this.rebuild();
  }

  private rebuild(): void {
    const out = [...this.core];
    for (const paths of this.loaded.values()) out.push(...paths);
    this.combined = out;
    this.version++;
    this.onChange();
  }
}
