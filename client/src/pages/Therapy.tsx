import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store.tsx';
import type { EventType, HealthEvent, Medication } from '../types.ts';
import { fmtDate, toInputDate } from '../lib/format.ts';
import { EVENT_LABEL } from '../lib/labels.ts';
import { Confirm, Field, useToast } from '../components/ui.tsx';

export function TherapyPage() {
  const { data, save, remove } = useStore();
  const toast = useToast();
  const [med, setMed] = useState<Partial<Medication> | null>(null);
  const [ev, setEv] = useState<Partial<HealthEvent> | null>(null);
  const [del, setDel] = useState<{ c: 'medications' | 'events'; id: string } | null>(null);

  const saveMed = async () => {
    if (!med?.name?.trim() || !med.startDate) { toast.show('Unesite naziv lijeka i datum početka.'); return; }
    await save('medications', { ...med, name: med.name.trim(), dose: med.dose || '', schedule: med.schedule || '', endDate: med.endDate || null, note: med.note || '' } as Medication);
    setMed(null); toast.show('Terapija je spremljena.');
  };
  const saveEv = async () => {
    if (!ev?.date || !ev.type) { toast.show('Unesite datum i vrstu događaja.'); return; }
    await save('events', { ...ev, title: ev.title || '', note: ev.note || '' } as HealthEvent);
    setEv(null); toast.show('Događaj je spremljen.');
  };

  return (
    <main className="page">
      <div className="page-header"><h1>Terapija i događaji</h1><Link to="/settings" className="btn small">← Postavke</Link></div>
      <p className="tiny">Evidencija služi za vremenski kontekst uz mjerenja. Aplikacija nije alat za propisivanje terapije i ne tvrdi uzročnu povezanost događaja i promjene tlaka.</p>

      <section className="card">
        <h2>Lijekovi</h2>
        {data.medications.map((m) => (
          <div key={m.id} className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <div><strong>{m.name}</strong> {m.dose}<div className="tiny">{m.schedule}{m.schedule && ' · '}od {fmtDate(m.startDate)}{m.endDate && ` do ${fmtDate(m.endDate)}`}{m.note && ` · ${m.note}`}</div></div>
            <div className="row"><button type="button" className="btn small" onClick={() => setMed({ ...m })}>Uredi</button><button type="button" className="btn small danger" onClick={() => setDel({ c: 'medications', id: m.id })}>Izbriši</button></div>
          </div>
        ))}
        {!med ? <button type="button" className="btn block" style={{ marginTop: 8 }} onClick={() => setMed({ startDate: toInputDate(new Date()) })}>+ Dodaj lijek</button> : (
          <form onSubmit={(e) => { e.preventDefault(); void saveMed(); }}>
            <Field label="Naziv lijeka"><input value={med.name || ''} onChange={(e) => setMed({ ...med, name: e.target.value })} required /></Field>
            <div className="grid2">
              <Field label="Doza"><input value={med.dose || ''} onChange={(e) => setMed({ ...med, dose: e.target.value })} placeholder="npr. 5 mg" /></Field>
              <Field label="Planirano vrijeme"><input value={med.schedule || ''} onChange={(e) => setMed({ ...med, schedule: e.target.value })} placeholder="npr. ujutro 08:00" /></Field>
              <Field label="Početak"><input type="date" value={med.startDate || ''} onChange={(e) => setMed({ ...med, startDate: e.target.value })} required /></Field>
              <Field label="Završetak"><input type="date" value={med.endDate || ''} onChange={(e) => setMed({ ...med, endDate: e.target.value || null })} /></Field>
            </div>
            <Field label="Bilješka (npr. promjena doze)"><input value={med.note || ''} onChange={(e) => setMed({ ...med, note: e.target.value })} /></Field>
            <div className="row"><button type="submit" className="btn primary">Spremi</button><button type="button" className="btn" onClick={() => setMed(null)}>Odustani</button>
              {med.id && <button type="button" className="btn" onClick={() => void save('events', { date: toInputDate(new Date()), type: 'dose_change', title: `${med.name} ${med.dose}`, note: '' } as HealthEvent).then(() => toast.show('Događaj „promjena doze” dodan na graf.'))}>Zabilježi promjenu doze danas</button>}</div>
          </form>
        )}
      </section>

      <section className="card">
        <h2>Važni događaji (oznake na grafu)</h2>
        {data.events.slice().reverse().map((e) => (
          <div key={e.id} className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <div><strong>{fmtDate(e.date)}</strong> · {EVENT_LABEL[e.type]}{e.title && `: ${e.title}`}<div className="tiny">{e.note}</div></div>
            <div className="row"><button type="button" className="btn small" onClick={() => setEv({ ...e })}>Uredi</button><button type="button" className="btn small danger" onClick={() => setDel({ c: 'events', id: e.id })}>Izbriši</button></div>
          </div>
        ))}
        {!ev ? <button type="button" className="btn block" style={{ marginTop: 8 }} onClick={() => setEv({ date: toInputDate(new Date()), type: 'other' })}>+ Dodaj događaj</button> : (
          <form onSubmit={(e) => { e.preventDefault(); void saveEv(); }}>
            <div className="grid2">
              <Field label="Datum"><input type="date" value={ev.date || ''} onChange={(e) => setEv({ ...ev, date: e.target.value })} required /></Field>
              <Field label="Vrsta"><select value={ev.type} onChange={(e) => setEv({ ...ev, type: e.target.value as EventType })}>{(Object.keys(EVENT_LABEL) as EventType[]).map((k) => <option key={k} value={k}>{EVENT_LABEL[k]}</option>)}</select></Field>
            </div>
            <Field label="Naslov (kratko, prikazuje se na grafu)"><input value={ev.title || ''} onChange={(e) => setEv({ ...ev, title: e.target.value })} maxLength={40} /></Field>
            <Field label="Bilješka"><input value={ev.note || ''} onChange={(e) => setEv({ ...ev, note: e.target.value })} /></Field>
            <div className="row"><button type="submit" className="btn primary">Spremi</button><button type="button" className="btn" onClick={() => setEv(null)}>Odustani</button></div>
          </form>
        )}
      </section>
      {del && <Confirm title="Izbrisati zapis?" confirmLabel="Izbriši" danger onConfirm={() => { void remove(del.c, del.id); setDel(null); }} onCancel={() => setDel(null)} />}
    </main>
  );
}
