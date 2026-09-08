import { useMemo, useState } from 'react';
import { useStore } from '../store.tsx';
import { fmtDate, fmtDateTime, fmtNum, fmtTime, toInputDate } from '../lib/format.ts';
import { MAIN_RANGES, RANGE_LABEL, RANGE_SHORT, resolveRange, inRange, type RangeKey } from '../lib/periods.ts';
import { summarize } from '../lib/stats.ts';
import { toCsv } from '../lib/csv.ts';
import { makeBackup } from '../lib/backup.ts';
import { shareOrDownload, stamp } from '../lib/share.ts';
import { PERIOD_LABEL, SOURCE_LABEL, TIMING_LABEL, EVENT_LABEL } from '../lib/labels.ts';
import { Segmented, useToast, DateInput } from '../components/ui.tsx';
import { CategoryBar, TimeChart } from '../components/charts.tsx';
import { categorize, CATEGORY_SHORT } from '../lib/categories.ts';

const RANGES: RangeKey[] = [...MAIN_RANGES, 'all', 'custom'];

export function ReportPage() {
  const { data, markBackup } = useStore();
  const toast = useToast();
  const [rangeKey, setRangeKey] = useState<RangeKey>('month');
  const [custom, setCustom] = useState({ from: toInputDate(new Date(Date.now() - 27 * 86400e3)), to: toInputDate(new Date()) });
  const [opts, setOpts] = useState({ profile: true, chart: true, list: true, notes: true, therapy: true });
  const earliest = data.measurements.length ? new Date(data.measurements[data.measurements.length - 1].measuredAt) : null;
  const range = useMemo(() => resolveRange(rangeKey, new Date(), { from: new Date(custom.from), to: new Date(custom.to) }, earliest), [rangeKey, custom, earliest]);
  const s = useMemo(() => summarize(data.measurements, range, data.targets, true, data.settings.categories), [data.measurements, range, data.targets, data.settings.categories]);
  const list = useMemo(() => data.measurements.filter((m) => inRange(m.measuredAt, range)).slice().sort((a, b) => a.measuredAt.localeCompare(b.measuredAt)), [data.measurements, range]);
  const events = data.events.filter((e) => e.date >= toInputDate(range.from) && e.date <= toInputDate(range.to));
  const meds = data.medications.filter((m) => !m.endDate || m.endDate >= toInputDate(range.from));

  const exportCsv = async () => { const r = await shareOrDownload(`tlak-${stamp()}.csv`, toCsv(list), 'text/csv;charset=utf-8'); toast.show(r === 'shared' ? 'CSV je podijeljen.' : 'CSV je preuzet.'); };
  const exportJson = async () => {
    const b = makeBackup({ measurements: data.measurements, targets: data.targets, devices: data.devices, medications: data.medications, events: data.events, settings: [data.settings], ocrModels: data.ocrModels });
    const r = await shareOrDownload(`tlak-kopija-${stamp()}.json`, JSON.stringify(b, null, 1), 'application/json');
    await markBackup();
    toast.show(r === 'shared' ? 'JSON kopija je podijeljena.' : 'JSON kopija je preuzeta.');
  };

  return (
    <main className="page">
      <div className="no-print">
        <h1>Izvještaj za liječnika</h1>
        <div className="card">
          <Segmented value={rangeKey} onChange={setRangeKey} short label="Razdoblje" options={RANGES.map((r) => ({ value: r, label: RANGE_SHORT[r], title: RANGE_LABEL[r] }))} />
          {rangeKey === 'custom' && (
            <div className="grid2">
              <div className="field"><label>Od<DateInput value={custom.from} onChange={(v) => setCustom({ ...custom, from: v })} /></label></div>
              <div className="field"><label>Do<DateInput value={custom.to} onChange={(v) => setCustom({ ...custom, to: v })} /></label></div>
            </div>
          )}
          <div className="chips" style={{ marginTop: 10 }}>
            {([['profile', 'Osobni podaci'], ['chart', 'Graf'], ['list', 'Popis mjerenja'], ['notes', 'Simptomi i bilješke'], ['therapy', 'Terapija i događaji']] as const).map(([k, l]) => (
              <button key={k} type="button" className="chip" aria-pressed={opts[k]} onClick={() => setOpts({ ...opts, [k]: !opts[k] })}>{l}</button>
            ))}
          </div>
          <div className="grid3" style={{ marginTop: 12 }}>
            <button type="button" className="btn primary" onClick={() => window.print()}>🖨 PDF / ispis</button>
            <button type="button" className="btn" onClick={() => void exportCsv()}>CSV</button>
            <button type="button" className="btn" onClick={() => void exportJson()}>JSON kopija</button>
          </div>
          <p className="tiny">Na iPhoneu: „PDF / ispis” otvara sustavski dijalog u kojem možete spremiti PDF u Datoteke, poslati e-poštom ili ispisati.</p>
        </div>
      </div>

      <article className="report" aria-label="Izvještaj">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Izvještaj o kućnom mjerenju krvnog tlaka</h2>
          {opts.profile && (data.settings.profileName || data.settings.profileBirthYear) && <p><strong>{data.settings.profileName}</strong>{data.settings.profileBirthYear && ` · god. rođenja ${data.settings.profileBirthYear}`}</p>}
          <p className="small">Razdoblje: <strong>{fmtDate(range.from)} – {fmtDate(range.to)}</strong> · izrađeno {fmtDateTime(new Date())} · izvor: aplikacija Tlak (vlastita mjerenja korisnika)</p>
          <table className="tbl"><tbody>
            <tr><th>Broj mjerenja / dana s mjerenjem</th><td className="n">{s.count}{s.countAll !== s.count ? ` (+${s.countAll - s.count} isključeno iz prosjeka)` : ''} / {s.days}</td></tr>
            <tr><th>SYS prosjek (min–max) – izračun</th><td className="n">{fmtNum(s.sys.avg)} ({fmtNum(s.sys.min)}–{fmtNum(s.sys.max)}) mmHg</td></tr>
            <tr><th>DIA prosjek (min–max) – izračun</th><td className="n">{fmtNum(s.dia.avg)} ({fmtNum(s.dia.min)}–{fmtNum(s.dia.max)}) mmHg</td></tr>
            <tr><th>Puls prosjek (min–max) – izračun</th><td className="n">{fmtNum(s.pulse.avg)} ({fmtNum(s.pulse.min)}–{fmtNum(s.pulse.max)}) /min</td></tr>
            <tr><th>Jutarnji prosjek (n)</th><td className="n">{fmtNum(s.morningSys.avg)}/{fmtNum(s.morningDia.avg)} ({s.morningSys.n})</td></tr>
            <tr><th>Večernji prosjek (n)</th><td className="n">{fmtNum(s.eveningSys.avg)}/{fmtNum(s.eveningDia.avg)} ({s.eveningSys.n})</td></tr>
            <tr><th>Dana s jutarnjim i večernjim mjerenjem</th><td className="n">{s.daysBoth} od {s.days}{s.daysBoth < 3 ? ' – ESC preporučuje najmanje 3 (idealno 7) dana' : s.daysBoth < 7 ? ' – ESC preporučuje idealno 7 dana' : ''}</td></tr>
            <tr><th>Udio unutar osobnog cilja</th><td className="n">{s.inTargetShare === null ? 'cilj nije postavljen' : `${Math.round(s.inTargetShare * 100)} %`}</td></tr>
          </tbody></table>
          <p className="small" style={{ marginTop: 10 }}>Raspodjela po ESC kategorijama kućnog tlaka (nepovišeni &lt; {data.settings.categories.elevatedSys}/{data.settings.categories.elevatedDia}, povišeni {data.settings.categories.elevatedSys}–{data.settings.categories.highSys - 1}/{data.settings.categories.elevatedDia}–{data.settings.categories.highDia - 1}, visoki {data.settings.categories.highSys}–{data.settings.categories.veryHighSys - 1}/{data.settings.categories.highDia}–{data.settings.categories.veryHighDia - 1}, vrlo visoki ≥ {data.settings.categories.veryHighSys}/{data.settings.categories.veryHighDia}; lošija vrijednost određuje kategoriju):</p>
          <CategoryBar counts={s.categories} />
          {data.targets.length > 0 && <p className="tiny">Osobni ciljni rasponi: {data.targets.map((t) => `od ${fmtDate(t.effectiveFrom)}: ${t.sysMin}–${t.sysMax}/${t.diaMin}–${t.diaMax}${t.note ? ` (${t.note})` : ''}`).join('; ')}.</p>}
        </div>
        {opts.chart && (
          <div className="card">
            <h3>Kretanje tlaka</h3>
            <TimeChart title="Graf tlaka za izvještaj" measurements={data.measurements} range={range} targets={data.targets} events={opts.therapy ? data.events : []} series={['systolic', 'diastolic']} height={220} categories={data.settings.categories} />
            <h3>Puls</h3>
            <TimeChart title="Graf pulsa za izvještaj" measurements={data.measurements} range={range} targets={data.targets} series={['pulse']} height={140} />
          </div>
        )}
        {opts.therapy && (meds.length > 0 || events.length > 0) && (
          <div className="card">
            <h3>Terapija i događaji (evidencija korisnika)</h3>
            {meds.map((m) => <p key={m.id} className="small">💊 {m.name} {m.dose} {m.schedule && `· ${m.schedule}`} · od {fmtDate(m.startDate)}{m.endDate && ` do ${fmtDate(m.endDate)}`}{m.note && ` · ${m.note}`}</p>)}
            {events.map((e) => <p key={e.id} className="small">📌 {fmtDate(e.date)} · {EVENT_LABEL[e.type]}{e.title && `: ${e.title}`}{e.note && ` · ${e.note}`}</p>)}
          </div>
        )}
        {opts.list && (
          <div className="card">
            <h3>Pojedinačna mjerenja ({list.length})</h3>
            <div className="scroll-x"><table className="tbl">
              <thead><tr><th>Datum</th><th>Vrijeme</th><th className="n">SYS</th><th className="n">DIA</th><th className="n">Puls</th><th>Kat.</th><th>Razd.</th><th>Terapija</th><th>Izvor</th>{opts.notes && <th>Simptomi / bilješka</th>}<th>Prosjek</th></tr></thead>
              <tbody>{list.map((m) => (
                <tr key={m.id}><td className="tabular">{fmtDate(m.measuredAt)}</td><td className="tabular">{fmtTime(m.measuredAt)}</td><td className="n">{m.systolic}</td><td className="n">{m.diastolic}</td><td className="n">{m.pulse ?? '–'}</td><td>{CATEGORY_SHORT[categorize(m.systolic, m.diastolic, data.settings.categories)]}</td>
                  <td>{PERIOD_LABEL[m.period]}</td><td>{m.medicationTiming === 'unknown' ? '–' : TIMING_LABEL[m.medicationTiming]}</td><td>{SOURCE_LABEL[m.source]}</td>
                  {opts.notes && <td>{[...m.symptoms, m.notes].filter(Boolean).join('; ')}</td>}
                  <td>{m.includedInAverage ? 'da' : `isključeno${m.exclusionReason ? ` (${m.exclusionReason})` : ''}`}</td></tr>
              ))}</tbody>
            </table></div>
          </div>
        )}
        <p className="tiny">Izmjerene vrijednosti unio je korisnik (ručno ili prepoznavanjem s fotografije uz ručnu potvrdu). Prosjeci, pulsni tlak i srednji arterijski tlak su izračuni. Aplikacija ne postavlja dijagnozu.</p>
      </article>
    </main>
  );
}
