import type { Mode } from './types.js';

const CELL = 128;
const RIM_WIDTH = 16;
const ORDER: Mode[] = ['bus', 'tram', 'metro', 'rail', 'ferry', 'other'];

export interface SpriteSet {
  atlas: string;
  mapping: Record<string, { x: number; y: number; width: number; height: number; mask: boolean; anchorY: number }>;
}

type Shape = (ctx: CanvasRenderingContext2D) => void;

const M = CELL / 2;

function rounded(ctx: CanvasRenderingContext2D, halfWidth: number, halfLength: number, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(M - halfWidth, M - halfLength, halfWidth * 2, halfLength * 2, radius);
}

const SHAPE: Record<Mode, Shape> = {
  bus: (ctx) => rounded(ctx, 21, 44, 10),
  tram: (ctx) => rounded(ctx, 17, 54, 8),
  metro: (ctx) => {
    ctx.beginPath();
    ctx.moveTo(M - 19, M - 34);
    ctx.quadraticCurveTo(M - 19, M - 56, M, M - 56);
    ctx.quadraticCurveTo(M + 19, M - 56, M + 19, M - 34);
    ctx.lineTo(M + 19, M + 48);
    ctx.quadraticCurveTo(M + 19, M + 56, M + 10, M + 56);
    ctx.lineTo(M - 10, M + 56);
    ctx.quadraticCurveTo(M - 19, M + 56, M - 19, M + 48);
    ctx.closePath();
  },
  rail: (ctx) => {
    ctx.beginPath();
    ctx.moveTo(M, M - 60);
    ctx.quadraticCurveTo(M + 18, M - 46, M + 18, M - 24);
    ctx.lineTo(M + 18, M + 50);
    ctx.quadraticCurveTo(M + 18, M + 58, M + 9, M + 58);
    ctx.lineTo(M - 9, M + 58);
    ctx.quadraticCurveTo(M - 18, M + 58, M - 18, M + 50);
    ctx.lineTo(M - 18, M - 24);
    ctx.quadraticCurveTo(M - 18, M - 46, M, M - 60);
    ctx.closePath();
  },
  ferry: (ctx) => {
    ctx.beginPath();
    ctx.moveTo(M, M - 52);
    ctx.quadraticCurveTo(M + 26, M - 12, M + 26, M + 22);
    ctx.lineTo(M + 26, M + 44);
    ctx.quadraticCurveTo(M + 26, M + 50, M + 19, M + 50);
    ctx.lineTo(M - 19, M + 50);
    ctx.quadraticCurveTo(M - 26, M + 50, M - 26, M + 44);
    ctx.lineTo(M - 26, M + 22);
    ctx.quadraticCurveTo(M - 26, M - 12, M, M - 52);
    ctx.closePath();
  },
  other: (ctx) => rounded(ctx, 20, 30, 14),
};

const CUTS: Record<Mode, Array<[number, number, number, number]>> = {
  bus: [[-14, -34, 28, 13], [-21, 14, 42, 4]],
  tram: [[-11, -44, 22, 13], [-17, -4, 34, 4], [-17, 26, 34, 4]],
  metro: [[-12, -44, 24, 14], [-19, 6, 38, 4]],
  rail: [[-10, -40, 20, 14], [-18, 12, 36, 4]],
  ferry: [[-14, -16, 28, 6], [-26, 22, 52, 5]],
  other: [[-12, -18, 24, 10]],
};

function paint(mode: Mode, dilate: number): HTMLCanvasElement {
  const cell = document.createElement('canvas');
  cell.width = CELL;
  cell.height = CELL;
  const ctx = cell.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  SHAPE[mode](ctx);
  if (dilate > 0) {
    ctx.lineWidth = dilate * 2;
    ctx.stroke();
  }
  ctx.fill();

  if (dilate === 0) {
    ctx.globalCompositeOperation = 'destination-out';
    for (const [x, y, w, h] of CUTS[mode]) {
      ctx.beginPath();
      ctx.roundRect(M + x, M + y, w, h, 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  return cell;
}

export function buildVehicleSprites(): SpriteSet {
  const columns = ORDER.length * 2;
  const atlas = document.createElement('canvas');
  atlas.width = CELL * columns;
  atlas.height = CELL;
  const ctx = atlas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');

  const mapping: SpriteSet['mapping'] = {};
  let column = 0;

  const place = (key: string, canvas: HTMLCanvasElement): void => {
    ctx.drawImage(canvas, column * CELL, 0);
    mapping[key] = { x: column * CELL, y: 0, width: CELL, height: CELL, mask: true, anchorY: CELL / 2 };
    column++;
  };

  for (const mode of ORDER) {
    place(mode, paint(mode, 0));
    place(`${mode}-rim`, paint(mode, RIM_WIDTH));
  }

  return { atlas: atlas.toDataURL('image/png'), mapping };
}
