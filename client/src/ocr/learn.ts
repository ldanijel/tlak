/**
 * Učenje OCR-a po tlakomjeru: iz potvrđenih očitanja pamte se bitmape znamenki (predlošci)
 * i pri idućem čitanju znamenke se prepoznaju usporedbom s predlošcima (k-NN, Hammingova udaljenost).
 * Sedmerosegmentni zaslon istog uređaja uvijek ima isti oblik znamenki, pa je ovo vrlo pouzdano
 * nakon nekoliko potvrđenih fotografija. Sve se odvija lokalno; pohranjuju se samo male bitmape.
 */
export const GW = 16;
export const GH = 24;
const READY_TOTAL = 6; // najmanje potvrđenih znamenki ukupno
const READY_PER_DIGIT = 2; // najmanje uzoraka za prepoznatu znamenku
export const MAX_PER_DIGIT = 40;

export interface Glyph { x0: number; x1: number; y0: number; y1: number; bits: Uint8Array }

export interface OcrModelData {
  samples: Record<string, string[]>; // znamenka → base64 bitmape
  variantWins: Record<string, number>;
  photos: number;
  layout: { rect: { x: number; y: number; w: number; h: number }; dividers: [number, number] } | null;
}

export const emptyModel = (): OcrModelData => ({ samples: {}, variantWins: {}, photos: 0, layout: null });

/** Segmentacija znamenki iz binarne slike (1 = tinta). Projekcija po stupcima, zatim okvir po redovima. */
export function segmentDigits(ink: Uint8Array, w: number, h: number): Glyph[] {
  const col = new Uint16Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink[y * w + x]) col[x]++;
  const minInk = Math.max(2, Math.round(h * 0.03));
  const runs: [number, number][] = [];
  let start = -1;
  for (let x = 0; x <= w; x++) {
    const on = x < w && col[x] >= minInk;
    if (on && start < 0) start = x;
    if (!on && start >= 0) { runs.push([start, x - 1]); start = -1; }
  }
  // spajanje vrlo bliskih nizova (segmenti iste znamenke razdvojeni šumom)
  const gapMax = Math.max(1, Math.round(h * 0.05));
  const merged: [number, number][] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] - 1 <= gapMax) last[1] = r[1];
    else merged.push([...r]);
  }
  const boxes = merged.map(([x0, x1]) => {
    let y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = x0; x <= x1; x++) if (ink[y * w + x]) { if (y < y0) y0 = y; if (y > y1) y1 = y; break; }
    return { x0, x1, y0, y1 };
  }).filter((b) => b.y1 >= b.y0);
  const maxH = Math.max(0, ...boxes.map((b) => b.y1 - b.y0 + 1));
  return boxes
    .filter((b) => b.y1 - b.y0 + 1 >= maxH * 0.5 && b.x1 - b.x0 + 1 >= 2)
    .map((b) => ({ ...b, bits: normalize(ink, w, b) }));
}

/** Skalira okvir znamenke u GW×GH bitmapu; visina se rasteže na GH, širina proporcionalno, poravnanje udesno. */
function normalize(ink: Uint8Array, w: number, b: { x0: number; x1: number; y0: number; y1: number }): Uint8Array {
  const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
  const tw = Math.max(1, Math.min(GW, Math.round((bw * GH) / bh)));
  const out = new Uint8Array(GW * GH);
  const offX = GW - tw;
  for (let ty = 0; ty < GH; ty++) {
    const sy0 = b.y0 + (ty * bh) / GH, sy1 = b.y0 + ((ty + 1) * bh) / GH;
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = b.x0 + (tx * bw) / tw, sx1 = b.x0 + ((tx + 1) * bw) / tw;
      let n = 0, on = 0;
      for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) { n++; if (ink[y * w + x]) on++; }
      out[ty * GW + offX + tx] = n && on / n >= 0.5 ? 1 : 0;
    }
  }
  return out;
}

export function bitsToBase64(bits: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) bytes[i >> 3] |= 1 << (i & 7);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function base64ToBits(s: string): Uint8Array {
  const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const bits = new Uint8Array(GW * GH);
  for (let i = 0; i < bits.length; i++) bits[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  return bits;
}

function distance(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d / a.length;
}

export function modelReady(m: OcrModelData): boolean {
  return Object.values(m.samples).reduce((n, l) => n + l.length, 0) >= READY_TOTAL;
}

export function sampleCount(m: OcrModelData): number {
  return Object.values(m.samples).reduce((n, l) => n + l.length, 0);
}

export interface DigitGuess { digit: string; confidence: number }

/** k-NN klasifikacija jedne znamenke. */
export function classifyGlyph(bits: Uint8Array, m: OcrModelData): DigitGuess | null {
  const all: { digit: string; d: number }[] = [];
  for (const [digit, list] of Object.entries(m.samples)) for (const s of list) all.push({ digit, d: distance(bits, base64ToBits(s)) });
  if (!all.length) return null;
  all.sort((a, b) => a.d - b.d);
  // najbliži susjed; ostali služe za ocjenu pouzdanosti (razmak do najbližeg drugog kandidata)
  const digit = all[0].digit;
  if ((m.samples[digit] || []).length < READY_PER_DIGIT) return { digit, confidence: 40 };
  const best = all.find((x) => x.digit === digit)!.d;
  const rival = all.find((x) => x.digit !== digit)?.d ?? 1;
  let conf = Math.round(100 * (1 - best * 2.5));
  if (rival - best < 0.04) conf = Math.min(conf, 55); // dvije znamenke gotovo jednako blizu
  return { digit, confidence: Math.max(0, Math.min(100, conf)) };
}

export function classifyBand(glyphs: Glyph[], m: OcrModelData, [lo, hi]: readonly [number, number]): { value: number | null; confidence: number; digits: DigitGuess[] } {
  if (!modelReady(m) || glyphs.length < 2 || glyphs.length > 3) return { value: null, confidence: 0, digits: [] };
  const digits = glyphs.map((g) => classifyGlyph(g.bits, m));
  if (digits.some((d) => !d)) return { value: null, confidence: 0, digits: [] };
  const ds = digits as DigitGuess[];
  const value = Number(ds.map((d) => d.digit).join(''));
  const confidence = Math.min(...ds.map((d) => d.confidence));
  if (value < lo || value > hi) return { value: null, confidence, digits: ds };
  return { value, confidence, digits: ds };
}

/** Dodaje potvrđene znamenke u model (lijevo → desno). Vraća novi model. */
export function learn(m: OcrModelData, glyphs: Glyph[], value: string): OcrModelData {
  if (glyphs.length !== value.length) return m;
  const samples = { ...m.samples };
  glyphs.forEach((g, i) => {
    const d = value[i];
    const list = [...(samples[d] || []), bitsToBase64(g.bits)];
    samples[d] = list.slice(-MAX_PER_DIGIT);
  });
  return { ...m, samples };
}

/** Tinta iz sive slike (0 = crno): 1 gdje je piksel tamniji od praga. */
export function inkFromGray(gray: Uint8ClampedArray, threshold: number): Uint8Array {
  const ink = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) ink[i] = gray[i] < threshold ? 1 : 0;
  return ink;
}
