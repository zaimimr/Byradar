import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const SS = 4;
const BG = [7, 9, 12, 255];
const BARS = ['#ec700c', '#0b91ef', '#e60000', '#354f7f'];
const HEIGHTS = [0.5, 0.82, 0.66, 1];

function rgba(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4;
      raw.set(pixels.slice(at, at + 4), row + 1 + x * 4);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function sampleAt(x, y, size, inset, radius) {
  const plate = size - inset * 2;
  const px = x - inset;
  const py = y - inset;
  if (px < 0 || py < 0 || px >= plate || py >= plate) return null;

  if (radius > 0) {
    const cx = Math.min(Math.max(px, radius), plate - radius);
    const cy = Math.min(Math.max(py, radius), plate - radius);
    if (Math.hypot(px - cx, py - cy) > radius) return null;
  }

  const pad = plate * 0.2;
  const field = plate - pad * 2;
  const slot = field / (BARS.length * 2 - 1);
  const barIdx = Math.floor((px - pad) / (slot * 2));
  const withinBar = px >= pad && px <= plate - pad && barIdx >= 0 && barIdx < BARS.length
    ? px - pad - barIdx * slot * 2 <= slot
    : false;
  if (withinBar) {
    const height = field * HEIGHTS[barIdx];
    const top = plate - pad - height;
    if (py >= top && py <= plate - pad) return rgba(BARS[barIdx]);
  }
  return BG;
}

function render(size, { inset, rounded }) {
  const hi = size * SS;
  const insetPx = inset * hi;
  const radius = rounded ? (hi - insetPx * 2) * 0.22 : 0;
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const hit = sampleAt(x * SS + sx + 0.5, y * SS + sy + 0.5, hi, insetPx, radius);
          if (!hit) continue;
          r += hit[0];
          g += hit[1];
          b += hit[2];
          a += hit[3];
        }
      }
      const samples = SS * SS;
      const at = (y * size + x) * 4;
      if (a === 0) continue;
      pixels[at] = Math.round(r / (a / 255));
      pixels[at + 1] = Math.round(g / (a / 255));
      pixels[at + 2] = Math.round(b / (a / 255));
      pixels[at + 3] = Math.round(a / samples);
    }
  }
  return encodePng(size, pixels);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

function renderSvg() {
  const plate = 64;
  const pad = plate * 0.2;
  const field = plate - pad * 2;
  const slot = field / (BARS.length * 2 - 1);
  const bars = BARS.map((color, i) => {
    const height = field * HEIGHTS[i];
    const x = (pad + i * slot * 2).toFixed(2);
    const y = (plate - pad - height).toFixed(2);
    return `  <rect x="${x}" y="${y}" width="${slot.toFixed(2)}" height="${height.toFixed(2)}" rx="${(slot * 0.22).toFixed(2)}" fill="${color}" />`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${plate} ${plate}">`,
    `  <rect width="${plate}" height="${plate}" rx="${(plate * 0.18).toFixed(2)}" fill="#07090c" />`,
    ...bars,
    '</svg>',
    '',
  ].join('\n');
}

const targets = [
  ['icon-192.png', 192, { inset: 0.04, rounded: true }],
  ['icon-512.png', 512, { inset: 0.04, rounded: true }],
  ['icon-maskable-512.png', 512, { inset: 0, rounded: false }],
  ['apple-touch-icon.png', 180, { inset: 0, rounded: false }],
];

for (const [name, size, opts] of targets) {
  writeFileSync(resolve(PUBLIC_DIR, name), render(size, opts));
  console.log(`wrote ${name} (${size}px)`);
}

const ICO_SIZES = [16, 32, 48];
const ico = encodeIco(ICO_SIZES.map((size) => ({ size, png: render(size, { inset: 0, rounded: false }) })));
writeFileSync(resolve(PUBLIC_DIR, 'favicon.ico'), ico);
console.log(`wrote favicon.ico (${ICO_SIZES.join(', ')}px)`);

writeFileSync(resolve(PUBLIC_DIR, 'favicon.svg'), renderSvg());
console.log('wrote favicon.svg');
