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
  rows: number; // koliko redova znamenki je nađeno (3 = potpuno; 0 = samo okvir zaslona, bez očitanja)
  confidence: number;
}

interface Box { x0: number; y0: number; x1: number; y1: number; area: number }
interface RowRead { boxes: (Box & { digit: string })[]; value: number; y0: number; y1: number; height: number }

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
  const state: { best: AutoDetectResult | null } = { best: null };
  const frames: Box[] = [];
  const consider = (r: AutoDetectResult | null) => { if (r && (!state.best || r.rows > state.best.rows)) state.best = r; };
  const done = () => state.best !== null && state.best.rows === 3;
  let acc: RowRead[] = [];
  for (const frac of [0.06, 0.09, 0.04]) {
    acc = mergeReads([...acc, ...readsAt(g, sw, sh, frac, debug, frames)]);
    consider(choose(acc, sw, sh));
    if (done()) break;
  }
  if (done()) return clip(state.best!);
  // Drugi pokušaj: unutar okvira zaslona. Na cijeloj fotografiji prag tinte određuju najtamniji dijelovi
  // (crijevo, sjene), pa sivi LCD sa znamenkama slabijeg kontrasta ispadne razlomljen, a rub zaslona
  // se spoji sa znamenkama. Velika šuplja komponenta (okvir zaslona) zato se obrađuje iznutra, s vlastitim pragom.
  const seen: Box[] = [];
  const uniq = frames.filter((f) => { const dup = seen.some((s) => Math.abs(s.x0 - f.x0) < sw * 0.03 && Math.abs(s.y0 - f.y0) < sh * 0.03 && Math.abs(s.x1 - f.x1) < sw * 0.03 && Math.abs(s.y1 - f.y1) < sh * 0.03); if (!dup) seen.push(f); return !dup; })
    .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0)).slice(0, 3);
  for (const f of uniq) {
    const fw = f.x1 - f.x0 + 1, fh = f.y1 - f.y0 + 1;
    // Zajedničko ishodište za sve varijante: okvir proširen za 5 % (i za 30 % visine prema dolje, jer je
    // donji rub LCD-a često zasebna komponenta pa okvir ne obuhvaća red pulsa). Redovi iz svih varijanti
    // spajaju se u tom koordinatnom sustavu.
    const pad = Math.round(Math.min(fw, fh) * 0.05) + 2;
    const ex0 = Math.max(0, f.x0 - pad), ey0 = Math.max(0, f.y0 - pad);
    const ex1 = Math.min(sw - 1, f.x1 + pad), ey1 = Math.min(sh - 1, f.y1 + Math.round(fh * 0.3));
    const ew = ex1 - ex0 + 1, eh = ey1 - ey0 + 1;
    if (ew < sw * 0.1 || eh < sh * 0.1) continue;
    const inset = Math.round(Math.min(fw, fh) * 0.03) + 2;
    // Varijante (u koordinatama proširenog izreza): 1) unutrašnjost bez ruba – rub LCD-a spojen sa znamenkama
    // se odreže; 2) unutrašnjost produžena dolje – red pulsa ispod okvira; 3) cijeli prošireni izrez – kad
    // „okvir” nije rub zaslona nego sam blok znamenki, pa bi rezanje ruba odrezalo znamenke.
    const ix0 = f.x0 + inset - ex0, iy0 = f.y0 + inset - ey0, ix1 = f.x1 - inset - ex0, iy1 = f.y1 - inset - ey0;
    const variants: [number, number, number, number][] = [[ix0, iy0, ix1, iy1], [ix0, iy0, ix1, eh - 1], [0, 0, ew - 1, eh - 1]];
    let facc: RowRead[] = [];
    for (let vi = 0; vi < variants.length; vi++) {
      const [vx0, vy0, vx1, vy1] = variants[vi];
      const cw = vx1 - vx0 + 1, ch = vy1 - vy0 + 1;
      if (cw < 8 || ch < 8) continue;
      const crop = new Uint8ClampedArray(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) crop[y * cw + x] = g[(ey0 + vy0 + y) * sw + ex0 + vx0 + x];
      // relativni kontrast pomaže na tamnom LCD-u u sjeni, apsolutni na svijetlom LCD-u pri dnevnom svjetlu
      // (relativni ondje gubi slabije desne segmente); redovi iz obiju binarizacija se spajaju
      for (const [frac, relative] of [[0.08, true], [0.08, false], [0.12, true], [0.05, true], [0.05, false], [0.12, false]] as [number, boolean][]) {
        const reads = readsAt(crop, cw, ch, frac, debug ? (info) => debug({ frame: [f.x0, f.y0, f.x1, f.y1], variant: vi, relative, ...(info as object) }) : undefined, undefined, relative);
        facc = mergeReads([...facc, ...shiftReads(reads, vx0, vy0)]);
        const r = choose(facc, ew, eh);
        if (!r) continue;
        consider({ ...r, rect: { x: (ex0 + r.rect.x * ew) / sw, y: (ey0 + r.rect.y * eh) / sh, w: (r.rect.w * ew) / sw, h: (r.rect.h * eh) / sh } });
        if (done()) return clip(state.best!);
      }
    }
  }
  if (state.best) return clip(state.best);
  // Ništa pročitano, ali okvir zaslona postoji: vraća se kao početni okvir za ručni izrez (rows = 0).
  const f = uniq[0];
  if (f) return clip({ rect: { x: f.x0 / sw, y: f.y0 / sh, w: (f.x1 - f.x0 + 1) / sw, h: (f.y1 - f.y0 + 1) / sh }, dividers: [0.4, 0.75], values: { systolic: null, diastolic: null, pulse: null }, rows: 0, confidence: 0 });
  return null;
}

