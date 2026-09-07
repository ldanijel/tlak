import { useMemo, useRef, useState } from 'react';
import type { HealthEvent, Measurement, Target } from '../types.ts';
import { fmtDateTime, fmtNum, fmtShortDate } from '../lib/format.ts';
import { categorizeValue } from '../lib/categories.ts';
import type { CategoryThresholds } from '../types.ts';
import { movingAverage } from '../lib/stats.ts';
import { boundsFor, targetFor } from '../lib/targets.ts';
import { EVENT_LABEL } from '../lib/labels.ts';
import type { DateRange } from '../lib/periods.ts';

/* ---------- min–AVG–max traka ---------- */
export function MinAvgMaxBar({ label, min, avg, max, domain, color }: {
  label: string; min: number | null; avg: number | null; max: number | null; domain: [number, number]; color: string;
}) {
  const W = 300, pad = 30;
  const x = (v: number) => pad + ((v - domain[0]) / (domain[1] - domain[0])) * (W - pad * 2);
  return (
    <div className="mam">
      <span className="lbl" style={{ color }}>{label}</span>
      {min === null || avg === null || max === null ? (
        <span className="muted small">nema podataka</span>
      ) : (
        <svg viewBox={`0 0 ${W} 30`} role="img" aria-label={`${label}: najmanje ${fmtNum(min)}, prosjek ${fmtNum(avg)}, najviše ${fmtNum(max)}`}>
          <line x1={pad} x2={W - pad} y1={15} y2={15} stroke="var(--border)" strokeWidth={1} />
          <line x1={x(min)} x2={x(max)} y1={15} y2={15} stroke={color} strokeWidth={6} strokeLinecap="round" opacity={0.35} />
          <circle cx={x(avg)} cy={15} r={6} fill={color} stroke="var(--surface)" strokeWidth={2} />
          <text x={x(min)} y={28} textAnchor="middle">{fmtNum(min)}</text>
          <text x={x(avg)} y={8} textAnchor="middle" fontWeight={700}>{fmtNum(avg)}</text>
          <text x={x(max)} y={28} textAnchor="middle">{fmtNum(max)}</text>
        </svg>
      )}
    </div>
  );
}

/* ---------- Raspodjela po ESC kategorijama ---------- */
export function CategoryBar({ counts }: { counts: { normal: number; elevated: number; high: number; veryhigh: number } }) {
  const total = counts.normal + counts.elevated + counts.high + counts.veryhigh;
  if (!total) return null;
  const pct = (n: number) => Math.round((n / total) * 100);
  return (
    <div>
      <div className="catbar" role="img" aria-label={`Nepovišeni ${counts.normal}, povišeni ${counts.elevated}, visoki ${counts.high}, vrlo visoki ${counts.veryhigh}`}>
        <i className="n" style={{ width: `${(counts.normal / total) * 100}%` }} />
        <i className="e" style={{ width: `${(counts.elevated / total) * 100}%` }} />
        <i className="h" style={{ width: `${(counts.high / total) * 100}%` }} />
        <i className="v" style={{ width: `${(counts.veryhigh / total) * 100}%` }} />
      </div>
      <div className="legend">
        <span><i style={{ background: 'var(--cat-normal)' }} />● Nepovišeni {counts.normal} ({pct(counts.normal)} %)</span>
        <span><i style={{ background: 'var(--cat-elevated)' }} />▲ Povišeni {counts.elevated} ({pct(counts.elevated)} %)</span>
        <span><i style={{ background: 'var(--cat-high)' }} />■ Visoki {counts.high} ({pct(counts.high)} %)</span>
        {counts.veryhigh > 0 && <span><i style={{ background: 'var(--cat-veryhigh)' }} />‼ Vrlo visoki {counts.veryhigh} ({pct(counts.veryhigh)} %)</span>}
      </div>
    </div>
  );
}

/* ---------- Vremenski graf ---------- */
type SeriesKey = 'systolic' | 'diastolic' | 'pulse';
interface Pt { t: number; v: number; m: Measurement; key: SeriesKey }

