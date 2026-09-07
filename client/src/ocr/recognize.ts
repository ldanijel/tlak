import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { parseBand, parseReading, type FieldGuess, type ParsedReading, type Token } from './parse.ts';
import { TECHNICAL_RANGE } from '../types.ts';
import { preprocess, trimBezel } from './preprocess.ts';
import { checkAlignment, classifyBand, decodeBandSevenSegment, emptyModel, inkFromGray, modelReady, rightmostDigits, segmentDigits, type BandDims, type Glyph, type OcrModelData } from './learn.ts';

const PATHS = {
  workerPath: '/tesseract/worker.min.js',
  corePath: '/tesseract/core',
  langPath: '/tessdata',
};

let digitWorker: Promise<Worker> | null = null;
let textWorker: Promise<Worker> | null = null;

/** Sedmerosegmentni model (letsgodigital, legacy engine) – za znamenke na LCD zaslonu. */
function getDigitWorker(onProgress?: (p: number) => void): Promise<Worker> {
  if (!digitWorker) {
    digitWorker = createWorker('letsgodigital', OEM.TESSERACT_ONLY, {
      ...PATHS, gzip: true, legacyCore: true, legacyLang: true,
      logger: (m) => { if (m.status === 'loading language traineddata' || m.status === 'loading tesseract core') onProgress?.(m.progress); },
    }).then(async (w) => {
      await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      return w;
    }).catch((e) => { digitWorker = null; throw e; });
  }
  return digitWorker;
}

/** Opći model (eng, LSTM) – za oznake SYS/DIA/PUL i rezervno čitanje znamenki. */
function getTextWorker(): Promise<Worker> {
  if (!textWorker) {
    textWorker = createWorker('eng', OEM.LSTM_ONLY, { ...PATHS, gzip: true, legacyCore: true })
      .then(async (w) => { await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT }); return w; })
      .catch((e) => { textWorker = null; throw e; });
  }
  return textWorker;
}

function tokensOf(page: { blocks: { paragraphs: { lines: { words: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[] }[] }[] }[] | null }): Token[] {
  const out: Token[] = [];
  for (const b of page.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) {
    if (!w.text.trim()) continue;
    out.push({ text: w.text.trim(), conf: w.confidence, ...w.bbox });
  }
  return out;
}

export interface OcrResult extends ParsedReading { dividers?: [number, number]; engine: string; debug: { digits: Token[]; text: Token[] }; preview: string; glyphs: Glyph[][]; bandDims: BandDims[]; variantWinner: (string | null)[]; learned: boolean[]; alignmentWarnings: string[]; diagnostics: { display: string; bands: { raw: string; adaptive: string }[] } }

/**
 * Prepoznaje SYS/DIA/puls s izrezanog zaslona tlakomjera. Obrada je u cijelosti lokalna.
 * Pokreće oba modela i vraća bolje ocijenjen rezultat.
 */
