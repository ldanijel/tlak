import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store.tsx';
import type { Device } from '../types.ts';
import { Confirm, Field, useToast } from '../components/ui.tsx';

export function DevicesPage() {
  const { data, save, remove } = useStore();
  const toast = useToast();
  const [d, setD] = useState<Partial<Device> | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const submit = async () => {
    if (!d?.name?.trim()) { toast.show('Unesite naziv tlakomjera.'); return; }
    await save('devices', { ...d, name: d.name.trim(), cuff: d.cuff || 'upper_arm', note: d.note || '' } as Device);
    setD(null); toast.show('Tlakomjer je spremljen.');
  };
  return (
    <main className="page">
      <div className="page-header"><h1>Tlakomjeri</h1><Link to="/settings" className="btn small">← Postavke</Link></div>
      <section className="card">
        {data.devices.length === 0 && !d && <p className="muted">Nema evidentiranih tlakomjera. Evidencija je neobvezna; služi za bilješku o uređaju uz mjerenje.</p>}
        {data.devices.map((x) => (
          <div key={x.id} className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <div><strong>{x.name}</strong><div className="tiny">{x.cuff === 'wrist' ? 'zapešće' : 'nadlaktica'}{x.note && ` · ${x.note}`}</div></div>
            <div className="row"><button type="button" className="btn small" onClick={() => setD({ ...x })}>Uredi</button><button type="button" className="btn small danger" onClick={() => setDel(x.id)}>Izbriši</button></div>
          </div>
        ))}
        {!d ? <button type="button" className="btn block" style={{ marginTop: 8 }} onClick={() => setD({ cuff: 'upper_arm' })}>+ Dodaj tlakomjer</button> : (
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <Field label="Naziv / model"><input value={d.name || ''} onChange={(e) => setD({ ...d, name: e.target.value })} required /></Field>
            <Field label="Manžeta"><select value={d.cuff} onChange={(e) => setD({ ...d, cuff: e.target.value as Device['cuff'] })}><option value="upper_arm">Nadlaktica</option><option value="wrist">Zapešće</option></select></Field>
            <Field label="Bilješka"><input value={d.note || ''} onChange={(e) => setD({ ...d, note: e.target.value })} placeholder="npr. validiran, kalibriran 2026." /></Field>
            <div className="row"><button type="submit" className="btn primary">Spremi</button><button type="button" className="btn" onClick={() => setD(null)}>Odustani</button></div>
          </form>
        )}
      </section>
      {del && <Confirm title="Izbrisati tlakomjer?" confirmLabel="Izbriši" danger onConfirm={() => { void remove('devices', del); setDel(null); }} onCancel={() => setDel(null)} />}
    </main>
  );
}
