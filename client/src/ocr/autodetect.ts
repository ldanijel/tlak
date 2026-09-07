/**
 * Automatsko pronalaženje zaslona tlakomjera na cijeloj fotografiji, bez ručnog izrezivanja:
 * binarizacija cijele (umanjene) slike, povezane komponente, grupiranje u redove znamenki
 * sedmerosegmentnog izgleda i provjera dekoderom segmenata. Ako se nađu tri reda (SYS, DIA, puls)
 * s uvjerljivim vrijednostima, vraća okvir zaslona i horizontale u udjelima slike.
 */
import { preprocessGray, scaleGray } from './preprocess.ts';
import { segmentsOf, inkFromGray, rightmostDigits, type Glyph, GW, GH } from './learn.ts';

export interface AutoDetectResult {
  rect: { x: number; y: number; w: number; h: number }; // udjeli slike
  dividers: [number, number];
  values: { systolic: number | null; diastolic: number | null; pulse: number | null };
  rows: number; // koliko redova znamenki je nađeno (3 = potpuno)
  confidence: number;
}

interface Box { x0: number; y0: number; x1: number; y1: number; area: number }

/** Povezane komponente (8-susjedstvo) nad binarnom slikom; vraća okvire s površinom tinte. */
export function connectedComponents(ink: Uint8Array, w: number, h: number, minArea = 8): Box[] {
  const label = new Int32Array(w * h);
  const boxes: Box[] = [];
  const stack: number[] = [];
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || label[start]) continue;
    const id = boxes.length + 1;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
    stack.push(start); label[start] = id;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p - x) / w;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (ink[q] && !label[q]) { label[q] = id; stack.push(q); }
      }
    }
    if (area >= minArea) boxes.push({ x0, y0, x1, y1, area });
  }
  return boxes;
}

function dilateInk(ink: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let dx = -r; dx <= r && !m; dx++) { const xx = x + dx; if (xx >= 0 && xx < w && ink[y * w + xx]) m = 1; }
    tmp[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let dy = -r; dy <= r && !m; dy++) { const yy = y + dy; if (yy >= 0 && yy < h && tmp[yy * w + x]) m = 1; }
    out[y * w + x] = m;
  }
  return out;
}

const RANGES = { systolic: [50, 260], diastolic: [30, 160], pulse: [25, 220] } as const;
const PATTERNS: Record<string, string> = { abcdef: '0', bc: '1', abdeg: '2', abcdg: '3', bcfg: '4', acdfg: '5', acdefg: '6', abc: '7', abcdefg: '8', abcdfg: '9', abcf: '7' };

/**
 * Pronalazi redove znamenki na sivoj slici. Radi na umanjenoj kopiji (najviše ~900 px po duljoj strani).
 */