export async function recognizeDisplay(display: HTMLCanvasElement, onProgress?: (stage: string, p: number) => void): Promise<OcrResult> {
  onProgress?.('Priprema slike', 0);
  const pre = preprocess(display, { threshold: false, targetHeight: 400 });
  const preBin = preprocess(display, { threshold: true, targetHeight: 400 });
  const preview = pre.canvas.toDataURL('image/png');

  onProgress?.('Učitavanje OCR modela', 0.1);
  const results: { engine: string; parsed: ParsedReading; digits: Token[]; text: Token[] }[] = [];
  let textTokens: Token[] = [];
  try {
    const tw = await getTextWorker();
    onProgress?.('Čitanje oznaka', 0.4);
    const r = await tw.recognize(pre.canvas, {}, { blocks: true, text: true });
    textTokens = tokensOf(r.data as never);
    const labels = textTokens.filter((t) => /SYS|DIA|PUL|mmHg|min/i.test(t.text));
    results.push({ engine: 'eng', parsed: parseReading(textTokens, labels), digits: textTokens, text: labels });
  } catch (e) {
    console.warn('OCR (eng) nije uspio', e);
  }
  try {
    const dw = await getDigitWorker((p) => onProgress?.('Učitavanje modela znamenki', 0.1 + p * 0.3));
    onProgress?.('Čitanje znamenki', 0.7);
    for (const canvas of [preBin.canvas, pre.canvas]) {
      const r = await dw.recognize(canvas, {}, { blocks: true, text: true });
      const digits = tokensOf(r.data as never);
      const labels = textTokens.filter((t) => /SYS|DIA|PUL/i.test(t.text));
      results.push({ engine: 'letsgodigital', parsed: parseReading(digits, labels), digits, text: labels });
    }
  } catch (e) {
    console.warn('OCR (letsgodigital) nije uspio', e);
  }
  onProgress?.('Provjera rezultata', 0.95);
  if (!results.length) throw new Error('OCR modeli nisu dostupni. Provjerite je li aplikacija u potpunosti učitana.');
  results.sort((a, b) => b.parsed.score - a.parsed.score);
  const best = results[0];
  onProgress?.('Gotovo', 1);
  return { ...best.parsed, engine: best.engine, debug: { digits: best.digits, text: best.text }, preview, glyphs: [], bandDims: [], variantWinner: [], learned: [], alignmentWarnings: [], diagnostics: { display: '', bands: [] } };
}

function grayOf(c: HTMLCanvasElement): Uint8ClampedArray {
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
  const g = new Uint8ClampedArray(c.width * c.height);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  return g;
}

/**
 * Privlači horizontale na prazne retke između redova znamenki (± 10 % visine): korisnik ih rijetko
 * postavi točno, a horizontala kroz znamenke odreže im dno i „prelije” ga u iduću zonu.
 */
function snapDividers(display: HTMLCanvasElement, dividers: [number, number]): [number, number] {
  const pre = preprocess(display, { adaptive: true, targetHeight: 480 }).canvas;
  const g = grayOf(pre);
  const w = pre.width, h = pre.height;
  // gledamo samo desnih 70 % širine: ondje su znamenke, a ikone i rubovi slijeva nikad ne daju prazan redak
  const xs = Math.round(w * 0.3);
  const rowInk = new Float32Array(h);
  for (let y = 0; y < h; y++) { let n = 0; for (let x = xs; x < w; x++) if (g[y * w + x] < 128) n++; rowInk[y] = n / (w - xs); }
  // „prazan” redak je relativan: rub zaslona ili natpis uz desni rub daju stalnu malu količinu tinte
  let base = 1, peak = 0;
  for (let y = Math.round(h * 0.05); y < h * 0.95; y++) { if (rowInk[y] < base) base = rowInk[y]; if (rowInk[y] > peak) peak = rowInk[y]; }
  const empty = (y: number) => rowInk[y] <= base + 0.15 * (peak - base);
  const out: [number, number] = [...dividers] as [number, number];
  for (let i = 0; i < 2; i++) {
    const y = Math.round(dividers[i] * h);
    if (empty(y)) continue;
    const lim = Math.round(h * 0.15);
    let best = -1;
    for (let d = 1; d <= lim && best < 0; d++) {
      for (const cand of [y - d, y + d]) if (cand > 0 && cand < h - 1 && empty(cand)) { best = cand; break; }
    }
    if (best < 0) continue;
    // unutar labavo praznog niza uzimamo sredinu strogo praznog dijela (donji segment znamenke
    // ima malo tinte i inače bi pomaknuo horizontalu u znamenku), a ako ga nema, redak s najmanje tinte
    let a = best, b = best;
    while (a > 0 && empty(a - 1)) a--;
    while (b < h - 1 && empty(b + 1)) b++;
    const strict = base + 0.06 * (peak - base);
    let sa = -1, sb = -1, minY = a;
    for (let y = a; y <= b; y++) {
      if (rowInk[y] < rowInk[minY]) minY = y;
      if (rowInk[y] <= strict) { if (sa < 0) sa = y; sb = y; }
    }
    out[i] = (sa >= 0 ? (sa + sb) / 2 : minY) / h;
  }
  if (out[1] - out[0] < 0.1) return dividers;
  return out;
}

