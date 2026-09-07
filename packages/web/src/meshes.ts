import type { Mode } from './types.js';

export type VehicleMesh = Record<string, { value: Float32Array | Uint16Array; size: number }>;

interface Profile {
  length: number;
  width: number;
  height: number;
  frontWidth: number;
  rake: number;
}

const PROFILES: Record<Mode, Profile> = {
  bus: { length: 1.0, width: 0.46, height: 0.46, frontWidth: 0.42, rake: 0.1 },
  tram: { length: 1.5, width: 0.42, height: 0.44, frontWidth: 0.36, rake: 0.14 },
  metro: { length: 1.75, width: 0.46, height: 0.48, frontWidth: 0.4, rake: 0.16 },
  rail: { length: 2.0, width: 0.48, height: 0.54, frontWidth: 0.38, rake: 0.2 },
  ferry: { length: 1.4, width: 0.68, height: 0.48, frontWidth: 0.22, rake: 0.22 },
  other: { length: 0.9, width: 0.44, height: 0.42, frontWidth: 0.4, rake: 0.08 },
};

type Vec = [number, number, number];

function faceNormal(a: Vec, b: Vec, c: Vec): Vec {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function build(profile: Profile): VehicleMesh {
  const l2 = profile.length / 2;
  const w2 = profile.width / 2;
  const f2 = profile.frontWidth / 2;
  const h = profile.height;
  const rake = profile.rake;

  const A: Vec = [-w2, -l2, 0];
  const B: Vec = [w2, -l2, 0];
  const C: Vec = [f2, l2, 0];
  const D: Vec = [-f2, l2, 0];
  const E: Vec = [-w2, -l2, h];
  const F: Vec = [w2, -l2, h];
  const G: Vec = [f2, l2 - rake, h];
  const H: Vec = [-f2, l2 - rake, h];

  const quads: Array<[Vec, Vec, Vec, Vec]> = [
    [A, D, C, B],
    [E, F, G, H],
    [A, E, H, D],
    [B, C, G, F],
    [A, B, F, E],
    [D, H, G, C],
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (const [p0, p1, p2, p3] of quads) {
    const base = positions.length / 3;
    const n = faceNormal(p0, p1, p2);
    for (const p of [p0, p1, p2, p3]) {
      positions.push(p[0], p[1], p[2]);
      normals.push(n[0], n[1], n[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  return {
    positions: { value: new Float32Array(positions), size: 3 },
    normals: { value: new Float32Array(normals), size: 3 },
    indices: { value: new Uint16Array(indices), size: 1 },
  };
}

const CACHE = new Map<Mode, VehicleMesh>();

export function vehicleMesh(mode: Mode): VehicleMesh {
  let mesh = CACHE.get(mode);
  if (!mesh) {
    mesh = build(PROFILES[mode] ?? PROFILES.other);
    CACHE.set(mode, mesh);
  }
  return mesh;
}

export function metresPerPixel(latitude: number, zoom: number): number {
  return (156_543.033_92 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
}
