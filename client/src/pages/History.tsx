import { useMemo, useState } from 'react';
import { Confirm, Field, Segmented, useToast, DateInput } from '../components/ui.tsx';
import { toInputDate, fromInputs } from '../lib/format.ts';
import { Link, useSearchParams } from 'react-router-dom';
import { useStore } from '../store.tsx';
import { MAIN_RANGES, RANGE_LABEL, resolveRange, inRange, type RangeKey } from '../lib/periods.ts';
import { classify } from '../lib/targets.ts';
import { MeasurementRow } from '../components/MeasurementRow.tsx';
import { localDayKey, fmtDate } from '../lib/format.ts';
import { categorize } from '../lib/categories.ts';

type F = { range: RangeKey; period: string; timing: string; source: string; target: string; note: string; included: string; category: string };

export function HistoryPage() {
  const { data, removeMany, restoreMany } = useStore();
  const toast = useToast();
  const [sp] = useSearchParams();
  const [bulk, setBulk] = useState<null | { mode: 'all' | 'from' | 'to' | 'range'; from: string; to: string }>(null);
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

  /** Skupno brisanje: SVE, SVE OD:, SVE DO:, RASPON OD–DO (po datumu mjerenja, uključivo). */
  const bulkTargets = () => {
    if (!bulk) return [];
    const from = bulk.mode === 'from' || bulk.mode === 'range' ? fromInputs(bulk.from, '00:00').getTime() : -Infinity;
    const to = bulk.mode === 'to' || bulk.mode === 'range' ? fromInputs(bulk.to, '23:59').getTime() + 59999 : Infinity;
    return data.measurements.filter((m) => { const t = new Date(m.measuredAt).getTime(); return t >= from && t <= to; });
  };
  const doBulk = async () => {
    const ids = bulkTargets().map((m) => m.id);
    setBulk(null);
    if (!ids.length) { toast.show('Nema mjerenja u odabranom razdoblju.'); return; }
    await removeMany('measurements', ids);
    toast.show(`Izbrisano ${ids.length} mjerenja.`, { actionLabel: 'Vrati', onAction: () => { void restoreMany('measurements', ids); }, durationMs: 12000 });
  };

  return (
    <main className="page">
      <div className="page-header"><h1>Povijest</h1><span className="small muted">{list.length} mjerenja</span>
        {data.measurements.length > 0 && <button type="button" className="btn small danger" onClick={() => setBulk({ mode: 'range', from: toInputDate(new Date()), to: toInputDate(new Date()) })}>Izbriši više…</button>}
      </div>
      {bulk && (
        <Confirm title="Skupno brisanje mjerenja" confirmLabel={`Izbriši ${bulkTargets().length}`} danger onConfirm={() => void doBulk()} onCancel={() => setBulk(null)}>
          <Segmented value={bulk.mode} onChange={(mode) => setBulk({ ...bulk, mode })} wrap label="Opseg" options={[{ value: 'all', label: 'SVE' }, { value: 'from', label: 'SVE OD:' }, { value: 'to', label: 'SVE DO:' }, { value: 'range', label: 'RASPON OD–DO' }]} />
          <div className="grid2">
            {(bulk.mode === 'from' || bulk.mode === 'range') && <Field label="Od (uključivo)"><DateInput value={bulk.from} onChange={(v) => setBulk({ ...bulk, from: v })} /></Field>}
            {(bulk.mode === 'to' || bulk.mode === 'range') && <Field label="Do (uključivo)"><DateInput value={bulk.to} onChange={(v) => setBulk({ ...bulk, to: v })} /></Field>}
          </div>
          <p className="small">Bit će izbrisano <strong>{bulkTargets().length}</strong> od {data.measurements.length} mjerenja. Brisanje se može poništiti gumbom „Vrati” odmah nakon brisanja, a briše se i na svim sinkroniziranim uređajima.</p>
        </Confirm>
      )}
      <div className="filters no-print" role="group" aria-label="Filtri">
        {sel('range', (['all', ...MAIN_RANGES] as RangeKey[]).map((r) => [r, r === 'all' ? 'Razdoblje: sve' : RANGE_LABEL[r]]))}
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
