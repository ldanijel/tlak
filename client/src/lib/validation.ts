import { TECHNICAL_RANGE, type CategoryThresholds, type Measurement, type SafetyThresholds, type Target } from '../types.ts';
import { classify } from './targets.ts';

export type MessageLevel = 'info' | 'warning' | 'check' | 'safety' | 'error';

export interface ValidationMessage {
  level: MessageLevel;
  code: string;
  text: string;
  /** Zahtijeva izričitu potvrdu korisnika prije spremanja. */
  requiresConfirm?: boolean;
  /** Ponuđena zamjena SYS/DIA. */
  suggestSwap?: boolean;
}

export interface Draft {
  systolic: number | null;
  diastolic: number | null;
  pulse: number | null;
  measuredAt: string;
  period: Measurement['period'];
}

export const LEVEL_LABEL: Record<MessageLevel, string> = {
  info: 'Informacija', warning: 'Upozorenje', check: 'Provjera', safety: 'Sigurnosna poruka', error: 'Greška',
};

export function validateDraft(
  d: Draft,
  opts: { existing: Measurement[]; editingId?: string | null; targets: Target[]; safety: SafetyThresholds; categories: CategoryThresholds },
): ValidationMessage[] {
  const out: ValidationMessage[] = [];
  const isInt = (v: number | null) => v !== null && Number.isInteger(v);
  if (!isInt(d.systolic) || !isInt(d.diastolic)) {
    out.push({ level: 'error', code: 'missing', text: 'Unesite SYS i DIA kao cijele brojeve. Puls je neobvezan.' });
    return out;
  }
  const sys = d.systolic!, dia = d.diastolic!, pulse = d.pulse; // puls može biti prazan

  const range = (v: number, [lo, hi]: readonly [number, number]) => v >= lo && v <= hi;
  if (!range(sys, TECHNICAL_RANGE.systolic) || !range(dia, TECHNICAL_RANGE.diastolic) || (pulse !== null && !range(pulse, TECHNICAL_RANGE.pulse))) {
    out.push({
      level: 'check', code: 'out_of_technical_range', requiresConfirm: true,
      text: `Vrijednost je izvan tehnički očekivanog raspona (SYS ${TECHNICAL_RANGE.systolic.join('–')}, DIA ${TECHNICAL_RANGE.diastolic.join('–')}, puls ${TECHNICAL_RANGE.pulse.join('–')}). Potvrdite da je podatak točan.`,
    });
  }
  if (sys <= dia) {
    out.push({
      level: 'error', code: 'sys_not_greater', suggestSwap: sys < dia,
      text: sys < dia ? 'SYS je manji od DIA. Vjerojatno su vrijednosti zamijenjene.' : 'SYS mora biti veći od DIA.',
    });
  }
  const t = new Date(d.measuredAt).getTime();
  const others = opts.existing.filter((m) => !m.deletedAt && m.id !== opts.editingId);
  if (others.some((m) => new Date(m.measuredAt).getTime() === t)) {
    out.push({ level: 'check', code: 'same_time', requiresConfirm: true, text: 'Već postoji mjerenje s istim datumom i vremenom. Potvrdite spremanje.' });
  }
  const near = others.find((m) => Math.abs(new Date(m.measuredAt).getTime() - t) <= 15 * 60000 && m.systolic === sys && m.diastolic === dia && m.pulse === pulse);
  if (near) {
    out.push({ level: 'check', code: 'duplicate_values', requiresConfirm: true, text: 'Ista kombinacija SYS/DIA/puls već je zabilježena u kratkom razmaku.' });
  }
  const s = opts.safety;
  const c = opts.categories;
  if (sys >= c.veryHighSys || dia >= c.veryHighDia) {
    out.push({
      level: 'safety', code: 'critical_high', requiresConfirm: true,
      text: `Vrlo visoki tlak (≥ ${c.veryHighSys}/${c.veryHighDia}). Odmorite 5 minuta i ponovite mjerenje. Ako imate bol u prsima, zaduhu, jaku glavoblju, smetnje vida ili govora, utrnulost ili slabost – nazovite 112.`,
    });
  } else if (sys <= s.sysLow || dia <= s.diaLow) {
    out.push({ level: 'warning', code: 'low', text: `Niska vrijednost (≤ ${s.sysLow}/${s.diaLow}). Ako imate vrtoglavicu ili slabost, ponovite mjerenje i obratite se liječniku.` });
  }
  if (pulse !== null && (pulse >= s.pulseHigh || pulse <= s.pulseLow)) {
    out.push({ level: 'warning', code: 'pulse_unusual', text: `Puls je neuobičajen (${pulse}/min). Ponovite mjerenje u mirovanju.` });
  }
  if (!out.some((m) => m.level === 'error')) {
    const status = classify({ systolic: sys, diastolic: dia, measuredAt: d.measuredAt, period: d.period }, opts.targets);
    if (status === 'above') out.push({ level: 'warning', code: 'above_target', text: 'Vrijednost je iznad osobnog ciljnog raspona.' });
    if (status === 'below') out.push({ level: 'warning', code: 'below_target', text: 'Vrijednost je ispod osobnog ciljnog raspona.' });
  }
  return out;
}

export function hasErrors(msgs: ValidationMessage[]): boolean {
  return msgs.some((m) => m.level === 'error');
}
export function needsConfirm(msgs: ValidationMessage[]): boolean {
  return msgs.some((m) => m.requiresConfirm);
}