/** Odreže svijetli rub kućišta ako ga je korisnik uhvatio okvirom; vraća samo LCD. */
function trimDisplay(display: HTMLCanvasElement): HTMLCanvasElement {
  const g = grayOf(display);
  const t = trimBezel(g, display.width, display.height);
  const w = t.x1 - t.x0 + 1, h = t.y1 - t.y0 + 1;
  if (w < display.width * 0.5 || h < display.height * 0.5) return display;
  if (t.x0 === 0 && t.y0 === 0 && w === display.width && h === display.height) return display;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d')!.drawImage(display, t.x0, t.y0, w, h, 0, 0, w, h);
  return c;
}

/**
 * Zona s podstavom ponavljanjem rubnih piksela: bez diskontinuiteta na rubu, pa ni bijela podstava
 * ni jednobojna ispuna ne stvaraju lažnu „tintu” pri binarizaciji (procjena pozadine ide preko ruba).
 */
function sliceBand(src: HTMLCanvasElement, from: number, to: number): HTMLCanvasElement {
  const y0 = Math.max(0, Math.round(src.height * from)), y1 = Math.min(src.height, Math.round(src.height * to));
  const pad = Math.round(src.width * 0.06);
  const tw = src.width, th = Math.max(1, y1 - y0);
  const tmp = document.createElement('canvas');
  tmp.width = tw; tmp.height = th;
  tmp.getContext('2d')!.drawImage(src, 0, y0, tw, th, 0, 0, tw, th);
  const c = document.createElement('canvas');
  c.width = tw + pad * 2; c.height = th + pad * 2;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, pad, pad);
  ctx.drawImage(tmp, 0, 0, tw, 1, pad, 0, tw, pad); // gore
  ctx.drawImage(tmp, 0, th - 1, tw, 1, pad, pad + th, tw, pad); // dolje
  ctx.drawImage(tmp, 0, 0, 1, th, 0, pad, pad, th); // lijevo
  ctx.drawImage(tmp, tw - 1, 0, 1, th, pad + tw, pad, pad, th); // desno
  ctx.drawImage(tmp, 0, 0, 1, 1, 0, 0, pad, pad); ctx.drawImage(tmp, tw - 1, 0, 1, 1, pad + tw, 0, pad, pad);
  ctx.drawImage(tmp, 0, th - 1, 1, 1, 0, pad + th, pad, pad); ctx.drawImage(tmp, tw - 1, th - 1, 1, 1, pad + tw, pad + th, pad, pad);
  return c;
}

function scaleNearest(src: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * factor); c.height = Math.round(src.height * factor);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/**
 * Prepoznavanje po zonama koje je korisnik označio horizontalama: [0, d1) → SYS, [d1, d2) → DIA, [d2, 1] → puls.
 * Svaka zona čita se zasebno (bez oslanjanja na položajnu heuristiku), s oba modela i obje predobrade;
 * uzima se očitanje s najvišom pouzdanošću.
 */
