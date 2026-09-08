import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MessageLevel } from '../lib/validation.ts';
import { LEVEL_LABEL } from '../lib/validation.ts';

/* ---------- Toast s poništavanjem ---------- */
interface Toast { id: number; text: string; actionLabel?: string; onAction?: () => void; level?: 'info' | 'success' | 'error' }
interface ToastApi { show(text: string, opts?: Omit<Toast, 'id' | 'text'> & { durationMs?: number }): void }
const ToastCtx = createContext<ToastApi>({ show: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const show = useCallback<ToastApi['show']>((text, opts = {}) => {
    const id = ++seq.current;
    const { durationMs = opts.onAction ? 7000 : 3500, ...rest } = opts;
    setToasts((t) => [...t.slice(-2), { id, text, ...rest }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), durationMs);
  }, []);
  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span className="t">{t.text}</span>
            {t.onAction && (
              <button type="button" onClick={() => { t.onAction?.(); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>{t.actionLabel || 'Poništi'}</button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- Modal ---------- */
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Confirm({ title, text, confirmLabel = 'Potvrdi', danger, onConfirm, onCancel, children }: {
  title: string; text?: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void; children?: ReactNode;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      {text && <p>{text}</p>}
      {children}
      <div className="actions">
        <button type="button" className="btn" onClick={onCancel}>Odustani</button>
        <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} autoFocus>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

/* ---------- Poruke (boja + tekst, nikad samo boja) ---------- */
const ICON: Record<MessageLevel | 'success', string> = { info: 'ℹ️', warning: '⚠️', check: '❓', safety: '🚨', error: '⛔', success: '✅' };
export function Message({ level, children }: { level: MessageLevel | 'success'; children: ReactNode }) {
  return (
    <div className={`msg ${level}`} role={level === 'safety' || level === 'error' ? 'alert' : 'status'}>
      <span aria-hidden="true">{ICON[level]}</span>
      <div>
        <div className="lvl">{level === 'success' ? 'Spremljeno' : LEVEL_LABEL[level]}</div>
        <div>{children}</div>
      </div>
    </div>
  );
}

/** Vrijednost obojena kategorijom (SYS i DIA zasebno); puls neutralno. Boja nikad nije sama: uz nju je i tekst kategorije drugdje na zaslonu. */
export function Val({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={cls}>{children}</span>;
}

export function Badge({ kind, children, title }: { kind: string; children: ReactNode; title?: string }) {
  return <span className={`badge ${kind}`} title={title}>{children}</span>;
}

/* ---------- Segmentirani izbor ---------- */
export function Segmented<T extends string>({ value, options, onChange, wrap, short, label }: {
  value: T; options: { value: T; label: string; title?: string }[]; onChange: (v: T) => void; wrap?: boolean; short?: boolean; label?: string;
}) {
  return (
    <div className={`segmented ${wrap ? 'wrap' : ''} ${short ? 'short' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} title={o.title} aria-label={o.title} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Chips({ values, options, onChange }: { values: string[]; options: string[]; onChange: (v: string[]) => void }) {
  const toggle = (o: string) => onChange(values.includes(o) ? values.filter((v) => v !== o) : [...values, o]);
  return (
    <div className="chips">
      {options.map((o) => (
        <button key={o} type="button" className="chip" aria-pressed={values.includes(o)} onClick={() => toggle(o)}>{o}</button>
      ))}
    </div>
  );
}

/* ---------- Polja ---------- */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}{children}</label>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function NumberInput({ value, onChange, placeholder, ref, ...rest }: {
  value: number | null; onChange: (v: number | null) => void; placeholder?: string; ref?: React.Ref<HTMLInputElement>;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <input ref={ref}
      type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" enterKeyHint="next"
      value={value === null ? '' : String(value)} placeholder={placeholder}
      onChange={(e) => { const s = e.target.value.replace(/\D/g, '').slice(0, 3); onChange(s ? Number(s) : null); }}
      {...rest}
    />
  );
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : initial; } catch { return initial; }
  });
  const set = useCallback((nv: T) => { setV(nv); try { localStorage.setItem(key, JSON.stringify(nv)); } catch { /* ignore */ } }, [key]);
  return [v, set];
}

export function Spinner({ text }: { text?: string }) {
  return <p className="muted" role="status">⏳ {text || 'Učitavanje…'}</p>;
}

/**
 * Datum kao DD.MM.GGGG, neovisno o jeziku uređaja (sistemsko <input type="date"> na iPhoneu s engleskim
 * postavkama prikazuje MM/DD/YYYY). Vrijednost prema van je ISO (GGGG-MM-DD) ili '' dok unos nije potpun.
 */
export function DateInput({ value, onChange, required, className }: { value: string; onChange: (iso: string) => void; required?: boolean; className?: string }) {
  const toShown = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; };
  const [text, setText] = useState(() => toShown(value));
  const last = useRef(value);
  useEffect(() => { if (value !== last.current) { last.current = value; setText(toShown(value)); } }, [value]);
  const commit = (t: string) => {
    const digits = t.replace(/\D/g, '').slice(0, 8);
    // automatske točke: 07092026 → 07.09.2026
    const shown = digits.length <= 2 ? digits : digits.length <= 4 ? `${digits.slice(0, 2)}.${digits.slice(2)}` : `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
    setText(shown);
    if (digits.length === 8) {
      const d = Number(digits.slice(0, 2)), mo = Number(digits.slice(2, 4)), y = Number(digits.slice(4));
      const dt = new Date(y, mo - 1, d);
      if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) { const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; last.current = iso; onChange(iso); return; }
    }
    if (!digits.length) { last.current = ''; onChange(''); }
  };
  const valid = text === '' || /^\d{2}\.\d{2}\.\d{4}$/.test(text) && toShown(last.current) === text;
  return <input type="text" inputMode="numeric" placeholder="DD.MM.GGGG" pattern="\d{2}\.\d{2}\.\d{4}" value={text} onChange={(e) => commit(e.target.value)} required={required} className={`${className || ''}${valid ? '' : ' invalid'}`} aria-invalid={!valid} maxLength={10} />;
}

/** Vrijeme kao HH:MM (24-satno), neovisno o jeziku uređaja. Vrijednost prema van je HH:MM ili ''. */
export function TimeInput({ value, onChange, required, className }: { value: string; onChange: (hhmm: string) => void; required?: boolean; className?: string }) {
  const [text, setText] = useState(value);
  const last = useRef(value);
  useEffect(() => { if (value !== last.current) { last.current = value; setText(value); } }, [value]);
  const commit = (t: string) => {
    const digits = t.replace(/\D/g, '').slice(0, 4);
    const shown = digits.length <= 2 ? digits : `${digits.slice(0, 2)}:${digits.slice(2)}`;
    setText(shown);
    if (digits.length === 4) {
      const hh = Number(digits.slice(0, 2)), mm = Number(digits.slice(2));
      if (hh <= 23 && mm <= 59) { const v = `${digits.slice(0, 2)}:${digits.slice(2)}`; last.current = v; onChange(v); return; }
    }
    if (!digits.length) { last.current = ''; onChange(''); }
  };
  const valid = text === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(text);
  return <input type="text" inputMode="numeric" placeholder="HH:MM" pattern="([01]\d|2[0-3]):[0-5]\d" value={text} onChange={(e) => commit(e.target.value)} required={required} className={`${className || ''}${valid ? '' : ' invalid'}`} aria-invalid={!valid} maxLength={5} />;
}
