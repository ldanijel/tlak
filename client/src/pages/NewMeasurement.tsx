import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../store.tsx';
import { SYMPTOMS, TAGS, type ArmLocation, type BodyPosition, type MedicationTiming, type Measurement, type Period, type Source } from '../types.ts';
import { currentTimezone, fromInputs, toInputDate, toInputTime } from '../lib/format.ts';
import { suggestPeriod } from '../lib/periods.ts';
import { hasErrors, needsConfirm, validateDraft, type ValidationMessage } from '../lib/validation.ts';
import { ARM_LABEL, PERIOD_LABEL, POSITION_LABEL, TIMING_LABEL } from '../lib/labels.ts';
import { Chips, Field, Message, NumberInput, Segmented, useToast } from '../components/ui.tsx';
import { uid } from '../lib/ids.ts';

/** Predispunjene vrijednosti (npr. iz OCR-a) prenose se kroz location.state. */
export interface Prefill { systolic?: number | null; diastolic?: number | null; pulse?: number | null; measuredAt?: string; source?: Source; ocrConfidence?: Measurement['ocrConfidence']; duplicateOf?: string }

export function NewMeasurementPage() {
  const { data, save, remove } = useStore();
  const nav = useNavigate();
  const toast = useToast();
  const { id } = useParams();
  const location = useLocation();
  const prefill = (location.state || {}) as Prefill;
  const editing = id ? data.measurements.find((m) => m.id === id) : undefined;
  const base = editing || (prefill.duplicateOf ? data.measurements.find((m) => m.id === prefill.duplicateOf) : undefined);

  const now = useMemo(() => new Date(), []);
  const initialAt = editing ? new Date(editing.measuredAt) : prefill.measuredAt ? new Date(prefill.measuredAt) : now;
  const [sys, setSys] = useState<number | null>(editing?.systolic ?? prefill.systolic ?? null);
  const [dia, setDia] = useState<number | null>(editing?.diastolic ?? prefill.diastolic ?? null);
  const [pulse, setPulse] = useState<number | null>(editing?.pulse ?? prefill.pulse ?? null);
  const [date, setDate] = useState(toInputDate(initialAt));
  const [time, setTime] = useState(toInputTime(initialAt));
  const [period, setPeriod] = useState<Period>(editing?.period ?? suggestPeriod(initialAt));
  const [periodTouched, setPeriodTouched] = useState(!!editing);
  const [timing, setTiming] = useState<MedicationTiming>(base?.medicationTiming ?? 'unknown');
  const [arm, setArm] = useState<ArmLocation>(base?.armLocation ?? 'unknown');
  const [pos, setPos] = useState<BodyPosition>(base?.bodyPosition ?? 'unknown');
  const [deviceId, setDeviceId] = useState<string>(base?.deviceId ?? data.devices[0]?.id ?? '');
  const [symptoms, setSymptoms] = useState<string[]>(base?.symptoms ?? []);
  const [tags, setTags] = useState<string[]>(base?.tags ?? []);
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [included, setIncluded] = useState(editing?.includedInAverage ?? true);
  const [exclusionReason, setExclusionReason] = useState(editing?.exclusionReason ?? '');
  const [more, setMore] = useState(!!editing || timing !== 'unknown');
  const [msgs, setMsgs] = useState<ValidationMessage[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checklistOpen, setChecklistOpen] = useState(data.settings.showChecklist && !editing);
  const sysRef = useRef<HTMLInputElement>(null), diaRef = useRef<HTMLInputElement>(null), pulseRef = useRef<HTMLInputElement>(null), saveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (!checklistOpen && !editing && sys === null) sysRef.current?.focus(); }, [checklistOpen, editing, sys]);
  useEffect(() => { if (!periodTouched) setPeriod(suggestPeriod(fromInputs(date, time))); }, [date, time, periodTouched]);

  // Ako korisnik nije mijenjao datum/vrijeme, zadržavaju se i sekunde stvarnog trenutka unosa.
  const untouched = date === toInputDate(initialAt) && time === toInputTime(initialAt);
  const measuredAt = (untouched ? initialAt : fromInputs(date, time)).toISOString();
  const draftMsgs = () => validateDraft({ systolic: sys, diastolic: dia, pulse, measuredAt, period }, { existing: data.measurements, editingId: editing?.id, targets: data.targets, safety: data.settings.safety });

  const onSave = async () => {
    const m = draftMsgs();
    setMsgs(m);
    if (hasErrors(m)) return;
    if (needsConfirm(m) && !confirmed) { setConfirmed(true); return; }
    setSaving(true);
    const rec: Omit<Measurement, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'> & { id?: string } = {
      id: editing?.id,
      measuredAt, timezone: editing?.timezone || currentTimezone(),
      systolic: sys!, diastolic: dia!, pulse: pulse!,
      source: editing?.source ?? prefill.source ?? 'manual',
      period, sessionId: editing?.sessionId ?? findSession(measuredAt, data.measurements, data.settings.sessionWindowMinutes),
      armLocation: arm, bodyPosition: pos, medicationTiming: timing, deviceId: deviceId || null,
      symptoms, tags, notes: notes.trim(), includedInAverage: included, exclusionReason: included ? '' : exclusionReason.trim(),
      ocrConfidence: editing?.ocrConfidence ?? prefill.ocrConfidence ?? null,
      confirmedUnusual: needsConfirm(m),
    };
    const saved = await save('measurements', rec);
    setSaving(false);
    if (editing) {
      toast.show('Mjerenje je ažurirano.');
      nav(`/measurement/${saved.id}`, { replace: true });
    } else {
      toast.show(`Mjerenje ${saved.systolic}/${saved.diastolic}, puls ${saved.pulse} spremljeno.`, { actionLabel: 'Poništi', onAction: () => { void remove('measurements', saved.id); toast.show('Mjerenje je poništeno.'); } });
      nav('/', { replace: true });
    }
  };

  const swap = () => { const s = sys; setSys(dia); setDia(s); setMsgs([]); setConfirmed(false); };
  const keyNext = (next: React.RefObject<HTMLInputElement | HTMLButtonElement | null>) => (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); next.current?.focus(); } };
  const lowConf = (k: 'systolic' | 'diastolic' | 'pulse') => !!prefill.ocrConfidence && prefill.ocrConfidence[k] < 70;

  if (checklistOpen) {
    return (
      <main className="page">
        <h1>Prije mjerenja</h1>
        <div className="card">
          <ul className="checklist">
            <li>odmor najmanje pet minuta</li><li>sjedeći položaj, leđa oslonjena</li><li>stopala na podu, noge nisu prekrižene</li>
            <li>ruka oslonjena u visini srca</li><li>ne razgovarati tijekom mjerenja</li>
          </ul>
          <button type="button" className="btn primary big" onClick={() => setChecklistOpen(false)}>Nastavi na unos</button>
          <p className="tiny">Kontrolna lista može se isključiti u Postavkama.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="page-header">
        <h1>{editing ? 'Uredi mjerenje' : prefill.duplicateOf ? 'Duplicirano mjerenje' : 'Novo mjerenje'}</h1>
        {!editing && <Link to="/new/photo" className="btn small">📷 Fotografija</Link>}
      </div>
      {prefill.source && prefill.source !== 'manual' && !editing && (
        <Message level="info">Vrijednosti su predložene iz fotografije. Provjerite ih i po potrebi ispravite prije spremanja.</Message>
      )}
      <form className="card" onSubmit={(e) => { e.preventDefault(); void onSave(); }}>
        <div className="grid3">
          <div className={`field bigfield sys ${lowConf('systolic') ? 'flag' : ''}`}><label>SYS<NumberInput ref={sysRef} value={sys} onChange={(v) => { setSys(v); setMsgs([]); setConfirmed(false); }} onKeyDown={keyNext(diaRef)} aria-describedby="sys-u" required /></label><span id="sys-u" className="unit">mmHg{lowConf('systolic') && ' · provjerite'}</span></div>
          <div className={`field bigfield dia ${lowConf('diastolic') ? 'flag' : ''}`}><label>DIA<NumberInput ref={diaRef} value={dia} onChange={(v) => { setDia(v); setMsgs([]); setConfirmed(false); }} onKeyDown={keyNext(pulseRef)} required /></label><span className="unit">mmHg{lowConf('diastolic') && ' · provjerite'}</span></div>
          <div className={`field bigfield pulse ${lowConf('pulse') ? 'flag' : ''}`}><label>Puls<NumberInput ref={pulseRef} value={pulse} onChange={(v) => { setPulse(v); setMsgs([]); setConfirmed(false); }} onKeyDown={keyNext(saveRef)} enterKeyHint="done" required /></label><span className="unit">otk./min{lowConf('pulse') && ' · provjerite'}</span></div>
        </div>
        <div className="grid2">
          <Field label="Datum"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
          <Field label="Vrijeme"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} required /></Field>
        </div>
        <Field label="Razdoblje" hint="Predloženo prema vremenu; možete promijeniti.">
          <Segmented value={period} onChange={(v) => { setPeriod(v); setPeriodTouched(true); }} options={(['morning', 'evening', 'other'] as Period[]).map((p) => ({ value: p, label: PERIOD_LABEL[p] }))} />
        </Field>

        {!more ? (
          <button type="button" className="btn ghost block" onClick={() => setMore(true)}>+ Dodatne okolnosti (terapija, ruka, položaj, simptomi, bilješka)</button>
        ) : (
          <>
            <Field label="Odnos prema terapiji">
              <select value={timing} onChange={(e) => setTiming(e.target.value as MedicationTiming)}>
                {(Object.keys(TIMING_LABEL) as MedicationTiming[]).map((k) => <option key={k} value={k}>{TIMING_LABEL[k]}</option>)}
              </select>
            </Field>
            <div className="grid2">
              <Field label="Ruka / mjesto"><select value={arm} onChange={(e) => setArm(e.target.value as ArmLocation)}>{(Object.keys(ARM_LABEL) as ArmLocation[]).map((k) => <option key={k} value={k}>{ARM_LABEL[k]}</option>)}</select></Field>
              <Field label="Položaj"><select value={pos} onChange={(e) => setPos(e.target.value as BodyPosition)}>{(Object.keys(POSITION_LABEL) as BodyPosition[]).map((k) => <option key={k} value={k}>{POSITION_LABEL[k]}</option>)}</select></Field>
            </div>
            {data.devices.length > 0 && (
              <Field label="Tlakomjer"><select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}><option value="">–</option>{data.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
            )}
            <div className="field"><label>Simptomi</label><Chips values={symptoms} options={SYMPTOMS} onChange={setSymptoms} /></div>
            <div className="field"><label>Oznake</label><Chips values={tags} options={TAGS} onChange={setTags} /></div>
            <Field label="Bilješka"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} /></Field>
            {editing && (
              <>
                <div className="field"><label className="row"><input type="checkbox" checked={included} onChange={(e) => setIncluded(e.target.checked)} style={{ width: 24, height: 24 }} /> Uključi u prosjeke i analize</label></div>
                {!included && <Field label="Razlog isključenja" hint="Razlog je vidljiv u povijesti i izvještaju."><input value={exclusionReason} onChange={(e) => setExclusionReason(e.target.value)} placeholder="npr. prvo mjerenje u seriji, pomicanje ruke" /></Field>}
              </>
            )}
          </>
        )}

        {msgs.map((m, i) => (
          <Message key={i} level={m.level}>
            {m.text}
            {m.suggestSwap && <div><button type="button" className="btn small" style={{ marginTop: 6 }} onClick={swap}>Zamijeni SYS i DIA</button></div>}
          </Message>
        ))}
        {confirmed && needsConfirm(msgs) && !hasErrors(msgs) && (
          <Message level="check">Potvrdite da su vrijednosti točne pritiskom na „Potvrdi i spremi”.</Message>
        )}
        <button ref={saveRef} type="submit" className="btn primary big" disabled={saving} style={{ marginTop: 8 }}>
          {confirmed && needsConfirm(msgs) ? 'Potvrdi i spremi' : editing ? 'Spremi izmjene' : 'Spremi mjerenje'}
        </button>
        {editing && <Link to={`/measurement/${editing.id}`} className="btn ghost block" style={{ marginTop: 6 }}>Odustani</Link>}
      </form>
    </main>
  );
}

/** Ako u zadanom prozoru postoji mjerenje, vraća njegov sessionId (ili stvara novi). */
export function findSession(measuredAt: string, all: Measurement[], windowMin: number): string {
  const t = new Date(measuredAt).getTime();
  const near = all.find((m) => !m.deletedAt && Math.abs(new Date(m.measuredAt).getTime() - t) <= windowMin * 60000);
  return near?.sessionId || near?.id || uid();
}
