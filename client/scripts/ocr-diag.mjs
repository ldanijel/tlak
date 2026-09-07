// Analiza dijagnostičke datoteke iz aplikacije („Preuzmi dijagnostiku OCR-a”) u Nodeu.
// Upotreba: node --experimental-strip-types client/scripts/ocr-diag.mjs <dijagnostika.json> [SYS DIA PULS]
// Pokreće isti cjevovod kao aplikacija na umanjenom izrezu zaslona iz datoteke i ispisuje što svaka faza vidi.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { preprocessGray, scaleGray, trimBezel, medianGray } from '../src/ocr/preprocess.ts';
import { segmentDigits, inkFromGray, rightmostDigits, decodeBandSevenSegment, decodeSevenSegment, GW, GH } from '../src/ocr/learn.ts';
import { parseBand } from '../src/ocr/parse.ts';

const require = createRequire(import.meta.url);
const jpeg = require('jpeg-js');
const { createWorker, OEM, PSM } = require('tesseract.js');
const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];
const truth = process.argv.slice(3, 6).map(Number);
const d = JSON.parse(readFileSync(file, 'utf8'));
const outDir = join(dirname(file), basename(file).replace(/\.json$/, '') + '-out');
mkdirSync(outDir, { recursive: true });

const img = jpeg.decode(Buffer.from(d.images.display.split(',')[1], 'base64'), { useTArray: true, formatAsRGBA: true });
let gray = new Uint8ClampedArray(img.width * img.height);
for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (img.data[i] * 299 + img.data[i + 1] * 587 + img.data[i + 2] * 114) / 1000;
let W = img.width, H = img.height;
const t = trimBezel(gray, W, H);
console.log(`izrez ${W}×${H}, medijan ${medianGray(gray)}, odrezan rub → x ${t.x0}–${t.x1}, y ${t.y0}–${t.y1}`);
{
  const w = t.x1 - t.x0 + 1, h = t.y1 - t.y0 + 1;
  if (w >= W * 0.5 && h >= H * 0.5) {
    const g = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = gray[(t.y0 + y) * W + t.x0 + x];
    gray = g; W = w; H = h;
  }
}
const toPng = (g, w, h) => {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; Buffer.from(g.buffer, g.byteOffset + y * w, w).copy(raw, y * (w + 1) + 1); }
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc32 = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (ty, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(ty), body]))); return Buffer.concat([len, Buffer.from(ty), body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
writeFileSync(join(outDir, 'display-trimmed.png'), toPng(gray, W, H));

// privlačenje horizontala na prazne retke (isto kao u aplikaciji)
const snap = (() => {
  const f = Math.max(1, 480 / H); const sw = Math.round(W * f), sh = Math.round(H * f);
  const pre = preprocessGray(scaleGray(gray, W, H, sw, sh), sw, sh, { adaptive: true }).gray;
  const xs = Math.round(sw * 0.3);
  const rowInk = new Float32Array(sh);
  for (let y = 0; y < sh; y++) { let n = 0; for (let x = xs; x < sw; x++) if (pre[y * sw + x] < 128) n++; rowInk[y] = n / (sw - xs); }
  let base = 1, peak = 0; for (let y = Math.round(sh * 0.05); y < sh * 0.95; y++) { if (rowInk[y] < base) base = rowInk[y]; if (rowInk[y] > peak) peak = rowInk[y]; }
  const empty = (y) => rowInk[y] <= base + 0.15 * (peak - base);
  const out = [...d.layout.dividers];
  for (let i = 0; i < 2; i++) {
    const y = Math.round(out[i] * sh); if (empty(y)) continue;
    const lim = Math.round(sh * 0.15); let best = -1;
    for (let dd = 1; dd <= lim && best < 0; dd++) for (const c of [y - dd, y + dd]) if (c > 0 && c < sh - 1 && empty(c)) { best = c; break; }
    if (best < 0) continue;
    let a = best, b = best; while (a > 0 && empty(a - 1)) a--; while (b < sh - 1 && empty(b + 1)) b++;
    const strict = base + 0.06 * (peak - base); let sa = -1, sb = -1, minY = a;
    for (let y = a; y <= b; y++) { if (rowInk[y] < rowInk[minY]) minY = y; if (rowInk[y] <= strict) { if (sa < 0) sa = y; sb = y; } }
    out[i] = (sa >= 0 ? (sa + sb) / 2 : minY) / sh;
  }
  let prof = ''; for (let y = Math.round(sh * 0.28); y < Math.round(sh * 0.42); y += 2) prof += (rowInk[y] * 100).toFixed(0) + ' '; console.log('profil redaka 28–42 % (% tinte desno):', prof);
  return out[1] - out[0] < 0.1 ? d.layout.dividers : out;
})();
console.log('horizontale', d.layout.dividers.map((x) => x.toFixed(3)).join('/'), '→', snap.map((x) => x.toFixed(3)).join('/'));
const [d1, d2] = snap;
const bounds = [[0, d1], [d1, d2], [d2, 1]];
const NAMES = ['SYS', 'DIA', 'puls'];
const RANGES = [[50, 260], [30, 160], [25, 220]];
const cache = join(here, '..', '..', 'node_modules', '.cache', 'tessdata');
const langPath = join(here, '..', 'public', 'tessdata');
const workers = [
  ['letsgodigital', await createWorker('letsgodigital', OEM.TESSERACT_ONLY, { langPath, gzip: true, cachePath: cache, legacyCore: true, legacyLang: true })],
  ['eng', await createWorker('eng', OEM.LSTM_ONLY, { langPath, gzip: true, cachePath: cache, legacyCore: true })],
];
for (const [, w] of workers) await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: PSM.SINGLE_LINE });
const tokensOf = (data) => { const out = []; for (const b of data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) for (const wd of l.words) if (wd.text.trim()) out.push({ text: wd.text.trim(), conf: wd.confidence, ...wd.bbox }); return out; };

