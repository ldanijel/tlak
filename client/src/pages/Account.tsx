import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store.tsx';
import { api, deviceName, errorText } from '../sync/api.ts';
import { fmtRelative, fmtDateTime } from '../lib/format.ts';
import { syncNow } from '../sync/sync.ts';
import { Confirm, Field, Message, useToast } from '../components/ui.tsx';

interface Me { user: { email: string }; sessions: { id: string; deviceName: string; createdAt: string; lastSeenAt: string; current: boolean }[]; counts: Record<string, number> }

export function AccountPage() {
  const { auth, setAuth, sync, data } = useStore();
  const toast = useToast();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [password2, setPassword2] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false); const [cur, setCur] = useState(''); const [nw, setNw] = useState('');
  const [delOpen, setDelOpen] = useState(false); const [delPw, setDelPw] = useState('');
  const [regAllowed, setRegAllowed] = useState(true);

  useEffect(() => {
    api<{ registration: boolean }>('GET', '/api/health').then((h) => setRegAllowed(h.registration)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!auth) { setMe(null); return; }
    api<Me>('GET', '/api/auth/me', undefined, auth.token).then(setMe).catch(() => setMe(null));
  }, [auth, sync.lastSyncAt]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (mode === 'register' && password !== password2) { setErr('Lozinke se ne podudaraju.'); return; }
    setBusy(true);
    try {
      const r = await api<{ token: string; sessionId: string; user: { email: string } }>('POST', `/api/auth/${mode}`, { email, password, deviceName: deviceName() });
      await setAuth({ token: r.token, email: r.user.email, sessionId: r.sessionId });
      toast.show(mode === 'register' ? 'Račun je stvoren. Lokalni podaci su poslani na račun.' : 'Prijava uspješna. Podaci su sinkronizirani.');
      setPassword(''); setPassword2('');
    } catch (ex) { setErr(errorText(ex)); }
    setBusy(false);
  };

  const logout = async (clearLocal: boolean) => {
    setLogoutOpen(false);
    try { await api('POST', '/api/auth/logout', {}, auth?.token); } catch { /* i bez veze odjavljujemo lokalno */ }
    await setAuth(null, { clearLocal });
    toast.show(clearLocal ? 'Odjavljeni ste; lokalni podaci su uklonjeni s uređaja.' : 'Odjavljeni ste; podaci ostaju na ovom uređaju.');
  };
  const changePw = async () => {
    try { await api('POST', '/api/auth/password', { currentPassword: cur, newPassword: nw }, auth?.token); setPwOpen(false); setCur(''); setNw(''); toast.show('Lozinka je promijenjena; ostali uređaji su odjavljeni.'); }
    catch (ex) { toast.show(errorText(ex)); }
  };
  const revoke = async (id: string) => {
    try { await api('DELETE', `/api/auth/sessions/${id}`, undefined, auth?.token); setMe(me && { ...me, sessions: me.sessions.filter((s) => s.id !== id) }); toast.show('Uređaj je odjavljen.'); }
    catch (ex) { toast.show(errorText(ex)); }
  };
  const deleteAccount = async () => {
    try { await api('DELETE', '/api/auth/account', { password: delPw }, auth?.token); setDelOpen(false); await setAuth(null, { clearLocal: false }); toast.show('Račun i podaci na poslužitelju su izbrisani. Lokalna kopija ostaje na uređaju.'); }
    catch (ex) { toast.show(errorText(ex)); }
  };

  return (
    <main className="page">
      <div className="page-header"><h1>Račun i sinkronizacija</h1><Link to="/settings" className="btn small">← Postavke</Link></div>
      {!auth ? (
        <>
          <div className="card">
            <p className="small">Bez računa podaci ostaju samo u ovom pregledniku. S računom se mjerenja, ciljevi i terapija sinkroniziraju na poslužitelj i dostupni su na svim vašim uređajima nakon prijave. Fotografije se nikada ne šalju.</p>
            {sync.status === 'unauthorized' && <Message level="warning">Sesija je istekla. Prijavite se ponovno.</Message>}
            <div className="segmented" role="group">
              <button type="button" aria-pressed={mode === 'login'} onClick={() => setMode('login')}>Prijava</button>
              <button type="button" aria-pressed={mode === 'register'} onClick={() => setMode('register')} disabled={!regAllowed}>Novi račun</button>
            </div>
            <form onSubmit={(e) => void submit(e)}>
              <Field label="E-pošta"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></Field>
              <Field label="Lozinka" hint={mode === 'register' ? 'Najmanje 8 znakova.' : undefined}><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength={8} required /></Field>
              {mode === 'register' && <Field label="Ponovite lozinku"><input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" required /></Field>}
              {err && <Message level="error">{err}</Message>}
              <button type="submit" className="btn primary big" disabled={busy}>{busy ? 'Pričekajte…' : mode === 'register' ? 'Stvori račun i sinkroniziraj' : 'Prijavi se'}</button>
              {data.measurements.length > 0 && <p className="tiny">Nakon prijave {data.measurements.length} lokalnih mjerenja spaja se s podacima na računu (novija izmjena istog zapisa pobjeđuje).</p>}
            </form>
          </div>
          <div className="card"><p className="tiny">Lozinka se pohranjuje isključivo kao scrypt sažetak. Podaci na poslužitelju čuvaju se u bazi vezanoj uz vaš račun; pristup je moguć samo uz prijavu. Ako zaboravite lozinku, podaci se mogu vratiti iz JSON sigurnosne kopije u novi račun.</p></div>
        </>
      ) : (
        <>
          <div className="card">
            <p><strong>{auth.email}</strong></p>
            <p className="small">Stanje: {sync.status === 'syncing' ? 'sinkronizacija u tijeku…' : sync.status === 'offline' ? 'offline – promjene čekaju vezu' : sync.status === 'error' ? `greška: ${sync.error}` : `sinkronizirano ${fmtRelative(sync.lastSyncAt)}`}{sync.pending > 0 && ` · ${sync.pending} promjena čeka`}</p>
            {me && <p className="tiny">Na poslužitelju: {me.counts.measurements || 0} mjerenja, {me.counts.targets || 0} ciljeva, {me.counts.medications || 0} lijekova, {me.counts.events || 0} događaja.</p>}
            <div className="row">
              <button type="button" className="btn primary" onClick={() => void syncNow().then((ok) => toast.show(ok ? 'Sinkronizacija dovršena.' : 'Sinkronizacija nije uspjela.'))}>⟳ Sinkroniziraj sada</button>
              <button type="button" className="btn" onClick={() => setPwOpen(true)}>Promijeni lozinku</button>
              <button type="button" className="btn" onClick={() => setLogoutOpen(true)}>Odjava</button>
            </div>
          </div>
          <div className="card">
            <h3>Prijavljeni uređaji</h3>
            {!me ? <p className="muted small">Popis nije dostupan (offline).</p> : me.sessions.map((s) => (
              <div key={s.id} className="row between" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <div><strong>{s.deviceName || 'Uređaj'}</strong>{s.current && ' (ovaj uređaj)'}<div className="tiny">zadnji pristup {fmtDateTime(s.lastSeenAt)} · prijava {fmtDateTime(s.createdAt)}</div></div>
                {!s.current && <button type="button" className="btn small" onClick={() => void revoke(s.id)}>Odjavi</button>}
              </div>
            ))}
          </div>
          <div className="card">
            <h3>Brisanje računa</h3>
            <p className="small muted">Trajno briše račun i sve podatke na poslužitelju. Lokalna kopija na ovom uređaju ostaje.</p>
            <button type="button" className="btn danger" onClick={() => setDelOpen(true)}>Izbriši račun</button>
          </div>
        </>
      )}
      {logoutOpen && (
        <Confirm title="Odjava" text="Želite li zadržati lokalnu kopiju podataka na ovom uređaju?" confirmLabel="Odjavi i zadrži podatke" onConfirm={() => void logout(false)} onCancel={() => setLogoutOpen(false)}>
          <button type="button" className="btn danger block" onClick={() => void logout(true)}>Odjavi i ukloni podatke s uređaja</button>
        </Confirm>
      )}
      {pwOpen && (
        <Confirm title="Promjena lozinke" confirmLabel="Promijeni" onConfirm={() => void changePw()} onCancel={() => setPwOpen(false)}>
          <Field label="Trenutačna lozinka"><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
          <Field label="Nova lozinka (min. 8)"><input type="password" value={nw} onChange={(e) => setNw(e.target.value)} autoComplete="new-password" /></Field>
        </Confirm>
      )}
      {delOpen && (
        <Confirm title="Izbrisati račun?" text="Ova radnja je nepovratna. Unesite lozinku za potvrdu." confirmLabel="Trajno izbriši" danger onConfirm={() => void deleteAccount()} onCancel={() => setDelOpen(false)}>
          <Field label="Lozinka"><input type="password" value={delPw} onChange={(e) => setDelPw(e.target.value)} /></Field>
        </Confirm>
      )}
    </main>
  );
}
