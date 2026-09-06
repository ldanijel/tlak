import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { parseReading, type ParsedReading, type Token } from './parse.ts';
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

export async function warmUpOcr(): Promise<void> {
  try { await Promise.all([getTextWorker(), getDigitWorker()]); } catch { /* prikazat će se pri korištenju */ }
}
