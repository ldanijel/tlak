// Ocjena OCR-a na stvarnim fotografijama tlakomjera (Node, bez preglednika).
// Upotreba: node --experimental-strip-types client/scripts/ocr-eval.mjs <mapa>
// Mapa sadrži JPEG/PNG datoteke nazvane SYS-DIA-PULS.jpg (istina) i layout.json:
//   { "default": { "rect": [x, y, w, h], "dividers": [d1, d2] }, "126-87-64.jpg": { ... } }   (udjeli 0–1)
// Ispisuje očitanje Tesseracta po zoni, očitanje naučenog modela (leave-one-out) i točnost.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync, deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { preprocessGray, scaleGray } from '../src/ocr/preprocess.ts';
import { segmentDigits, inkFromGray, learn, classifyBand, emptyModel, rightmostDigits } from '../src/ocr/learn.ts';
import { parseBand } from '../src/ocr/parse.ts';

const require = createRequire(import.meta.url);
const jpeg = require('jpeg-js');
const { createWorker, OEM, PSM } = require('tesseract.js');
const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(process.argv[2] || join(here, '..', 'test', 'fixtures', 'real'));
const langPath = join(here, '..', 'public', 'tessdata');
const RANGES = [[50, 260], [30, 160], [25, 220]];
const NAMES = ['SYS', 'DIA', 'puls'];

function decode(path) {
  const buf = readFileSync(path);
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    const gray = new Uint8ClampedArray(img.width * img.height);
    for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (img.data[i] * 299 + img.data[i + 1] * 587 + img.data[i + 2] * 114) / 1000;
    return { w: img.width, h: img.height, gray, orientation: exifOrientation(buf) };
  }
  // PNG (8-bit siva ili RGB/RGBA, bez interlacea)
  let pos = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (pos < buf.length) { const len = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos + 4, pos + 8); const body = buf.subarray(pos + 8, pos + 8 + len); if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); ct = body[9]; } if (type === 'IDAT') idat.push(body); pos += 12 + len; }
  const bpp = ct === 0 ? 1 : ct === 2 ? 3 : ct === 6 ? 4 : ct === 4 ? 2 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp + 1; const out = Buffer.alloc(w * h * bpp); let prev = Buffer.alloc(w * bpp);
  for (let y = 0; y < h; y++) { // unfilter
    const f = raw[y * stride]; const line = Buffer.from(raw.subarray(y * stride + 1, (y + 1) * stride));
    for (let i = 0; i < line.length; i++) { const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0; let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255; }
    line.copy(out, y * w * bpp); prev = line;
  }
  const gray = new Uint8ClampedArray(w * h);
  for (let j = 0; j < gray.length; j++) gray[j] = bpp >= 3 ? (out[j * bpp] * 299 + out[j * bpp + 1] * 587 + out[j * bpp + 2] * 114) / 1000 : out[j * bpp];
  return { w, h, gray, orientation: 1 };
}

function exifOrientation(buf) {
  try {
    let off = 2;
    while (off + 4 < buf.length) {
      const marker = buf.readUInt16BE(off), len = buf.readUInt16BE(off + 2);
      if (marker === 0xffe1 && buf.readUInt32BE(off + 4) === 0x45786966) {
        const t = off + 10; const le = buf.readUInt16BE(t) === 0x4949;
        const u16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p)), u32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
        const dir = t + u32(t + 4); const n = u16(dir);
        for (let i = 0; i < n; i++) { const e = dir + 2 + i * 12; if (u16(e) === 0x0112) return u16(e + 8); }
        return 1;
      }
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + len;
    }
  } catch { /* ignore */ }
  return 1;
}

function rotate(img) { // primjena EXIF orijentacije (1, 3, 6, 8)
  const { w, h, gray, orientation } = img;
  if (orientation === 6 || orientation === 8) {
    const out = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const nx = orientation === 6 ? h - 1 - y : y, ny = orientation === 6 ? x : w - 1 - x;
      out[ny * h + nx] = gray[y * w + x];
    }
    return { w: h, h: w, gray: out };
  }
  if (orientation === 3) { const out = new Uint8ClampedArray(w * h); for (let i = 0; i < gray.length; i++) out[gray.length - 1 - i] = gray[i]; return { w, h, gray: out }; }
  return { w, h, gray };
}