export function TimeChart({ measurements, range, targets, events = [], series, showMovingAverage, height = 240, title, categories }: {
  measurements: Measurement[]; range: DateRange; targets: Target[]; events?: HealthEvent[];
  series: SeriesKey[]; showMovingAverage?: boolean; height?: number; title: string; categories?: CategoryThresholds;
}) {
  const W = 640, H = height, padL = 36, padR = 10, padT = 14, padB = 26;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; m: Measurement } | null>(null);
  const t0 = range.from.getTime(), t1 = range.to.getTime();
  const ms = useMemo(() => measurements.filter((m) => { const t = new Date(m.measuredAt).getTime(); return t >= t0 && t <= t1; }).sort((a, b) => a.measuredAt.localeCompare(b.measuredAt)), [measurements, t0, t1]);
  const pts: Pt[] = useMemo(() => ms.flatMap((m) => series.map((key) => ({ t: new Date(m.measuredAt).getTime(), v: m[key], m, key })).filter((p): p is Pt => p.v !== null)), [ms, series]);

  // Ciljne zone po razdobljima važenja (samo za SYS/DIA graf).
  const zones = useMemo(() => {
    if (!series.includes('systolic')) return [];
    const eff = targets.filter((t) => !t.deletedAt).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    const out: { from: number; to: number; sysMin: number; sysMax: number; diaMin: number; diaMax: number }[] = [];
    for (let i = 0; i < eff.length; i++) {
      const from = Math.max(t0, new Date(eff[i].effectiveFrom).getTime());
      const to = i + 1 < eff.length ? Math.min(t1, new Date(eff[i + 1].effectiveFrom).getTime()) : t1;
      if (to <= from) continue;
      const b = boundsFor(eff[i], 'other')!;
      out.push({ from, to, sysMin: b.sysMin, sysMax: b.sysMax, diaMin: b.diaMin, diaMax: b.diaMax });
    }
    return out;
  }, [targets, series, t0, t1]);

  const vals = pts.map((p) => p.v).concat(zones.flatMap((z) => [z.sysMin, z.sysMax, z.diaMin, z.diaMax]));
  const lo = vals.length ? Math.min(...vals) : series.includes('pulse') ? 50 : 60;
  const hi = vals.length ? Math.max(...vals) : series.includes('pulse') ? 100 : 160;
  const yMin = Math.floor((lo - 8) / 10) * 10, yMax = Math.ceil((hi + 8) / 10) * 10;
  const x = (t: number) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - yMin) / Math.max(1, yMax - yMin)) * (H - padT - padB);
  const yTicks: number[] = [];
  const step = yMax - yMin > 80 ? 20 : 10;
  for (let v = yMin; v <= yMax; v += step) yTicks.push(v);
  const days = (t1 - t0) / 86400e3;
  const xTicks: number[] = [];
  const tickEvery = days <= 8 ? 1 : days <= 31 ? 7 : days <= 100 ? 14 : days <= 200 ? 30 : 60;
  for (let d = new Date(range.from); d.getTime() <= t1; d.setDate(d.getDate() + tickEvery)) xTicks.push(d.getTime());

  /** Linija je prekinuta kada između točaka prođe više od 2 dana (nedostajući podaci nisu prikazani kao neprekinuti). */
  const path = (key: SeriesKey, list: { t: number; v: number }[]) => {
    let d = '', prev: number | null = null;
    for (const p of list) {
      const gap = prev !== null && p.t - prev > 2 * 86400e3;
      d += `${!d || gap ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)} `;
      prev = p.t;
    }
    return <path key={key} className={`line ${key === 'systolic' ? 'sys' : key === 'diastolic' ? 'dia' : 'pulse'}`} d={d} />;
  };

  const included = (key: SeriesKey) => pts.filter((p) => p.key === key && p.m.includedInAverage);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!pts.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best: Pt | null = null, bd = Infinity;
    for (const p of pts) { const d = Math.abs(x(p.t) - px); if (d < bd) { bd = d; best = p; } }
    if (best && bd < 30) setHover({ x: x(best.t), y: y(best.v), m: best.m }); else setHover(null);
  };

  const colorOf = (k: SeriesKey) => (k === 'systolic' ? 'var(--sys)' : k === 'diastolic' ? 'var(--dia)' : 'var(--pulse)');
  const labelOf = (k: SeriesKey) => (k === 'systolic' ? 'SYS' : k === 'diastolic' ? 'DIA' : 'Puls');

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <g className="grid">{yTicks.map((v) => <line key={v} x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} />)}</g>
        <g className="axis">
          {yTicks.map((v) => <text key={v} x={padL - 6} y={y(v) + 4} textAnchor="end">{v}</text>)}
          {xTicks.map((t) => <text key={t} x={x(t)} y={H - 8} textAnchor="middle">{fmtShortDate(new Date(t))}</text>)}
        </g>
        {zones.map((z, i) => (
          <g key={i}>
            <rect className="zone" x={x(z.from)} width={Math.max(0, x(z.to) - x(z.from))} y={y(z.sysMax)} height={Math.max(0, y(z.sysMin) - y(z.sysMax))} />
            <rect className="zone" x={x(z.from)} width={Math.max(0, x(z.to) - x(z.from))} y={y(z.diaMax)} height={Math.max(0, y(z.diaMin) - y(z.diaMax))} />
          </g>
        ))}
        {events.filter((ev) => { const t = new Date(ev.date).getTime(); return t >= t0 && t <= t1; }).map((ev) => (
          <g key={ev.id} className="event">
            <line x1={x(new Date(ev.date).getTime())} x2={x(new Date(ev.date).getTime())} y1={padT} y2={H - padB} />
            <text x={x(new Date(ev.date).getTime()) + 3} y={padT + 10}>{(ev.title || EVENT_LABEL[ev.type]).slice(0, 18)}</text>
          </g>
        ))}
        {series.map((k) => path(k, included(k)))}
        {showMovingAverage && series.map((k) => {
          const ma = movingAverage(included(k).map((p) => ({ t: p.t, v: p.v })), 7);
          if (ma.length < 2) return null;
          return <path key={`ma-${k}`} className={`line avg ${k === 'systolic' ? 'sys' : k === 'diastolic' ? 'dia' : 'pulse'}`} d={ma.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')} />;
        })}
        {pts.map((p, i) => {
          // točke SYS i DIA obojene kategorijom te vrijednosti (zasebno za SYS i DIA); puls neutralno
          const cat = categories && p.key !== 'pulse' ? `cat-${categorizeValue(p.key === 'systolic' ? 'sys' : 'dia', p.v, categories)}` : (p.key === 'systolic' ? 'sys' : p.key === 'diastolic' ? 'dia' : 'pulse');
          return <circle key={i} className={`dot ${p.m.includedInAverage ? cat : 'excluded'}`} cx={x(p.t)} cy={y(p.v)} r={pts.length > 120 ? 3 : 4} />;
        })}
        {hover && (
          <g className="cross"><line x1={hover.x} x2={hover.x} y1={padT} y2={H - padB} /></g>
        )}
      </svg>
      {hover && (
        <div className="tooltip" style={{ left: `${(hover.x / W) * 100}%`, top: 0, transform: hover.x > W * 0.6 ? 'translateX(-105%)' : 'translateX(8px)' }}>
          <div><strong>{fmtDateTime(hover.m.measuredAt)}</strong></div>
          <div>{series.map((k) => `${labelOf(k)} ${hover.m[k] ?? '–'}`).join(' · ')}{!hover.m.includedInAverage && ' · isključeno'}</div>
        </div>
      )}
      <div className="legend" aria-hidden="true">
        {categories && series.includes('systolic') ? (
          <>
            <span>● Nepovišen</span><span style={{ color: 'var(--cat-elevated)' }}>▲ Povišen</span><span style={{ color: 'var(--cat-high)' }}>■ Visok</span><span style={{ color: 'var(--cat-veryhigh-bg)' }}>‼ Vrlo visok</span><span>(gornje točke SYS, donje DIA)</span>
          </>
        ) : series.map((k) => <span key={k}><i style={{ background: colorOf(k) }} />{labelOf(k)}</span>)}
        {zones.length > 0 && <span><i style={{ background: 'var(--target-zone)', height: 10, border: '1px solid var(--border)' }} />ciljni raspon</span>}
        {showMovingAverage && <span><i style={{ background: 'var(--text-3)' }} />7-dnevni pomični prosjek (izračun)</span>}
        <span><i style={{ background: 'var(--surface)', border: '1px solid var(--text-3)', height: 8, width: 8, borderRadius: 4 }} />isključeno iz prosjeka</span>
      </div>
    </div>
  );
}

/** Ciljne granice u legendi teksta (za čitljivost bez boje). */
export function targetText(targets: Target[], iso: string): string | null {
  const t = targetFor(targets, iso);
  if (!t) return null;
  return `${t.sysMin}–${t.sysMax} / ${t.diaMin}–${t.diaMax} mmHg`;
}
