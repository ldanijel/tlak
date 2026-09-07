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

export interface Glyph { x0: number; x1: number; y0: number; y1: number; bits: Uint8Array; segs: string }

/** Prosječan položaj znamenki u zoni (udjeli širine/visine zone) – za otkrivanje pomaknutog okvira i ikona. */
export interface BandPosition { n: number; xStart: number; xEnd: number; yCenter: number; height: number; digits: number }

export interface OcrModelData {
  samples: Record<string, string[]>; // znamenka → base64 bitmape
  variantWins: Record<string, number>;
  photos: number;
  layout: { rect: { x: number; y: number; w: number; h: number }; dividers: [number, number] } | null;
  positions?: Record<string, BandPosition>; // ključ: indeks zone (0 SYS, 1 DIA, 2 puls)
}

export const emptyModel = (): OcrModelData => ({ samples: {}, variantWins: {}, photos: 0, layout: null, positions: {} });

export interface BandDims { w: number; h: number }

/**
 * Znamenke na LCD-u poravnate su udesno, a ikone (ruka, srce) stoje lijevo od njih.
 * Vraća do `max` najdesnijih glifova usklađene visine (≥ 72 % prosječne visine dvaju najdesnijih).
 */
export function rightmostDigits(glyphs: Glyph[], max = 3): Glyph[] {
  if (glyphs.length <= 1) return glyphs;
  const sorted = glyphs.slice().sort((a, b) => a.x0 - b.x0);
  const right = sorted.slice(-2);
  const refH = (right[0].y1 - right[0].y0 + right[1].y1 - right[1].y0) / 2;
  const out: Glyph[] = [];
  for (let i = sorted.length - 1; i >= 0 && out.length < max; i--) {
    const g = sorted[i];
    const h = g.y1 - g.y0;
    if (h < refH * 0.72 || h > refH * 1.25) break; // uska „1” može biti nešto niža (bez gornjeg/donjeg segmenta)
    // razmak veći od ~1,5 širine znamenke znači da lijevo više nisu znamenke istog broja
    if (out.length && out[0].x0 - g.x1 > (g.x1 - g.x0 + 1) * 2.5 && out[0].x0 - g.x1 > refH * 0.9) break;
    out.unshift(g);
  }
  return out;
}

/** Ažurira prosječan položaj znamenki u zoni (tekući prosjek). */
export function updatePosition(m: OcrModelData, band: number, glyphs: Glyph[], dims: BandDims): OcrModelData {
  if (!glyphs.length || !dims.w || !dims.h) return m;
  const xStart = Math.min(...glyphs.map((g) => g.x0)) / dims.w;
  const xEnd = Math.max(...glyphs.map((g) => g.x1)) / dims.w;
  const yCenter = glyphs.reduce((a, g) => a + (g.y0 + g.y1) / 2, 0) / glyphs.length / dims.h;
  const height = glyphs.reduce((a, g) => a + (g.y1 - g.y0), 0) / glyphs.length / dims.h;
  const prev = m.positions?.[band];
  const n = (prev?.n || 0) + 1;
  const avg = (a: number | undefined, b: number) => (a === undefined ? b : a + (b - a) / n);
  const pos: BandPosition = { n, xStart: avg(prev?.xStart, xStart), xEnd: avg(prev?.xEnd, xEnd), yCenter: avg(prev?.yCenter, yCenter), height: avg(prev?.height, height), digits: avg(prev?.digits, glyphs.length) };
  return { ...m, positions: { ...(m.positions || {}), [band]: pos } };
}

