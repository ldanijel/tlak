import type { Measurement } from '../types.ts';
import { fmtDate, fmtTime, fromInputs } from './format.ts';
import { pulsePressure, meanArterialPressure } from './stats.ts';

export const CSV_HEADERS = [
  'datum', 'vrijeme', 'sys', 'dia', 'puls', 'razdoblje', 'terapija', 'izvor', 'ukljuceno_u_prosjek', 'razlog_iskljucenja',
  'ruka', 'polozaj', 'simptomi', 'oznake', 'biljeska', 'pulsni_tlak_izracun', 'map_izracun', 'id',
];

function esc(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV s točkom-zarezom (Excel u hrvatskim postavkama), UTF-8 BOM. */
export function toCsv(ms: Measurement[]): string {
  const rows = [CSV_HEADERS.join(';')];
  for (const m of ms) {
    rows.push([
      fmtDate(m.measuredAt), fmtTime(m.measuredAt), m.systolic, m.diastolic, m.pulse, m.period, m.medicationTiming, m.source,
      m.includedInAverage ? 'da' : 'ne', m.exclusionReason, m.armLocation, m.bodyPosition, m.symptoms.join(', '), m.tags.join(', '), m.notes,
      pulsePressure(m), meanArterialPressure(m).toFixed(1), m.id,
    ].map(esc).join(';'));
  }
  return '﻿' + rows.join('\r\n');
}

export const CSV_TEMPLATE = '﻿datum;vrijeme;sys;dia;puls;razdoblje;biljeska\r\n06.09.2026.;07:30;128;82;66;jutro;primjer retka\r\n';

export interface CsvRow { measuredAt: string; systolic: number; diastolic: number; pulse: number; period: Measurement['period']; notes: string; line: number }
export interface CsvParseResult { rows: CsvRow[]; errors: string[] }

function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseDate(s: string): string | null {
  const t = s.trim().replace(/\.$/, '');
  let m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return t;
  return null;
}

export function parseCsv(text: string): CsvParseResult {
  const errors: string[] = [];
  const rows: CsvRow[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows, errors: ['Datoteka je prazna.'] };
  const sep = lines[0].includes(';') ? ';' : ',';
  const header = splitLine(lines[0], sep).map((h) => h.trim().toLowerCase());
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
  const iDate = idx(['datum', 'date']), iTime = idx(['vrijeme', 'time']), iSys = idx(['sys', 'systolic', 'sistolicki']),
    iDia = idx(['dia', 'diastolic', 'dijastolicki']), iPulse = idx(['puls', 'pulse', 'hr']), iPeriod = idx(['razdoblje', 'period']), iNotes = idx(['biljeska', 'bilješka', 'notes', 'napomena']);
  if (iDate < 0 || iSys < 0 || iDia < 0 || iPulse < 0) {
    return { rows, errors: ['Zaglavlje mora sadržavati stupce: datum, vrijeme, sys, dia, puls (prema predlošku).'] };
  }
  lines.slice(1).forEach((line, i) => {
    const n = i + 2;
    const c = splitLine(line, sep);
    const date = parseDate(c[iDate] || '');
    const time = (c[iTime] || '00:00').trim();
    if (!date || !/^\d{1,2}:\d{2}/.test(time)) { errors.push(`Redak ${n}: neispravan datum ili vrijeme.`); return; }
    const num = (s: string | undefined) => { const v = Number((s || '').trim()); return Number.isInteger(v) && v > 0 ? v : null; };
    const sys = num(c[iSys]), dia = num(c[iDia]), pulse = num(c[iPulse]);
    if (sys === null || dia === null || pulse === null) { errors.push(`Redak ${n}: SYS, DIA i puls moraju biti cijeli brojevi.`); return; }
    const p = (c[iPeriod] || '').trim().toLowerCase();
    const period: Measurement['period'] = p.startsWith('jut') || p === 'morning' ? 'morning' : p.startsWith('ve') || p === 'evening' ? 'evening' : 'other';
    rows.push({ measuredAt: fromInputs(date, time.slice(0, 5)).toISOString(), systolic: sys, diastolic: dia, pulse, period, notes: (c[iNotes] || '').trim(), line: n });
  });
  return { rows, errors };
}