function crop(img, rect) {
  const x0 = Math.round(rect[0] * img.w), y0 = Math.round(rect[1] * img.h), cw = Math.round(rect[2] * img.w), ch = Math.round(rect[3] * img.h);
  const out = new Uint8ClampedArray(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = img.gray[(y0 + y) * img.w + x0 + x];
  return { w: cw, h: ch, gray: out };
}

function sliceBand(img, from, to) {
  const y0 = Math.round(img.h * from), y1 = Math.round(img.h * to), pad = Math.round(img.w * 0.06);
  const w = img.w + 2 * pad, h = y1 - y0 + 2 * pad; const out = new Uint8ClampedArray(w * h).fill(255);
  for (let y = y0; y < y1; y++) for (let x = 0; x < img.w; x++) out[(y - y0 + pad) * w + x + pad] = img.gray[y * img.w + x];
  return { w, h, gray: out };
}

function toPng(img) {
  const raw = Buffer.alloc((img.w + 1) * img.h);
  for (let y = 0; y < img.h; y++) { raw[y * (img.w + 1)] = 0; Buffer.from(img.gray.buffer, img.gray.byteOffset + y * img.w, img.w).copy(raw, y * (img.w + 1) + 1); }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t), d]))); return Buffer.concat([len, Buffer.from(t), d, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b) { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }

const scaleTo = (img, th) => { const f = Math.max(1, th / img.h); const tw = Math.round(img.w * f); return { w: tw, h: Math.round(img.h * f), gray: scaleGray(img.gray, img.w, img.h, tw, Math.round(img.h * f)) }; };
const variantsOf = (band) => {
  const bin = (() => { const s = scaleTo(band, 320); const r = preprocessGray(s.gray, s.w, s.h, { threshold: true }); return { w: s.w, h: s.h, gray: r.gray }; })();
  const gray320 = (() => { const s = scaleTo(band, 320); const r = preprocessGray(s.gray, s.w, s.h, { threshold: false }); return { w: s.w, h: s.h, gray: r.gray }; })();
  return { list: [['raw', band], ['gray320', gray320], ['bin320', bin]], bin };
};

const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)) : [];
if (!files.length) { console.error(`Nema fotografija u ${dir}. Dodajte JPEG/PNG datoteke nazvane SYS-DIA-PULS.jpg i layout.json.`); process.exit(1); }
const layouts = existsSync(join(dir, 'layout.json')) ? JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8')) : {};
const cache = join(here, '..', '..', 'node_modules', '.cache', 'tessdata');
const workers = [];
workers.push(['letsgodigital', await createWorker('letsgodigital', OEM.TESSERACT_ONLY, { langPath, gzip: true, cachePath: cache, legacyCore: true, legacyLang: true })]);
workers.push(['eng', await createWorker('eng', OEM.LSTM_ONLY, { langPath, gzip: true, cachePath: cache, legacyCore: true })]);
for (const [, w] of workers) await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: PSM.SINGLE_LINE });
const tokensOf = (data) => { const out = []; for (const b of data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) for (const wd of l.words) if (wd.text.trim()) out.push({ text: wd.text.trim(), conf: wd.confidence, ...wd.bbox }); return out; };

const photos = [];
for (const f of files) {
  const truth = f.replace(/\.[^.]+$/, '').split('-').map(Number);
  const lay = layouts[f] || layouts.default;
  if (!lay || truth.length !== 3 || truth.some(Number.isNaN)) { console.log(`preskačem ${f} (nema layouta ili ime nije SYS-DIA-PULS)`); continue; }
  const img = rotate(decode(join(dir, f)));
  const display = crop(img, lay.rect);
  const bounds = [[0, lay.dividers[0]], [lay.dividers[0], lay.dividers[1]], [lay.dividers[1], 1]];
  const bands = bounds.map(([a, b]) => sliceBand(display, a, b));
  const tess = []; const glyphs = []; const dims = [];
  for (let i = 0; i < 3; i++) {
    const { list, bin } = variantsOf(bands[i]);
    const g = segmentDigits(inkFromGray(bin.gray, 128), bin.w, bin.h);
    glyphs.push(g); dims.push({ w: bin.w, h: bin.h });
    let best = { value: null, confidence: 0 }, via = '';
    for (const [name, w] of workers) for (const [vn, v] of list) {
      const r = await w.recognize(toPng(v), {}, { blocks: true, text: true });
      const pg = parseBand(tokensOf(r.data), RANGES[i]);
      if ((pg.value === null ? -1 : pg.confidence) > (best.value === null ? -1 : best.confidence)) { best = pg; via = `${name}/${vn}`; }
    }
    tess.push({ ...best, via });
  }
  photos.push({ f, truth, tess, glyphs, dims });
  console.log(`${f}: Tesseract ${tess.map((t, i) => `${NAMES[i]} ${t.value ?? '–'} (${t.confidence}%, ${t.via})`).join(' | ')}; glifovi po zoni: ${glyphs.map((g) => `${g.length}→${rightmostDigits(g, 3).length}`).join('/')}`);
}
for (const [, w] of workers) await w.terminate();

// Naučeni model: leave-one-out (uči iz svih ostalih fotografija, čita ovu)
let okT = 0, okM = 0, okC = 0, n = 0;
for (const p of photos) {
  let m = emptyModel();
  for (const q of photos) if (q !== p) q.truth.forEach((v, i) => { m = learn(m, q.glyphs[i], String(v), q.dims[i], i); });
  const res = p.truth.map((v, i) => {
    const t = p.tess[i], c = classifyBand(p.glyphs[i], m, RANGES[i]);
    let comb = t.value;
    if (c.value !== null && c.confidence >= 70) comb = c.value; else if (c.value !== null && t.value === null) comb = c.value;
    n++; if (t.value === v) okT++; if (c.value === v) okM++; if (comb === v) okC++;
    return `${NAMES[i]} istina ${v}: T ${t.value ?? '–'} ${t.value === v ? '✓' : '✗'} · model ${c.value ?? '–'} (${c.confidence}%) ${c.value === v ? '✓' : '✗'}`;
  });
  console.log(`${p.f}: ${res.join(' | ')}`);
}
console.log(`\nTočnost po polju (n=${n}): Tesseract ${okT}/${n}, naučeni model (leave-one-out) ${okM}/${n}, kombinirano ${okC}/${n}`);
