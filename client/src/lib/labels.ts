import type { ArmLocation, BodyPosition, EventType, MedicationTiming, Period, Source } from '../types.ts';

export const PERIOD_LABEL: Record<Period, string> = { morning: 'Jutro', evening: 'Večer', other: 'Drugo' };
export const SOURCE_LABEL: Record<Source, string> = {
  manual: 'Ručno', camera: 'Fotografija', gallery: 'Fotografija (galerija)', import: 'Uvoz', device: 'Uređaj',
};
export const TIMING_LABEL: Record<MedicationTiming, string> = {
  before: 'Prije terapije',
  within1h: 'Do 1 h nakon terapije',
  '1to4h': '1–4 h nakon terapije',
  over4h: 'Više od 4 h nakon terapije',
  unknown: 'Nepoznato',
};
export const ARM_LABEL: Record<ArmLocation, string> = {
  left_upper: 'Lijeva nadlaktica', right_upper: 'Desna nadlaktica', left_wrist: 'Lijevo zapešće', right_wrist: 'Desno zapešće', unknown: 'Nije zabilježeno',
};
export const POSITION_LABEL: Record<BodyPosition, string> = { sitting: 'Sjedeći', standing: 'Stojeći', lying: 'Ležeći', unknown: 'Nije zabilježeno' };
export const EVENT_LABEL: Record<EventType, string> = {
  medication_change: 'Promjena lijeka', dose_change: 'Promjena doze', illness: 'Početak bolesti', travel: 'Putovanje',
  lab: 'Laboratorijska kontrola', doctor: 'Liječnički pregled', other: 'Drugi važan događaj',
};