/** Upozorenje ako se položaj znamenki bitno razlikuje od naučenog (pomaknut ili preuzak okvir). */
export function checkAlignment(m: OcrModelData, band: number, glyphs: Glyph[], dims: BandDims): string | null {
  const pos = m.positions?.[band];
  if (!pos || pos.n < 2 || !dims.w || !dims.h) return null;
  const name = ['SYS', 'DIA', 'puls'][band] || `zona ${band + 1}`;
  if (!glyphs.length) return `Zona ${name}: nisu pronađene znamenke; okvir ili horizontale vjerojatno nisu na zaslonu.`;
  const yCenter = glyphs.reduce((a, g) => a + (g.y0 + g.y1) / 2, 0) / glyphs.length / dims.h;
  const height = glyphs.reduce((a, g) => a + (g.y1 - g.y0), 0) / glyphs.length / dims.h;
  const xEnd = Math.max(...glyphs.map((g) => g.x1)) / dims.w;
  if (Math.abs(height - pos.height) > pos.height * 0.35) return `Zona ${name}: znamenke su znatno ${height > pos.height ? 'veće' : 'manje'} nego pri prošlim čitanjima – provjerite okvir i horizontale.`;
  if (Math.abs(yCenter - pos.yCenter) > 0.22) return `Zona ${name}: znamenke su pomaknute ${yCenter > pos.yCenter ? 'prema dolje' : 'prema gore'} u odnosu na prošla čitanja – pomaknite horizontalu.`;
  if (Math.abs(xEnd - pos.xEnd) > 0.25) return `Zona ${name}: znamenke su vodoravno pomaknute u odnosu na prošla čitanja – provjerite lijevi i desni rub okvira.`;
  return null;
}

/** Segmentacija znamenki iz binarne slike (1 = tinta). Projekcija po stupcima, zatim okvir po redovima. */
export function segmentDigits(inkIn: Uint8Array, w: number, h: number): Glyph[] {
  // Rubovi zaslona, sjene i crte preko cijele širine/visine nisu znamenke: retke s tintom u > 60 %
  // širine i stupce s tintom u > 92 % visine brišemo, inače bi spojili sve znamenke u jedan glif.
  const ink = new Uint8Array(inkIn);
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) n += ink[y * w + x];
    if (n > w * 0.6) ink.fill(0, y * w, (y + 1) * w);
  }
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y++) n += ink[y * w + x];
    if (n > h * 0.92) for (let y = 0; y < h; y++) ink[y * w + x] = 0;
  }
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
  // visina glifa: najdulji neprekinuti niz redaka s dovoljno tinte unutar stupaca glifa
  // (rijetki ostaci ruba pri vrhu/dnu zone ne rastežu okvir)
  const rowExtent = (x0: number, x1: number) => {
    const gw = x1 - x0 + 1;
    const rowInk = new Uint16Array(h);
    for (let y = 0; y < h; y++) for (let x = x0; x <= x1; x++) rowInk[y] += ink[y * w + x];
    const minRow = Math.max(1, gw * 0.08);
    let best: [number, number] | null = null, start = -1;
    for (let y = 0; y <= h; y++) {
      const on = y < h && rowInk[y] >= minRow;
      if (on && start < 0) start = y;
      if (!on && start >= 0) {
        // dopusti kratke praznine (između segmenata) do 12 % visine zone
        if (best && start - best[1] - 1 <= h * 0.12) best = [best[0], y - 1];
        else if (!best || y - 1 - start > best[1] - best[0]) best = [start, y - 1];
        start = -1;
      }
    }
    return best;
  };
  let boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
  for (const [x0, x1] of merged) {
    const e = rowExtent(x0, x1);
    if (e) boxes.push({ x0, x1, y0: e[0], y1: e[1] });
  }
  // kose znamenke koje se u projekciji dodiruju (npr. „1” uz „2”): preširok glif dijeli se na
  // stupcu s najmanje tinte u središnjem dijelu, ako je ondje projekcija gotovo prazna
  const split: typeof boxes = [];
  for (const b of boxes) {
    const gw = b.x1 - b.x0 + 1, gh = b.y1 - b.y0 + 1;
    if (gw / gh > 0.72 && gw > 8) {
      let bestX = -1, bestV = Infinity, maxV = 0;
      const prof = new Uint16Array(gw);
      for (let x = b.x0; x <= b.x1; x++) { let n = 0; for (let y = b.y0; y <= b.y1; y++) n += ink[y * w + x]; prof[x - b.x0] = n; if (n > maxV) maxV = n; }
      for (let x = Math.round(gw * 0.15); x <= Math.round(gw * 0.85); x++) if (prof[x] < bestV) { bestV = prof[x]; bestX = x; }
      if (bestX > 0 && bestV <= maxV * 0.25) {
        const l = rowExtent(b.x0, b.x0 + bestX - 1), r = rowExtent(b.x0 + bestX + 1, b.x1);
        if (l) split.push({ x0: b.x0, x1: b.x0 + bestX - 1, y0: l[0], y1: l[1] });
        if (r) split.push({ x0: b.x0 + bestX + 1, x1: b.x1, y0: r[0], y1: r[1] });
        continue;
      }
    }
    split.push(b);
  }
  boxes = split;
  // kose znamenke koje se preklapaju u projekciji („1” uz „2”): znamenke u istom redu jednake su
  // širine, pa se preširok glif reže zdesna na referentnu širinu ostalih znamenki
  const normal = boxes.filter((b) => { const a = (b.x1 - b.x0 + 1) / (b.y1 - b.y0 + 1); return a >= 0.42 && a <= 0.72; }).map((b) => b.x1 - b.x0 + 1).sort((a, b) => a - b);
  if (normal.length) {
    const refW = normal[normal.length >> 1];
    const cut: typeof boxes = [];
    for (const b of boxes) {
      const gw = b.x1 - b.x0 + 1;
      if (gw > refW * 1.15 && gw < refW * 2.6) {
        const gap = Math.round(refW * 0.08);
        const rx0 = b.x1 - refW + 1, lx1 = rx0 - 1 - gap;
        const r = rowExtent(rx0, b.x1), l = lx1 - b.x0 + 1 >= refW * 0.12 ? rowExtent(b.x0, lx1) : null;
        if (r) cut.push({ x0: rx0, x1: b.x1, y0: r[0], y1: r[1] });
        if (l) cut.push({ x0: b.x0, x1: lx1, y0: l[0], y1: l[1] });
        if (r || l) continue;
      }
      cut.push(b);
    }
    boxes = cut.sort((a, b) => a.x0 - b.x0);
  }
  const maxH = Math.max(0, ...boxes.map((b) => b.y1 - b.y0 + 1));
  return boxes
    .filter((b) => b.y1 - b.y0 + 1 >= maxH * 0.5 && b.x1 - b.x0 + 1 >= 2)
    .map((b) => ({ ...b, bits: normalize(ink, w, b), segs: segmentsOf(ink, w, b) }));
}

