/**
 * Lokalna predobrada za OCR: siva skala, rastezanje kontrasta, uklanjanje šuma (median 3×3),
 * inverzija ako je zaslon svijetlih znamenki na tamnoj podlozi, adaptivni prag (Otsu).
 */
/** Prozor zatvaranja kao udio visine zone (mora biti veći od debljine segmenta, manji od promjena osvjetljenja) i udio p98 kontrasta za prag. */
export const ADAPTIVE_WIN_FRAC = Number((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.TLAK_WIN ?? 0.12);
export const ADAPTIVE_T_FRAC = Number((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.TLAK_T ?? 0.45);

export interface PreprocessResult { canvas: HTMLCanvasElement; inverted: boolean; contrast: number }

export function preprocess(src: HTMLCanvasElement, opts: { threshold?: boolean; adaptive?: boolean; targetHeight?: number } = {}): PreprocessResult {
  const targetH = opts.targetHeight ?? 400;
  const scale = Math.max(1, targetH / src.height);
  const w = Math.round(src.width * scale), h = Math.round(src.height * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) gray[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  const r = preprocessGray(gray, w, h, { threshold: opts.threshold, adaptive: opts.adaptive });
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { d[i] = d[i + 1] = d[i + 2] = r.gray[j]; d[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, inverted: r.inverted, contrast: r.contrast };
}

/** Ista predobrada nad sivom slikom (bez canvasa) – koristi se i u Node ispitnom alatu. */
export function preprocessGray(gray: Uint8ClampedArray, w: number, h: number, opts: { threshold?: boolean; adaptive?: boolean; closingWindow?: number } = {}): { gray: Uint8ClampedArray; inverted: boolean; contrast: number } {
  // median 3×3 protiv šuma
  const med = new Uint8ClampedArray(gray);
  const win = new Array<number>(9);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    let k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) win[k++] = gray[(y + dy) * w + x + dx];
    win.sort((a, b) => a - b);
    med[y * w + x] = win[4];
  }
  // rastezanje kontrasta po percentilima 2–98
  const hist = new Uint32Array(256);
  for (const v of med) hist[v]++;
  const total = w * h;
  let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.02) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= total * 0.02) { hi = i; break; } }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < med.length; i++) med[i] = ((med[i] - lo) * 255) / range;
  // Inverzija samo za zaslone sa svijetlim znamenkama na crnoj podlozi (pozadinski osvijetljeni):
  // sirova srednja svjetlina prije rastezanja je tada vrlo niska. Tamni LCD s još tamnijim znamenkama
  // (npr. Beurer BM38, srednja ~100) ostaje neinvertiran.
  let rawSum = 0;
  for (const v of gray) rawSum += v;
  const inverted = rawSum / gray.length < 60;
  if (inverted) for (let i = 0; i < med.length; i++) med[i] = 255 - med[i];
  let out: Uint8ClampedArray<ArrayBuffer> = med;
  if (opts.adaptive) {
    // prozor ≈ 35 % visine zone: veći od debljine segmenta, manji od promjene osvjetljenja
    out = sauvola(med, w, h, opts.closingWindow ?? Math.max(9, Math.round(h * ADAPTIVE_WIN_FRAC) | 1), 0);
  } else if (opts.threshold) {
    const t = otsu(med);
    out = new Uint8ClampedArray(med.length);
    for (let i = 0; i < med.length; i++) out[i] = med[i] > t ? 255 : 0;
  }
  return { gray: out, inverted, contrast: range / 255 };
}

/**
 * Adaptivna binarizacija oduzimanjem pozadine: pozadina se procijeni morfološkim zatvaranjem
 * (dilatacija pa erozija) koje popuni tanke tamne segmente, a glatku pozadinu (gradijent, odsjaj)
 * vraća gotovo netaknutu; binarizira se razlika pozadina − piksel. Otporno na odsjaj i nejednako
 * osvjetljenje LCD zaslona, za razliku od globalnog praga.
 */
