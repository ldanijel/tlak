import { Link } from 'react-router-dom';
import { useStore } from '../store.tsx';
import { useToast } from '../components/ui.tsx';

/** Kratke upute za ukućane; javna stranica bez pozivnog koda (kod se šalje zasebno). */
export function GuidePage() {
  const { auth } = useStore();
  const toast = useToast();
  const url = `${location.origin}/upute`;
  const share = async () => {
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    const text = `Aplikacija Tlak za praćenje krvnog tlaka: ${location.origin}\nUpute: ${url}\nPozivni kod šaljem zasebno.`;
    try {
      if (nav.share) { await nav.share({ title: 'Tlak – upute', text, url }); return; }
      await navigator.clipboard.writeText(text);
      toast.show('Tekst s adresom je kopiran.');
    } catch { /* korisnik je odustao */ }
  };
  return (
    <main className="page">
      <div className="page-header"><h1>Upute za ukućane</h1><Link to="/settings" className="btn small no-print">← Postavke</Link></div>
      <section className="card">
        <h2>1. Instalacija na iPhone</h2>
        <ol>
          <li>U Safariju otvorite <strong>{location.origin}</strong>.</li>
          <li>Pritisnite gumb Dijeli (kvadrat sa strelicom) → <strong>Dodaj na početni zaslon</strong> → Dodaj.</li>
          <li>Aplikaciju otvarajte s početnog zaslona; radi i bez interneta.</li>
        </ol>
        <p className="tiny">Android: Chrome → izbornik ⋮ → „Dodaj na početni zaslon”. Računalo: otvorite adresu u pregledniku.</p>
      </section>
      <section className="card">
        <h2>2. Vaš račun</h2>
        <ol>
          <li>Postavke → Račun i sinkronizacija → <strong>Novi račun</strong>.</li>
          <li>Upišite svoju e-poštu, lozinku od najmanje 8 znakova i <strong>pozivni kod</strong> koji ste dobili.</li>
          <li>Na drugom uređaju odaberite Prijava s istim podacima; mjerenja se sinkroniziraju.</li>
        </ol>
        <p className="small">Svatko vidi samo svoja mjerenja. Zaboravljena lozinka ne može se poslati e-poštom, zato povremeno izradite kopiju (Postavke → Sigurnosna kopija).</p>
      </section>
      <section className="card">
        <h2>3. Unos mjerenja</h2>
        <ul>
          <li><strong>Ručno:</strong> gumb + → SYS, DIA, puls (neobvezno) → Spremi. Datum i vrijeme su trenutačni.</li>
          <li><strong>Fotografijom:</strong> Početna → Fotografiraj tlakomjer. Snimite zaslon ravno, bez odsjaja. Aplikacija sama pronađe brojke; provjerite ih i potvrdite. Prvi put odaberite ili dodajte svoj tlakomjer, da aplikacija uči njegove znamenke.</li>
          <li>Prije mjerenja: 5 minuta odmora, sjedeći, leđa oslonjena, stopala na podu, ruka u visini srca, bez razgovora.</li>
        </ul>
      </section>
      <section className="card">
        <h2>4. Što znače boje</h2>
        <ul>
          <li><span className="val-normal">● Nepovišeni</span>: SYS ispod 120 i DIA ispod 70.</li>
          <li><span className="val-elevated">▲ Povišeni</span>: SYS 120–134 ili DIA 70–84.</li>
          <li><span className="val-high">■ Visoki</span>: SYS 135–179 ili DIA 85–119.</li>
          <li><span className="val-veryhigh">‼ Vrlo visoki</span>: SYS 180 i više ili DIA 120 i više. Odmorite 5 minuta i ponovite; uz bol u prsima, zaduhu, smetnje vida ili govora nazovite 112.</li>
        </ul>
        <p className="tiny">Aplikacija ne postavlja dijagnozu i ne mijenja terapiju. Pragovi su prema ESC smjernicama za kućno mjerenje.</p>
      </section>
      <section className="card">
        <h2>5. Izvještaj za liječnika</h2>
        <p className="small">Analiza → Izvještaj → odaberite razdoblje → „PDF / ispis” i pošaljite e-poštom ili spremite u Datoteke.</p>
      </section>
      {auth && <button type="button" className="btn primary block no-print" onClick={() => void share()}>Podijeli upute i adresu</button>}
    </main>
  );
}