export function autoDetect(gray: Uint8ClampedArray, w: number, h: number, debug?: (info: unknown) => void): AutoDetectResult | null {
  const scale = Math.min(1, 900 / Math.max(w, h));
  const sw = Math.round(w * scale), sh = Math.round(h * scale);
  const g = scale < 1 ? scaleGray(gray, w, h, sw, sh) : gray;
  // više mjerila prozora zatvaranja (debljina segmenta ovisi o udaljenosti fotografiranja); prvi potpun rezultat pobjeđuje
  let best: AutoDetectResult | null = null;
  const frames: Box[] = [];
  for (const frac of [0.06, 0.09, 0.04]) {
    const r = detectAt(g, sw, sh, frac, debug, frames);
    if (r && (!best || r.rows > best.rows)) best = r;
    if (best && best.rows === 3) break;
  }
  if (best && best.rows === 3) return clip(best);
  // Drugi pokušaj: unutar okvira zaslona. Na cijeloj fotografiji prag tinte određuju najtamniji dijelovi
  // (crijevo, sjene), pa sivi LCD sa znamenkama slabijeg kontrasta ispadne razlomljen, a rub zaslona
  // se spoji sa znamenkama. Velika šuplja komponenta (okvir zaslona) zato se obrađuje iznutra, s vlastitim pragom.
  const seen: Box[] = [];
  const uniq = frames.filter((f) => { const dup = seen.some((s) => Math.abs(s.x0 - f.x0) < sw * 0.03 && Math.abs(s.y0 - f.y0) < sh * 0.03 && Math.abs(s.x1 - f.x1) < sw * 0.03 && Math.abs(s.y1 - f.y1) < sh * 0.03); if (!dup) seen.push(f); return !dup; })
    .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0)).slice(0, 3);
  for (const f of uniq) {
    const inset = Math.round(Math.min(f.x1 - f.x0, f.y1 - f.y0) * 0.03) + 2;
    const cx0 = f.x0 + inset, cy0 = f.y0 + inset, cx1 = f.x1 - inset, cy1 = f.y1 - inset;
    const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1;
    if (cw < sw * 0.1 || ch < sh * 0.1) continue;
    const crop = new Uint8ClampedArray(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) crop[y * cw + x] = g[(cy0 + y) * sw + cx0 + x];
    for (const frac of [0.08, 0.12, 0.05]) {
      const r = detectAt(crop, cw, ch, frac, debug ? (info) => debug({ frame: [f.x0, f.y0, f.x1, f.y1], ...(info as object) }) : undefined, undefined, true);
      if (!r) continue;
      const mapped: AutoDetectResult = { ...r, rect: { x: (cx0 + r.rect.x * cw) / sw, y: (cy0 + r.rect.y * ch) / sh, w: (r.rect.w * cw) / sw, h: (r.rect.h * ch) / sh } };
      if (!best || mapped.rows > best.rows) best = mapped;
      if (best.rows === 3) return clip(best);
    }
  }
  return best && clip(best);
}

/** Obrezivanje okvira na granice slike (udjeli 0–1). */
function clip(r: AutoDetectResult): AutoDetectResult {
  const x0 = Math.max(0, r.rect.x), y0 = Math.max(0, r.rect.y), x1 = Math.min(1, r.rect.x + r.rect.w), y1 = Math.min(1, r.rect.y + r.rect.h);
  // horizontale su udjeli visine okvira; pri obrezivanju se preračunaju
  const d = r.dividers.map((v) => (r.rect.y + v * r.rect.h - y0) / (y1 - y0)) as [number, number];
  return { ...r, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, dividers: d };
}