export async function recognizeBands(displayIn: HTMLCanvasElement, dividersIn: [number, number], onProgress?: (stage: string, p: number) => void, model: OcrModelData = emptyModel()): Promise<OcrResult> {
  onProgress?.('Učitavanje OCR modela', 0.05);
  const display = trimDisplay(displayIn);
  const dividers = snapDividers(display, dividersIn);
  const workers: { name: string; w: Worker }[] = [];
  try { workers.push({ name: 'letsgodigital', w: await getDigitWorker((p) => onProgress?.('Učitavanje modela znamenki', 0.05 + p * 0.25)) }); } catch (e) { console.warn(e); }
  try { const w = await getTextWorker(); await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: PSM.SINGLE_LINE }); workers.push({ name: 'eng', w }); } catch (e) { console.warn(e); }
  if (!workers.length) throw new Error('OCR modeli nisu dostupni. Provjerite je li aplikacija u potpunosti učitana.');
  const bounds: [number, number][] = [[0, dividers[0]], [dividers[0], dividers[1]], [dividers[1], 1]];
  const ranges = [TECHNICAL_RANGE.systolic, TECHNICAL_RANGE.diastolic, TECHNICAL_RANGE.pulse] as const;
  const names = ['SYS', 'DIA', 'puls'];
  const guesses: FieldGuess[] = [];
  const debugTokens: Token[] = [];
  const glyphsPerBand: Glyph[][] = [];
  const bandDims: BandDims[] = [];
  const alignmentWarnings: string[] = [];
  const variantWinner: (string | null)[] = [];
  const learned: boolean[] = [];
  let engineUsed = '';
  const VARIANT_NAMES = ['raw', 'nearest2x', 'gray320', 'bin320', 'adaptive320', 'digitsOnly'];
  const diagBands: { raw: string; adaptive: string }[] = [];
  for (let i = 0; i < 3; i++) {
    onProgress?.(`Čitanje: ${names[i]}`, 0.3 + i * 0.22);
    const band = sliceBand(display, bounds[i][0], bounds[i][1]);
    // Više varijanti iste zone (sirova, uvećana bez zaglađivanja, siva s kontrastom, binarizirana); uzima se najpouzdanije očitanje.
    const variants = [
      band,
      scaleNearest(band, band.height < 200 ? 2 : 1),
      preprocess(band, { threshold: false, targetHeight: 320 }).canvas,
      preprocess(band, { threshold: true, targetHeight: 320 }).canvas,
      preprocess(band, { adaptive: true, targetHeight: 320 }).canvas,
    ];
    diagBands.push({ raw: band.toDataURL('image/jpeg', 0.7), adaptive: variants[4].toDataURL('image/png') });
    let best: FieldGuess = { value: null, confidence: 0, reason: 'nije prepoznato' };
    let bestVariant: string | null = null;
    // naučeni predlošci ovog tlakomjera: segmentacija znamenki iz adaptivno binarizirane zone (otporno na odsjaj)
    const bin = variants[4];
    const bctx = bin.getContext('2d', { willReadFrequently: true })!;
    const bd = bctx.getImageData(0, 0, bin.width, bin.height).data;
    const gray = new Uint8ClampedArray(bin.width * bin.height);
    for (let k = 0, j = 0; k < bd.length; k += 4, j++) gray[j] = bd[k];
    const glyphs = segmentDigits(inkFromGray(gray, 128), bin.width, bin.height); // zona je već binarizirana (0/255)
    glyphsPerBand.push(glyphs);
    // Tesseract dodatno čita samo izrezane znamenke (bez ikona i rubova), na čistoj binariziranoj slici
    const kept = rightmostDigits(glyphs, 3);
    if (kept.length >= 2) {
      const x0 = Math.min(...kept.map((g) => g.x0)), x1 = Math.max(...kept.map((g) => g.x1));
      const y0 = Math.min(...kept.map((g) => g.y0)), y1 = Math.max(...kept.map((g) => g.y1));
      const p = Math.round((y1 - y0) * 0.25);
      const c = document.createElement('canvas');
      c.width = x1 - x0 + 1 + 2 * p; c.height = y1 - y0 + 1 + 2 * p;
      const cx = c.getContext('2d')!;
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      cx.drawImage(bin, x0, y0, x1 - x0 + 1, y1 - y0 + 1, p, p, x1 - x0 + 1, y1 - y0 + 1);
      variants.push(c);
    }
    const seg = decodeBandSevenSegment(glyphs, ranges[i]);
    bandDims.push({ w: bin.width, h: bin.height });
    const align = checkAlignment(model, i, glyphs, { w: bin.width, h: bin.height });
    if (align) alignmentWarnings.push(align);
    const tpl = modelReady(model) ? classifyBand(glyphs, model, ranges[i]) : { value: null, confidence: 0, digits: [], used: [] };
    for (const { name, w } of workers) {
      await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
      for (let vi = 0; vi < variants.length; vi++) {
        const r = await w.recognize(variants[vi], {}, { blocks: true, text: true });
        const tokens = tokensOf(r.data as never);
        debugTokens.push(...tokens.map((t) => ({ ...t, text: `${names[i]}/${name}:${t.text}` })));
        const g = parseBand(tokens, ranges[i]);
        const score = (x: FieldGuess) => (x.value === null ? -1 : x.confidence + (model.variantWins[`${name}/${VARIANT_NAMES[vi]}`] || 0) * 0.5);
        if (score(g) > score(best)) { best = g; engineUsed = name; bestVariant = `${name}/${VARIANT_NAMES[vi]}`; }
      }
    }
    // dekoder segmenata (bez učenja): siguran je kad su segmenti jasno uključeni/isključeni
    if (seg.value !== null) {
      if (best.value === seg.value) best = { value: seg.value, confidence: Math.max(best.confidence, seg.confidence, 85) };
      else if (best.value === null || seg.confidence >= 75) best = { value: seg.value, confidence: Math.min(seg.confidence, best.value === null ? seg.confidence : 65), reason: best.value === null ? undefined : `segmenti ${seg.value}, OCR ${best.value}` };
      if (!bestVariant) bestVariant = 'sevenseg';
    }
    // spajanje s naučenim modelom: slaganje diže pouzdanost, neslaganje traži ručnu provjeru
    let used = false;
    if (tpl.value !== null && tpl.confidence >= 70) {
      used = true;
      if (best.value === tpl.value) best = { value: tpl.value, confidence: Math.max(best.confidence, tpl.confidence, 90) };
      else if (best.value === null) best = { value: tpl.value, confidence: tpl.confidence };
      else best = { value: tpl.value, confidence: Math.min(tpl.confidence, 60), reason: `naučeni model ${tpl.value}, OCR ${best.value}` };
    } else if (tpl.value !== null && best.value === null) {
      best = { value: tpl.value, confidence: tpl.confidence, reason: 'niska pouzdanost (naučeni model)' };
      used = true;
    }
    guesses.push(best);
    variantWinner.push(bestVariant);
    learned.push(used);
  }
  const [systolic, diastolic, pulse] = guesses;
  const warnings: string[] = [];
  if (systolic.value !== null && diastolic.value !== null && systolic.value <= diastolic.value) {
    warnings.push('Prepoznati SYS nije veći od DIA – provjerite vrijednosti i položaj horizontala.');
    systolic.confidence = Math.min(systolic.confidence, 50); diastolic.confidence = Math.min(diastolic.confidence, 50);
    systolic.reason = diastolic.reason = 'SYS ≤ DIA';
  }
  onProgress?.('Gotovo', 1);
  const preview = preprocess(display, { threshold: false, targetHeight: 400 }).canvas.toDataURL('image/png');
  (window as unknown as { __ocrDebug?: unknown }).__ocrDebug = { guesses, tokens: debugTokens, glyphs: glyphsPerBand.map((g) => g.map((x) => [x.x0, x.x1, x.y0, x.y1])), bandSizes: bounds.map(([a, b]) => [Math.round(display.height * a), Math.round(display.height * b)]) };
  const small = document.createElement('canvas');
  const sf = Math.min(1, 800 / Math.max(display.width, display.height));
  small.width = Math.round(display.width * sf); small.height = Math.round(display.height * sf);
  small.getContext('2d')!.drawImage(display, 0, 0, small.width, small.height);
  const diagnostics = { display: small.toDataURL('image/jpeg', 0.8), bands: diagBands };
  return { systolic, diastolic, pulse, dividers, score: (systolic.confidence + diastolic.confidence + pulse.confidence) / 3, warnings: [...alignmentWarnings, ...warnings], engine: learned.some(Boolean) ? `${engineUsed || workers[0].name} + naučeni model` : engineUsed || workers[0].name, debug: { digits: debugTokens, text: [] }, preview, glyphs: glyphsPerBand, bandDims, variantWinner, learned, alignmentWarnings, diagnostics };
}

export async function warmUpOcr(): Promise<void> {
  try { await Promise.all([getTextWorker(), getDigitWorker()]); } catch { /* prikazat će se pri korištenju */ }
}