export function sauvola(gray: Uint8ClampedArray, w: number, h: number, win: number, _k: number): Uint8ClampedArray<ArrayBuffer> {
  void _k;
  const r = Math.max(2, win >> 1);
  const bg = erode(dilate(gray, w, h, r), w, h, r);
  const diff = new Uint8ClampedArray(w * h);
  for (let i = 0; i < diff.length; i++) diff[i] = Math.max(0, bg[i] - gray[i]);
  // prag vezan uz kontrast najjačih poteza (98. percentil razlike), a ne uz Otsu koji na
  // blago neravnoj pozadini pada prenisko i pretvara okolinu znamenki u mrlju
  const hist = new Uint32Array(256);
  for (const v of diff) hist[v]++;
  let acc = 0, p98 = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= diff.length * 0.98) { p98 = v; break; } }
  let t = Math.max(12, Math.round(p98 * ADAPTIVE_T_FRAC));
  if (p98 < 18) t = 255; // nema stvarne tinte: sve bijelo
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < diff.length; i++) out[i] = diff[i] > t ? 0 : 255;
  return out;
}

function dilate(g: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray { return sepFilter(g, w, h, r, Math.max); }
function erode(g: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray { return sepFilter(g, w, h, r, Math.min); }
function sepFilter(g: Uint8ClampedArray, w: number, h: number, r: number, f: (a: number, b: number) => number): Uint8ClampedArray {
  const tmp = new Uint8ClampedArray(w * h), out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = g[y * w + x];
    for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx >= 0 && xx < w) m = f(m, g[y * w + xx]); }
    tmp[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = tmp[y * w + x];
    for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy >= 0 && yy < h) m = f(m, tmp[yy * w + x]); }
    out[y * w + x] = m;
  }
  return out;
}

/** Skaliranje sive slike (bilinearno). */
export function scaleGray(gray: Uint8ClampedArray, w: number, h: number, tw: number, th: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(tw * th);
  for (let y = 0; y < th; y++) {
    const sy = ((y + 0.5) * h) / th - 0.5;
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < tw; x++) {
      const sx = ((x + 0.5) * w) / tw - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
      const a = gray[y0 * w + x0], b = gray[y0 * w + x1], c = gray[y1 * w + x0], d = gray[y1 * w + x1];
      out[y * tw + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

export function otsu(gray: Uint8ClampedArray): number {
  const hist = new Uint32Array(256);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/** Medijan svjetline (uzorkovano). */
export function medianGray(gray: Uint8ClampedArray): number {
  const hist = new Uint32Array(256);
  const step = Math.max(1, Math.floor(gray.length / 20000));
  let n = 0;
  for (let i = 0; i < gray.length; i += step) { hist[gray[i]]++; n++; }
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n / 2) return v; }
  return 128;
}

/**
 * Odrezuje svijetli rub kućišta oko LCD zaslona (bijela plastika, natpisi SYS/DIA/PUL) koji je
 * korisnik uhvatio okvirom. Rub je znatno svjetliji od medijana zaslona; reže se s rubova prema
 * unutra dok je udio svijetlih piksela u stupcu/retku velik. Vraća okvir zaslona.
 */
export function trimBezel(gray: Uint8ClampedArray, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } {
  const m = medianGray(gray);
  const white = m + (255 - m) * 0.45;
  const colWhite = new Float32Array(w), rowWhite = new Float32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (gray[y * w + x] > white) { colWhite[x]++; rowWhite[y]++; }
  for (let x = 0; x < w; x++) colWhite[x] /= h;
  for (let y = 0; y < h; y++) rowWhite[y] /= w;
  const LIM = 0.4;
  let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1;
  while (x0 < w * 0.4 && colWhite[x0] > LIM) x0++;
  while (x1 > w * 0.6 && colWhite[x1] > LIM) x1--;
  while (y0 < h * 0.4 && rowWhite[y0] > LIM) y0++;
  while (y1 > h * 0.6 && rowWhite[y1] > LIM) y1--;
  // mala sigurnosna margina prema unutra (rub kućišta nije oštar)
  const mx = Math.round((x1 - x0) * 0.015), my = Math.round((y1 - y0) * 0.015);
  return { x0: x0 + mx, y0: y0 + my, x1: x1 - mx, y1: y1 - my };
}
