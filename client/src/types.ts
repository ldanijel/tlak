export type Source = 'manual' | 'camera' | 'gallery' | 'import' | 'device';
export type Period = 'morning' | 'evening' | 'other';
export type MedicationTiming = 'before' | 'within1h' | '1to4h' | 'over4h' | 'unknown';
export type ArmLocation = 'left_upper' | 'right_upper' | 'left_wrist' | 'right_wrist' | 'unknown';
export type BodyPosition = 'sitting' | 'standing' | 'lying' | 'unknown';

/** Zajednička polja svih sinkroniziranih zapisa. */
export interface SyncBase {
  id: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Measurement extends SyncBase {
  measuredAt: string; // ISO 8601 (UTC)
  timezone: string; // IANA zona u trenutku mjerenja
  systolic: number;
  diastolic: number;
  pulse: number;
  source: Source;
  period: Period;
  sessionId: string | null;
  armLocation: ArmLocation;
  bodyPosition: BodyPosition;
  medicationTiming: MedicationTiming;
  deviceId: string | null;
  symptoms: string[];
  tags: string[];
  notes: string;
  includedInAverage: boolean;
  exclusionReason: string;
  ocrConfidence: { systolic: number; diastolic: number; pulse: number } | null;
  confirmedUnusual: boolean;
}

export interface TargetBounds {
  sysMin: number;
  sysMax: number;
  diaMin: number;
  diaMax: number;
  pulseMin: number | null;
  pulseMax: number | null;
}

export interface Target extends SyncBase, TargetBounds {
  effectiveFrom: string; // YYYY-MM-DD
  morning: TargetBounds | null;
  evening: TargetBounds | null;
  note: string;
}

export interface Device extends SyncBase {
  name: string;
  cuff: 'upper_arm' | 'wrist';
  note: string;
}

export interface Medication extends SyncBase {
  name: string;
  dose: string;
  schedule: string;
  startDate: string; // YYYY-MM-DD
  endDate: string | null;
  note: string;
}

export type EventType = 'medication_change' | 'dose_change' | 'illness' | 'travel' | 'lab' | 'doctor' | 'other';

export interface HealthEvent extends SyncBase {
  date: string; // YYYY-MM-DD
  type: EventType;
  title: string;
  note: string;
}

/** Ostali sigurnosni pragovi (niske vrijednosti i puls); gornji prag je kategorija „vrlo visoki”. */
export interface SafetyThresholds {
  sysLow: number;
  diaLow: number;
  pulseHigh: number;
  pulseLow: number;
}

/** Pragovi kategorija kućnog tlaka (zadano prema ESC smjernicama za kućno mjerenje). */
export interface CategoryThresholds {
  elevatedSys: number; // od ove vrijednosti: povišeni
  elevatedDia: number;
  highSys: number; // od ove vrijednosti: visoki
  highDia: number;
  veryHighSys: number; // od ove vrijednosti: vrlo visoki (sigurnosna poruka, ponoviti mjerenje, 112 uz simptome)
  veryHighDia: number;
}

export type BpCategory = 'normal' | 'elevated' | 'high' | 'veryhigh';

export interface Settings extends SyncBase {
  profileName: string;
  profileBirthYear: string;
  safety: SafetyThresholds;
  categories: CategoryThresholds;
  showChecklist: boolean;
  movingAverage: boolean;
  sessionWindowMinutes: number;
  backupReminderDays: number;
}

/** Naučeni OCR model po tlakomjeru (predlošci znamenki, raspored zaslona). */
export interface OcrModel extends SyncBase {
  deviceId: string;
  samples: Record<string, string[]>;
  variantWins: Record<string, number>;
  photos: number;
  layout: { rect: { x: number; y: number; w: number; h: number }; dividers: [number, number] } | null;
  positions?: Record<string, { n: number; xStart: number; xEnd: number; yCenter: number; height: number; digits: number }>;
}

export type Collection = 'measurements' | 'targets' | 'devices' | 'medications' | 'events' | 'settings' | 'ocrModels';

export interface CollectionMap {
  measurements: Measurement;
  targets: Target;
  devices: Device;
  medications: Medication;
  events: HealthEvent;
  settings: Settings;
  ocrModels: OcrModel;
}

export const COLLECTIONS: Collection[] = ['measurements', 'targets', 'devices', 'medications', 'events', 'settings', 'ocrModels'];

export const DEFAULT_SAFETY: SafetyThresholds = {
  sysLow: 90,
  diaLow: 60,
  pulseHigh: 120,
  pulseLow: 45,
};

export const DEFAULT_CATEGORIES: CategoryThresholds = { elevatedSys: 120, elevatedDia: 70, highSys: 135, highDia: 85, veryHighSys: 180, veryHighDia: 120 };

export const TECHNICAL_RANGE = {
  systolic: [50, 260],
  diastolic: [30, 160],
  pulse: [25, 220],
} as const;

export const SYMPTOMS = ['glavobolja', 'vrtoglavica', 'lupanje srca', 'bol u prsima', 'zaduha', 'umor', 'mučnina', 'smetnje vida'];
export const TAGS = ['nakon aktivnosti', 'stres', 'nedovoljno odmora', 'kava', 'alkohol', 'bolest', 'putovanje'];
