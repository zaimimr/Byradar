import type { Mode } from './types.js';

const CELL = 192;
const HULL_FILL = 0.96;
const RIM_SCALE = 1.1;
const MODES: Mode[] = ['bus', 'tram', 'metro', 'rail', 'ferry', 'other'];

const HULL_ASPECT: Record<Mode, number> = {
  bus: 2.6,
  tram: 4.2,
  metro: 4.4,
  rail: 4.8,
  ferry: 2.2,
  other: 2.2,
};

const HULL_SLOTS: Record<Mode, number[]> = {
  bus: [0.12, 0.34],
  tram: [-0.2, 0.06, 0.32],
  metro: [-0.12, 0.2],
  rail: [0.02, 0.28],
  ferry: [0.16, 0.34],
  other: [],
};

export interface SpriteSet {
  atlas: string;
  mapping: Record<string, { x: number; y: number; width: number; height: number; mask: boolean; anchorY: number }>;
}

const M = CELL / 2;

function ctxOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  return ctx;
}

function blank(): HTMLCanvasElement {
  const cell = document.createElement('canvas');
  cell.width = CELL;
  cell.height = CELL;
  return cell;
}

function hullOutline(ctx: CanvasRenderingContext2D, mode: Mode, hl: number, hw: number): void {
  const front = M - hl;
  const back = M + hl;
  ctx.beginPath();

  if (mode === 'rail') {
    ctx.moveTo(M, front);
    ctx.quadraticCurveTo(M + hw, front + hl * 0.18, M + hw, front + hl * 0.42);
    ctx.lineTo(M + hw, back - hw * 0.6);
    ctx.quadraticCurveTo(M + hw, back, M + hw * 0.45, back);
    ctx.lineTo(M - hw * 0.45, back);
    ctx.quadraticCurveTo(M - hw, back, M - hw, back - hw * 0.6);
    ctx.lineTo(M - hw, front + hl * 0.42);
    ctx.quadraticCurveTo(M - hw, front + hl * 0.18, M, front);
  } else if (mode === 'ferry') {
    ctx.moveTo(M, front);
    ctx.quadraticCurveTo(M + hw, front + hl * 0.55, M + hw, M + hl * 0.15);
    ctx.lineTo(M + hw, back - hw * 0.3);
    ctx.quadraticCurveTo(M + hw, back, M + hw * 0.6, back);
    ctx.lineTo(M - hw * 0.6, back);
    ctx.quadraticCurveTo(M - hw, back, M - hw, back - hw * 0.3);
    ctx.lineTo(M - hw, M + hl * 0.15);
    ctx.quadraticCurveTo(M - hw, front + hl * 0.55, M, front);
  } else if (mode === 'metro') {
    ctx.moveTo(M - hw, front + hl * 0.2);
    ctx.quadraticCurveTo(M - hw, front, M, front);
    ctx.quadraticCurveTo(M + hw, front, M + hw, front + hl * 0.2);
    ctx.lineTo(M + hw, back - hw * 0.5);
    ctx.quadraticCurveTo(M + hw, back, M + hw * 0.5, back);
    ctx.lineTo(M - hw * 0.5, back);
    ctx.quadraticCurveTo(M - hw, back, M - hw, back - hw * 0.5);
  } else {
    ctx.roundRect(M - hw, front, hw * 2, hl * 2, mode === 'bus' ? hw * 0.44 : hw * 0.3);
  }

  ctx.closePath();
}

