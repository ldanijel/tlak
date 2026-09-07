import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store.tsx';
import { fmtNum, fmtDelta, toInputDate } from '../lib/format.ts';
import { MAIN_RANGES, RANGE_LABEL, RANGE_SHORT, resolveRange, type RangeKey } from '../lib/periods.ts';
import { summarize, groupSessions, analyzed } from '../lib/stats.ts';
import { Badge, Segmented, useLocalStorage } from '../components/ui.tsx';
import { CategoryBar, TimeChart } from '../components/charts.tsx';

const RANGES: RangeKey[] = [...MAIN_RANGES, 'all', 'custom'];

export function AnalysisPage() {
  const { data, updateSettings } = useStore();
  const [rangeKey, setRangeKey] = useLocalStorage<RangeKey>('tlak.analysis.range2', 'month');
  const [custom, setCustom] = useState({ from: toInputDate(new Date(Date.now() - 27 * 86400e3)), to: toInputDate(new Date()) });
  const earliest = data.measurements.length ? new Date(data.measurements[data.measurements.length - 1].measuredAt) : null;
  const range = useMemo(() => resolveRange(rangeKey, new Date(), { from: new Date(custom.from), to: new Date(custom.to) }, earliest), [rangeKey, custom, earliest]);
  const s = useMemo(() => summarize(data.measurements, range, data.targets, true, data.settings.categories), [data.measurements, range, data.targets, data.settings.categories]);
  const sessions = useMemo(() => groupSessions(analyzed(data.measurements).filter((m) => { const t = new Date(m.measuredAt).getTime(); return t >= range.from.getTime() && t <= range.to.getTime(); }), data.settings.sessionWindowMinutes).filter((x) => x.measurements.length > 1), [data.measurements, range, data.settings.sessionWindowMinutes]);
  const pp = useMemo(() => { const l = analyzed(data.measurements).filter((m) => { const t = new Date(m.measuredAt).getTime(); return t >= range.from.getTime() && t <= range.to.getTime(); }); return l.length ? { pp: l.reduce((a, m) => a + m.systolic - m.diastolic, 0) / l.length, map: l.reduce((a, m) => a + m.diastolic + (m.systolic - m.diastolic) / 3, 0) / l.length } : null; }, [data.measurements, range]);

  return (
    <main className="page">
      <div className="page-header"><h1>Analiza</h1><Link to="/report" className="btn small">📄 Izvještaj</Link></div>
      <Segmented value={rangeKey} onChange={setRangeKey} short label="Razdoblje" options={RANGES.map((r) => ({ value: r, label: RANGE_SHORT[r], title: RANGE_LABEL[r] }))} />
      {rangeKey === 'custom' && (
        <div className="grid2">
          <div className="field"><label>Od<input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label></div>
          <div className="field"><label>Do<input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label></div>
        </div>
      )}

      <section className="card">
        <h2>Krvni tlak (SYS/DIA)</h2>
        <TimeChart title="Graf sistoličkog i dijastoličkog tlaka" measurements={data.measurements} range={range} targets={data.targets} events={data.events} series={['systolic', 'diastolic']} showMovingAverage={data.settings.movingAverage} categories={data.settings.categories} />
        <label className="row small" style={{ marginTop: 8 }}><input type="checkbox" checked={data.settings.movingAverage} onChange={(e) => void updateSettings({ movingAverage: e.target.checked })} /> Prikaži 7-dnevni pomični prosjek (izračun)</label>
      </section>
      <section className="card">
        <h2>Puls</h2>
        <TimeChart title="Graf pulsa" measurements={data.measurements} range={range} targets={data.targets} series={['pulse']} height={180} showMovingAverage={data.settings.movingAverage} />
      </section>

      <section className="card">
        <h2>Jutro i večer <Badge kind="calc">izračun</Badge></h2>
        {s.morningSys.n === 0 && s.eveningSys.n === 0 ? <p className="muted">Nema jutarnjih ni večernjih mjerenja u razdoblju.</p> : (
          <table className="tbl"><thead><tr><th></th><th className="n">Jutro</th><th className="n">Večer</th><th className="n">Razlika</th></tr></thead><tbody>
            <tr><th>SYS prosjek</th><td className="n">{fmtNum(s.morningSys.avg, 1)}</td><td className="n">{fmtNum(s.eveningSys.avg, 1)}</td><td className="n">{s.morningSys.avg !== null && s.eveningSys.avg !== null ? fmtDelta(s.morningSys.avg - s.eveningSys.avg, 1) : '–'}</td></tr>
            <tr><th>DIA prosjek</th><td className="n">{fmtNum(s.morningDia.avg, 1)}</td><td className="n">{fmtNum(s.eveningDia.avg, 1)}</td><td className="n">{s.morningDia.avg !== null && s.eveningDia.avg !== null ? fmtDelta(s.morningDia.avg - s.eveningDia.avg, 1) : '–'}</td></tr>
            <tr><th>Broj mjerenja</th><td className="n">{s.morningSys.n}</td><td className="n">{s.eveningSys.n}</td><td></td></tr>
          </tbody></table>
        )}
      </section>

      <section className="card">
        <h2>Kategorije (ESC, kućno mjerenje)</h2>
        <p className="tiny">Nepovišeni: SYS &lt; {data.settings.categories.elevatedSys} i DIA &lt; {data.settings.categories.elevatedDia} · Povišeni: SYS {data.settings.categories.elevatedSys}–{data.settings.categories.highSys - 1} ili DIA {data.settings.categories.elevatedDia}–{data.settings.categories.highDia - 1} · Visoki: SYS {data.settings.categories.highSys}–{data.settings.categories.veryHighSys - 1} ili DIA {data.settings.categories.highDia}–{data.settings.categories.veryHighDia - 1} · Vrlo visoki: SYS ≥ {data.settings.categories.veryHighSys} ili DIA ≥ {data.settings.categories.veryHighDia}. Lošija od dviju vrijednosti određuje kategoriju.</p>
        {s.count ? <CategoryBar counts={s.categories} /> : <p className="muted">Nema mjerenja u razdoblju.</p>}
      </section>

      <section className="card">
        <h2>Sažetak razdoblja</h2>
        <div className="grid3">
          <div className="stat"><div className="k">Prosjek SYS/DIA</div><div className="v tabular">{fmtNum(s.sys.avg)}/{fmtNum(s.dia.avg)}</div></div>
          <div className="stat"><div className="k">Min–max SYS</div><div className="v tabular">{fmtNum(s.sys.min)}–{fmtNum(s.sys.max)}</div></div>
          <div className="stat"><div className="k">Min–max DIA</div><div className="v tabular">{fmtNum(s.dia.min)}–{fmtNum(s.dia.max)}</div></div>
          <div className="stat"><div className="k">Prosjek pulsa</div><div className="v tabular">{fmtNum(s.pulse.avg)}</div></div>
          <div className="stat"><div className="k">Mjerenja / dana</div><div className="v tabular">{s.count} / {s.days}</div></div>
          <div className="stat"><div className="k">Unutar cilja</div><div className="v tabular">{s.inTargetShare === null ? '–' : `${Math.round(s.inTargetShare * 100)} %`}</div></div>
        </div>
        {pp && <p className="small">Izvedeni pokazatelji <Badge kind="calc">izračun</Badge>: prosječni pulsni tlak {fmtNum(pp.pp, 1)} mmHg · prosječni srednji arterijski tlak {fmtNum(pp.map, 1)} mmHg.</p>}
        {s.delta && <p className="small muted">Promjena prema prethodnom razdoblju: SYS {fmtDelta(s.delta.sys, 1)}, DIA {fmtDelta(s.delta.dia, 1)}, puls {fmtDelta(s.delta.pulse, 1)}.</p>}
      </section>

      <section className="card">
        <h2>Sesije mjerenja</h2>
        <p className="tiny">Mjerenja unutar {data.settings.sessionWindowMinutes} minuta grupiraju se u sesiju. Prvo mjerenje nikad se ne odbacuje automatski.</p>
        {sessions.length === 0 ? <p className="muted">Nema sesija s više mjerenja u razdoblju.</p> : (
          <div className="scroll-x"><table className="tbl"><thead><tr><th>Početak</th><th className="n">N</th><th className="n">Prosjek</th><th className="n">Raspon SYS</th><th className="n">Raspon DIA</th></tr></thead><tbody>
            {sessions.slice(-30).reverse().map((x) => (
              <tr key={x.id}><td><Link to={`/measurement/${x.measurements[0].id}`}>{new Date(x.measurements[0].measuredAt).toLocaleString('hr-HR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</Link></td>
                <td className="n">{x.measurements.length}</td><td className="n">{fmtNum(x.sys.avg)}/{fmtNum(x.dia.avg)}</td>
                <td className="n">{x.sys.n ? x.sys.max! - x.sys.min! : '–'}</td><td className="n">{x.dia.n ? x.dia.max! - x.dia.min! : '–'}</td></tr>
            ))}
          </tbody></table></div>
        )}
      </section>
    </main>
  );
}
