import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { parseBand, parseReading, type FieldGuess, type ParsedReading, type Token } from './parse.ts';
import { TECHNICAL_RANGE } from '../types.ts';
import { preprocess } from './preprocess.ts';

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

export interface OcrResult extends ParsedReading { engine: string; debug: { digits: Token[]; text: Token[] }; preview: string }

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
  return { ...best.parsed, engine: best.engine, debug: { digits: best.digits, text: best.text }, preview };
}

function sliceBand(src: HTMLCanvasElement, from: number, to: number): HTMLCanvasElement {
  const y0 = Math.max(0, Math.round(src.height * from)), y1 = Math.min(src.height, Math.round(src.height * to));
  const pad = Math.round(src.width * 0.06);
  const c = document.createElement('canvas');
  c.width = src.width + pad * 2; c.height = Math.max(1, y1 - y0) + pad * 2;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, y0, src.width, y1 - y0, pad, pad, src.width, y1 - y0);
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
export async function recognizeBands(display: HTMLCanvasElement, dividers: [number, number], onProgress?: (stage: string, p: number) => void): Promise<OcrResult> {
  onProgress?.('Učitavanje OCR modela', 0.05);
  const workers: { name: string; w: Worker }[] = [];
  try { workers.push({ name: 'letsgodigital', w: await getDigitWorker((p) => onProgress?.('Učitavanje modela znamenki', 0.05 + p * 0.25)) }); } catch (e) { console.warn(e); }
  try { const w = await getTextWorker(); await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: PSM.SINGLE_LINE }); workers.push({ name: 'eng', w }); } catch (e) { console.warn(e); }
  if (!workers.length) throw new Error('OCR modeli nisu dostupni. Provjerite je li aplikacija u potpunosti učitana.');
  const bounds: [number, number][] = [[0, dividers[0]], [dividers[0], dividers[1]], [dividers[1], 1]];
  const ranges = [TECHNICAL_RANGE.systolic, TECHNICAL_RANGE.diastolic, TECHNICAL_RANGE.pulse] as const;
  const names = ['SYS', 'DIA', 'puls'];
  const guesses: FieldGuess[] = [];
  const debugTokens: Token[] = [];
  let engineUsed = '';
  for (let i = 0; i < 3; i++) {
    onProgress?.(`Čitanje: ${names[i]}`, 0.3 + i * 0.22);
    const band = sliceBand(display, bounds[i][0], bounds[i][1]);
    // Više varijanti iste zone (sirova, uvećana bez zaglađivanja, siva s kontrastom, binarizirana); uzima se najpouzdanije očitanje.
    const variants = [
      band,
      scaleNearest(band, band.height < 200 ? 2 : 1),
      preprocess(band, { threshold: false, targetHeight: 320 }).canvas,
      preprocess(band, { threshold: true, targetHeight: 320 }).canvas,
    ];
    let best: FieldGuess = { value: null, confidence: 0, reason: 'nije prepoznato' };
    for (const { name, w } of workers) {
      await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
      for (const v of variants) {
        const r = await w.recognize(v, {}, { blocks: true, text: true });
        const tokens = tokensOf(r.data as never);
        debugTokens.push(...tokens.map((t) => ({ ...t, text: `${names[i]}/${name}:${t.text}` })));
        const g = parseBand(tokens, ranges[i]);
        const score = (x: FieldGuess) => (x.value === null ? -1 : x.confidence);
        if (score(g) > score(best)) { best = g; engineUsed = name; }
      }
    }
    guesses.push(best);
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
  (window as unknown as { __ocrDebug?: unknown }).__ocrDebug = { guesses, tokens: debugTokens };
  return { systolic, diastolic, pulse, score: (systolic.confidence + diastolic.confidence + pulse.confidence) / 3, warnings, engine: engineUsed || workers[0].name, debug: { digits: debugTokens, text: [] }, preview };
}

export async function warmUpOcr(): Promise<void> {
  try { await Promise.all([getTextWorker(), getDigitWorker()]); } catch { /* prikazat će se pri korištenju */ }
}
