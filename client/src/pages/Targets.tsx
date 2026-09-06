import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store.tsx';
import type { Target, TargetBounds } from '../types.ts';
import { fmtDate, toInputDate } from '../lib/format.ts';
import { Confirm, Field, useToast } from '../components/ui.tsx';

const empty = (): TargetBounds => ({ sysMin: 100, sysMax: 135, diaMin: 60, diaMax: 85, pulseMin: null, pulseMax: null });

function BoundsEditor({ b, onChange, withPulse }: { b: TargetBounds; onChange: (b: TargetBounds) => void; withPulse?: boolean }) {
  const n = (k: keyof TargetBounds, nullable = false) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...b, [k]: e.target.value === '' && nullable ? null : Number(e.target.value) });
  return (
    <div className="grid2">
      <Field label="SYS od"><input type="number" inputMode="numeric" value={b.sysMin} onChange={n('sysMin')} /></Field>
      <Field label="SYS do"><input type="number" inputMode="numeric" value={b.sysMax} onChange={n('sysMax')} /></Field>
      <Field label="DIA od"><input type="number" inputMode="numeric" value={b.diaMin} onChange={n('diaMin')} /></Field>
      <Field label="DIA do"><input type="number" inputMode="numeric" value={b.diaMax} onChange={n('diaMax')} /></Field>
      {withPulse && <><Field label="Puls od (neobvezno)"><input type="number" inputMode="numeric" value={b.pulseMin ?? ''} onChange={n('pulseMin', true)} /></Field>
        <Field label="Puls do (neobvezno)"><input type="number" inputMode="numeric" value={b.pulseMax ?? ''} onChange={n('pulseMax', true)} /></Field></>}
    </div>
  );
}

export function TargetsPage() {
  const { data, save, remove } = useStore();
  const toast = useToast();
  const last = data.targets[data.targets.length - 1];
  const [editing, setEditing] = useState<Partial<Target> | null>(null);
  const [del, setDel] = useState<string | null>(null);

  const startNew = () => setEditing({ ...(last ? { ...last, id: undefined, morning: last.morning, evening: last.evening } : empty()), effectiveFrom: toInputDate(new Date()), note: '' });
  const submit = async () => {
    if (!editing) return;
    const t = editing as Target;
    if (t.sysMin >= t.sysMax || t.diaMin >= t.diaMax) { toast.show('Donja granica mora biti manja od gornje.'); return; }
    await save('targets', { ...t, morning: t.morning ?? null, evening: t.evening ?? null, pulseMin: t.pulseMin ?? null, pulseMax: t.pulseMax ?? null, note: t.note || '' });
    setEditing(null); toast.show('Ciljni raspon je spremljen.');
  };

  return (
    <main className="page">
      <div className="page-header"><h1>Osobni ciljni raspon</h1><Link to="/settings" className="btn small">← Postavke</Link></div>
      <p className="small muted">Ciljeve postavljate prema preporuci liječnika. Promjena cilja ne mijenja povijesne podatke: za svako mjerenje vrijedi cilj koji je bio na snazi tog datuma.</p>
      {!editing && <button type="button" className="btn primary big" onClick={startNew}>{last ? 'Novi cilj od datuma…' : 'Postavi ciljni raspon'}</button>}
      {editing && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <h3>{editing.id ? 'Uredi cilj' : 'Novi cilj'}</h3>
          <Field label="Vrijedi od"><input type="date" value={editing.effectiveFrom} onChange={(e) => setEditing({ ...editing, effectiveFrom: e.target.value })} required /></Field>
          <BoundsEditor b={editing as TargetBounds} onChange={(b) => setEditing({ ...editing, ...b })} withPulse />
          <label className="row small"><input type="checkbox" checked={!!editing.morning} onChange={(e) => setEditing({ ...editing, morning: e.target.checked ? { ...(editing as TargetBounds) } : null })} /> Različite granice za jutro</label>
          {editing.morning && <BoundsEditor b={editing.morning} onChange={(b) => setEditing({ ...editing, morning: b })} />}
          <label className="row small"><input type="checkbox" checked={!!editing.evening} onChange={(e) => setEditing({ ...editing, evening: e.target.checked ? { ...(editing as TargetBounds) } : null })} /> Različite granice za večer</label>
          {editing.evening && <BoundsEditor b={editing.evening} onChange={(b) => setEditing({ ...editing, evening: b })} />}
          <Field label="Bilješka"><input value={editing.note || ''} onChange={(e) => setEditing({ ...editing, note: e.target.value })} placeholder="npr. prema preporuci liječnika, 5. 9. 2026." /></Field>
          <div className="row"><button type="submit" className="btn primary">Spremi</button><button type="button" className="btn" onClick={() => setEditing(null)}>Odustani</button></div>
        </form>
      )}
      <section className="card">
        <h3>Povijest ciljeva</h3>
        {data.targets.length === 0 ? <p className="muted">Nema postavljenih ciljeva.</p> : data.targets.slice().reverse().map((t) => (
          <div key={t.id} className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <div><strong className="tabular">{t.sysMin}–{t.sysMax} / {t.diaMin}–{t.diaMax} mmHg</strong>{t.pulseMax && <span className="small"> · puls {t.pulseMin ?? '–'}–{t.pulseMax}</span>}
              <div className="tiny">od {fmtDate(t.effectiveFrom)}{t.morning && ` · jutro ${t.morning.sysMin}–${t.morning.sysMax}/${t.morning.diaMin}–${t.morning.diaMax}`}{t.evening && ` · večer ${t.evening.sysMin}–${t.evening.sysMax}/${t.evening.diaMin}–${t.evening.diaMax}`}{t.note && ` · ${t.note}`}</div></div>
            <div className="row"><button type="button" className="btn small" onClick={() => setEditing({ ...t })}>Uredi</button><button type="button" className="btn small danger" onClick={() => setDel(t.id)}>Izbriši</button></div>
          </div>
        ))}
      </section>
      {del && <Confirm title="Izbrisati cilj?" confirmLabel="Izbriši" danger onConfirm={() => { void remove('targets', del); setDel(null); }} onCancel={() => setDel(null)} />}
    </main>
  );
}
