import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store.tsx';
import { makeBackup, parseBackup, encryptBackup, decryptBackup, isEncryptedBackup, type Backup, type BackupPreview } from '../lib/backup.ts';
import { CSV_TEMPLATE, parseCsv, toCsv, type CsvRow } from '../lib/csv.ts';
import { shareOrDownload, stamp } from '../lib/share.ts';
import { fmtDate, fmtDateTime, fmtRelative, currentTimezone } from '../lib/format.ts';
import { Confirm, Field, Message, useToast } from '../components/ui.tsx';
import { findSession } from './NewMeasurement.tsx';

export function BackupPage() {
  const { data, markBackup, lastBackupAt, restoreBackup, saveMany } = useStore();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const [pw, setPw] = useState('');
  const [pending, setPending] = useState<{ backup: Backup; preview: BackupPreview } | null>(null);
  const [encText, setEncText] = useState<string | null>(null);
  const [decPw, setDecPw] = useState('');
  const [csv, setCsv] = useState<{ rows: CsvRow[]; errors: string[]; dupes: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const full = () => makeBackup({ measurements: data.measurements, targets: data.targets, devices: data.devices, medications: data.medications, events: data.events, settings: [data.settings], ocrModels: data.ocrModels });

  const exportJson = async () => {
    const r = await shareOrDownload(`tlak-kopija-${stamp()}.json`, JSON.stringify(full(), null, 1), 'application/json');
    await markBackup(); toast.show(r === 'shared' ? 'Kopija je podijeljena.' : 'Kopija je preuzeta.');
  };
  const exportEncrypted = async () => {
    if (pw.length < 8) { toast.show('Lozinka kopije mora imati najmanje 8 znakova.'); return; }
    const r = await shareOrDownload(`tlak-kopija-${stamp()}.enc.json`, await encryptBackup(JSON.stringify(full()), pw), 'application/json');
    await markBackup(); setPw(''); toast.show(r === 'shared' ? 'Šifrirana kopija je podijeljena.' : 'Šifrirana kopija je preuzeta.');
  };
  const exportCsv = async () => { const r = await shareOrDownload(`tlak-${stamp()}.csv`, toCsv(data.measurements.slice().reverse()), 'text/csv;charset=utf-8'); toast.show(r === 'shared' ? 'CSV je podijeljen.' : 'CSV je preuzet.'); };

  const onJsonFile = async (f: File | undefined) => {
    if (!f) return;
    setErr(null); setPending(null); setEncText(null);
    const text = await f.text();
    try {
      if (isEncryptedBackup(text)) { setEncText(text); return; }
      setPending(parseBackup(text));
    } catch (e) { setErr((e as Error).message); }
  };
  const decrypt = async () => {
    try { setPending(parseBackup(await decryptBackup(encText!, decPw))); setEncText(null); setDecPw(''); }
    catch (e) { setErr((e as Error).message); }
  };
  const doRestore = async (mode: 'merge' | 'replace') => {
    if (!pending) return;
    await restoreBackup(pending.backup, mode);
    setPending(null);
    toast.show(mode === 'replace' ? 'Podaci su zamijenjeni sadržajem kopije.' : 'Kopija je spojena s postojećim podacima.');
  };

  const onCsvFile = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    const r = parseCsv(await f.text());
    const dupes = r.rows.filter((row) => data.measurements.some((m) => Math.abs(new Date(m.measuredAt).getTime() - new Date(row.measuredAt).getTime()) < 60000 && m.systolic === row.systolic && m.diastolic === row.diastolic)).length;
    setCsv({ ...r, dupes });
  };
  const doCsvImport = async (skipDupes: boolean) => {
    if (!csv) return;
    const rows = skipDupes ? csv.rows.filter((row) => !data.measurements.some((m) => Math.abs(new Date(m.measuredAt).getTime() - new Date(row.measuredAt).getTime()) < 60000 && m.systolic === row.systolic && m.diastolic === row.diastolic)) : csv.rows;
    await saveMany('measurements', rows.map((r) => ({
      measuredAt: r.measuredAt, timezone: currentTimezone(), systolic: r.systolic, diastolic: r.diastolic, pulse: r.pulse, source: 'import' as const, period: r.period,
      sessionId: findSession(r.measuredAt, data.measurements, data.settings.sessionWindowMinutes), armLocation: 'unknown' as const, bodyPosition: 'unknown' as const, medicationTiming: 'unknown' as const,
      deviceId: null, symptoms: [], tags: [], notes: r.notes, includedInAverage: true, exclusionReason: '', ocrConfidence: null, confirmedUnusual: false,
    })));
    setCsv(null); toast.show(`Uvezeno ${rows.length} mjerenja.`);
  };

  return (
    <main className="page">
      <div className="page-header"><h1>Sigurnosna kopija</h1><Link to="/settings" className="btn small">← Postavke</Link></div>
      <section className="card">
        <p className="small">Posljednja kopija: <strong>{lastBackupAt ? `${fmtDateTime(lastBackupAt)} (${fmtRelative(lastBackupAt)})` : 'nikad'}</strong>. Brisanje podataka preglednika briše lokalnu bazu; kopija (ili račun sa sinkronizacijom) štiti od gubitka.</p>
        <div className="stack">
          <button type="button" className="btn primary" onClick={() => void exportJson()}>💾 Izvezi JSON kopiju ({data.measurements.length} mjerenja)</button>
          <div className="row">
            <input type="password" placeholder="Lozinka za šifriranu kopiju" value={pw} onChange={(e) => setPw(e.target.value)} style={{ flex: 1, minHeight: 44, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)' }} autoComplete="new-password" />
            <button type="button" className="btn" onClick={() => void exportEncrypted()}>🔒 Šifrirana kopija</button>
          </div>
          <button type="button" className="btn" onClick={() => void exportCsv()}>📊 Izvezi CSV (sva mjerenja)</button>
        </div>
      </section>

      <section className="card">
        <h2>Povrat iz JSON kopije</h2>
        <input ref={fileRef} type="file" accept=".json,application/json" className="sr-only" onChange={(e) => void onJsonFile(e.target.files?.[0])} />
        <button type="button" className="btn block" onClick={() => fileRef.current?.click()}>Odaberi JSON datoteku</button>
        {err && <Message level="error">{err}</Message>}
        {encText && (
          <div>
            <Field label="Lozinka šifrirane kopije"><input type="password" value={decPw} onChange={(e) => setDecPw(e.target.value)} /></Field>
            <button type="button" className="btn primary" onClick={() => void decrypt()}>Dešifriraj</button>
          </div>
        )}
        {pending && (
          <Confirm title="Vratiti kopiju?" confirmLabel="Spoji s postojećim" onConfirm={() => void doRestore('merge')} onCancel={() => setPending(null)}>
            <p className="small">Kopija od {pending.preview.exportedAt ? fmtDateTime(pending.preview.exportedAt) : '–'}: <strong>{pending.preview.counts.measurements} mjerenja</strong>
              {pending.preview.from && ` (${fmtDate(pending.preview.from)} – ${fmtDate(pending.preview.to!)})`}, {pending.preview.counts.targets} ciljeva, {pending.preview.counts.medications} lijekova, {pending.preview.counts.events} događaja, {pending.preview.counts.devices} tlakomjera.</p>
            <p className="small muted">„Spoji” zadržava postojeće zapise i dodaje nove (isti zapis: novija verzija pobjeđuje). „Zamijeni” briše sve trenutačne podatke i vraća točno sadržaj kopije.</p>
            <button type="button" className="btn danger block" onClick={() => void doRestore('replace')}>Zamijeni sve trenutačne podatke kopijom</button>
          </Confirm>
        )}
      </section>

      <section className="card">
        <h2>Uvoz CSV-a prema predlošku</h2>
        <p className="tiny">Stupci: datum (dd.mm.gggg.), vrijeme (HH:mm), sys, dia, puls, razdoblje (jutro/večer/drugo), biljeska. Razdjelnik ; ili ,.</p>
        <div className="row">
          <button type="button" className="btn" onClick={() => void shareOrDownload('tlak-predlozak.csv', CSV_TEMPLATE, 'text/csv;charset=utf-8')}>Preuzmi predložak</button>
          <input ref={csvRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void onCsvFile(e.target.files?.[0])} />
          <button type="button" className="btn primary" onClick={() => csvRef.current?.click()}>Odaberi CSV</button>
        </div>
        {csv && (
          <div style={{ marginTop: 10 }}>
            {csv.errors.map((e, i) => <Message key={i} level="warning">{e}</Message>)}
            <p className="small">Za uvoz: <strong>{csv.rows.length}</strong> redaka{csv.dupes > 0 && <>, od toga <strong>{csv.dupes}</strong> mogućih duplikata (isto vrijeme i vrijednosti)</>}.</p>
            <div className="scroll-x"><table className="tbl"><thead><tr><th>Datum</th><th className="n">SYS</th><th className="n">DIA</th><th className="n">Puls</th><th>Razd.</th></tr></thead><tbody>
              {csv.rows.slice(0, 10).map((r) => <tr key={r.line}><td className="tabular">{fmtDateTime(r.measuredAt)}</td><td className="n">{r.systolic}</td><td className="n">{r.diastolic}</td><td className="n">{r.pulse}</td><td>{r.period}</td></tr>)}
              {csv.rows.length > 10 && <tr><td colSpan={5} className="tiny">… i još {csv.rows.length - 10}</td></tr>}
            </tbody></table></div>
            <div className="row" style={{ marginTop: 8 }}>
              <button type="button" className="btn primary" disabled={!csv.rows.length} onClick={() => void doCsvImport(true)}>Uvezi{csv.dupes > 0 && ' (preskoči duplikate)'}</button>
              {csv.dupes > 0 && <button type="button" className="btn" onClick={() => void doCsvImport(false)}>Uvezi sve</button>}
              <button type="button" className="btn" onClick={() => setCsv(null)}>Odustani</button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