/**
 * Koji su segmenti sedmerosegmentne znamenke uključeni, iz stvarnog okvira znamenke:
 * vodoravni (a, g, d) iz udjela tinte u srednjim stupcima gornjeg/srednjeg/donjeg pojasa,
 * okomiti (f, b, e, c) iz lijevog/desnog dijela gornje i donje polovice. Podnosi kosi font.
 */
export function segmentsOf(ink: Uint8Array, w: number, b: { x0: number; x1: number; y0: number; y1: number }): string {
  const gw = b.x1 - b.x0 + 1, gh = b.y1 - b.y0 + 1;
  const frac = (fx0: number, fx1: number, fy0: number, fy1: number) => {
    const x0 = b.x0 + Math.round(gw * fx0), x1 = b.x0 + Math.round(gw * fx1) - 1;
    const y0 = b.y0 + Math.round(gh * fy0), y1 = b.y0 + Math.round(gh * fy1) - 1;
    let n = 0, on = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { n++; if (ink[y * w + x]) on++; }
    return n ? on / n : 0;
  };
  if (gw / gh < 0.35) return frac(0, 1, 0.1, 0.9) > 0.3 ? 'bc' : '';
  // vodoravni: gusta tinta po sredini pojasa; okomiti: u gornjoj/donjoj polovici, lijevo/desno
  // kosi font: gornji vodoravni segment pomaknut je udesno, donji ulijevo
  const f = {
    a: frac(0.35, 0.9, 0, 0.16), g: frac(0.25, 0.8, 0.42, 0.58), d: frac(0.1, 0.65, 0.84, 1),
    f: frac(0, 0.32, 0.17, 0.42), b: frac(0.68, 1, 0.17, 0.42), e: frac(0, 0.32, 0.58, 0.83), c: frac(0.62, 0.95, 0.58, 0.83),
  };
  return (['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const).filter((k) => f[k] > 0.3).join('');
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

export interface BandClassification { value: number | null; confidence: number; digits: DigitGuess[]; used: Glyph[] }

/**
 * Klasifikacija zone: uzimaju se najdesniji glifovi usklađene visine (ikone lijevo se odbacuju);
 * isprobava se 3 i 2 znamenke, a treća (lijeva) prihvaća se samo ako i sama pouzdano sliči znamenki.
 */
export function classifyBand(glyphs: Glyph[], m: OcrModelData, [lo, hi]: readonly [number, number]): BandClassification {
  const none: BandClassification = { value: null, confidence: 0, digits: [], used: [] };
  if (!modelReady(m)) return none;
  const cand = rightmostDigits(glyphs, 3);
  if (cand.length < 2) return none;
  const guessOf = (set: Glyph[]): BandClassification => {
    const digits = set.map((g) => classifyGlyph(g.bits, m));
    if (digits.some((d) => !d)) return none;
    const ds = digits as DigitGuess[];
    const value = Number(ds.map((d) => d.digit).join(''));
    const confidence = Math.min(...ds.map((d) => d.confidence));
    return { value: value >= lo && value <= hi ? value : null, confidence, digits: ds, used: set };
  };
  const three = cand.length === 3 ? guessOf(cand) : none;
  const two = guessOf(cand.slice(-2));
  if (three.value !== null) {
    const g = cand[0];
    const narrow = (g.x1 - g.x0 + 1) / (g.y1 - g.y0 + 1) < 0.35; // uski glif = gotovo sigurno znamenka „1”
    if (three.digits[0].confidence >= 70 || narrow) return three;
  }
  if (two.value !== null) return two;
  return three.value !== null ? three : two;
}

/**
 * Dodaje potvrđene znamenke u model. Uzima najdesnije glifove usklađene visine, koliko ima znamenki
 * (ikone lijevo od broja se preskaču). Ako ih je premalo, ne uči. Uz dimenzije zone pamti i položaj.
 */
export function learn(m: OcrModelData, glyphs: Glyph[], value: string, dims?: BandDims, band?: number): OcrModelData {
  const digits = rightmostDigits(glyphs, value.length);
  if (digits.length !== value.length) return m;
  const samples = { ...m.samples };
  digits.forEach((g, i) => {
    const d = value[i];
    const list = [...(samples[d] || []), bitsToBase64(g.bits)];
    samples[d] = list.slice(-MAX_PER_DIGIT);
  });
  let out: OcrModelData = { ...m, samples };
  if (dims && band !== undefined) out = updatePosition(out, band, digits, dims);
  return out;
}

/** Tinta iz sive slike (0 = crno): 1 gdje je piksel tamniji od praga. */
export function inkFromGray(gray: Uint8ClampedArray, threshold: number): Uint8Array {
  const ink = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) ink[i] = gray[i] < threshold ? 1 : 0;
  return ink;
}

/**
 * Dekoder sedmerosegmentne znamenke iz normalizirane bitmape (GW×GH, poravnano udesno), bez učenja.
 * Segmenti: a gore, b gore-desno, c dolje-desno, d dolje, e dolje-lijevo, f gore-lijevo, g sredina.
 * Uzorkuje se udio tinte u području svakog segmenta (šira područja podnose kosi „italic” font).
 */
const SEG_PATTERNS: Record<string, string> = {
  abcdef: '0', bc: '1', abdeg: '2', abcdg: '3', bcfg: '4', acdfg: '5', acdefg: '6', abc: '7', abcdefg: '8', abcdfg: '9', abcf: '7',
};
export function decodeSevenSegment(g: Glyph): { digit: string | null; margin: number } {
  const digit = SEG_PATTERNS[g.segs] ?? null;
  return { digit, margin: digit ? 0.15 : 0 };
}

/** Čitanje zone dekoderom segmenata (bez učenja); pouzdanost iz razmaka do praga uključenosti segmenata. */
export function decodeBandSevenSegment(glyphs: Glyph[], [lo, hi]: readonly [number, number]): { value: number | null; confidence: number; digits: (string | null)[] } {
  const cand = rightmostDigits(glyphs, 3);
  if (cand.length < 2) return { value: null, confidence: 0, digits: [] };
  const dec = cand.map((g) => decodeSevenSegment(g));
  const tryLen = (n: number) => {
    const part = dec.slice(-n);
    if (part.some((d) => d.digit === null)) return null;
    const value = Number(part.map((d) => d.digit).join(''));
    if (value < lo || value > hi) return null;
    const confidence = 80;
    return { value, confidence, digits: part.map((d) => d.digit) };
  };
  return tryLen(cand.length) || (cand.length === 3 ? tryLen(2) : null) || { value: null, confidence: 0, digits: dec.map((d) => d.digit) };
}
