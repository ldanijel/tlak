import type { Measurement, Target } from '../types.ts';
import { localDayKey } from './format.ts';
import { inRange, previousRange, type DateRange } from './periods.ts';
import { classify } from './targets.ts';

export interface MinAvgMax { min: number | null; avg: number | null; max: number | null; n: number }

export function minAvgMax(values: number[]): MinAvgMax {
  if (!values.length) return { min: null, avg: null, max: null, n: 0 };
  let min = Infinity, max = -Infinity, sum = 0;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; sum += v; }
  return { min, avg: sum / values.length, max, n: values.length };
}

export interface Summary {
  count: number;
  countAll: number;
  days: number;
  sys: MinAvgMax;
  dia: MinAvgMax;
  pulse: MinAvgMax;
  morningSys: MinAvgMax;
  morningDia: MinAvgMax;
  eveningSys: MinAvgMax;
  eveningDia: MinAvgMax;
  inTargetShare: number | null;
  delta: { sys: number | null; dia: number | null; pulse: number | null } | null;
}

export function active(ms: Measurement[]): Measurement[] {
  return ms.filter((m) => !m.deletedAt);
}

export function analyzed(ms: Measurement[]): Measurement[] {
  return ms.filter((m) => !m.deletedAt && m.includedInAverage);
}

export function summarize(all: Measurement[], range: DateRange, targets: Target[], withDelta = true): Summary {
  const inR = active(all).filter((m) => inRange(m.measuredAt, range));
  const inc = inR.filter((m) => m.includedInAverage);
  const morning = inc.filter((m) => m.period === 'morning');
  const evening = inc.filter((m) => m.period === 'evening');
  const days = new Set(inR.map((m) => localDayKey(m.measuredAt))).size;
  const withTarget = inc.map((m) => classify(m, targets)).filter((s) => s !== 'none');
  const inTarget = withTarget.filter((s) => s === 'in').length;
  const cur = {
    sys: minAvgMax(inc.map((m) => m.systolic)),
    dia: minAvgMax(inc.map((m) => m.diastolic)),
    pulse: minAvgMax(inc.map((m) => m.pulse)),
  };
  let delta: Summary['delta'] = null;
  if (withDelta) {
    const prev = summarize(all, previousRange(range), targets, false);
    const d = (a: number | null, b: number | null) => (a !== null && b !== null ? a - b : null);
    delta = prev.count ? { sys: d(cur.sys.avg, prev.sys.avg), dia: d(cur.dia.avg, prev.dia.avg), pulse: d(cur.pulse.avg, prev.pulse.avg) } : null;
  }
  return {
    count: inc.length,
    countAll: inR.length,
    days,
    ...cur,
    morningSys: minAvgMax(morning.map((m) => m.systolic)),
    morningDia: minAvgMax(morning.map((m) => m.diastolic)),
    eveningSys: minAvgMax(evening.map((m) => m.systolic)),
    eveningDia: minAvgMax(evening.map((m) => m.diastolic)),
    inTargetShare: withTarget.length ? inTarget / withTarget.length : null,
    delta,
  };
}

/** Izvedeni pokazatelji – izračuni, ne izmjerene vrijednosti. */
export function pulsePressure(m: Pick<Measurement, 'systolic' | 'diastolic'>): number {
  return m.systolic - m.diastolic;
}
export function meanArterialPressure(m: Pick<Measurement, 'systolic' | 'diastolic'>): number {
  return m.diastolic + (m.systolic - m.diastolic) / 3;
}

export interface Session {
  id: string;
  measurements: Measurement[]; // kronološki
  sys: MinAvgMax;
  dia: MinAvgMax;
  pulse: MinAvgMax;
  spanMinutes: number;
}

/** Grupira mjerenja unutar zadanog prozora (zadano 10 min) u sesije. */
export function groupSessions(ms: Measurement[], windowMinutes = 10): Session[] {
  const sorted = active(ms).slice().sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  const sessions: Session[] = [];
  let current: Measurement[] = [];
  const flush = () => {
    if (!current.length) return;
    const inc = current.filter((m) => m.includedInAverage);
    const first = new Date(current[0].measuredAt).getTime();
    const last = new Date(current[current.length - 1].measuredAt).getTime();
    sessions.push({
      id: current[0].sessionId || current[0].id,
      measurements: current,
      sys: minAvgMax(inc.map((m) => m.systolic)),
      dia: minAvgMax(inc.map((m) => m.diastolic)),
      pulse: minAvgMax(inc.map((m) => m.pulse)),
      spanMinutes: Math.round((last - first) / 60000),
    });
    current = [];
  };
  for (const m of sorted) {
    if (current.length) {
      const prev = new Date(current[current.length - 1].measuredAt).getTime();
      if (new Date(m.measuredAt).getTime() - prev > windowMinutes * 60000) flush();
    }
    current.push(m);
  }
  flush();
  return sessions;
}

/** Pomični prosjek po danima (prozor u danima), vraća točke (dan, prosjek). */
export function movingAverage(points: { t: number; v: number }[], windowDays = 7): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  const win = windowDays * 86400e3;
  const sorted = points.slice().sort((a, b) => a.t - b.t);
  let start = 0, sum = 0;
  for (let i = 0; i < sorted.length; i++) {
    sum += sorted[i].v;
    while (sorted[i].t - sorted[start].t > win) { sum -= sorted[start].v; start++; }
    out.push({ t: sorted[i].t, v: sum / (i - start + 1) });
  }
  return out;
}

/** Dnevni prosjeci (za usporedbu CSV-a i grafa). */
export function dailyAverages(ms: Measurement[]): { day: string; sys: number; dia: number; pulse: number; n: number }[] {
  const map = new Map<string, Measurement[]>();
  for (const m of analyzed(ms)) {
    const k = localDayKey(m.measuredAt);
    (map.get(k) || map.set(k, []).get(k)!).push(m);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, list]) => ({
    day,
    sys: minAvgMax(list.map((m) => m.systolic)).avg!,
    dia: minAvgMax(list.map((m) => m.diastolic)).avg!,
    pulse: minAvgMax(list.map((m) => m.pulse)).avg!,
    n: list.length,
  }));
}