function detectAt(g: Uint8ClampedArray, sw: number, sh: number, winFrac: number, debug?: (info: unknown) => void, frames?: Box[], relative = false): AutoDetectResult | null {
  const bin = preprocessGray(g, sw, sh, { adaptive: true, closingWindow: Math.max(9, Math.round(sh * winFrac) | 1), relative }).gray;
  const ink = inkFromGray(bin, 128);
  // blaga dilatacija spaja segmente iste znamenke koji se ne dodiruju u kutovima
  const joined = dilateInk(ink, sw, sh, Math.max(1, Math.round(sh * 0.005)));
  const comps = connectedComponents(joined, sw, sh, Math.round(sh * sh * 0.0002));
  // kandidati za okvir zaslona: velike šuplje komponente (rub LCD-a, eventualno spojen sa znamenkama)
  if (frames) for (const b of comps) {
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1, fill = b.area / (bw * bh);
    if (bw >= sw * 0.2 && bh >= sh * 0.15 && bw <= sw * 0.97 && bh <= sh * 0.97 && fill <= 0.5) frames.push(b);
  }
  // komponente koje mogu biti (dio) znamenke: ne prevelike i ne sitne
  // znamenke mogu biti i vrlo velike (tijesan izrez ili blizu snimljeno): do 45 % visine
  const parts = comps.filter((b) => { const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1; return bh >= sh * 0.012 && bh <= sh * 0.45 && bw <= sw * 0.5; });
  // sjeme redova: visoke uspravne komponente (cijele znamenke ili njihovi okomiti segmenti)
  const seeds = parts.filter((b) => { const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1; return bh >= sh * 0.03 && bh / bw >= 1.1; }).sort((a, b) => (b.y1 - b.y0) - (a.y1 - a.y0));
  const rows: { y0: number; y1: number; members: Box[] }[] = [];
  for (const sd of seeds) {
    const cy = (sd.y0 + sd.y1) / 2, hh = sd.y1 - sd.y0 + 1;
    // okomiti segment odlomljene znamenke visok je oko pola znamenke, pa i on pripada redu
    const row = rows.find((r) => cy >= r.y0 && cy <= r.y1 && hh >= (r.y1 - r.y0 + 1) * 0.35);
    if (row) { row.members.push(sd); row.y0 = Math.min(row.y0, sd.y0); row.y1 = Math.max(row.y1, sd.y1); }
    else rows.push({ y0: sd.y0, y1: sd.y1, members: [sd] });
  }
  // ostali dijelovi (vodoravni segmenti, odlomljeni kutovi) pridružuju se redu koji ih vertikalno pokriva
  for (const b of parts) {
    if (seeds.includes(b)) continue;
    const cy = (b.y0 + b.y1) / 2;
    const row = rows.find((r) => cy >= r.y0 - (r.y1 - r.y0) * 0.1 && cy <= r.y1 + (r.y1 - r.y0) * 0.1);
    if (row) row.members.push(b);
  }
  const cands: number[][] = [];
  interface RowRead { boxes: Box[]; value: number; y0: number; y1: number; height: number }
  const reads: RowRead[] = [];
  for (const row of rows) {
    const H = row.y1 - row.y0 + 1;
    // ćelije znamenki: dijelovi iste znamenke preklapaju se po x (vodoravni segment iznad okomitog);
    // susjedne znamenke se ne preklapaju (ili tek rubno, kod kosog fonta), pa se spaja samo pri
    // preklapanju od najmanje 30 % uže komponente
    const ms = row.members.slice().sort((a, b) => a.x0 - b.x0);
    const cells: Box[] = [];
    for (const m of ms) {
      const last = cells[cells.length - 1];
      const overlap = last ? Math.min(last.x1, m.x1) - m.x0 + 1 : 0;
      const minW = last ? Math.min(last.x1 - last.x0 + 1, m.x1 - m.x0 + 1) : 1;
      if (last && overlap >= minW * 0.3) { last.x1 = Math.max(last.x1, m.x1); last.y0 = Math.min(last.y0, m.y0); last.y1 = Math.max(last.y1, m.y1); last.area += m.area; }
      else cells.push({ ...m });
    }
    // ćelija je znamenka ako je uspravna i nije puna mrlja (7-seg dekoder bi punu mrlju pročitao kao 8)
    const glyphs: Glyph[] = [];
    for (const c of cells) {
      const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
      if (ch < H * 0.55) continue;
      const aspect = ch / cw, fill = c.area / (cw * ch);
      cands.push([c.x0, c.y0, c.x1, c.y1, +fill.toFixed(2)]);
      if (aspect < 1.05 || aspect > 7) continue;
      if (aspect < 2.8 && fill > 0.72) continue;
      glyphs.push({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, bits: new Uint8Array(GW * GH), segs: segmentsOf(ink, sw, c) });
      cands[cands.length - 1].push(glyphs[glyphs.length - 1].segs as never);
    }
    // samo ćelije koje se dekodiraju kao znamenka (rub zaslona, ikone i natpisi ispadaju)
    const kept = rightmostDigits(glyphs.filter((g) => PATTERNS[g.segs]), 3);
    if (kept.length < 2) continue;
    const digits = kept.map((k) => PATTERNS[k.segs] ?? null);
    const tryLen = (n: number) => { const part = digits.slice(-n); return part.every((d) => d !== null) ? Number(part.join('')) : null; };
    const value = tryLen(kept.length) ?? (kept.length === 3 ? tryLen(2) : null);
    if (value === null) continue;
    const used = kept.length === 3 && tryLen(3) === null ? kept.slice(-2) : kept;
    const y0 = Math.min(...used.map((k) => k.y0)), y1 = Math.max(...used.map((k) => k.y1));
    reads.push({ boxes: used.map((k) => ({ x0: k.x0, y0: k.y0, x1: k.x1, y1: k.y1, area: 0 })), value, y0, y1, height: y1 - y0 + 1 });
  }
  debug?.({ win: winFrac, size: [sw, sh], comps: comps.map((b) => [b.x0, b.y0, b.x1, b.y1, b.area]), parts: parts.map((b) => [b.x0, b.y0, b.x1, b.y1]), rowsY: rows.map((r) => [r.y0, r.y1]), cands, rows: rows.map((r) => r.members.length), reads: reads.map((r) => [r.value, r.y0, r.y1, r.boxes.length]) });
  if (reads.length < 2) return null;
  reads.sort((a, b) => a.y0 - b.y0);
  // biramo tri uzastopna reda: SYS > DIA, puls manji od DIA po visini znamenki, vrijednosti u rasponu
  const inR = (v: number, [lo, hi]: readonly [number, number]) => v >= lo && v <= hi;
  let best: { s: RowRead; d: RowRead; p: RowRead | null; score: number } | null = null;
  for (let i = 0; i < reads.length; i++) for (let j = i + 1; j < reads.length; j++) {
    const s = reads[i], d = reads[j];
    if (!inR(s.value, RANGES.systolic) || !inR(d.value, RANGES.diastolic) || s.value <= d.value) continue;
    if (Math.max(s.height, d.height) / Math.min(s.height, d.height) > 1.5) continue;
    if (d.y0 - s.y1 > s.height * 1.5) continue; // predaleko
    let p: RowRead | null = null;
    for (let k = j + 1; k < reads.length; k++) {
      const c = reads[k];
      if (inR(c.value, RANGES.pulse) && c.height <= d.height * 1.1 && c.y0 - d.y1 < d.height * 1.5) { p = c; break; }
    }
    const score = (p ? 3 : 2) + (s.boxes.length === 3 ? 0.5 : 0);
    if (!best || score > best.score) best = { s, d, p, score };
  }
  if (!best) return null;
  const all = [best.s, best.d, ...(best.p ? [best.p] : [])];
  const x0 = Math.min(...all.flatMap((r) => r.boxes.map((b) => b.x0))), x1 = Math.max(...all.flatMap((r) => r.boxes.map((b) => b.x1)));
  // ako red pulsa nije nađen (manje znamenke), okvir se produžuje ispod DIA-e za otprilike jedan red
  const y0 = best.s.y0, y1 = best.p ? best.p.y1 : Math.min(sh - 1, best.d.y1 + best.d.height * 1.25);
  const mh = best.s.height * 0.35, mw = (x1 - x0) * 0.12;
  // okvir s rubom smije prijeći granice ove slike (kad se radi unutar okvira zaslona); obrezuje ga pozivatelj
  const rect = { x: (x0 - mw) / sw, y: (y0 - mh) / sh, w: (x1 + mw) / sw, h: (y1 + mh) / sh };
  rect.w -= rect.x; rect.h -= rect.y;
  const mid = (a: RowRead, b: RowRead) => ((a.y1 + b.y0) / 2 / sh - rect.y) / rect.h;
  const d1 = mid(best.s, best.d);
  // bez reda pulsa: horizontala odmah ispod DIA-e (puls je tik ispod), glavni cjevovod je poslije privuče na prazan redak
  const d2 = best.p ? mid(best.d, best.p) : ((best.d.y1 + best.d.height * 0.08) / sh - rect.y) / rect.h;
  return {
    rect, dividers: [d1, d2],
    values: { systolic: best.s.value, diastolic: best.d.value, pulse: best.p?.value ?? null },
    rows: best.p ? 3 : 2,
    confidence: best.p ? 80 : 60,
  };
}
