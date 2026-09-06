import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store.tsx';
import { fmtDateTime, fmtNum, fmtDelta, fmtRelative, toInputDate } from '../lib/format.ts';
import { RANGE_LABEL, resolveRange, type RangeKey } from '../lib/periods.ts';
import { summarize } from '../lib/stats.ts';
import { classify, STATUS_LABEL } from '../lib/targets.ts';
import { PERIOD_LABEL, SOURCE_LABEL } from '../lib/labels.ts';
import { Badge, Segmented, useLocalStorage } from '../components/ui.tsx';
import { CategoryBar, MinAvgMaxBar } from '../components/charts.tsx';
import { categorize, CATEGORY_ICON, CATEGORY_LABEL, categoryRangeText } from '../lib/categories.ts';

const RANGES: RangeKey[] = ['7d', '28d', '90d', 'ytd', 'custom'];

export function HomePage() {
  const { data, sync, auth, lastBackupAt } = useStore();
  const [rangeKey, setRangeKey] = useLocalStorage<RangeKey>('tlak.home.range', '7d');
  const [custom, setCustom] = useState({ from: toInputDate(new Date(Date.now() - 13 * 86400e3)), to: toInputDate(new Date()) });
  const range = useMemo(() => resolveRange(rangeKey, new Date(), { from: new Date(custom.from), to: new Date(custom.to) }), [rangeKey, custom]);
  const s = useMemo(() => summarize(data.measurements, range, data.targets, true, data.settings.categories), [data.measurements, range, data.targets, data.settings.categories]);
  const last = data.measurements[0];
  const backupDue = !lastBackupAt || Date.now() - new Date(lastBackupAt).getTime() > data.settings.backupReminderDays * 86400e3;

  return (
    <main className="page">
      <div className="page-header"><h1>Tlak</h1>
        {auth ? <span className="tiny">{sync.status === 'syncing' ? '⟳ sinkronizacija…' : sync.status === 'offline' ? '⚠ offline' : sync.status === 'error' ? '⚠ greška sinkronizacije' : `☁ ${fmtRelative(sync.lastSyncAt)}`}</span>
          : <Link to="/settings/account" className="tiny">Samo lokalno · prijava</Link>}
      </div>

      <section className="card" aria-labelledby="last">
        <h2 id="last">Posljednje mjerenje</h2>
        {last ? (
          <Link to={`/measurement/${last.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="reading">
              <div className="sys"><div className="l">SYS</div><div className="v">{last.systolic}</div><div className="u">mmHg</div></div>
              <div className="dia"><div className="l">DIA</div><div className="v">{last.diastolic}</div><div className="u">mmHg</div></div>
              <div className="pulse"><div className="l">Puls</div><div className="v">{last.pulse}</div><div className="u">otk./min</div></div>
            </div>
            <div className="row" style={{ marginTop: 10, justifyContent: 'center' }}>
              <span className="small muted tabular">{fmtDateTime(last.measuredAt)} · {PERIOD_LABEL[last.period]} · {SOURCE_LABEL[last.source]}</span>
            </div>
            <div className="row" style={{ marginTop: 6, justifyContent: 'center' }}>
              {(() => { const c = categorize(last.systolic, last.diastolic, data.settings.categories); return <Badge kind={`cat-${c} big`} title={categoryRangeText(c, data.settings.categories)}>{CATEGORY_ICON[c]} {CATEGORY_LABEL[c]}</Badge>; })()}
              {(() => { const st = classify(last, data.targets); return st === 'none' ? null : <Badge kind={st}>{st === 'in' ? '✓' : st === 'above' ? '↑' : '↓'} {STATUS_LABEL[st]}</Badge>; })()}
              {(last.systolic >= data.settings.safety.sysCritical || last.diastolic >= data.settings.safety.diaCritical) && <Badge kind="safety">🚨 vrlo visoko – ponovite mjerenje</Badge>}
              {(last.symptoms.length > 0 || last.notes) && <span className="small muted">{[...last.symptoms, last.notes].filter(Boolean).join(' · ')}</span>}
            </div>
          </Link>
        ) : <p className="muted">Još nema mjerenja. Dodajte prvo mjerenje gumbom „Novo”.</p>}
      </section>

      <section className="card" aria-labelledby="quick">
        <h2 id="quick">Brze radnje</h2>
        <div className="quick">
          <Link to="/new" className="btn primary">✏️ Unesi ručno</Link>
          <Link to="/new/photo" className="btn">📷 Fotografiraj tlakomjer</Link>
          <Link to="/new/gallery" className="btn">🖼 Odaberi fotografiju</Link>
          <Link to="/history?range=7d" className="btn">📅 Posljednjih 7 dana</Link>
          <Link to="/report" className="btn" style={{ gridColumn: '1 / -1' }}>📄 Izradi izvještaj za liječnika</Link>
        </div>
      </section>

      <section className="card" aria-labelledby="sum">
        <h2 id="sum">Sažetak razdoblja</h2>
        <Segmented value={rangeKey} onChange={setRangeKey} wrap label="Razdoblje" options={RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }))} />
        {rangeKey === 'custom' && (
          <div className="grid2">
            <div className="field"><label>Od<input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label></div>
            <div className="field"><label>Do<input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label></div>
          </div>
        )}
        {s.count === 0 ? <p className="muted">Nema mjerenja u odabranom razdoblju.</p> : (
          <>
            <div style={{ marginTop: 10 }}>
              <MinAvgMaxBar label="SYS" min={s.sys.min} avg={s.sys.avg} max={s.sys.max} domain={[60, 200]} color="var(--sys)" />
              <MinAvgMaxBar label="DIA" min={s.dia.min} avg={s.dia.avg} max={s.dia.max} domain={[40, 130]} color="var(--dia)" />
              <MinAvgMaxBar label="Puls" min={s.pulse.min} avg={s.pulse.avg} max={s.pulse.max} domain={[40, 140]} color="var(--pulse)" />
            </div>
            <CategoryBar counts={s.categories} />
            <div className="grid3">
              <div className="stat"><div className="k">Prosjek (izračun)</div><div className="v tabular">{fmtNum(s.sys.avg)}/{fmtNum(s.dia.avg)} <small>mmHg</small></div></div>
              <div className="stat"><div className="k">Mjerenja</div><div className="v tabular">{s.count}{s.countAll !== s.count && <small> (+{s.countAll - s.count} isklj.)</small>}</div></div>
              <div className="stat"><div className="k">Dana s mjerenjem</div><div className="v tabular">{s.days}</div></div>
              <div className="stat"><div className="k">Jutro (prosjek)</div><div className="v tabular">{fmtNum(s.morningSys.avg)}/{fmtNum(s.morningDia.avg)} <small>n={s.morningSys.n}</small></div></div>
              <div className="stat"><div className="k">Večer (prosjek)</div><div className="v tabular">{fmtNum(s.eveningSys.avg)}/{fmtNum(s.eveningDia.avg)} <small>n={s.eveningSys.n}</small></div></div>
              <div className="stat"><div className="k">Unutar cilja</div><div className="v tabular">{s.inTargetShare === null ? '–' : `${Math.round(s.inTargetShare * 100)} %`}</div></div>
            </div>
            <div className="small muted">
              Min–max: SYS {fmtNum(s.sys.min)}–{fmtNum(s.sys.max)}, DIA {fmtNum(s.dia.min)}–{fmtNum(s.dia.max)}, puls {fmtNum(s.pulse.min)}–{fmtNum(s.pulse.max)}.
              {s.delta ? ` Promjena prema prethodnom razdoblju: SYS ${fmtDelta(s.delta.sys, 1)}, DIA ${fmtDelta(s.delta.dia, 1)}, puls ${fmtDelta(s.delta.pulse, 1)}.` : ' Nema usporedivog prethodnog razdoblja.'}
            </div>
            {s.morningSys.avg !== null && s.eveningSys.avg !== null && (
              <div className="small muted">Jutro − večer: SYS {fmtDelta(s.morningSys.avg - s.eveningSys.avg, 1)}, DIA {fmtDelta(s.morningDia.avg! - s.eveningDia.avg!, 1)}.</div>
            )}
          </>
        )}
      </section>

      {backupDue && data.measurements.length > 0 && (
        <section className="card tight">
          <div className="row between">
            <span className="small">💾 {lastBackupAt ? `Posljednja sigurnosna kopija: ${fmtRelative(lastBackupAt)}.` : 'Još niste izradili sigurnosnu kopiju.'}</span>
            <Link to="/settings/backup" className="btn small">Izradi kopiju</Link>
          </div>
        </section>
      )}
      {!auth && data.measurements.length > 0 && (
        <section className="card tight">
          <div className="row between">
            <span className="small">☁ Podaci su samo na ovom uređaju. Prijavite se za pristup s više uređaja.</span>
            <Link to="/settings/account" className="btn small">Račun</Link>
          </div>
        </section>
      )}
    </main>
  );
}
