const SIZE = 64;

function chevronPath(ctx: CanvasRenderingContext2D, inset: number): void {
  const c = SIZE / 2;
  const r = c - inset;
  ctx.beginPath();
  ctx.moveTo(c, c - r);
  ctx.lineTo(c + r * 0.78, c + r * 0.82);
  ctx.lineTo(c, c + r * 0.42);
  ctx.lineTo(c - r * 0.78, c + r * 0.82);
  ctx.closePath();
}

function canvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const el = document.createElement('canvas');
  el.width = SIZE;
  el.height = SIZE;
  const ctx = el.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  return [el, ctx];
}

export interface SpriteSet {
  atlas: string;
  mapping: Record<string, { x: number; y: number; width: number; height: number; mask: boolean; anchorY: number }>;
}

export function buildVehicleSprites(): SpriteSet {
  const atlas = document.createElement('canvas');
  atlas.width = SIZE * 3;
  atlas.height = SIZE;
  const ctx = atlas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');

  const [solid, solidCtx] = canvas();
  solidCtx.fillStyle = '#fff';
  chevronPath(solidCtx, 6);
  solidCtx.fill();

  const [hollow, hollowCtx] = canvas();
  hollowCtx.fillStyle = '#fff';
  chevronPath(hollowCtx, 6);
  hollowCtx.fill();
  hollowCtx.globalCompositeOperation = 'destination-out';
  chevronPath(hollowCtx, 22);
  hollowCtx.fill();

  const [disc, discCtx] = canvas();
  discCtx.fillStyle = '#fff';
  discCtx.beginPath();
  discCtx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 9, 0, Math.PI * 2);
  discCtx.fill();

  ctx.drawImage(solid, 0, 0);
  ctx.drawImage(hollow, SIZE, 0);
  ctx.drawImage(disc, SIZE * 2, 0);

  const entry = (x: number) => ({ x, y: 0, width: SIZE, height: SIZE, mask: true, anchorY: SIZE / 2 });

  return {
    atlas: atlas.toDataURL('image/png'),
    mapping: {
      solid: entry(0),
      hollow: entry(SIZE),
      disc: entry(SIZE * 2),
    },
  };
}
