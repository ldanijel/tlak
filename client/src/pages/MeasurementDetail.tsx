import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../store.tsx';
import { fmtDateTime, fmtNum } from '../lib/format.ts';
import { ARM_LABEL, PERIOD_LABEL, POSITION_LABEL, SOURCE_LABEL, TIMING_LABEL } from '../lib/labels.ts';
import { classify, STATUS_LABEL, targetFor, boundsFor } from '../lib/targets.ts';
import { groupSessions, meanArterialPressure, pulsePressure } from '../lib/stats.ts';
import { Badge, Confirm, Message, useToast } from '../components/ui.tsx';

export function MeasurementDetailPage() {
  const { id } = useParams();
  const { data, remove, restore, save } = useStore();
  const nav = useNavigate();
  const toast = useToast();
  const [confirmDel, setConfirmDel] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState('');
  const m = data.measurements.find((x) => x.id === id);
  if (!m) return <main className="page"><h1>Mjerenje</h1><p className="muted">Mjerenje nije pronađeno (možda je izbrisano).</p><Link to="/history" className="btn">Povijest</Link></main>;

  const status = classify(m, data.targets);
  const bounds = boundsFor(targetFor(data.targets, m.measuredAt), m.period);
  const session = groupSessions(data.measurements.filter((x) => x.sessionId === m.sessionId || x.id === m.id), data.settings.sessionWindowMinutes).find((s) => s.measurements.some((x) => x.id === m.id));
  const critical = m.systolic >= data.settings.safety.sysCritical || m.diastolic >= data.settings.safety.diaCritical;

  const del = async () => {
    setConfirmDel(false);
    await remove('measurements', m.id);
    toast.show('Mjerenje je izbrisano.', { actionLabel: 'Vrati', onAction: () => { void restore('measurements', m.id); }, durationMs: 10000 });
    nav('/history', { replace: true });
  };
  const toggleIncluded = async () => {
    if (m.includedInAverage) { setReasonOpen(true); return; }
    await save('measurements', { ...m, includedInAverage: true, exclusionReason: '' });
    toast.show('Mjerenje je uključeno u prosjek.');
  };
  const exclude = async () => {
    setReasonOpen(false);
    await save('measurements', { ...m, includedInAverage: false, exclusionReason: reason.trim() || 'bez navedenog razloga' });
    toast.show('Mjerenje je isključeno iz prosjeka.');
  };

  return (
    <main className="page">
      <div className="page-header"><h1>Mjerenje</h1><Link to="/history" className="btn small">← Povijest</Link></div>
      <section className="card">
        <div className="reading">
          <div className="sys"><div className="l">SYS</div><div className="v">{m.systolic}</div><div className="u">mmHg</div></div>
          <div className="dia"><div className="l">DIA</div><div className="v">{m.diastolic}</div><div className="u">mmHg</div></div>
          <div className="pulse"><div className="l">Puls</div><div className="v">{m.pulse}</div><div className="u">otk./min</div></div>
        </div>
        <p style={{ textAlign: 'center' }} className="tabular">{fmtDateTime(m.measuredAt)} · {PERIOD_LABEL[m.period]}</p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <Badge kind={status}>{status === 'in' ? '✓' : status === 'above' ? '↑' : status === 'below' ? '↓' : 'ⓘ'} {STATUS_LABEL[status]}</Badge>
          {bounds && <span className="tiny">cilj {bounds.sysMin}–{bounds.sysMax}/{bounds.diaMin}–{bounds.diaMax}</span>}
          {!m.includedInAverage && <Badge kind="none">isključeno iz prosjeka</Badge>}
          {critical && <Badge kind="safety">🚨 vrlo visoko</Badge>}
        </div>
        {critical && <Message level="safety">Izrazito visoka vrijednost. Ponovite mjerenje nakon 5 minuta mirovanja. Uz bol u prsima, zaduhu, smetnje vida ili govora, utrnulost ili slabost nazovite 112.</Message>}
        {!m.includedInAverage && <p className="small muted">Razlog isključenja: {m.exclusionReason || '–'}</p>}
      </section>

      <section className="card">
        <h3>Podaci</h3>
        <table className="tbl"><tbody>
          <tr><th>Izvor</th><td>{SOURCE_LABEL[m.source]}{m.ocrConfidence && <span className="tiny"> (OCR pouzdanost: SYS {m.ocrConfidence.systolic} %, DIA {m.ocrConfidence.diastolic} %, puls {m.ocrConfidence.pulse} %)</span>}</td></tr>
          <tr><th>Terapija</th><td>{TIMING_LABEL[m.medicationTiming]}</td></tr>
          <tr><th>Ruka</th><td>{ARM_LABEL[m.armLocation]}</td></tr>
          <tr><th>Položaj</th><td>{POSITION_LABEL[m.bodyPosition]}</td></tr>
          <tr><th>Tlakomjer</th><td>{data.devices.find((d) => d.id === m.deviceId)?.name || '–'}</td></tr>
          <tr><th>Simptomi</th><td>{m.symptoms.join(', ') || '–'}</td></tr>
          <tr><th>Oznake</th><td>{m.tags.join(', ') || '–'}</td></tr>
          <tr><th>Bilješka</th><td>{m.notes || '–'}</td></tr>
          <tr><th>Vremenska zona</th><td>{m.timezone}</td></tr>
          {m.confirmedUnusual && <tr><th>Napomena</th><td>Korisnik je potvrdio neuobičajenu vrijednost pri unosu.</td></tr>}
        </tbody></table>
        <h3>Izvedeni pokazatelji <Badge kind="calc">izračun</Badge></h3>
        <p className="small">Pulsni tlak (SYS − DIA): <strong className="tabular">{pulsePressure(m)} mmHg</strong> · Procijenjeni srednji arterijski tlak: <strong className="tabular">{fmtNum(meanArterialPressure(m), 1)} mmHg</strong></p>
      </section>

      {session && session.measurements.length > 1 && (
        <section className="card">
          <h3>Sesija mjerenja ({session.measurements.length} mjerenja u {session.spanMinutes} min)</h3>
          <table className="tbl"><thead><tr><th>Vrijeme</th><th>SYS/DIA</th><th>Puls</th><th>Razmak</th><th>Prosjek</th></tr></thead><tbody>
            {session.measurements.map((x, i) => (
              <tr key={x.id}>
                <td className="tabular">{fmtDateTime(x.measuredAt).slice(-5)}{x.id === m.id && ' ◀'}</td>
                <td className="tabular">{x.systolic}/{x.diastolic}</td><td className="tabular">{x.pulse}</td>
                <td className="tabular">{i ? `+${Math.round((new Date(x.measuredAt).getTime() - new Date(session.measurements[i - 1].measuredAt).getTime()) / 60000)} min` : '–'}</td>
                <td>{x.includedInAverage ? 'uključeno' : `isključeno (${x.exclusionReason || '–'})`}</td>
              </tr>
            ))}
          </tbody></table>
          <p className="small">Prosjek sesije <Badge kind="calc">izračun</Badge>: <strong className="tabular">{fmtNum(session.sys.avg)}/{fmtNum(session.dia.avg)}</strong>, puls <strong className="tabular">{fmtNum(session.pulse.avg)}</strong>
            {session.sys.n ? ` · raspon SYS ${session.sys.max! - session.sys.min!}, DIA ${session.dia.max! - session.dia.min!}` : ''}</p>
        </section>
      )}

      <section className="card stack">
        <Link to={`/measurement/${m.id}/edit`} className="btn primary">✏️ Uredi</Link>
        <button type="button" className="btn" onClick={toggleIncluded}>{m.includedInAverage ? 'Isključi iz prosjeka' : 'Uključi u prosjek'}</button>
        <Link to="/new" state={{ duplicateOf: m.id, systolic: m.systolic, diastolic: m.diastolic, pulse: m.pulse }} className="btn">⧉ Dupliciraj</Link>
        <button type="button" className="btn danger" onClick={() => setConfirmDel(true)}>🗑 Izbriši</button>
      </section>

      {confirmDel && <Confirm title="Izbrisati mjerenje?" text="Mjerenje možete vratiti odmah nakon brisanja pomoću gumba „Vrati”." confirmLabel="Izbriši" danger onConfirm={() => void del()} onCancel={() => setConfirmDel(false)} />}
      {reasonOpen && (
        <Confirm title="Isključi iz prosjeka" confirmLabel="Isključi" onConfirm={() => void exclude()} onCancel={() => setReasonOpen(false)}>
          <div className="field"><label>Razlog (vidljiv u povijesti)<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="npr. prvo mjerenje u seriji" autoFocus /></label></div>
        </Confirm>
      )}
    </main>
  );
}
