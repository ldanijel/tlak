/**
 * Lokalna predobrada za OCR: siva skala, rastezanje kontrasta, uklanjanje šuma (median 3×3),
 * inverzija ako je zaslon svijetlih znamenki na tamnoj podlozi, adaptivni prag (Otsu).
 */
export interface PreprocessResult { canvas: HTMLCanvasElement; inverted: boolean; contrast: number }

export function preprocess(src: HTMLCanvasElement, opts: { threshold?: boolean; targetHeight?: number } = {}): PreprocessResult {
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

  // inverzija: znamenke moraju biti tamne na svijetloj podlozi (većina piksela je podloga)
  let sum = 0;
  for (const v of med) sum += v;
  const mean = sum / med.length;
  const inverted = mean < 110;
  if (inverted) for (let i = 0; i < med.length; i++) med[i] = 255 - med[i];

  let out = med;
  if (opts.threshold) {
    const t = otsu(med);
    out = new Uint8ClampedArray(med.length);
    for (let i = 0; i < med.length; i++) out[i] = med[i] > t ? 255 : 0;
  }
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { d[i] = d[i + 1] = d[i + 2] = out[j]; d[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, inverted, contrast: range / 255 };
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
