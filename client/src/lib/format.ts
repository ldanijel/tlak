const pad = (n: number) => String(n).padStart(2, '0');

export function fmtDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}.`;
}

export function fmtTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDateTime(iso: string | Date): string {
  return `${fmtDate(iso)} ${fmtTime(iso)}`;
}

export function fmtShortDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${d.getDate()}.${d.getMonth() + 1}.`;
}

/** Lokalni datum kao YYYY-MM-DD (za grupiranje po danima). */
export function localDayKey(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Vrijednosti za <input type="date"> i <input type="time"> iz ISO datuma. */
export function toInputDate(iso: string | Date): string {
  return localDayKey(iso);
}
export function toInputTime(iso: string | Date): string {
  return fmtTime(iso);
}
export function fromInputs(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0);
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return n.toLocaleString('hr-HR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtDelta(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  const s = fmtNum(Math.abs(n), digits);
  if (n > 0) return `+${s}`;
  if (n < 0) return `−${s}`;
  return `±0`;
}

export function fmtRelative(iso: string | null): string {
  if (!iso) return 'nikad';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'upravo sada';
  if (min < 60) return `prije ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `prije ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30) return `prije ${d} d`;
  return fmtDate(iso);
}

export function currentTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
