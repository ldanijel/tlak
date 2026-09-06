import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useStore } from '../store.tsx';
import { RANGE_LABEL, resolveRange, inRange, type RangeKey } from '../lib/periods.ts';
import { classify } from '../lib/targets.ts';
import { MeasurementRow } from '../components/MeasurementRow.tsx';
import { localDayKey, fmtDate } from '../lib/format.ts';
import { categorize } from '../lib/categories.ts';

type F = { range: RangeKey; period: string; timing: string; source: string; target: string; note: string; included: string; category: string };

export function HistoryPage() {
  const { data } = useStore();
  const [sp] = useSearchParams();
  const [f, setF] = useState<F>({ range: (sp.get('range') as RangeKey) || 'all', period: '', timing: '', source: '', target: '', note: '', included: '', category: '' });
  const [limit, setLimit] = useState(100);
  const range = useMemo(() => resolveRange(f.range, new Date(), undefined, data.measurements.length ? new Date(data.measurements[data.measurements.length - 1].measuredAt) : null), [f.range, data.measurements]);

  const list = useMemo(() => data.measurements.filter((m) => {
    if (f.range !== 'all' && !inRange(m.measuredAt, range)) return false;
    if (f.period && m.period !== f.period) return false;
    if (f.timing === 'before' && m.medicationTiming !== 'before') return false;
    if (f.timing === 'after' && !['within1h', '1to4h', 'over4h'].includes(m.medicationTiming)) return false;
    if (f.source === 'manual' && m.source !== 'manual') return false;
    if (f.source === 'photo' && !['camera', 'gallery'].includes(m.source)) return false;
    if (f.source === 'import' && m.source !== 'import') return false;
    if (f.category && categorize(m.systolic, m.diastolic, data.settings.categories) !== f.category) return false;
    if (f.target) { const s = classify(m, data.targets); if (f.target === 'in' ? s !== 'in' : s === 'in' || s === 'none') return false; }
    if (f.note && !(m.notes || m.symptoms.length)) return false;
    if (f.included === 'yes' && !m.includedInAverage) return false;
    if (f.included === 'no' && m.includedInAverage) return false;
    return true;
  }), [data.measurements, data.targets, f, range]);

  const groups = useMemo(() => {
    const g = new Map<string, typeof list>();
    for (const m of list.slice(0, limit)) { const k = localDayKey(m.measuredAt); (g.get(k) || g.set(k, []).get(k)!).push(m); }
    return [...g.entries()];
  }, [list, limit]);

  const sel = (k: keyof F, opts: [string, string][]) => (
    <select value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} aria-label={opts[0][1]}>
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );

  return (
    <main className="page">
      <div className="page-header"><h1>Povijest</h1><span className="small muted">{list.length} mjerenja</span></div>
      <div className="filters no-print" role="group" aria-label="Filtri">
        {sel('range', (['all', '7d', '28d', '90d', '180d', '1y', 'ytd'] as RangeKey[]).map((r) => [r, r === 'all' ? 'Razdoblje: sve' : RANGE_LABEL[r]]))}
        {sel('period', [['', 'Jutro/večer: sve'], ['morning', 'Jutro'], ['evening', 'Večer'], ['other', 'Drugo']])}
        {sel('timing', [['', 'Terapija: sve'], ['before', 'Prije terapije'], ['after', 'Nakon terapije']])}
        {sel('source', [['', 'Izvor: svi'], ['manual', 'Ručni'], ['photo', 'Fotografija'], ['import', 'Uvoz']])}
        {sel('category', [['', 'Kategorija: sve'], ['normal', 'Nepovišeni'], ['elevated', 'Povišeni'], ['high', 'Visoki'], ['veryhigh', 'Vrlo visoki']])}
        {sel('target', [['', 'Cilj: sve'], ['in', 'Unutar cilja'], ['out', 'Izvan cilja']])}
        {sel('note', [['', 'Bilješke: sve'], ['1', 'S bilješkom/simptomom']])}
        {sel('included', [['', 'Prosjek: sve'], ['yes', 'Uključeno'], ['no', 'Isključeno']])}
      </div>
      {list.length === 0 ? (
        <div className="card"><p className="muted">Nema mjerenja za odabrane filtre.</p><Link to="/new" className="btn primary">Novo mjerenje</Link></div>
      ) : groups.map(([day, ms]) => (
        <section key={day} className="card tight" aria-label={fmtDate(ms[0].measuredAt)}>
          <div className="tiny" style={{ padding: '2px 4px' }}>{fmtDate(ms[0].measuredAt)}</div>
          <div className="list">{ms.map((m) => <MeasurementRow key={m.id} m={m} targets={data.targets} categories={data.settings.categories} />)}</div>
        </section>
      ))}
      {list.length > limit && <button type="button" className="btn block" onClick={() => setLimit(limit + 200)}>Prikaži još ({list.length - limit})</button>}
    </main>
  );
}
