import { TECHNICAL_RANGE } from '../types.ts';

/** Prepoznata znamenkasta stavka s položajem. */
export interface Token { text: string; conf: number; x0: number; y0: number; x1: number; y1: number }

export interface FieldGuess { value: number | null; confidence: number; reason?: string }
export interface ParsedReading { systolic: FieldGuess; diastolic: FieldGuess; pulse: FieldGuess; score: number; warnings: string[] }

const CONF_OK = 70;

/**
 * Mapira prepoznate brojeve na SYS/DIA/puls: gornji → SYS, srednji → DIA, donji → puls,
 * uz veličinu znamenki, oznake (SYS/DIA/PUL) i međusobnu provjeru vrijednosti.
 */
export function parseReading(tokens: Token[], labels: Token[] = []): ParsedReading {
  const warnings: string[] = [];
  const nums = tokens
    .map((t) => ({ ...t, clean: t.text.replace(/[^0-9]/g, '') }))
    .filter((t) => /^\d{2,3}$/.test(t.clean) && !/[:/.]/.test(t.text))
    .map((t) => ({ ...t, value: Number(t.clean), h: t.y1 - t.y0, cy: (t.y0 + t.y1) / 2 }));
  if (tokens.some((t) => /\d{1,2}[:.]\d{2}/.test(t.text) || /^\d{4}$/.test(t.text.replace(/\D/g, '')))) {
    warnings.push('Na zaslonu su prepoznati i brojevi koji izgledaju kao vrijeme, datum ili broj memorije; oni su zanemareni.');
  }
  const empty = (reason: string): FieldGuess => ({ value: null, confidence: 0, reason });
  if (nums.length < 2) {
    return { systolic: empty('nije prepoznato'), diastolic: empty('nije prepoznato'), pulse: empty('nije prepoznato'), score: 0, warnings: [...warnings, 'Premalo čitljivih brojeva.'] };
  }
  // Velike znamenke: zadržavamo tokene čija je visina bar 45 % najvećeg (isključuje sitne datume/memoriju).
  const maxH = Math.max(...nums.map((n) => n.h));
  let big = nums.filter((n) => n.h >= maxH * 0.45);
  // Oznake (ako su prepoznate) mogu izravno mapirati: token najbliži po visini oznaci.
  const byLabel = (re: RegExp) => {
    const l = labels.find((t) => re.test(t.text.toUpperCase()));
    if (!l) return null;
    const lcy = (l.y0 + l.y1) / 2;
    return big.slice().sort((a, b) => Math.abs(a.cy - lcy) - Math.abs(b.cy - lcy))[0] || null;
  };
  const labSys = byLabel(/SYS/), labDia = byLabel(/DIA/), labPul = byLabel(/PUL|HR\b|♥/);

  big = big.sort((a, b) => a.cy - b.cy);
  // Spajamo tokene u istom redu (npr. "1" i "28" razdvojeni), zadržavajući najviše 3 reda.
  const rows: typeof big = [];
  for (const n of big) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.cy - n.cy) < Math.max(last.h, n.h) * 0.5) {
      const merged = { ...last, clean: last.x0 < n.x0 ? last.clean + n.clean : n.clean + last.clean, x0: Math.min(last.x0, n.x0), x1: Math.max(last.x1, n.x1), conf: Math.min(last.conf, n.conf) };
      merged.value = Number(merged.clean);
      rows[rows.length - 1] = /^\d{2,3}$/.test(merged.clean) ? merged : last;
    } else rows.push(n);
  }
  let sysT = labSys, diaT = labDia, pulT = labPul;
  if (!sysT || !diaT) {
    const top = rows.slice(0, 3);
    sysT = sysT || top[0] || null;
    diaT = diaT || top.find((r) => r !== sysT) || null;
    pulT = pulT || top.find((r) => r !== sysT && r !== diaT) || null;
  }
  const guess = (t: typeof big[number] | null, [lo, hi]: readonly [number, number]): FieldGuess => {
    if (!t) return empty('nije prepoznato');
    const conf = Math.round(t.conf);
    if (t.value < lo || t.value > hi) return { value: null, confidence: conf, reason: `izvan raspona (${t.value})` };
    if (conf < CONF_OK) return { value: t.value, confidence: conf, reason: 'niska pouzdanost' };
    return { value: t.value, confidence: conf };
  };
  const systolic = guess(sysT, TECHNICAL_RANGE.systolic);
  const diastolic = guess(diaT, TECHNICAL_RANGE.diastolic);
  const pulse = guess(pulT, TECHNICAL_RANGE.pulse);
  let score = (systolic.confidence + diastolic.confidence + pulse.confidence) / 3;
  if (systolic.value !== null && diastolic.value !== null) {
    if (systolic.value <= diastolic.value) {
      warnings.push('Prepoznati SYS nije veći od DIA – provjerite vrijednosti.');
      systolic.reason = diastolic.reason = 'SYS ≤ DIA';
      systolic.confidence = Math.min(systolic.confidence, 50);
      diastolic.confidence = Math.min(diastolic.confidence, 50);
      score *= 0.5;
    }
  }
  if (systolic.value === null || diastolic.value === null || pulse.value === null) score *= 0.6;
  return { systolic, diastolic, pulse, score, warnings };
}

/**
 * Očitanje jedne zone (SYS, DIA ili puls) koju je korisnik označio horizontalama:
 * bira najveći čitljiv broj od 2–3 znamenke; spaja znamenke razdvojene u istom redu.
 */
export function parseBand(tokens: Token[], [lo, hi]: readonly [number, number]): FieldGuess {
  const nums = tokens
    .filter((t) => !/[:/.]/.test(t.text))
    .map((t) => ({ ...t, clean: t.text.replace(/[^0-9]/g, ''), h: t.y1 - t.y0, cy: (t.y0 + t.y1) / 2 }))
    .filter((t) => t.clean.length >= 1 && t.clean.length <= 3)
    .sort((a, b) => a.x0 - b.x0);
  if (!nums.length) return { value: null, confidence: 0, reason: 'nije prepoznato' };
  const maxH = Math.max(...nums.map((n) => n.h));
  const big = nums.filter((n) => n.h >= maxH * 0.6);
  // spajanje susjednih tokena istog reda (npr. "1" + "28")
  let text = '', conf = 100;
  for (const n of big) { if ((text + n.clean).length > 3) break; text += n.clean; conf = Math.min(conf, n.conf); }
  if (text.length < 2) {
    const single = big.find((n) => n.clean.length >= 2);
    if (!single) return { value: null, confidence: Math.round(conf), reason: 'nedovoljno znamenki' };
    text = single.clean; conf = single.conf;
  }
  const value = Number(text);
  const c = Math.round(conf);
  if (value < lo || value > hi) return { value: null, confidence: c, reason: `izvan raspona (${value})` };
  if (c < CONF_OK) return { value, confidence: c, reason: 'niska pouzdanost' };
  return { value, confidence: c };
}
