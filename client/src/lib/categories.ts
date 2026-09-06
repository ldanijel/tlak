import type { BpCategory, CategoryThresholds } from '../types.ts';

export const CATEGORY_LABEL: Record<BpCategory, string> = { normal: 'Nepovišeni tlak', elevated: 'Povišeni tlak', high: 'Visoki tlak' };
export const CATEGORY_SHORT: Record<BpCategory, string> = { normal: 'Nepovišen', elevated: 'Povišen', high: 'Visok' };
export const CATEGORY_ICON: Record<BpCategory, string> = { normal: '●', elevated: '▲', high: '■' };

/**
 * Kategorija prema ESC pragovima za kućno mjerenje. Gleda se SYS i DIA zasebno, a vrijedi
 * lošija od dviju kategorija (npr. 118/71 je „povišeni” zbog DIA, iako je SYS < 120).
 */
export function categorize(systolic: number, diastolic: number, t: CategoryThresholds): BpCategory {
  const sys: BpCategory = systolic >= t.highSys ? 'high' : systolic >= t.elevatedSys ? 'elevated' : 'normal';
  const dia: BpCategory = diastolic >= t.highDia ? 'high' : diastolic >= t.elevatedDia ? 'elevated' : 'normal';
  const rank: Record<BpCategory, number> = { normal: 0, elevated: 1, high: 2 };
  return rank[sys] >= rank[dia] ? sys : dia;
}

export function categoryRangeText(c: BpCategory, t: CategoryThresholds): string {
  switch (c) {
    case 'normal': return `SYS < ${t.elevatedSys} i DIA < ${t.elevatedDia}`;
    case 'elevated': return `SYS ${t.elevatedSys}–${t.highSys - 1} ili DIA ${t.elevatedDia}–${t.highDia - 1}`;
    case 'high': return `SYS ≥ ${t.highSys} ili DIA ≥ ${t.highDia}`;
  }
}
