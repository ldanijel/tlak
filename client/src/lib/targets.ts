import type { Measurement, Period, Target, TargetBounds } from '../types.ts';
import { localDayKey } from './format.ts';

export type TargetStatus = 'in' | 'above' | 'below' | 'none';

/** Cilj koji je vrijedio na zadani datum (posljednji s effectiveFrom <= datum). */
export function targetFor(targets: Target[], isoDate: string): Target | null {
  const day = localDayKey(isoDate);
  let best: Target | null = null;
  for (const t of targets) {
    if (t.deletedAt) continue;
    if (t.effectiveFrom <= day && (!best || t.effectiveFrom > best.effectiveFrom)) best = t;
  }
  return best;
}

export function boundsFor(target: Target | null, period: Period): TargetBounds | null {
  if (!target) return null;
  if (period === 'morning' && target.morning) return target.morning;
  if (period === 'evening' && target.evening) return target.evening;
  return target;
}

export function classify(m: Pick<Measurement, 'systolic' | 'diastolic' | 'measuredAt' | 'period'>, targets: Target[]): TargetStatus {
  const b = boundsFor(targetFor(targets, m.measuredAt), m.period);
  if (!b) return 'none';
  if (m.systolic > b.sysMax || m.diastolic > b.diaMax) return 'above';
  if (m.systolic < b.sysMin || m.diastolic < b.diaMin) return 'below';
  return 'in';
}

export const STATUS_LABEL: Record<TargetStatus, string> = {
  in: 'Unutar cilja', above: 'Iznad cilja', below: 'Ispod cilja', none: 'Cilj nije postavljen',
};
