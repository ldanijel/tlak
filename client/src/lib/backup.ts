import { COLLECTIONS, type Collection, type CollectionMap, type SyncBase } from '../types.ts';

export interface Backup {
  app: 'tlak';
  version: 1;
  exportedAt: string;
  data: { [C in Collection]: CollectionMap[C][] };
}

export function makeBackup(data: Backup['data']): Backup {
  return { app: 'tlak', version: 1, exportedAt: new Date().toISOString(), data };
}

export interface BackupPreview { counts: Record<Collection, number>; from: string | null; to: string | null; exportedAt: string }

export function parseBackup(text: string): { backup: Backup; preview: BackupPreview } {
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { throw new Error('Datoteka nije ispravan JSON.'); }
  const b = obj as Partial<Backup>;
  if (!b || b.app !== 'tlak' || !b.data || typeof b.data !== 'object') throw new Error('Datoteka nije sigurnosna kopija aplikacije Tlak.');
  const counts = {} as Record<Collection, number>;
  for (const c of COLLECTIONS) {
    const list = (b.data as Record<string, unknown>)[c];
    if (list !== undefined && !Array.isArray(list)) throw new Error(`Neispravan popis: ${c}.`);
    counts[c] = Array.isArray(list) ? (list as SyncBase[]).filter((r) => !r.deletedAt).length : 0;
  }
  const times = ((b.data.measurements || []) as CollectionMap['measurements'][]).filter((m) => !m.deletedAt).map((m) => m.measuredAt).sort();
  const data = Object.fromEntries(COLLECTIONS.map((c) => [c, (b.data as Record<string, unknown[]>)[c] || []])) as Backup['data'];
  return {
    backup: { app: 'tlak', version: 1, exportedAt: b.exportedAt || '', data },
    preview: { counts, from: times[0] || null, to: times[times.length - 1] || null, exportedAt: b.exportedAt || '' },
  };
}

/* Šifrirana kopija: AES-GCM s ključem izvedenim iz lozinke (PBKDF2). */
const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function b64(a: Uint8Array): string { return btoa(String.fromCharCode(...a)); }
function unb64(s: string): Uint8Array { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }

export async function encryptBackup(text: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(text)));
  return JSON.stringify({ app: 'tlak', encrypted: true, kdf: 'PBKDF2-SHA256-310000', salt: b64(salt), iv: b64(iv), data: b64(ct) });
}

export function isEncryptedBackup(text: string): boolean {
  try { const o = JSON.parse(text); return o?.app === 'tlak' && o?.encrypted === true; } catch { return false; }
}

export async function decryptBackup(text: string, password: string): Promise<string> {
  const o = JSON.parse(text) as { salt: string; iv: string; data: string };
  const key = await deriveKey(password, unb64(o.salt));
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) as BufferSource }, key, unb64(o.data) as BufferSource);
    return dec.decode(pt);
  } catch {
    throw new Error('Pogrešna lozinka ili oštećena datoteka.');
  }
}
