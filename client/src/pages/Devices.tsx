import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store.tsx';
import type { Device } from '../types.ts';
import { Confirm, Field, useToast } from '../components/ui.tsx';
import { modelReady, sampleCount } from '../ocr/learn.ts';

export function DevicesPage() {
  const { data, save, remove, auth, unsynced, sync } = useStore();
  const toast = useToast();
  const [d, setD] = useState<Partial<Device> | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const [forget, setForget] = useState<string | null>(null);
  const modelOf = (id: string) => data.ocrModels.find((m) => m.deviceId === id);
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
            <div><strong>{x.name}</strong><div className="tiny">{x.cuff === 'wrist' ? 'zapešće' : 'nadlaktica'}{x.note && ` · ${x.note}`}</div>
              {(() => { const m = modelOf(x.id); const md = m ? { samples: m.samples, variantWins: m.variantWins, photos: m.photos, layout: m.layout } : null; return (<>
                <div className="tiny">OCR učenje: {md ? `${md.photos} potvrđenih fotografija, ${sampleCount(md)} znamenki` : 'još ništa'}{md && (modelReady(md) ? ' · aktivno' : ' · još se uči (potrebno ≥ 6 znamenki)')}{md?.layout && ' · raspored zaslona zapamćen'}</div>
              {m && <div className="tiny">{!auth ? '📱 samo na ovom uređaju (bez računa)' : unsynced.has(`ocrModels/${m.id}`) ? `⏳ čeka sinkronizaciju na račun${sync.status === 'offline' ? ' (offline)' : ''}` : '☁ spremljeno na račun'}</div>}
              </>); })()}
            </div>
            <div className="row"><button type="button" className="btn small" onClick={() => setD({ ...x })}>Uredi</button>{modelOf(x.id) && <button type="button" className="btn small" onClick={() => setForget(x.id)}>Zaboravi OCR</button>}<button type="button" className="btn small danger" onClick={() => setDel(x.id)}>Izbriši</button></div>
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
      {del && <Confirm title="Izbrisati tlakomjer?" confirmLabel="Izbriši" danger onConfirm={() => { const m = modelOf(del); if (m) void remove('ocrModels', m.id); void remove('devices', del); setDel(null); }} onCancel={() => setDel(null)} />}
      {forget && <Confirm title="Zaboraviti naučeno?" text="Briše naučene znamenke i zapamćeni raspored zaslona za ovaj tlakomjer. Mjerenja ostaju." confirmLabel="Zaboravi" danger onConfirm={() => { const m = modelOf(forget); if (m) void remove('ocrModels', m.id); setForget(null); toast.show('Naučeni OCR model je obrisan.'); }} onCancel={() => setForget(null)} />}
    </main>
  );
}
