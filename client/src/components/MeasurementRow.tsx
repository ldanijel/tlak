import { Link } from 'react-router-dom';
import type { Measurement, Target } from '../types.ts';
import { fmtDate, fmtTime } from '../lib/format.ts';
import { PERIOD_LABEL, SOURCE_LABEL, TIMING_LABEL } from '../lib/labels.ts';
import { classify, STATUS_LABEL } from '../lib/targets.ts';
import { Badge } from './ui.tsx';
import type { SafetyThresholds } from '../types.ts';

const STATUS_ICON = { in: '✓', above: '↑', below: '↓', none: '' };

export function MeasurementRow({ m, targets, safety }: { m: Measurement; targets: Target[]; safety: SafetyThresholds }) {
  const status = classify(m, targets);
  const critical = m.systolic >= safety.sysCritical || m.diastolic >= safety.diaCritical;
  return (
    <Link to={`/measurement/${m.id}`} className={`mrow ${m.includedInAverage ? '' : 'excluded'}`}>
      <div className="when tabular">{fmtDate(m.measuredAt)}<br />{fmtTime(m.measuredAt)}</div>
      <div>
        <div className="vals tabular">{m.systolic}/{m.diastolic}<span className="p">♥ {m.pulse}</span></div>
        <div className="meta">
          <span>{PERIOD_LABEL[m.period]}</span>
          {m.medicationTiming !== 'unknown' && <span>· {TIMING_LABEL[m.medicationTiming]}</span>}
          <span>· {SOURCE_LABEL[m.source]}</span>
          {!m.includedInAverage && <span>· isključeno{m.exclusionReason ? `: ${m.exclusionReason}` : ''}</span>}
          {m.symptoms.length > 0 && <span>· {m.symptoms.join(', ')}</span>}
          {m.notes && <span>· {m.notes.slice(0, 40)}{m.notes.length > 40 ? '…' : ''}</span>}
        </div>
      </div>
      <div className="badges">
        {critical && <Badge kind="safety">🚨 vrlo visoko</Badge>}
        {status !== 'none' && <Badge kind={status}>{STATUS_ICON[status]} {STATUS_LABEL[status]}</Badge>}
      </div>
    </Link>
  );
}