/** Obrezivanje okvira na granice slike (udjeli 0–1). */
function clip(r: AutoDetectResult): AutoDetectResult {
  const x0 = Math.max(0, r.rect.x), y0 = Math.max(0, r.rect.y), x1 = Math.min(1, r.rect.x + r.rect.w), y1 = Math.min(1, r.rect.y + r.rect.h);
  // horizontale su udjeli visine okvira; pri obrezivanju se preračunaju
  const d = r.dividers.map((v) => (r.rect.y + v * r.rect.h - y0) / (y1 - y0)) as [number, number];
  return { ...r, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, dividers: d };
}

/** Redovi znamenki (s dekodiranom vrijednošću) na jednoj binarizaciji slike. */
function readsAt(g: Uint8ClampedArray, sw: number, sh: number, winFrac: number, debug?: (info: unknown) => void, frames?: Box[], relative = false): RowRead[] {
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
  // (vrlo tanke visoke šipke – traka u boji uz zaslon, rub kućišta – nisu znamenke ni njihovi segmenti,
  // a spojile bi susjedne redove u jedan)
  const seeds = parts.filter((b) => { const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1; return bh >= sh * 0.03 && bh / bw >= 1.1 && bh / bw <= 7; }).sort((a, b) => (b.y1 - b.y0) - (a.y1 - a.y0));
  const rows: { y0: number; y1: number; members: Box[] }[] = [];
  // red s najvećim okomitim preklapanjem (a ne prvi koji sadrži središte: gornja polovica odlomljene „1”
  // inače završi u redu ruba zaslona iznad)
  const overlapOf = (r: { y0: number; y1: number }, b: Box) => Math.min(r.y1, b.y1) - Math.max(r.y0, b.y0) + 1;
  const bestRow = (b: Box, ok: (r: { y0: number; y1: number; members: Box[] }) => boolean) => {
    let best: (typeof rows)[number] | null = null, bestO = 0;
    for (const r of rows) { if (!ok(r)) continue; const o = overlapOf(r, b); if (o > bestO) { bestO = o; best = r; } }
    return best;
  };
  for (const sd of seeds) {
    const cy = (sd.y0 + sd.y1) / 2, hh = sd.y1 - sd.y0 + 1;
    // okomiti segment odlomljene znamenke visok je oko pola znamenke, pa i on pripada redu
    const row = bestRow(sd, (r) => cy >= r.y0 && cy <= r.y1 && hh >= (r.y1 - r.y0 + 1) * 0.35);
    if (row) { row.members.push(sd); row.y0 = Math.min(row.y0, sd.y0); row.y1 = Math.max(row.y1, sd.y1); }
    else rows.push({ y0: sd.y0, y1: sd.y1, members: [sd] });
  }
  // ostali dijelovi (vodoravni segmenti, odlomljeni kutovi) pridružuju se redu koji ih vertikalno pokriva
  for (const b of parts) {
    if (seeds.includes(b)) continue;
    const cy = (b.y0 + b.y1) / 2;
    const row = bestRow(b, (r) => cy >= r.y0 - (r.y1 - r.y0) * 0.1 && cy <= r.y1 + (r.y1 - r.y0) * 0.1);
    if (row) row.members.push(b);
  }
  const cands: number[][] = [];
  const allCells: number[][] = [];
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
      // dijelovi iste znamenke i okomito se dodiruju ili gotovo dodiruju; ikona ispod znamenke (srce ispod „9”) ne
      const vgap = last ? Math.max(m.y0 - last.y1, last.y0 - m.y1) : 0;
      if (last && overlap >= minW * 0.3 && vgap <= H * 0.12) { last.x1 = Math.max(last.x1, m.x1); last.y0 = Math.min(last.y0, m.y0); last.y1 = Math.max(last.y1, m.y1); last.area += m.area; }
      else cells.push({ ...m });
    }
    // ćelija je znamenka ako je uspravna i nije puna mrlja (7-seg dekoder bi punu mrlju pročitao kao 8)
    // preširoka ćelija (kose znamenke „1” i „2” spojene dilatacijom) dijeli se na najpraznijem stupcu
    // nedilatirane tinte, ako je ondje projekcija gotovo prazna
    const splitCells: Box[] = [];
    for (const c of cells) {
      const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
      if (cw / ch > 0.72 && cw > 8) {
        const prof = new Uint16Array(cw);
        let maxV = 0, bestX = -1, bestV = Infinity;
        for (let x = c.x0; x <= c.x1; x++) { let n = 0; for (let y = c.y0; y <= c.y1; y++) n += ink[y * sw + x]; prof[x - c.x0] = n; if (n > maxV) maxV = n; }
        for (let x = Math.round(cw * 0.15); x <= Math.round(cw * 0.85); x++) if (prof[x] < bestV) { bestV = prof[x]; bestX = x; }
        if (bestX > 0 && bestV <= maxV * 0.2) {
          const ext = (x0: number, x1: number): Box | null => {
            let y0 = c.y1, y1 = c.y0, area = 0;
            for (let y = c.y0; y <= c.y1; y++) for (let x = x0; x <= x1; x++) if (ink[y * sw + x]) { area++; if (y < y0) y0 = y; if (y > y1) y1 = y; }
            return area ? { x0, x1, y0, y1, area } : null;
          };
          const l = ext(c.x0, c.x0 + bestX - 1), r = ext(c.x0 + bestX + 1, c.x1);
          if (l) splitCells.push(l);
          if (r) splitCells.push(r);
          continue;
        }
      }
      splitCells.push(c);
    }
    const glyphs: Glyph[] = [];
    for (const c of splitCells) {
      const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
      allCells.push([row.y0, c.x0, c.y0, c.x1, c.y1]);
      if (ch < H * 0.55) continue;
      const aspect = ch / cw, fill = c.area / (cw * ch);
      cands.push([c.x0, c.y0, c.x1, c.y1, +fill.toFixed(2)]);
      if (aspect < 1.05 || aspect > 7) continue;
      if (aspect < 2.8 && fill > 0.85) continue; // puna mrlja (ikona, pravokutnik); debela „8” ima udio tinte do ~0,8
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
    reads.push({ boxes: used.map((k) => ({ x0: k.x0, y0: k.y0, x1: k.x1, y1: k.y1, area: 0, digit: PATTERNS[k.segs] })), value, y0, y1, height: y1 - y0 + 1 });
  }
  debug?.({ win: winFrac, size: [sw, sh], cells: allCells, comps: comps.map((b) => [b.x0, b.y0, b.x1, b.y1, b.area]), parts: parts.map((b) => [b.x0, b.y0, b.x1, b.y1]), rowsY: rows.map((r) => [r.y0, r.y1]), cands, rows: rows.map((r) => r.members.length), reads: reads.map((r) => [r.value, r.y0, r.y1, r.boxes.length]) });
  return reads;
}

