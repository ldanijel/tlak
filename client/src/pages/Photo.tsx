import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useStore } from '../store.tsx';
import { exifDate, loadImage, toCanvas, cropRotate, type Rect } from '../ocr/image.ts';
import { recognizeDisplay, warmUpOcr, type OcrResult } from '../ocr/recognize.ts';
import { fmtDateTime, fromInputs, toInputDate, toInputTime, currentTimezone } from '../lib/format.ts';
import { suggestPeriod } from '../lib/periods.ts';
import { hasErrors, needsConfirm, validateDraft, type ValidationMessage } from '../lib/validation.ts';
import { Message, NumberInput, useToast } from '../components/ui.tsx';
import { findSession } from './NewMeasurement.tsx';

type Stage = 'pick' | 'crop' | 'ocr' | 'confirm';

export function PhotoPage({ mode }: { mode: 'camera' | 'gallery' }) {
  const { data, save, remove } = useStore();
  const nav = useNavigate();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage>('pick');
  const [source, setSource] = useState<HTMLCanvasElement | null>(null);
  const [rect, setRect] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [progress, setProgress] = useState({ stage: '', p: 0 });
  const [result, setResult] = useState<OcrResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sys, setSys] = useState<number | null>(null), [dia, setDia] = useState<number | null>(null), [pulse, setPulse] = useState<number | null>(null);
  const [dateSrc, setDateSrc] = useState<'now' | 'exif'>('now');
  const [date, setDate] = useState(toInputDate(new Date())), [time, setTime] = useState(toInputTime(new Date()));
  const [msgs, setMsgs] = useState<ValidationMessage[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const drag = useRef<{ handle: string; sx: number; sy: number; r: Rect } | null>(null);

  useEffect(() => { void warmUpOcr(); }, []);
  useEffect(() => { if (stage === 'pick') inputRef.current?.click(); }, [stage, mode]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const img = await loadImage(file);
      const c = toCanvas(img, 1600);
      setSource(c);
      setRect({ x: c.width * 0.15, y: c.height * 0.25, w: c.width * 0.7, h: c.height * 0.5 });
      setRotation(0);
      if (mode === 'gallery') {
        const d = await exifDate(file);
        if (d) { setDate(toInputDate(d)); setTime(toInputTime(d)); setDateSrc('exif'); }
        else { const n = new Date(); setDate(toInputDate(n)); setTime(toInputTime(n)); setDateSrc('now'); }
      } else { const n = new Date(); setDate(toInputDate(n)); setTime(toInputTime(n)); setDateSrc('now'); }
      setStage('crop');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const runOcr = async () => {
    if (!source) return;
    setStage('ocr');
    try {
      const display = cropRotate(source, rect, rotation);
      const r = await recognizeDisplay(display, (s, p) => setProgress({ stage: s, p }));
      setResult(r);
      setSys(r.systolic.value); setDia(r.diastolic.value); setPulse(r.pulse.value);
      setMsgs([]); setConfirmed(false);
      setStage('confirm');
    } catch (e) {
      setError((e as Error).message);
      setStage('crop');
    }
  };

  const measuredAt = fromInputs(date, time).toISOString();
  const onSave = async () => {
    const m = validateDraft({ systolic: sys, diastolic: dia, pulse, measuredAt, period: suggestPeriod(new Date(measuredAt)) }, { existing: data.measurements, targets: data.targets, safety: data.settings.safety });
    setMsgs(m);
    if (hasErrors(m)) return;
    if (needsConfirm(m) && !confirmed) { setConfirmed(true); return; }
    const saved = await save('measurements', {
      measuredAt, timezone: currentTimezone(), systolic: sys!, diastolic: dia!, pulse: pulse!,
      source: mode, period: suggestPeriod(new Date(measuredAt)), sessionId: findSession(measuredAt, data.measurements, data.settings.sessionWindowMinutes),
      armLocation: 'unknown', bodyPosition: 'unknown', medicationTiming: 'unknown', deviceId: data.devices[0]?.id ?? null,
      symptoms: [], tags: [], notes: '', includedInAverage: true, exclusionReason: '',
      ocrConfidence: result ? { systolic: result.systolic.confidence, diastolic: result.diastolic.confidence, pulse: result.pulse.confidence } : null,
      confirmedUnusual: needsConfirm(m),
    });
    // Fotografija se ne čuva: izvor je uklonjen iz radne memorije.
    setSource(null); setResult(null);
    toast.show(`Mjerenje ${saved.systolic}/${saved.diastolic}, puls ${saved.pulse} spremljeno.`, { actionLabel: 'Poništi', onAction: () => { void remove('measurements', saved.id); } });
    nav('/', { replace: true });
  };

  /* --- izrezivanje: povlačenje ručica i pomicanje okvira --- */
  const scale = () => (source && stageRef.current ? source.width / stageRef.current.clientWidth : 1);
  const onPointerDown = (handle: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { handle, sx: e.clientX, sy: e.clientY, r: rect };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !source) return;
    const k = scale();
    const dx = (e.clientX - drag.current.sx) * k, dy = (e.clientY - drag.current.sy) * k;
    const r = { ...drag.current.r };
    const min = 40;
    switch (drag.current.handle) {
      case 'move': r.x += dx; r.y += dy; break;
      case 'tl': r.x += dx; r.y += dy; r.w -= dx; r.h -= dy; break;
      case 'tr': r.y += dy; r.w += dx; r.h -= dy; break;
      case 'bl': r.x += dx; r.w -= dx; r.h += dy; break;
      case 'br': r.w += dx; r.h += dy; break;
    }
    if (r.w < min) r.w = min; if (r.h < min) r.h = min;
    r.x = Math.max(0, Math.min(source.width - r.w, r.x)); r.y = Math.max(0, Math.min(source.height - r.h, r.y));
    setRect(r);
  };
  const onPointerUp = () => { drag.current = null; };

  const conf = (k: 'systolic' | 'diastolic' | 'pulse') => result?.[k];
  const flag = (k: 'systolic' | 'diastolic' | 'pulse') => { const c = conf(k); return !c || c.value === null || c.confidence < 70; };

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
          <p className="small muted">Postavite okvir točno oko zaslona tlakomjera: gornji red SYS, srednji DIA, donji puls. Po potrebi zakrenite.</p>
          <div className="photo-stage" ref={stageRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            <CanvasView canvas={source} />
            {(() => { const k = 1 / scale(); return (
              <div className="crop" style={{ left: rect.x * k, top: rect.y * k, width: rect.w * k, height: rect.h * k }} onPointerDown={onPointerDown('move')}>
                <div className="guide" aria-hidden="true"><span>SYS</span><span>DIA</span><span>PULS</span></div>
                {['tl', 'tr', 'bl', 'br'].map((h) => <div key={h} className={`h ${h}`} onPointerDown={onPointerDown(h)} role="slider" aria-label={`Ručica ${h}`} />)}
              </div>
            ); })()}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" className="btn" onClick={() => setRotation(((rotation + 90) % 360) as 0 | 90 | 180 | 270)}>↻ Zakreni ({rotation}°)</button>
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
          <p className="tiny">Model: {result.engine}. Ništa se ne sprema bez vaše potvrde.</p>
          {msgs.map((m, i) => <Message key={i} level={m.level}>{m.text}{m.suggestSwap && <div><button type="button" className="btn small" onClick={() => { const s = sys; setSys(dia); setDia(s); setMsgs([]); }}>Zamijeni SYS i DIA</button></div>}</Message>)}
          <div className="stack" style={{ marginTop: 8 }}>
            <button type="submit" className="btn primary big">{confirmed && needsConfirm(msgs) ? 'Potvrdi i spremi' : 'Potvrdi i spremi'}</button>
            <button type="button" className="btn" onClick={() => setStage('crop')}>Ispravi izrez / ponovno prepoznaj</button>
            <button type="button" className="btn" onClick={() => { setSource(null); setResult(null); setStage('pick'); }}>{mode === 'camera' ? 'Ponovno fotografiraj' : 'Druga fotografija'}</button>
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
