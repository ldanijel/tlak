import type { Period } from '../types.ts';

export type RangeKey = 'day' | 'week' | 'month' | '3m' | '6m' | 'year' | 'all' | 'custom';

/** Kratke oznake za zaslon (D / T / M / 3M / 6M / G) i puni nazivi za pristupačnost. */
export const RANGE_SHORT: Record<RangeKey, string> = { day: 'D', week: 'T', month: 'M', '3m': '3M', '6m': '6M', year: 'G', all: 'Sve', custom: '…' };
export const RANGE_LABEL: Record<RangeKey, string> = {
  day: 'Dan', week: 'Tjedan', month: 'Mjesec', '3m': '3 mjeseca', '6m': '6 mjeseci', year: 'Godina', all: 'Sve', custom: 'Prilagođeno',
};
export const MAIN_RANGES: RangeKey[] = ['day', 'week', 'month', '3m', '6m', 'year'];

export interface DateRange { from: Date; to: Date }

export function suggestPeriod(d: Date): Period {
  const h = d.getHours();
  if (h >= 4 && h < 12) return 'morning';
  if (h >= 17 && h < 24) return 'evening';
  return 'other';
}

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export function resolveRange(key: RangeKey, now = new Date(), custom?: DateRange, earliest?: Date | null): DateRange {
  const to = endOfDay(now);
  const days = (n: number) => {
    const from = startOfDay(now);
    from.setDate(from.getDate() - (n - 1));
    return { from, to };
  };
  switch (key) {
    case 'day': return days(1);
    case 'week': return days(7);
    case 'month': return days(30);
    case '3m': return days(90);
    case '6m': return days(180);
    case 'year': return days(365);
    case 'all': return { from: earliest ? startOfDay(earliest) : new Date(2000, 0, 1), to };
    case 'custom': return custom ? { from: startOfDay(custom.from), to: endOfDay(custom.to) } : days(7);
  }
}

/** Prethodno usporedivo razdoblje jednake duljine, neposredno prije zadanog. */
export function previousRange(r: DateRange): DateRange {
  const len = r.to.getTime() - r.from.getTime();
  const to = new Date(r.from.getTime() - 1);
  const from = new Date(to.getTime() - len);
  return { from, to };
}

export function inRange(iso: string, r: DateRange): boolean {
  const t = new Date(iso).getTime();
  return t >= r.from.getTime() && t <= r.to.getTime();
}
