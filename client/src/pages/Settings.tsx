import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store.tsx';
import { fmtRelative } from '../lib/format.ts';
import { DEFAULT_CATEGORIES, DEFAULT_SAFETY } from '../types.ts';
import { Confirm, Field, Modal, useToast } from '../components/ui.tsx';
import { useNavigate } from 'react-router-dom';
import { syncNow } from '../sync/sync.ts';
import { clearPin, getLockCfg, setPin } from '../components/Lock.tsx';
import { api } from '../sync/api.ts';

export function SettingsPage() {
  const { data, updateSettings, auth, sync, lastBackupAt, factoryReset } = useStore();
  const toast = useToast();
  const nav = useNavigate();
  const [resetOpen, setResetOpen] = useState(false);
  const [resetWord, setResetWord] = useState('');
  const [upd, setUpd] = useState<'idle' | 'checking' | 'none' | 'found'>('idle');
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const checkUpdate = async () => {
    setUpd('checking');
    try {
      const h = await api<{ version?: string }>('GET', '/api/health').catch(() => null);
      if (h?.version) setServerVersion(h.version);
      const found = window.__tlakCheckUpdate ? await Promise.race([window.__tlakCheckUpdate(), new Promise<boolean>((r) => setTimeout(() => r(false), 8000))]) : false;
      const newer = !!h?.version && h.version !== __APP_VERSION__;
      if (found || newer) { setUpd('found'); toast.show('Nova verzija je preuzeta, aplikacija se osvježava…'); setTimeout(() => { if (window.__tlakUpdateNow) void window.__tlakUpdateNow(); else location.reload(); }, 800); }
      else setUpd('none');
    } catch { setUpd('none'); }
  };
  const s = data.settings;
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPinVal] = useState(''); const [pin2, setPin2] = useState(''); const [autoLock, setAutoLock] = useState(5);
  const [lockCfg, setLockCfg] = useState(getLockCfg());
  const [safety, setSafety] = useState(s.safety);
  const [cat, setCat] = useState(s.categories);

  const savePin = async () => {
    if (!/^\d{4}$/.test(pin) || pin !== pin2) { toast.show('PIN mora imati 4 znamenke i oba unosa moraju biti jednaka.'); return; }
    await setPin(pin, autoLock);
    setLockCfg(getLockCfg()); setPinOpen(false); setPinVal(''); setPin2('');
    toast.show('PIN je postavljen za ovaj uređaj.');
  };

  return (
    <main className="page">
      <h1>Postavke</h1>
      <section className="card stack">
        <Link to="/settings/account" className="btn block" style={{ justifyContent: 'space-between' }}>
          <span>☁ Račun i sinkronizacija</span><span className="small muted">{auth ? `${auth.email} · ${sync.status === 'syncing' ? 'sinkronizacija…' : fmtRelative(sync.lastSyncAt)}` : 'samo lokalno'}</span>
        </Link>
        <Link to="/settings/targets" className="btn block" style={{ justifyContent: 'space-between' }}><span>🎯 Osobni ciljni raspon</span><span className="small muted">{data.targets.length ? `${data.targets[data.targets.length - 1].sysMin}–${data.targets[data.targets.length - 1].sysMax}/${data.targets[data.targets.length - 1].diaMin}–${data.targets[data.targets.length - 1].diaMax}` : 'nije postavljen'}</span></Link>
        <Link to="/settings/therapy" className="btn block" style={{ justifyContent: 'space-between' }}><span>💊 Terapija i događaji</span><span className="small muted">{data.medications.length} lijekova · {data.events.length} događaja</span></Link>
        <Link to="/settings/devices" className="btn block" style={{ justifyContent: 'space-between' }}><span>🩺 Tlakomjeri</span><span className="small muted">{data.devices.length}</span></Link>
        <Link to="/settings/backup" className="btn block" style={{ justifyContent: 'space-between' }}><span>💾 Sigurnosna kopija, uvoz i izvoz</span><span className="small muted">{lastBackupAt ? fmtRelative(lastBackupAt) : 'nikad'}</span></Link>
        <Link to="/upute" className="btn block" style={{ justifyContent: 'space-between' }}><span>📖 Upute za ukućane</span><span className="small muted">podijeli link</span></Link>
      </section>

      <section className="card">
        <h2>Unos</h2>
        <label className="row"><input type="checkbox" checked={s.showChecklist} onChange={(e) => void updateSettings({ showChecklist: e.target.checked })} style={{ width: 24, height: 24 }} /> Prikaži kontrolnu listu prije mjerenja</label>
        <Field label="Prozor sesije (min)" hint="Mjerenja unutar ovog razmaka grupiraju se u jednu sesiju."><input type="number" min={1} max={60} value={s.sessionWindowMinutes} onChange={(e) => void updateSettings({ sessionWindowMinutes: Math.max(1, Number(e.target.value) || 10) })} /></Field>
        <Field label="Podsjetnik na sigurnosnu kopiju (dana)"><input type="number" min={1} max={365} value={s.backupReminderDays} onChange={(e) => void updateSettings({ backupReminderDays: Math.max(1, Number(e.target.value) || 30) })} /></Field>
      </section>

      <section className="card">
        <h2>Podaci za izvještaj</h2>
        <Field label="Ime i prezime (neobvezno)"><input value={s.profileName} onChange={(e) => void updateSettings({ profileName: e.target.value })} autoComplete="name" /></Field>
        <Field label="Godina rođenja (neobvezno)"><input inputMode="numeric" value={s.profileBirthYear} onChange={(e) => void updateSettings({ profileBirthYear: e.target.value.replace(/\D/g, '').slice(0, 4) })} /></Field>
      </section>

      <section className="card">
        <h2>Kategorije tlaka (ESC)</h2>
        <p className="tiny">Zadano prema ESC smjernicama za kućno mjerenje: nepovišeni &lt; 120/70, povišeni 120–134/70–84, visoki 135–179/85–119, vrlo visoki ≥ 180/120. Kategoriju određuje lošija od dviju vrijednosti (npr. 118/71 je povišeni zbog DIA). Kod „vrlo visoki” aplikacija traži ponovljeno mjerenje i provjeru simptoma (112).</p>
        <div className="grid2">
          <Field label="Povišeni – SYS od"><input type="number" value={cat.elevatedSys} onChange={(e) => setCat({ ...cat, elevatedSys: Number(e.target.value) })} /></Field>
          <Field label="Povišeni – DIA od"><input type="number" value={cat.elevatedDia} onChange={(e) => setCat({ ...cat, elevatedDia: Number(e.target.value) })} /></Field>
          <Field label="Visoki – SYS od"><input type="number" value={cat.highSys} onChange={(e) => setCat({ ...cat, highSys: Number(e.target.value) })} /></Field>
          <Field label="Visoki – DIA od"><input type="number" value={cat.highDia} onChange={(e) => setCat({ ...cat, highDia: Number(e.target.value) })} /></Field>
          <Field label="Vrlo visoki – SYS od"><input type="number" value={cat.veryHighSys} onChange={(e) => setCat({ ...cat, veryHighSys: Number(e.target.value) })} /></Field>
          <Field label="Vrlo visoki – DIA od"><input type="number" value={cat.veryHighDia} onChange={(e) => setCat({ ...cat, veryHighDia: Number(e.target.value) })} /></Field>
        </div>
        <div className="row">
          <button type="button" className="btn primary" onClick={() => { if (cat.elevatedSys >= cat.highSys || cat.elevatedDia >= cat.highDia || cat.highSys >= cat.veryHighSys || cat.highDia >= cat.veryHighDia) { toast.show('Pragovi moraju rasti: povišeni < visoki < vrlo visoki.'); return; } void updateSettings({ categories: cat }); toast.show('Kategorije su spremljene.'); }}>Spremi kategorije</button>
          <button type="button" className="btn" onClick={() => { setCat({ ...DEFAULT_CATEGORIES }); void updateSettings({ categories: { ...DEFAULT_CATEGORIES } }); }}>Vrati ESC zadano</button>
        </div>
      </section>

      <section className="card">
        <h2>Upozorenja na niske vrijednosti i puls</h2>
        <p className="tiny">Gornji sigurnosni prag je kategorija „vrlo visoki” (gore). Ovdje su upozorenja za niske vrijednosti i neuobičajen puls; aplikacija ne postavlja dijagnozu.</p>
        <div className="grid2">
          <Field label="SYS – upozorenje na nisko do"><input type="number" value={safety.sysLow} onChange={(e) => setSafety({ ...safety, sysLow: Number(e.target.value) })} /></Field>
          <Field label="DIA – upozorenje na nisko do"><input type="number" value={safety.diaLow} onChange={(e) => setSafety({ ...safety, diaLow: Number(e.target.value) })} /></Field>
          <Field label="Puls – visok od"><input type="number" value={safety.pulseHigh} onChange={(e) => setSafety({ ...safety, pulseHigh: Number(e.target.value) })} /></Field>
          <Field label="Puls – nizak do"><input type="number" value={safety.pulseLow} onChange={(e) => setSafety({ ...safety, pulseLow: Number(e.target.value) })} /></Field>
        </div>
        <div className="row">
          <button type="button" className="btn primary" onClick={() => { void updateSettings({ safety }); toast.show('Pragovi su spremljeni.'); }}>Spremi pragove</button>
          <button type="button" className="btn" onClick={() => { setSafety({ ...DEFAULT_SAFETY }); void updateSettings({ safety: { ...DEFAULT_SAFETY } }); }}>Vrati zadano</button>
        </div>
      </section>

      <section className="card">
        <h2>Zaključavanje aplikacije</h2>
        <p className="small muted">{lockCfg ? `PIN je postavljen na ovom uređaju (automatsko zaključavanje nakon ${lockCfg.autoLockMin} min u pozadini).` : 'PIN nije postavljen. Vrijedi samo za ovaj uređaj.'}</p>
        <div className="row">
          <button type="button" className="btn" onClick={() => setPinOpen(true)}>{lockCfg ? 'Promijeni PIN' : 'Postavi PIN'}</button>
          {lockCfg && <button type="button" className="btn danger" onClick={() => { clearPin(); setLockCfg(null); toast.show('PIN je uklonjen.'); }}>Ukloni PIN</button>}
        </div>
        <p className="tiny">Otključavanje putem Face ID-ja/Touch ID-ja zahtijeva sustavsku WebAuthn integraciju i nije uključeno u ovu verziju.</p>
      </section>

      <section className="card">
        <h2>Tvornički reset ovog uređaja</h2>
        <p className="small muted">Briše sve lokalne podatke na ovom uređaju: mjerenja, postavke, naučeni OCR, PIN i prijavu. Podaci na računu ostaju i vraćaju se ponovnom prijavom. Ako niste prijavljeni, lokalna mjerenja su nepovratno izgubljena; prije toga izradite sigurnosnu kopiju.</p>
        <button type="button" className="btn danger" onClick={() => { setResetWord(''); setResetOpen(true); }}>Tvornički reset</button>
      </section>

      <section className="card">
        <h2>O aplikaciji</h2>
        <p className="small"><strong>Tlak v{__APP_VERSION__}</strong> · izgrađeno {new Date(__BUILD_TIME__).toLocaleString('hr-HR', { dateStyle: 'short', timeStyle: 'short' })}{serverVersion && ` · poslužitelj v${serverVersion}`}</p>
        <div className="row"><button type="button" className="btn small" disabled={upd === 'checking'} onClick={() => void checkUpdate()}>{upd === 'checking' ? 'Provjera…' : 'Provjeri ažuriranje'}</button>{upd === 'none' && <span className="tiny">Imate najnoviju verziju.</span>}{upd === 'found' && <span className="tiny">Nova verzija, osvježavanje…</span>}</div>
        <p className="small muted">Nova verzija preuzima se sama u pozadini i primjenjuje pri idućem otvaranju aplikacije; provjera se ponavlja svakih sat vremena. Hrvatski · mmHg, otkucaji/min · datum dd.mm.gggg., 24-satno vrijeme. Aplikacija ne postavlja dijagnozu i ne predlaže promjenu terapije. U hitnom slučaju nazovite 112.</p>
      </section>

      {resetOpen && (
        <Confirm title="Tvornički reset" confirmLabel="Obriši sve na ovom uređaju" danger onConfirm={() => { if (resetWord.trim().toUpperCase() !== 'RESET') { toast.show('Upišite RESET za potvrdu.'); return; } void (async () => { if (auth) { const ok = await syncNow(); if (!ok) { toast.show('Sinkronizacija nije uspjela; reset je otkazan da se ne izgube nesinkronizirane promjene. Pokušajte s mrežom.'); return; } } setResetOpen(false); await factoryReset(); toast.show('Uređaj je vraćen na početno stanje.'); nav('/'); })(); }} onCancel={() => setResetOpen(false)}>
          <p className="small">{auth ? `Prijavljeni ste kao ${auth.email}; mjerenja i naučeni OCR ostaju na računu i vraćaju se prijavom. Prije brisanja aplikacija će sinkronizirati promjene.` : 'Niste prijavljeni: lokalna mjerenja i naučeni OCR bit će trajno izbrisani.'} {data.measurements.length} mjerenja na ovom uređaju.</p>
          <Field label="Za potvrdu upišite RESET"><input value={resetWord} onChange={(e) => setResetWord(e.target.value)} autoComplete="off" /></Field>
        </Confirm>
      )}
      {pinOpen && (
        <Modal title="PIN aplikacije" onClose={() => setPinOpen(false)}>
          <Field label="Novi PIN (4 znamenke)"><input type="password" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPinVal(e.target.value.replace(/\D/g, ''))} autoFocus /></Field>
          <Field label="Ponovite PIN"><input type="password" inputMode="numeric" maxLength={4} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label="Automatsko zaključavanje nakon (min)"><input type="number" min={0} max={120} value={autoLock} onChange={(e) => setAutoLock(Number(e.target.value))} /></Field>
          <div className="actions"><button type="button" className="btn" onClick={() => setPinOpen(false)}>Odustani</button><button type="button" className="btn primary" onClick={() => void savePin()}>Spremi</button></div>
        </Modal>
      )}
    </main>
  );
}
