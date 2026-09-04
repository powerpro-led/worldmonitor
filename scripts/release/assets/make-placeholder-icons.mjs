#!/usr/bin/env node
/**
 * Generates PLACEHOLDER launcher icons for the worldmonitor-local Desktop
 * launcher: icon.png (1024²), icon.ico, and — on macOS — icon.icns.
 *
 *   node scripts/release/assets/make-placeholder-icons.mjs
 *
 * These are deliberately plain (flat brand-blue rounded square). Replace
 * icon.png with real 1024×1024 artwork and re-run to regenerate the .icns/.ico.
 * No external image libraries — a hand-rolled PNG encoder + a PNG-in-ICO
 * wrapper, plus Apple's `iconutil` for the .icns.
 */

import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import {
  writeFileSync, mkdtempSync, mkdirSync, rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BG = [37, 99, 235]; // #2563eb
const FG = [255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

// A flat rounded square with a bold "W" wordmark block, drawn by hand into an
// RGBA raster. Good enough for a placeholder tab/dock icon.
function raster(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.18; // corner radius
  const inCorner = (x, y) => {
    const cx = x < r ? r : x > size - r ? size - r : x;
    const cy = y < r ? r : y > size - r ? size - r : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
      || (x >= r && x <= size - r) || (y >= r && y <= size - r);
  };
  // "W": four diagonal strokes inside a centered box
  const bx0 = size * 0.22; const bx1 = size * 0.78;
  const by0 = size * 0.30; const by1 = size * 0.70;
  const stroke = size * 0.085;
  const onW = (x, y) => {
    if (y < by0 || y > by1) return false;
    const t = (y - by0) / (by1 - by0);
    const legs = [bx0 + t * (size * 0.13), bx0 + (size * 0.28) - t * (size * 0.13),
      bx1 - (size * 0.28) + t * (size * 0.13), bx1 - t * (size * 0.13)];
    return legs.some((lx) => Math.abs(x - lx) <= stroke / 2);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      if (!inCorner(x, y)) { px[o + 3] = 0; continue; }
      const c = onW(x + 0.5, y + 0.5) ? FG : BG;
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
    }
  }
  return px;
}

function png(size) {
  const raw = raster(size);
  const stride = size * 4;
  const withFilters = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    withFilters[y * (stride + 1)] = 0;
    raw.copy(withFilters, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(withFilters, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Vista-era ICO: a single PNG-compressed 256×256 entry.
function ico(pngBuf) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(1, 2); // type 1 = icon
  dir.writeUInt16LE(1, 4); // count 1
  const entry = Buffer.alloc(16);
  entry[0] = 0; entry[1] = 0; // 0 ⇒ 256
  entry[2] = 0; entry[4] = 1; entry[5] = 0;
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(6 + 16, 12);
  return Buffer.concat([dir, entry, pngBuf]);
}

writeFileSync(path.join(DIR, 'icon.png'), png(1024));
writeFileSync(path.join(DIR, 'icon.ico'), ico(png(256)));
console.log('wrote icon.png (1024²), icon.ico (256² PNG)');

if (process.platform === 'darwin') {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wm-iconset-'));
  const set = path.join(tmp, 'icon.iconset');
  mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(path.join(set, `icon_${s}x${s}.png`), png(s));
    writeFileSync(path.join(set, `icon_${s}x${s}@2x.png`), png(s * 2));
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(DIR, 'icon.icns')]);
  rmSync(tmp, { recursive: true, force: true });
  console.log('wrote icon.icns');
} else {
  console.log('(.icns needs macOS `iconutil` — regenerate there)');
}
