import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.tsx';
import './styles.css';

// Ažuriranje: nova verzija se preuzima u pozadini i stranica se sama osvježava (autoUpdate).
// Uz to se provjera pokreće svakih sat vremena i pri svakom povratku u aplikaciju, jer instalirana
// PWA na iPhoneu može danima ostati otvorena bez nove navigacije.
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_url, r) {
    if (!r) return;
    const check = () => { void r.update().catch(() => {}); };
    setInterval(check, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    window.__tlakCheckUpdate = async () => { await r.update(); return !!(r.waiting || r.installing); };
  },
});
window.__tlakUpdateNow = () => updateSW(true);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
