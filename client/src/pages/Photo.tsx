import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useStore } from '../store.tsx';
import { exifDate, loadImage, toCanvas, cropRotate, type Rect } from '../ocr/image.ts';
import { recognizeBands, warmUpOcr, type OcrResult } from '../ocr/recognize.ts';
import { autoDetect } from '../ocr/autodetect.ts';
import { fmtDateTime, fromInputs, toInputDate, toInputTime, currentTimezone } from '../lib/format.ts';
import { suggestPeriod } from '../lib/periods.ts';
import { hasErrors, needsConfirm, validateDraft, type ValidationMessage } from '../lib/validation.ts';
import { Message, NumberInput, useToast } from '../components/ui.tsx';
import { emptyModel, learn, modelReady, sampleCount, type OcrModelData } from '../ocr/learn.ts';
import type { OcrModel } from '../types.ts';
import { shareOrDownload, stamp } from '../lib/share.ts';
import { bitsToBase64 } from '../ocr/learn.ts';
import { findSession } from './NewMeasurement.tsx';

type Stage = 'pick' | 'crop' | 'ocr' | 'confirm';

/** Umanjena kopija cijele fotografije (dulja stranica 800 px) za dijagnostiku. */
function thumbnail(c: HTMLCanvasElement): string {
  try {
    const k = Math.min(1, 800 / Math.max(c.width, c.height));
    const t = document.createElement('canvas'); t.width = Math.round(c.width * k); t.height = Math.round(c.height * k);
    t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.6);
  } catch { return ''; }
}

