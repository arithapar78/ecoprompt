// Draws the monochrome tray icon (black bolt on transparent) as a PNG.
// macOS treats it as a template image (icon_as_template) and recolors it for
// light/dark menu bars. Usage: node scripts/make-tray-icon.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const N = 44, SS = 4; // 44px (22pt @2x), 4x4 supersampling
const poly = [[26,2],[10,25],[20,25],[16,42],[34,17],[24,17],[30,2]].map(([x,y]) => [x, y]);
const inside = (x, y) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    let hit = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++)
      if (inside(x + (sx + .5) / SS, y + (sy + .5) / SS)) hit++;
    const o = y * (N * 4 + 1) + 1 + x * 4;
    raw[o] = raw[o + 1] = raw[o + 2] = 0;
    raw[o + 3] = Math.round((hit / (SS * SS)) * 255);
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(new URL('../src-tauri/icons/tray/tray-template.png', import.meta.url),
  Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote tray-template.png');