for (let i = 0; i < 3; i++) {
  const y0 = Math.round(H * bounds[i][0]), y1 = Math.round(H * bounds[i][1]);
  const pad = Math.round(W * 0.06);
  const bw = W + 2 * pad, bh = y1 - y0 + 2 * pad;
  const band = new Uint8ClampedArray(bw * bh);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) band[y * bw + x] = gray[clamp(y - pad + y0, y0, y1 - 1) * W + clamp(x - pad, 0, W - 1)]; // podstava ponavljanjem ruba
  const f = Math.max(1, 320 / bh); const sw = Math.round(bw * f), sh = Math.round(bh * f);
  const s320 = scaleGray(band, bw, bh, sw, sh);
  const variants = [
    ['raw', band, bw, bh],
    ['gray320', preprocessGray(s320, sw, sh, {}).gray, sw, sh],
    ['bin320', preprocessGray(s320, sw, sh, { threshold: true }).gray, sw, sh],
    ['adaptive320', preprocessGray(s320, sw, sh, { adaptive: true }).gray, sw, sh],
  ];
  for (const [n, g, w, h] of variants) writeFileSync(join(outDir, `band${i}-${n}.png`), toPng(g, w, h));
  const ad = variants[3];
  const glyphs = segmentDigits(inkFromGray(ad[1], 128), ad[2], ad[3]);
  const kept = rightmostDigits(glyphs, 3);
  console.log(`\n${NAMES[i]} (istina ${truth[i] ?? '?'}): glifovi ${glyphs.length} → zadržano ${kept.length} ${JSON.stringify(kept.map((x) => [x.x0, x.x1, x.y0, x.y1]))}`);
  const seg = decodeBandSevenSegment(glyphs, RANGES[i]);
  console.log(`  7-seg dekoder: ${seg.value ?? '–'} (${seg.confidence}%) znamenke ${JSON.stringify(seg.digits)}`);
  for (const g of kept) console.log(`    glif ${g.x0}-${g.x1} × ${g.y0}-${g.y1} segmenti=${g.segs || '-'} → ${decodeSevenSegment(g).digit ?? '?'}`);
  if (kept.length >= 2) {
    const x0 = Math.min(...kept.map((g) => g.x0)), x1 = Math.max(...kept.map((g) => g.x1)), y0 = Math.min(...kept.map((g) => g.y0)), y1 = Math.max(...kept.map((g) => g.y1));
    const p = Math.round((y1 - y0) * 0.25); const cw = x1 - x0 + 1 + 2 * p, ch = y1 - y0 + 1 + 2 * p;
    const cg = new Uint8ClampedArray(cw * ch).fill(255);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cg[(y - y0 + p) * cw + (x - x0 + p)] = ad[1][y * ad[2] + x];
    variants.push(['digitsOnly', cg, cw, ch]);
    writeFileSync(join(outDir, `band${i}-digitsOnly.png`), toPng(cg, cw, ch));
  }
  for (const [name, wk] of workers) for (const [vn, g, w, h] of variants) {
    const r = await wk.recognize(toPng(g, w, h), {}, { blocks: true, text: true });
    const toks = tokensOf(r.data);
    const pg = parseBand(toks, RANGES[i]);
    console.log(`  ${name}/${vn}: ${pg.value ?? '–'} (${pg.confidence}%${pg.reason ? ', ' + pg.reason : ''})  tokeni: ${toks.map((x) => `${x.text}@${Math.round(x.conf)}`).join(' ') || '-'}`);
  }
}
for (const [, w] of workers) await w.terminate();
console.log(`\nSlike faza spremljene u ${outDir}`);