export function PhotoPage({ mode }: { mode: 'camera' | 'gallery' }) {
  const { data, save, remove, auth } = useStore();
  const nav = useNavigate();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage>('pick');
  const [source, setSource] = useState<HTMLCanvasElement | null>(null);
  const [rect, setRect] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [dividers, setDividers] = useState<[number, number]>([0.34, 0.67]);
  const [deviceId, setDeviceId] = useState<string>(() => { try { return localStorage.getItem('tlak.lastDevice') || data.devices[0]?.id || ''; } catch { return data.devices[0]?.id || ''; } });
  const [newDevice, setNewDevice] = useState('');
  const model: OcrModel | undefined = data.ocrModels.find((x) => x.deviceId === deviceId);
  const modelData: OcrModelData = model ? { samples: model.samples, variantWins: model.variantWins, photos: model.photos, layout: model.layout, positions: model.positions || {} } : emptyModel();
  const [layoutApplied, setLayoutApplied] = useState(false);
  const [autoFound, setAutoFound] = useState<'auto' | 'memory' | null>(null);
  /** Podrijetlo trenutačnog izreza: automatski, zapamćeni raspored ili ručno postavljen. */
  const [origin, setOrigin] = useState<'auto' | 'memory' | 'manual'>('manual');
  const [autoNotice, setAutoNotice] = useState<string | null>(null);
  const autoInfo = useRef<unknown>(null);
  const [thumb, setThumb] = useState<string>('');
  // Opcija: nakon spremanja odmah nova fotografija (serija mjerenja). Pamti se na ovom uređaju.
  const [series, setSeries] = useState<boolean>(() => { try { return localStorage.getItem('tlak.photoSeries') === '1'; } catch { return false; } });
  const toggleSeries = (v: boolean) => { setSeries(v); try { localStorage.setItem('tlak.photoSeries', v ? '1' : '0'); } catch { /* ignore */ } };

  const applyLayout = (c: HTMLCanvasElement, m: OcrModel | undefined) => {
    if (m?.layout) {
      const l = m.layout;
      setRect({ x: l.rect.x * c.width, y: l.rect.y * c.height, w: l.rect.w * c.width, h: l.rect.h * c.height });
      setDividers(l.dividers);
      setLayoutApplied(true);
    } else {
      setRect({ x: c.width * 0.15, y: c.height * 0.25, w: c.width * 0.7, h: c.height * 0.5 });
      setDividers([0.34, 0.67]);
      setLayoutApplied(false);
    }
  };
  const chooseDevice = (id: string) => {
    setDeviceId(id);
    try { localStorage.setItem('tlak.lastDevice', id); } catch { /* ignore */ }
    if (source) applyLayout(source, data.ocrModels.find((x) => x.deviceId === id));
  };
  const addDevice = async () => {
    const name = newDevice.trim();
    if (!name) return;
    const d = await save('devices', { name, cuff: 'upper_arm', note: '' });
    setNewDevice('');
    chooseDevice(d.id);
  };
  const [progress, setProgress] = useState({ stage: '', p: 0 });
  const [result, setResult] = useState<OcrResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sys, setSys] = useState<number | null>(null), [dia, setDia] = useState<number | null>(null), [pulse, setPulse] = useState<number | null>(null);
  const [dateSrc, setDateSrc] = useState<'now' | 'exif'>('now');
  const [date, setDate] = useState(toInputDate(new Date())), [time, setTime] = useState(toInputTime(new Date()));
  const [msgs, setMsgs] = useState<ValidationMessage[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const drag = useRef<{ handle: string; sx: number; sy: number; r: Rect; d: [number, number] } | null>(null);

  useEffect(() => { void warmUpOcr(); }, []);
  useEffect(() => { if (stage === 'pick') inputRef.current?.click(); }, [stage, mode]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const img = await loadImage(file);
      const c = toCanvas(img, 1600);
      setSource(c);
      setRotation(0);
      setAutoNotice(null);
      setThumb(thumbnail(c));
      if (mode === 'gallery') {
        const d = await exifDate(file);
        if (d) { setDate(toInputDate(d)); setTime(toInputTime(d)); setDateSrc('exif'); }
        else { const n = new Date(); setDate(toInputDate(n)); setTime(toInputTime(n)); setDateSrc('now'); }
      } else { const n = new Date(); setDate(toInputDate(n)); setTime(toInputTime(n)); setDateSrc('now'); }
      // 1) automatsko pronalaženje redova znamenki; 2) zapamćeni raspored; 3) ručni izrez.
      // Svaki automatski pokušaj prolazi samo ako su SYS i DIA pouzdano pročitani; inače slijedi idući korak.
      const attempts: { origin: 'auto' | 'memory'; rect: Rect; dividers: [number, number] }[] = [];
      const found = detectDisplay(c);
      if (found && found.rows >= 2) attempts.push({ origin: 'auto', rect: found.rect, dividers: found.dividers });
      if (model?.layout) {
        const l = model.layout;
        attempts.push({ origin: 'memory', rect: { x: l.rect.x * c.width, y: l.rect.y * c.height, w: l.rect.w * c.width, h: l.rect.h * c.height }, dividers: l.dividers });
      }
      for (const a of attempts) {
        setRect(a.rect); setDividers(a.dividers); setLayoutApplied(a.origin === 'memory'); setAutoFound(a.origin); setOrigin(a.origin);
        const ok = await runOcrWith(c, a.rect, a.dividers, a.origin);
        if (ok) return;
      }
      // Ni jedan automatski pokušaj nije bio pouzdan: ručni izrez, s najboljim dosad poznatim okvirom kao početnim.
      setAutoFound(null); setOrigin('manual');
      if (attempts.length) {
        const a = attempts[0];
        setRect(a.rect); setDividers(a.dividers); setLayoutApplied(false);
        setAutoNotice(a.origin === 'auto' ? 'Automatski izrez nije dao pouzdano očitanje, zato provjerite i prilagodite okvir i horizontale.' : 'Zapamćeni raspored nije dao pouzdano očitanje, zato prilagodite okvir i horizontale.');
      } else if (found) {
        // znamenke nisu pročitane, ali je okvir zaslona pronađen: on je početni okvir za ručni izrez
        setRect(found.rect); setDividers(found.dividers); setLayoutApplied(false);
        setAutoNotice('Zaslon je pronađen, ali znamenke nisu pročitane automatski. Provjerite okvir i horizontale pa pokrenite prepoznavanje.');
      } else applyLayout(c, model);
      setStage('crop');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Sivi raster fotografije za automatsko pronalaženje zaslona. */
  const detectDisplay = (c: HTMLCanvasElement): { rect: Rect; dividers: [number, number]; rows: number } | null => {
    try {
      const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
      const gray = new Uint8ClampedArray(c.width * c.height);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) gray[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      autoInfo.current = null;
      const r = autoDetect(gray, c.width, c.height, (info) => { autoInfo.current = info; });
      if (!r) return null;
      return { rect: { x: r.rect.x * c.width, y: r.rect.y * c.height, w: r.rect.w * c.width, h: r.rect.h * c.height }, dividers: r.dividers, rows: r.rows };
    } catch (e) {
      console.warn('autoDetect', e);
      return null;
    }
  };

  const runOcr = () => { setOrigin('manual'); setAutoFound(null); setAutoNotice(null); void runOcrWith(source, rect, dividers, 'manual'); };
  /** Automatski izrez vrijedi samo ako su SYS i DIA pročitani dovoljno pouzdano i bez upozorenja o pomaknutom okviru. */
  const reliable = (r: OcrResult) => r.systolic.value !== null && r.diastolic.value !== null && r.systolic.confidence >= 55 && r.diastolic.confidence >= 55 && r.alignmentWarnings.length === 0 && r.systolic.value > r.diastolic.value;
  const runOcrWith = async (src: HTMLCanvasElement | null, r0: Rect, div: [number, number], from: 'auto' | 'memory' | 'manual'): Promise<boolean> => {
    if (!src) return false;
    setStage('ocr');
    try {
      const display = cropRotate(src, r0, 0);
      const r = await recognizeBands(display, div, (s, p) => setProgress({ stage: s, p }), modelData);
      if (from !== 'manual' && !reliable(r)) return false;
      if (r.dividers) setDividers(r.dividers); // horizontale privučene na prazne retke ostaju zapamćene
      setResult(r);
      setSys(r.systolic.value); setDia(r.diastolic.value); setPulse(r.pulse.value);
      setMsgs([]); setConfirmed(false);
      setStage('confirm');
      return true;
    } catch (e) {
      if (from !== 'manual') return false;
      setError((e as Error).message);
      setStage('crop');
      return false;
    }
  };

  const measuredAt = fromInputs(date, time).toISOString();
  const onSave = async (next = series) => {
    const m = validateDraft({ systolic: sys, diastolic: dia, pulse, measuredAt, period: suggestPeriod(new Date(measuredAt)) }, { existing: data.measurements, targets: data.targets, safety: data.settings.safety, categories: data.settings.categories });
    setMsgs(m);
    if (hasErrors(m)) return;
    if (needsConfirm(m) && !confirmed) { setConfirmed(true); return; }
    const saved = await save('measurements', {
      measuredAt, timezone: currentTimezone(), systolic: sys!, diastolic: dia!, pulse,
      source: mode, period: suggestPeriod(new Date(measuredAt)), sessionId: findSession(measuredAt, data.measurements, data.settings.sessionWindowMinutes),
      armLocation: 'unknown', bodyPosition: 'unknown', medicationTiming: 'unknown', deviceId: deviceId || null,
      symptoms: [], tags: [], notes: '', includedInAverage: true, exclusionReason: '',
      ocrConfidence: result ? { systolic: result.systolic.confidence, diastolic: result.diastolic.confidence, pulse: result.pulse.confidence } : null,
      confirmedUnusual: needsConfirm(m),
    });
    // Učenje: potvrđene znamenke i raspored zaslona pamte se za ovaj tlakomjer.
    if (deviceId && result && source) {
      try {
      let md = { ...modelData, samples: { ...modelData.samples }, variantWins: { ...modelData.variantWins } };
      const confirmedValues = [String(sys), String(dia), pulse === null ? '' : String(pulse)];
      const ocrValues = [result.systolic.value, result.diastolic.value, result.pulse.value];
      // Izrez je pouzdan ako ga je korisnik postavio ručno ili ako je OCR pogodio bar SYS ili DIA.
      // Iz nepouzdanog (automatskog, a pogrešnog) izreza uče se samo zone koje je OCR pogodio, da krivi izrez ne pokvari model.
      const cropTrusted = origin === 'manual' || ocrValues[0] === sys || ocrValues[1] === dia;
      let learnedBands = 0;
      confirmedValues.forEach((v, i) => {
        if (!v) return; // puls nije unesen: bez učenja za tu zonu
        if (!cropTrusted && ocrValues[i] !== Number(v)) return;
        const before = sampleCount(md);
        md = learn(md, result.glyphs[i] || [], v, result.bandDims[i], i);
        if (sampleCount(md) !== before) learnedBands += 1;
        const win = result.variantWinner[i];
        if (win && ocrValues[i] === Number(v)) md.variantWins[win] = (md.variantWins[win] || 0) + 1;
      });
      if (learnedBands > 0) md.photos += 1;
      if (cropTrusted) md.layout = { rect: { x: rect.x / source.width, y: rect.y / source.height, w: rect.w / source.width, h: rect.h / source.height }, dividers };
      if (learnedBands > 0 || cropTrusted) await save('ocrModels', { id: model?.id || deviceId, deviceId, ...md });
      try { localStorage.setItem('tlak.lastLearn', `${new Date().toISOString()} ${learnedBands > 0 ? 'ok' : 'skip'} origin=${origin} trusted=${cropTrusted} bands=${learnedBands} photos=${md.photos}`); } catch { /* ignore */ }
      if (learnedBands === 0) toast.show('Iz ove fotografije aplikacija nije učila: izrez nije bio pouzdan. Za učenje koristite „Ispravi izrez”.');
      } catch (e) {
        try { localStorage.setItem('tlak.lastLearn', `${new Date().toISOString()} ERR ${(e as Error).message}`); } catch { /* ignore */ }
        toast.show(`Učenje OCR-a nije uspjelo: ${(e as Error).message}`);
      }
    }
    // Fotografija se ne čuva: izvor je uklonjen iz radne memorije.
    setSource(null); setResult(null);
    toast.show(`Mjerenje ${saved.systolic}/${saved.diastolic}${saved.pulse !== null ? `, puls ${saved.pulse}` : ''} spremljeno.`, { actionLabel: 'Poništi', onAction: () => { void remove('measurements', saved.id); } });
    if (next) {
      // serija: odmah nova fotografija, s istim tlakomjerom i zapamćenim okvirom
      setSys(null); setDia(null); setPulse(null); setMsgs([]); setConfirmed(false);
      setStage('pick');
      return;
    }
    nav('/', { replace: true });
  };

  /* --- izrezivanje: povlačenje ručica i pomicanje okvira --- */
  const [stageW, setStageW] = useState(0);
  useEffect(() => {
    if (stage !== 'crop' || !stageRef.current) return;
    const el = stageRef.current;
    const measure = () => setStageW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stage, source]);
  const scale = () => (source && stageW ? source.width / stageW : 1);
  const onPointerDown = (handle: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation(); // ručice i horizontale ne smiju pokrenuti pomicanje cijelog okvira
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { handle, sx: e.clientX, sy: e.clientY, r: rect, d: dividers };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !source) return;
    const k = scale();
    const dx = (e.clientX - drag.current.sx) * k, dy = (e.clientY - drag.current.sy) * k;
    const r = { ...drag.current.r };
    const min = 40;
    const h = drag.current.handle;
    if (h === 'd1' || h === 'd2') {
      // pomicanje unutarnjih horizontala (SYS | DIA | puls), uz minimalnu visinu zone 10 %
      const frac = dy / r.h;
      const d: [number, number] = [...drag.current.d] as [number, number];
      if (h === 'd1') d[0] = Math.max(0.1, Math.min(d[1] - 0.1, drag.current.d[0] + frac));
      else d[1] = Math.max(d[0] + 0.1, Math.min(0.9, drag.current.d[1] + frac));
      setDividers(d);
      return;
    }
    if (h.includes('l')) { r.x += dx; r.w -= dx; }
    if (h.includes('r')) r.w += dx;
    if (h.includes('t')) { r.y += dy; r.h -= dy; }
    if (h.includes('b')) r.h += dy;
    if (h === 'move') { r.x += dx; r.y += dy; }
    if (r.w < min) { if (h.includes('l')) r.x = drag.current.r.x + drag.current.r.w - min; r.w = min; }
    if (r.h < min) { if (h.includes('t')) r.y = drag.current.r.y + drag.current.r.h - min; r.h = min; }
    // okvir ne smije izaći izvan fotografije
    r.w = Math.min(r.w, source.width); r.h = Math.min(r.h, source.height);
    r.x = Math.max(0, Math.min(source.width - r.w, r.x)); r.y = Math.max(0, Math.min(source.height - r.h, r.y));
    setRect(r);
  };
  const onPointerUp = () => { drag.current = null; };

  /** Paket za dijagnostiku: izrezani zaslon (umanjen), zone, prepoznati tokeni, glifovi i naučeni model. Bez cijele fotografije. */
  const exportDiagnostics = async () => {
    if (!result) return;
    const pkg = {
      app: 'tlak-ocr-diagnostics', version: 2, createdAt: new Date().toISOString(),
      device: data.devices.find((d) => d.id === deviceId)?.name || null,
      confirmed: { systolic: sys, diastolic: dia, pulse },
      ocr: { systolic: result.systolic, diastolic: result.diastolic, pulse: result.pulse, engine: result.engine, warnings: result.warnings, variantWinner: result.variantWinner },
      layout: { rect: source ? { x: rect.x / source.width, y: rect.y / source.height, w: rect.w / source.width, h: rect.h / source.height } : null, dividers, origin, autoDetect: autoInfo.current },
      photo: thumb,
      tokens: result.debug.digits,
      glyphs: result.glyphs.map((g) => g.map((x) => ({ x0: x.x0, x1: x.x1, y0: x.y0, y1: x.y1, bits: bitsToBase64(x.bits) }))),
      bandDims: result.bandDims,
      model: { samples: Object.fromEntries(Object.entries(modelData.samples).map(([k, v]) => [k, v.length])), bitmaps: modelData.samples, variantWins: modelData.variantWins, photos: modelData.photos, layout: modelData.layout, positions: modelData.positions || {} },
      learning: { deviceId, modelRecords: data.ocrModels.map((m) => ({ id: m.id, deviceId: m.deviceId, photos: m.photos })), lastLearn: (() => { try { return localStorage.getItem('tlak.lastLearn'); } catch { return null; } })(), auth: !!auth },
      images: result.diagnostics,
    };
    const r = await shareOrDownload(`tlak-ocr-dijagnostika-${stamp()}.json`, JSON.stringify(pkg), 'application/json');
    toast.show(r === 'shared' ? 'Dijagnostika je podijeljena.' : 'Dijagnostika je preuzeta.');
  };

  const conf = (k: 'systolic' | 'diastolic' | 'pulse') => result?.[k];
  const flag = (k: 'systolic' | 'diastolic' | 'pulse') => { const c = conf(k); return !c || c.value === null || c.confidence < 70; };

  const devicePicker = (
    <div className="field">
      <label>Tlakomjer (za pamćenje rasporeda i učenje znamenki)
        <select value={deviceId} onChange={(e) => chooseDevice(e.target.value)}>
          <option value="">– nije odabran –</option>
          {data.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>
      {(!data.devices.length || deviceId === '') && (
        <div className="row" style={{ marginTop: 4 }}>
          <input placeholder="Naziv novog tlakomjera (npr. Omron M3)" value={newDevice} onChange={(e) => setNewDevice(e.target.value)} style={{ flex: 1, minHeight: 40, padding: '6px 10px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)' }} />
          <button type="button" className="btn small" onClick={() => void addDevice()} disabled={!newDevice.trim()}>Dodaj</button>
        </div>
      )}
    </div>
  );

  return (
    <main className="page">
      <div className="page-header"><h1>{mode === 'camera' ? 'Fotografiraj tlakomjer' : 'Odaberi fotografiju'}</h1><Link to="/new" className="btn small">Ručni unos</Link></div>
      <input ref={inputRef} type="file" accept="image/*" {...(mode === 'camera' ? { capture: 'environment' } : {})} className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
      {error && <Message level="error">{error}</Message>}

      {stage === 'pick' && (
        <div className="card stack">
          <p className="muted">Fotografija se obrađuje isključivo na ovom uređaju, ne šalje se nikamo i ne sprema se trajno.</p>
          <button type="button" className="btn primary big" onClick={() => inputRef.current?.click()}>{mode === 'camera' ? '📷 Otvori kameru' : '🖼 Odaberi fotografiju'}</button>
          <Link to={mode === 'camera' ? '/new/gallery' : '/new/photo'} className="btn">{mode === 'camera' ? 'Odaberi postojeću fotografiju' : 'Fotografiraj kamerom'}</Link>
        </div>
      )}

      {stage === 'crop' && source && (
        <div className="card">
          {devicePicker}
          {autoNotice && <Message level="check">{autoNotice}</Message>}
          <p className="small muted">{layoutApplied ? 'Okvir i horizontale postavljeni su prema prošlom čitanju ovog tlakomjera; po potrebi ih prilagodite.' : 'Povucite rubove ili kutove okvira oko zaslona tlakomjera, a žute horizontale postavite tako da odvajaju redove SYS, DIA i puls. Svaka zona čita se zasebno.'}</p>
          <div className="photo-stage" ref={stageRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            <CanvasView canvas={source} />
            {(() => { const k = 1 / scale(); return (
              <div className="crop" style={{ left: rect.x * k, top: rect.y * k, width: rect.w * k, height: rect.h * k }} onPointerDown={onPointerDown('move')}>
                <div className="band" style={{ top: 0 }} aria-hidden="true">SYS</div>
                <div className="band" style={{ top: `${dividers[0] * 100}%` }} aria-hidden="true">DIA</div>
                <div className="band" style={{ top: `${dividers[1] * 100}%` }} aria-hidden="true">PULS</div>
                <div className="div" style={{ top: `${dividers[0] * 100}%` }} onPointerDown={onPointerDown('d1')} role="slider" aria-label="Granica SYS/DIA" aria-valuenow={Math.round(dividers[0] * 100)} />
                <div className="div" style={{ top: `${dividers[1] * 100}%` }} onPointerDown={onPointerDown('d2')} role="slider" aria-label="Granica DIA/puls" aria-valuenow={Math.round(dividers[1] * 100)} />
                {['tl', 'tr', 'bl', 'br', 't', 'b', 'l', 'r'].map((h) => <div key={h} className={`h ${h}`} onPointerDown={onPointerDown(h)} role="slider" aria-label={`Ručica ${h}`} />)}
              </div>
            ); })()}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" className="btn" onClick={() => { const rot = cropRotate(source, { x: 0, y: 0, w: source.width, h: source.height }, 90); setSource(rot); setRotation(((rotation + 90) % 360) as 0 | 90 | 180 | 270); setRect({ x: rot.width * 0.15, y: rot.height * 0.25, w: rot.width * 0.7, h: rot.height * 0.5 }); }}>↻ Zakreni ({rotation}°)</button>
            <button type="button" className="btn" onClick={() => setStage('pick')}>{mode === 'camera' ? 'Ponovno fotografiraj' : 'Druga fotografija'}</button>
          </div>
          <button type="button" className="btn primary big" style={{ marginTop: 10 }} onClick={() => void runOcr()}>Prepoznaj vrijednosti</button>
        </div>
      )}

      {stage === 'ocr' && (
        <div className="card">
          <p>{progress.stage || 'Obrada…'}</p>
          <div className="progress" role="progressbar" aria-valuenow={Math.round(progress.p * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${progress.p * 100}%` }} /></div>
          <p className="tiny">Prvo pokretanje traje dulje jer se OCR modeli učitavaju iz aplikacije (bez mreže).</p>
        </div>
      )}

      {stage === 'confirm' && result && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); void onSave(); }}>
          <img src={result.preview} alt="Izrezani zaslon tlakomjera (obrađen)" style={{ width: '100%', borderRadius: 10, border: '1px solid var(--border)' }} />
          {autoFound && <p className="tiny">{autoFound === 'auto' ? 'Zaslon je pronađen automatski na fotografiji.' : 'Korišten je zapamćeni raspored ovog tlakomjera.'} Provjerite obrađeni izrez iznad: ako brojke nisu jasno vidljive, koristite „Ispravi izrez”.</p>}
          {(result.systolic.value === null || result.diastolic.value === null || result.pulse.value === null) && (
            <Message level="check">Neke vrijednosti nisu pouzdano prepoznate i nisu popunjene. Unesite ih ručno prema fotografiji.</Message>
          )}
          {result.warnings.map((w, i) => <Message key={i} level="check">{w}</Message>)}
          <div className="grid3" style={{ marginTop: 8 }}>
            {(['systolic', 'diastolic', 'pulse'] as const).map((k) => (
              <div key={k} className={`field bigfield ${k === 'systolic' ? 'sys' : k === 'diastolic' ? 'dia' : 'pulse'} ${flag(k) ? 'flag' : ''}`}>
                <label>{k === 'systolic' ? 'SYS' : k === 'diastolic' ? 'DIA' : 'Puls'}
                  <NumberInput value={k === 'systolic' ? sys : k === 'diastolic' ? dia : pulse} onChange={(v) => { (k === 'systolic' ? setSys : k === 'diastolic' ? setDia : setPulse)(v); setMsgs([]); setConfirmed(false); }} />
                </label>
                <span className="conf">{conf(k)?.value === null ? `nije prepoznato${conf(k)?.reason ? ` (${conf(k)!.reason})` : ''}` : `pouzdanost ${conf(k)?.confidence ?? 0} %${flag(k) ? ' – provjerite' : ''}`}</span>
              </div>
            ))}
          </div>
          <div className="grid2">
            <div className="field"><label>Datum<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label></div>
            <div className="field"><label>Vrijeme<input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label></div>
          </div>
          <p className="small">
            Datum i vrijeme: <strong className="tabular">{fmtDateTime(measuredAt)}</strong>{' '}
            <span className="muted">({dateSrc === 'exif' ? 'iz metapodataka fotografije' : mode === 'camera' ? 'trenutačno vrijeme' : 'metapodaci nisu dostupni – trenutačno vrijeme'})</span>
          </p>
          {devicePicker}
          <p className="tiny">Model: {result.engine}. Ništa se ne sprema bez vaše potvrde.{deviceId ? ` Potvrdom aplikacija uči znamenke ovog tlakomjera (${sampleCount(modelData)} naučenih znamenki${modelReady(modelData) ? ', aktivno' : ', još se uči'}).` : ' Odaberite tlakomjer da bi aplikacija učila njegove znamenke.'}</p>
          {msgs.map((m, i) => <Message key={i} level={m.level}>{m.text}{m.suggestSwap && <div><button type="button" className="btn small" onClick={() => { const s = sys; setSys(dia); setDia(s); setMsgs([]); }}>Zamijeni SYS i DIA</button></div>}</Message>)}
          <label className="row small" style={{ marginTop: 6 }}><input type="checkbox" checked={series} onChange={(e) => toggleSeries(e.target.checked)} /> Nakon spremanja odmah fotografiraj sljedeće (serija mjerenja)</label>
          <div className="stack" style={{ marginTop: 8 }}>
            <button type="submit" className="btn primary big">{series ? 'Potvrdi, spremi i fotografiraj sljedeće' : 'Potvrdi i spremi'}</button>
            {series && <button type="button" className="btn" onClick={() => void onSave(false)}>Potvrdi i spremi (završi seriju)</button>}
            <button type="button" className="btn" onClick={() => setStage('crop')}>Ispravi izrez / ponovno prepoznaj</button>
            <button type="button" className="btn" onClick={() => { setSource(null); setResult(null); setStage('pick'); }}>{mode === 'camera' ? 'Ponovno fotografiraj' : 'Druga fotografija'}</button>
            <button type="button" className="btn ghost small" onClick={() => void exportDiagnostics()}>Preuzmi dijagnostiku OCR-a (za podršku)</button>
            <Link to="/" className="btn ghost">Odustani</Link>
          </div>
        </form>
      )}
    </main>
  );
}

function CanvasView({ canvas }: { canvas: HTMLCanvasElement }) {
  const [url, setUrl] = useState('');
  useEffect(() => { setUrl(canvas.toDataURL('image/jpeg', 0.85)); }, [canvas]);
  return url ? <img src={url} alt="Fotografija tlakomjera" draggable={false} /> : null;
}
