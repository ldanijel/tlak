import { useEffect, useState, type ReactNode } from 'react';

/* PIN se čuva samo na ovom uređaju (localStorage), kao SHA-256 sažetak sa soli. */
const KEY = 'tlak.lock';
interface LockCfg { hash: string; salt: string; autoLockMin: number }

async function digest(pin: string, salt: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
export function getLockCfg(): LockCfg | null {
  try { const r = localStorage.getItem(KEY); return r ? (JSON.parse(r) as LockCfg) : null; } catch { return null; }
}
export async function setPin(pin: string, autoLockMin: number): Promise<void> {
  const salt = crypto.randomUUID();
  localStorage.setItem(KEY, JSON.stringify({ hash: await digest(pin, salt), salt, autoLockMin }));
}
export function clearPin(): void { localStorage.removeItem(KEY); }
export async function verifyPin(pin: string): Promise<boolean> {
  const c = getLockCfg();
  return !!c && (await digest(pin, c.salt)) === c.hash;
}

export function LockGate({ children }: { children: ReactNode }) {
  const [locked, setLocked] = useState(() => !!getLockCfg());
  const [pin, setPinState] = useState('');
  const [err, setErr] = useState(false);

  useEffect(() => {
    let hiddenAt = 0;
    const onVis = () => {
      const cfg = getLockCfg();
      if (!cfg) return;
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > cfg.autoLockMin * 60000) setLocked(true);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    if (pin.length === 4) {
      verifyPin(pin).then((ok) => { if (ok) { setLocked(false); setPinState(''); setErr(false); } else { setErr(true); setPinState(''); } });
    }
  }, [pin]);

  if (!locked) return <>{children}</>;
  return (
    <div className="lock">
      <h1>Tlak</h1>
      <p className="muted">Unesite PIN za otključavanje.</p>
      <div className="dots" aria-label={`Uneseno ${pin.length} od 4 znamenke`}>{[0, 1, 2, 3].map((i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}</div>
      {err && <p role="alert" style={{ color: 'var(--critical)' }}>Pogrešan PIN.</p>}
      <div className="pin">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) => (
          <button key={i} type="button" className="btn" disabled={k === ''} style={{ visibility: k === '' ? 'hidden' : 'visible' }}
            onClick={() => setPinState((p) => (k === '⌫' ? p.slice(0, -1) : (p + k).slice(0, 4)))}>{k}</button>
        ))}
      </div>
      <p className="tiny">Zaboravljeni PIN može se ukloniti samo brisanjem podataka web-mjesta u pregledniku; podaci na računu ostaju.</p>
    </div>
  );
}
