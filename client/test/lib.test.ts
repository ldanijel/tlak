import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, groupSessions, pulsePressure, meanArterialPressure, dailyAverages } from '../src/lib/stats.ts';
import { validateDraft, hasErrors, needsConfirm } from '../src/lib/validation.ts';
import { parseCsv, toCsv } from '../src/lib/csv.ts';
import { targetFor, classify } from '../src/lib/targets.ts';
import { parseReading } from '../src/ocr/parse.ts';
import { resolveRange, previousRange, suggestPeriod } from '../src/lib/periods.ts';
import { fmtDate, fmtTime } from '../src/lib/format.ts';
import { DEFAULT_SAFETY, type Measurement, type Target } from '../src/types.ts';

const m = (over: Partial<Measurement>): Measurement => ({
  id: over.id || Math.random().toString(36).slice(2), createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', deletedAt: null,
  measuredAt: '2026-09-01T06:00:00.000Z', timezone: 'Europe/Zagreb', systolic: 120, diastolic: 80, pulse: 70, source: 'manual', period: 'morning',
  sessionId: null, armLocation: 'unknown', bodyPosition: 'unknown', medicationTiming: 'unknown', deviceId: null, symptoms: [], tags: [], notes: '',
  includedInAverage: true, exclusionReason: '', ocrConfidence: null, confirmedUnusual: false, ...over,
});
const target: Target = { id: 't1', createdAt: '', updatedAt: '', deletedAt: null, effectiveFrom: '2026-01-01', sysMin: 100, sysMax: 135, diaMin: 60, diaMax: 85, pulseMin: null, pulseMax: null, morning: null, evening: null, note: '' };

test('format: dd.mm.gggg. i 24-satno vrijeme', () => {
  const d = new Date(2026, 8, 6, 19, 5);
  assert.equal(fmtDate(d), '06.09.2026.');
  assert.equal(fmtTime(d), '19:05');
});

test('sažetak: prosjeci, jutro/večer, cilj, prethodno razdoblje', () => {
  const list = [
    m({ measuredAt: '2026-09-01T06:00:00.000Z', systolic: 120, diastolic: 80, pulse: 60, period: 'morning' }),
    m({ measuredAt: '2026-09-01T18:00:00.000Z', systolic: 140, diastolic: 90, pulse: 80, period: 'evening' }),
    m({ measuredAt: '2026-09-02T06:00:00.000Z', systolic: 130, diastolic: 85, pulse: 70, period: 'morning', includedInAverage: false }),
    m({ measuredAt: '2026-08-20T06:00:00.000Z', systolic: 150, diastolic: 95, pulse: 70, period: 'morning' }),
  ];
  const range = { from: new Date('2026-08-27T00:00:00Z'), to: new Date('2026-09-03T00:00:00Z') };
  const s = summarize(list, range, [target]);
  assert.equal(s.count, 2);
  assert.equal(s.countAll, 3);
  assert.equal(s.days, 2);
  assert.equal(s.sys.avg, 130);
  assert.equal(s.dia.min, 80);
  assert.equal(s.morningSys.avg, 120);
  assert.equal(s.eveningSys.avg, 140);
  assert.equal(s.inTargetShare, 0.5);
  assert.equal(s.delta?.sys, 130 - 150);
});

test('sesije: grupiranje unutar 10 minuta, isključeno mjerenje ne ulazi u prosjek', () => {
  const list = [
    m({ measuredAt: '2026-09-01T06:00:00.000Z', systolic: 140 }),
    m({ measuredAt: '2026-09-01T06:03:00.000Z', systolic: 130 }),
    m({ measuredAt: '2026-09-01T06:06:00.000Z', systolic: 120, includedInAverage: false, exclusionReason: 'x' }),
    m({ measuredAt: '2026-09-01T07:00:00.000Z', systolic: 125 }),
  ];
  const s = groupSessions(list, 10);
  assert.equal(s.length, 2);
  assert.equal(s[0].measurements.length, 3);
  assert.equal(s[0].sys.avg, 135);
  assert.equal(s[0].spanMinutes, 6);
});

test('izvedeni pokazatelji', () => {
  assert.equal(pulsePressure({ systolic: 120, diastolic: 80 }), 40);
  assert.ok(Math.abs(meanArterialPressure({ systolic: 120, diastolic: 80 }) - 93.33) < 0.01);
});

