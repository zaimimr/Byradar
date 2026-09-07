import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ENV } from './env.js';

export interface RouteMeta {
  id: string;
  line: string;
  name: string;
  mode: string;
  color: string;
  text: string;
}

export interface ShapeMeta {
  o: number;
  n: number;
  len: number;
}

export interface TripMeta {
  id: string;
  r: number;
  s: number;
  d: number;
  h: string;
  o: number;
  n: number;
}

export interface DataMeta {
  generatedAt: string;
  serviceDate: string;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  counts: Record<string, number>;
  modes: string[];
}

export const CALL_STRIDE = 5;
export const CALL_SEQ = 0;
export const CALL_ARR = 1;
export const CALL_DEP = 2;
export const CALL_DIST = 3;
export const CALL_QUAY = 4;

export const SHAPE_STRIDE = 3;

export class Store {
  private constructor(
    readonly meta: DataMeta,
    readonly routes: RouteMeta[],
    readonly shapes: ShapeMeta[],
    readonly shapeData: Float64Array,
    readonly trips: TripMeta[],
    readonly callData: Float64Array,
    readonly quayNames: string[],
    readonly tripById: Map<string, number>,
    readonly window: { firstDep: Float64Array; lastArr: Float64Array },
  ) {}

  static async load(): Promise<Store> {
    const dir = ENV.dataDir;
    const read = async <T>(name: string): Promise<T> => JSON.parse(await readFile(join(dir, name), 'utf8')) as T;

    const meta = await read<DataMeta>('meta.json');
    const routes = await read<RouteMeta[]>('routes.json');
    const shapes = await read<ShapeMeta[]>('shapes-index.json');
    const trips = await read<TripMeta[]>('trips-index.json');
    const quays = await read<{ ids: string[]; names: string[] }>('quays.json');

    const shapeBuf = await readFile(join(dir, 'shapes.bin'));
    const callBuf = await readFile(join(dir, 'trips.bin'));
    const shapeData = new Float64Array(shapeBuf.buffer, shapeBuf.byteOffset, shapeBuf.byteLength / 8);
    const callData = new Float64Array(callBuf.buffer, callBuf.byteOffset, callBuf.byteLength / 8);

    const tripById = new Map<string, number>();
    const firstDep = new Float64Array(trips.length);
    const lastArr = new Float64Array(trips.length);
    for (let i = 0; i < trips.length; i++) {
      const t = trips[i]!;
      tripById.set(t.id, i);
      firstDep[i] = callData[t.o * CALL_STRIDE + CALL_DEP]!;
      lastArr[i] = callData[(t.o + t.n - 1) * CALL_STRIDE + CALL_ARR]!;
    }

    return new Store(meta, routes, shapes, shapeData, trips, callData, quays.names, tripById, { firstDep, lastArr });
  }

  call(tripIdx: number, callIdx: number, field: number): number {
    const t = this.trips[tripIdx]!;
    return this.callData[(t.o + callIdx) * CALL_STRIDE + field]!;
  }

  quayName(quayIdx: number): string {
    return this.quayNames[quayIdx] ?? '';
  }
}
