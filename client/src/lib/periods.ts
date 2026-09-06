import type { Period } from '../types.ts';

export type RangeKey = '7d' | '28d' | '90d' | '180d' | '1y' | 'ytd' | 'all' | 'custom';

export const RANGE_LABEL: Record<RangeKey, string> = {
  '7d': '7 dana', '28d': '4 tjedna', '90d': '3 mjeseca', '180d': '6 mjeseci', '1y': '1 godina', ytd: 'Tekuća godina', all: 'Sve', custom: 'Prilagođeno',
};

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
    case '7d': return days(7);
    case '28d': return days(28);
    case '90d': return days(90);
    case '180d': return days(180);
    case '1y': return days(365);
    case 'ytd': return { from: new Date(now.getFullYear(), 0, 1), to };
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