test('validacija: nedostaje, SYS<=DIA, raspon, duplikat, sigurnosna poruka, cilj', () => {
  const base = { measuredAt: '2026-09-01T06:00:00.000Z', period: 'morning' as const };
  const opts = { existing: [m({ measuredAt: '2026-09-01T06:00:00.000Z', systolic: 120, diastolic: 80, pulse: 70 })], targets: [target], safety: DEFAULT_SAFETY };
  assert.ok(hasErrors(validateDraft({ ...base, systolic: 120, diastolic: null, pulse: 70 }, opts)));
  const swapped = validateDraft({ ...base, systolic: 80, diastolic: 120, pulse: 70 }, opts);
  assert.ok(swapped.some((x) => x.suggestSwap));
  const hi = validateDraft({ ...base, measuredAt: '2026-09-01T09:00:00.000Z', systolic: 185, diastolic: 95, pulse: 70 }, opts);
  assert.ok(hi.some((x) => x.level === 'safety'));
  assert.ok(needsConfirm(hi));
  const dup = validateDraft({ ...base, systolic: 120, diastolic: 80, pulse: 70 }, opts);
  assert.ok(dup.some((x) => x.code === 'same_time') && dup.some((x) => x.code === 'duplicate_values'));
  const outOfRange = validateDraft({ ...base, measuredAt: '2026-09-01T10:00:00.000Z', systolic: 300, diastolic: 80, pulse: 70 }, opts);
  assert.ok(outOfRange.some((x) => x.code === 'out_of_technical_range'));
  const above = validateDraft({ ...base, measuredAt: '2026-09-01T11:00:00.000Z', systolic: 150, diastolic: 80, pulse: 70 }, opts);
  assert.ok(above.some((x) => x.code === 'above_target'));
});

test('ciljevi: vrijedi cilj na snazi na datum mjerenja', () => {
  const t2: Target = { ...target, id: 't2', effectiveFrom: '2026-09-01', sysMax: 125 };
  assert.equal(targetFor([target, t2], '2026-08-15T10:00:00.000Z')?.id, 't1');
  assert.equal(targetFor([target, t2], '2026-09-05T10:00:00.000Z')?.id, 't2');
  assert.equal(classify({ systolic: 130, diastolic: 80, measuredAt: '2026-09-05T10:00:00.000Z', period: 'other' }, [target, t2]), 'above');
  assert.equal(classify({ systolic: 130, diastolic: 80, measuredAt: '2026-08-05T10:00:00.000Z', period: 'other' }, [target, t2]), 'in');
});

test('CSV: izvoz pa uvoz daje iste prosjeke kao graf', () => {
  const list = [
    m({ measuredAt: new Date(2026, 8, 1, 7, 0).toISOString(), systolic: 121, diastolic: 81, pulse: 61 }),
    m({ measuredAt: new Date(2026, 8, 1, 21, 0).toISOString(), systolic: 139, diastolic: 89, pulse: 79, period: 'evening', notes: 'bilješka; sa "navodnicima"' }),
  ];
  const csv = toCsv(list);
  const parsed = parseCsv(csv);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[1].notes, 'bilješka; sa "navodnicima"');
  const daily = dailyAverages(list);
  const avgCsv = parsed.rows.reduce((a, r) => a + r.systolic, 0) / parsed.rows.length;
  assert.equal(daily[0].sys, avgCsv);
  const tpl = parseCsv('datum;vrijeme;sys;dia;puls;razdoblje;biljeska\n06.09.2026.;07:30;128;82;66;jutro;x\nloš;;;;;;');
  assert.equal(tpl.rows.length, 1);
  assert.equal(tpl.rows[0].period, 'morning');
  assert.equal(tpl.errors.length, 1);
});

test('OCR parsiranje: gornji → SYS, srednji → DIA, donji → puls; sitni brojevi zanemareni', () => {
  const tok = (text: string, y: number, h: number, conf = 90) => ({ text, conf, x0: 10, y0: y, x1: 60, y1: y + h });
  const r = parseReading([tok('128', 10, 40), tok('82', 60, 40), tok('66', 110, 30), tok('12:30', 150, 10), tok('2026', 165, 10)]);
  assert.equal(r.systolic.value, 128);
  assert.equal(r.diastolic.value, 82);
  assert.equal(r.pulse.value, 66);
  assert.ok(r.warnings.length >= 1);
  const low = parseReading([tok('128', 10, 40, 40), tok('82', 60, 40), tok('66', 110, 30)]);
  assert.equal(low.systolic.reason, 'niska pouzdanost');
  const bad = parseReading([tok('80', 10, 40), tok('120', 60, 40), tok('66', 110, 30)]);
  assert.ok(bad.warnings.some((w) => w.includes('SYS')));
  const none = parseReading([tok('7', 10, 40)]);
  assert.equal(none.systolic.value, null);
});

test('razdoblja: 7 dana, prethodno razdoblje, prijedlog jutro/večer', () => {
  const now = new Date(2026, 8, 6, 12);
  const r = resolveRange('7d', now);
  assert.equal(r.from.getDate(), 31);
  const p = previousRange(r);
  assert.ok(p.to < r.from);
  assert.equal(suggestPeriod(new Date(2026, 8, 6, 7)), 'morning');
  assert.equal(suggestPeriod(new Date(2026, 8, 6, 20)), 'evening');
  assert.equal(suggestPeriod(new Date(2026, 8, 6, 14)), 'other');
});
