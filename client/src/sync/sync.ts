import { COLLECTIONS, type Collection, type SyncBase } from '../types.ts';
import { getDirty, getMeta, getRecord, putRecord, setMeta, type Stored } from '../db/idb.ts';
import { api, ApiError, loadAuth, saveAuth } from './api.ts';

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'offline' | 'error' | 'unauthorized';

export interface SyncState { status: SyncStatus; lastSyncAt: string | null; error: string | null; pending: number }

interface Change { collection: Collection; id: string; data: SyncBase; updatedAt: string; deleted: boolean }
interface SyncResponse {
  rev: number; more: boolean;
  applied: { collection: Collection; id: string; rev: number }[];
  rejected: { collection: Collection; id: string; reason: string }[];
  changes: (Change & { rev: number })[];
}

type Listener = (s: SyncState) => void;
const listeners = new Set<Listener>();
let state: SyncState = { status: loadAuth() ? 'idle' : 'off', lastSyncAt: null, error: null, pending: 0 };
let running: Promise<boolean> | null = null;
let changedDuringRun = false;
let timer: number | null = null;
let onRemoteChange: (() => void) | null = null;

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  l(state);
  return () => listeners.delete(l);
}
export function getSyncState(): SyncState {
  return state;
}
function set(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}
export function setRemoteChangeHandler(fn: () => void) {
  onRemoteChange = fn;
}

export async function initSync(): Promise<void> {
  const last = await getMeta<string>('lastSyncAt');
  set({ lastSyncAt: last ?? null, status: loadAuth() ? 'idle' : 'off' });
  window.addEventListener('online', () => void syncNow());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void syncNow(); });
  window.setInterval(() => void syncNow(), 5 * 60 * 1000);
  void syncNow();
}

/** Odgođena sinkronizacija nakon lokalne izmjene. */
export function scheduleSync(delayMs = 1500): void {
  if (!loadAuth()) return;
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => { timer = null; void syncNow(); }, delayMs);
}

/** Sinkronizira samo ako od zadnje sinkronizacije prošlo više od zadanog vremena (npr. pri promjeni stranice). */
export function syncIfStale(maxAgeMs = 20000): void {
  if (!loadAuth() || running) return;
  const last = state.lastSyncAt ? new Date(state.lastSyncAt).getTime() : 0;
  if (Date.now() - last > maxAgeMs) void syncNow();
}

export function syncNow(): Promise<boolean> {
  if (!loadAuth()) { set({ status: 'off' }); return Promise.resolve(false); }
  if (running) { changedDuringRun = true; return running; }
  running = run().finally(() => {
    running = null;
    if (changedDuringRun) { changedDuringRun = false; scheduleSync(300); }
  });
  return running;
}

async function run(): Promise<boolean> {
  const auth = loadAuth();
  if (!auth) return false;
  if (!navigator.onLine) { set({ status: 'offline' }); return false; }
  set({ status: 'syncing', error: null });
  try {
    let since = (await getMeta<number>('syncRev')) ?? 0;
    const dirty = await getDirty();
    set({ pending: dirty.length });
    let changes: Change[] = dirty.map(({ collection, record }) => {
      const { dirty: _d, ...data } = record;
      void _d;
      return { collection, id: record.id, data, updatedAt: record.updatedAt, deleted: !!record.deletedAt };
    });
    let remoteApplied = false;
    for (let guard = 0; guard < 100; guard++) {
      const batch = changes.slice(0, 500);
      changes = changes.slice(500);
      const res = await api<SyncResponse>('POST', '/api/sync', { since, changes: batch }, auth.token);
      // Prihvaćene lokalne promjene više nisu "dirty" (osim ako su u međuvremenu ponovno izmijenjene).
      for (const a of res.applied) {
        const local = await getRecord(a.collection, a.id);
        const sent = batch.find((b) => b.collection === a.collection && b.id === a.id);
        if (local && sent && local.updatedAt === sent.updatedAt) await putRecord(a.collection, { ...local, dirty: 0 });
      }
      for (const c of res.changes) {
        if (!COLLECTIONS.includes(c.collection)) continue;
        const local = await getRecord(c.collection, c.id);
        if (local && local.dirty && local.updatedAt > c.updatedAt) continue; // lokalna je novija, ide u idućem krugu
        if (local && !local.dirty && local.updatedAt === c.updatedAt) continue;
        const data = { ...(c.data as SyncBase), id: c.id, updatedAt: c.updatedAt } as Stored<SyncBase>;
        if (c.deleted && !data.deletedAt) data.deletedAt = c.updatedAt;
        if (!c.deleted) data.deletedAt = data.deletedAt ?? null;
        data.dirty = 0;
        await putRecord(c.collection, data as never);
        remoteApplied = true;
      }
      since = res.rev;
      await setMeta('syncRev', since);
      if (!res.more && !changes.length) break;
    }
    const now = new Date().toISOString();
    await setMeta('lastSyncAt', now);
    set({ status: 'idle', lastSyncAt: now, pending: 0 });
    // i bez udaljenih promjena zastavice „dirty” su se promijenile, pa se stanje osvježava
    if ((remoteApplied || dirty.length) && onRemoteChange) onRemoteChange();
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      saveAuth(null);
      set({ status: 'unauthorized', error: 'Sesija je istekla. Prijavite se ponovno.' });
    } else if (e instanceof ApiError && e.status === 0) {
      set({ status: 'offline' });
    } else {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
    return false;
  }
}

export async function resetSyncCursor(): Promise<void> {
  await setMeta('syncRev', 0);
  await setMeta('lastSyncAt', null);
  set({ lastSyncAt: null, status: loadAuth() ? 'idle' : 'off' });
}