/**
 * Spajanje redova s više binarizacija iste slike: isti red (preklapanje po visini) zadržava se jednom,
 * s više znamenki ako ih koja binarizacija nađe (npr. „111” umjesto „11”).
 */
function mergeReads(all: RowRead[]): RowRead[] {
  const out: RowRead[] = [];
  for (const r of all) {
    const same = out.findIndex((o) => Math.min(o.y1, r.y1) - Math.max(o.y0, r.y0) > Math.min(o.height, r.height) * 0.6);
    if (same < 0) { out.push(r); continue; }
    // unija znamenki obiju binarizacija (jedna nađe lijevu „1”, druga srednju): ista znamenka = preklapanje po x
    const o = out[same];
    const boxes = o.boxes.slice();
    for (const b of r.boxes) {
      const dup = boxes.some((x) => Math.min(x.x1, b.x1) - Math.max(x.x0, b.x0) + 1 >= Math.min(x.x1 - x.x0, b.x1 - b.x0) * 0.5);
      if (!dup) boxes.push(b);
    }
    boxes.sort((a, b) => a.x0 - b.x0);
    const used = boxes.slice(-3);
    const y0 = Math.min(...used.map((k) => k.y0)), y1 = Math.max(...used.map((k) => k.y1));
    out[same] = { boxes: used, value: Number(used.map((k) => k.digit).join('')), y0, y1, height: y1 - y0 + 1 };
  }
  return out;
}

/** Pomak redova (iz koordinata pod-izreza u koordinate proširenog izreza). */
function shiftReads(reads: RowRead[], dx: number, dy: number): RowRead[] {
  return reads.map((r) => ({ ...r, y0: r.y0 + dy, y1: r.y1 + dy, boxes: r.boxes.map((b) => ({ ...b, x0: b.x0 + dx, x1: b.x1 + dx, y0: b.y0 + dy, y1: b.y1 + dy })) }));
}

/** Izbor tri reda (SYS, DIA, puls) i okvira iz nađenih redova. */
function choose(reads: RowRead[], sw: number, sh: number): AutoDetectResult | null {
  if (reads.length < 2) return null;
  reads = reads.slice().sort((a, b) => a.y0 - b.y0);
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
  const y0 = best.s.y0, y1 = best.p ? best.p.y1 : best.d.y1 + best.d.height * 1.5;
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