function hull(mode: Mode, rim: boolean): HTMLCanvasElement {
  const cell = blank();
  const ctx = ctxOf(cell);
  const length = CELL * HULL_FILL;
  const hl = length / 2;
  const hw = length / (HULL_ASPECT[mode] ?? HULL_ASPECT.other) / 2;

  ctx.fillStyle = '#ffffff';
  ctx.lineJoin = 'round';

  if (rim) {
    ctx.translate(M, M);
    ctx.scale(RIM_SCALE, RIM_SCALE);
    ctx.translate(-M, -M);
  }

  hullOutline(ctx, mode, hl, hw);
  ctx.fill();

  if (!rim) {
    ctx.globalCompositeOperation = 'destination-out';
    const screenW = hw * 1.2;
    const screenH = hl * 0.13;
    const screenTop = M - hl + hl * (mode === 'rail' || mode === 'ferry' ? 0.28 : 0.14);
    ctx.beginPath();
    ctx.roundRect(M - screenW / 2, screenTop, screenW, screenH, 2);
    ctx.fill();
    for (const at of HULL_SLOTS[mode] ?? []) {
      ctx.fillRect(M - hw, M + hl * at, hw * 2, Math.max(1.6, hl * 0.02));
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  return cell;
}

function disc(): HTMLCanvasElement {
  const cell = blank();
  const ctx = ctxOf(cell);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(M, M, M * 0.94, 0, Math.PI * 2);
  ctx.fill();
  return cell;
}

function arrow(): HTMLCanvasElement {
  const cell = blank();
  const ctx = ctxOf(cell);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(M, M - M * 0.9);
  ctx.lineTo(M + M * 0.62, M + M * 0.5);
  ctx.quadraticCurveTo(M, M + M * 0.16, M - M * 0.62, M + M * 0.5);
  ctx.closePath();
  ctx.fill();
  return cell;
}

function wheels(ctx: CanvasRenderingContext2D, ys: number, xs: number[], r: number): void {
  for (const x of xs) {
    ctx.beginPath();
    ctx.arc(M + x, ys, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function glyph(mode: Mode): HTMLCanvasElement {
  const cell = blank();
  const ctx = ctxOf(cell);
  ctx.fillStyle = '#ffffff';
  ctx.lineJoin = 'round';
  const u = CELL / 24;

  if (mode === 'bus' || mode === 'other') {
    ctx.beginPath();
    ctx.roundRect(M - 8 * u, M - 7 * u, 16 * u, 11 * u, 2.4 * u);
    ctx.fill();
    wheels(ctx, M + 5.4 * u, [-4.6 * u, 4.6 * u], 2.1 * u);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.roundRect(M - 6 * u, M - 5 * u, 5 * u, 4 * u, 0.8 * u);
    ctx.roundRect(M + 1 * u, M - 5 * u, 5 * u, 4 * u, 0.8 * u);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  } else if (mode === 'tram') {
    ctx.fillRect(M - 0.7 * u, M - 11 * u, 1.4 * u, 4 * u);
    ctx.beginPath();
    ctx.roundRect(M - 7.5 * u, M - 7 * u, 15 * u, 12 * u, 3 * u);
    ctx.fill();
    wheels(ctx, M + 6 * u, [-4 * u, 4 * u], 1.8 * u);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.roundRect(M - 5.6 * u, M - 5 * u, 4.6 * u, 4.2 * u, 0.8 * u);
    ctx.roundRect(M + 1 * u, M - 5 * u, 4.6 * u, 4.2 * u, 0.8 * u);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  } else if (mode === 'metro') {
    ctx.beginPath();
    ctx.roundRect(M - 8 * u, M - 8 * u, 16 * u, 16 * u, 4.5 * u);
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = 2.3 * u;
    ctx.strokeStyle = '#000';
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    ctx.moveTo(M - 4.2 * u, M + 4.2 * u);
    ctx.lineTo(M - 4.2 * u, M - 4.2 * u);
    ctx.lineTo(M, M + 1.2 * u);
    ctx.lineTo(M + 4.2 * u, M - 4.2 * u);
    ctx.lineTo(M + 4.2 * u, M + 4.2 * u);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  } else if (mode === 'rail') {
    ctx.beginPath();
    ctx.moveTo(M - 7 * u, M + 5 * u);
    ctx.lineTo(M - 7 * u, M - 3 * u);
    ctx.quadraticCurveTo(M - 7 * u, M - 8 * u, M, M - 8 * u);
    ctx.quadraticCurveTo(M + 7 * u, M - 8 * u, M + 7 * u, M - 3 * u);
    ctx.lineTo(M + 7 * u, M + 5 * u);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(M - 8.6 * u, M + 5.4 * u, 17.2 * u, 1.8 * u);
    wheels(ctx, M + 8.4 * u, [-4 * u, 4 * u], 1.5 * u);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.roundRect(M - 5 * u, M - 6 * u, 10 * u, 5 * u, 1 * u);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  } else {
    ctx.beginPath();
    ctx.moveTo(M - 9 * u, M + 1 * u);
    ctx.lineTo(M + 9 * u, M + 1 * u);
    ctx.lineTo(M + 6 * u, M + 7 * u);
    ctx.lineTo(M - 6 * u, M + 7 * u);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(M - 4.5 * u, M - 6 * u, 9 * u, 6 * u, 1.2 * u);
    ctx.fill();
    ctx.fillRect(M - 0.8 * u, M - 10 * u, 1.6 * u, 4 * u);
  }

  return cell;
}

export function buildVehicleSprites(): SpriteSet {
  const frames: Array<[string, HTMLCanvasElement]> = [];
  for (const mode of MODES) {
    frames.push([`hull-${mode}`, hull(mode, false)]);
    frames.push([`hull-${mode}-rim`, hull(mode, true)]);
    frames.push([`glyph-${mode}`, glyph(mode)]);
  }
  frames.push(['disc', disc()]);
  frames.push(['arrow', arrow()]);

  const atlas = document.createElement('canvas');
  atlas.width = CELL * frames.length;
  atlas.height = CELL;
  const ctx = ctxOf(atlas);

  const mapping: SpriteSet['mapping'] = {};
  frames.forEach(([key, canvas], index) => {
    ctx.drawImage(canvas, index * CELL, 0);
    mapping[key] = { x: index * CELL, y: 0, width: CELL, height: CELL, mask: true, anchorY: CELL / 2 };
  });

  return { atlas: atlas.toDataURL('image/png'), mapping };
}
