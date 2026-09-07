import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  COLLECTIONS, DEFAULT_CATEGORIES, DEFAULT_SAFETY, type Collection, type CollectionMap, type Device, type HealthEvent, type Measurement, type Medication,
  type OcrModel, type Settings, type SyncBase, type Target,
} from './types.ts';
import { clearAllData, getAll, getMeta, markAllDirty, putMany, setMeta, type Stored } from './db/idb.ts';
import { uid } from './lib/ids.ts';
import { initSync, scheduleSync, setRemoteChangeHandler, subscribe, syncNow, resetSyncCursor, type SyncState } from './sync/sync.ts';
import { loadAuth, saveAuth, type AuthState } from './sync/api.ts';
import type { Backup } from './lib/backup.ts';

export interface Data {
  measurements: Measurement[];
  targets: Target[];
  devices: Device[];
  medications: Medication[];
  events: HealthEvent[];
  settings: Settings;
  ocrModels: OcrModel[];
}

type NewRecord<T extends SyncBase> = Omit<T, keyof SyncBase> & Partial<SyncBase>;

export interface Store {
  ready: boolean;
  data: Data;
  sync: SyncState;
  auth: AuthState | null;
  lastBackupAt: string | null;
  /** Zapisi s lokalnim izmjenama koje još nisu potvrđene na poslužitelju (collection/id). */
  unsynced: Set<string>;
  save<C extends Collection>(c: C, rec: NewRecord<CollectionMap[C]>): Promise<CollectionMap[C]>;
  saveMany<C extends Collection>(c: C, recs: NewRecord<CollectionMap[C]>[]): Promise<void>;
  remove(c: Collection, id: string): Promise<void>;
  restore(c: Collection, id: string): Promise<void>;
  removeMany(c: Collection, ids: string[]): Promise<void>;
  restoreMany(c: Collection, ids: string[]): Promise<void>;
  /** Tvornički reset ovog uređaja: briše lokalnu bazu, prijavu, PIN i postavke uređaja. Podaci na računu ostaju. */
  factoryReset(): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  setAuth(a: AuthState | null, opts?: { clearLocal?: boolean }): Promise<void>;
  restoreBackup(b: Backup, mode: 'merge' | 'replace'): Promise<void>;
  markBackup(): Promise<void>;
  reload(): Promise<void>;
}

const defaultSettings = (): Settings => ({
  id: 'main', createdAt: new Date().toISOString(), updatedAt: new Date(0).toISOString(), deletedAt: null,
  profileName: '', profileBirthYear: '', safety: { ...DEFAULT_SAFETY }, categories: { ...DEFAULT_CATEGORIES }, showChecklist: false, movingAverage: false,
  sessionWindowMinutes: 10, backupReminderDays: 30,
});

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('StoreProvider nedostaje');
  return s;
}

function alive<T extends SyncBase>(list: Stored<T>[]): T[] {
  return list.filter((r) => !r.deletedAt).map(({ dirty: _d, ...r }) => { void _d; return r as unknown as T; });
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<Data>({ measurements: [], targets: [], devices: [], medications: [], events: [], settings: defaultSettings(), ocrModels: [] });
  const [sync, setSync] = useState<SyncState>({ status: 'off', lastSyncAt: null, error: null, pending: 0 });
  const [auth, setAuthState] = useState<AuthState | null>(loadAuth());
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [unsynced, setUnsynced] = useState<Set<string>>(new Set());
  const raw = useRef<{ [C in Collection]: Stored<CollectionMap[C]>[] }>({ measurements: [], targets: [], devices: [], medications: [], events: [], settings: [], ocrModels: [] });

  const reload = useCallback(async () => {
    const [measurements, targets, devices, medications, events, settings, ocrModels] = await Promise.all([
      getAll('measurements'), getAll('targets'), getAll('devices'), getAll('medications'), getAll('events'), getAll('settings'), getAll('ocrModels'),
    ]);
    raw.current = { measurements, targets, devices, medications, events, settings, ocrModels };
    const dirtySet = new Set<string>();
    for (const [c, list] of Object.entries(raw.current)) for (const r of list as { id: string; dirty: 0 | 1 }[]) if (r.dirty) dirtySet.add(`${c}/${r.id}`);
    setUnsynced(dirtySet);
    // Mjerenja koja su izbrisana i sinkronizirana zadržavamo u memoriji radi "vrati" tijekom sesije.
    const s = settings.find((x) => x.id === 'main');
    setData({
      measurements: alive(measurements).sort((a, b) => b.measuredAt.localeCompare(a.measuredAt) || b.createdAt.localeCompare(a.createdAt)),
      targets: alive(targets).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)),
      devices: alive(devices),
      medications: alive(medications),
      events: alive(events).sort((a, b) => a.date.localeCompare(b.date)),
      ocrModels: alive(ocrModels),
      settings: s ? { ...defaultSettings(), ...(s as unknown as Settings), safety: { ...DEFAULT_SAFETY, ...(s as unknown as Settings).safety }, categories: { ...DEFAULT_CATEGORIES, ...((s as unknown as Settings).categories || {}) } } : defaultSettings(),
    });
    setLastBackupAt((await getMeta<string>('lastBackupAt')) ?? null);
  }, []);

  useEffect(() => {
    let unsub = () => {};
    (async () => {
      await reload();
      setReady(true);
      setRemoteChangeHandler(() => void reload());
      unsub = subscribe((s) => { setSync(s); if (s.status === 'unauthorized') setAuthState(null); });
      await initSync();
    })();
    return () => unsub();
  }, [reload]);

  const write = useCallback(async <C extends Collection>(c: C, recs: Stored<CollectionMap[C]>[]) => {
    await putMany(c, recs);
    await reload();
    scheduleSync();
  }, [reload]);

  const save = useCallback(async <C extends Collection>(c: C, rec: NewRecord<CollectionMap[C]>) => {
    const now = new Date().toISOString();
    const existing = rec.id ? raw.current[c].find((r) => r.id === rec.id) : undefined;
    const full = { ...(existing || {}), ...rec, id: rec.id || uid(), createdAt: existing?.createdAt || rec.createdAt || now, updatedAt: now, deletedAt: rec.deletedAt ?? null, dirty: 1 } as unknown as Stored<CollectionMap[C]>;
    await write(c, [full]);
    const { dirty: _d, ...clean } = full;
    void _d;
    return clean as unknown as CollectionMap[C];
  }, [write]);

  const saveMany = useCallback(async <C extends Collection>(c: C, recs: NewRecord<CollectionMap[C]>[]) => {
    const now = new Date().toISOString();
    await write(c, recs.map((rec) => ({ ...rec, id: rec.id || uid(), createdAt: rec.createdAt || now, updatedAt: now, deletedAt: rec.deletedAt ?? null, dirty: 1 }) as unknown as Stored<CollectionMap[C]>));
  }, [write]);

  const remove = useCallback(async (c: Collection, id: string) => {
    const r = raw.current[c].find((x) => x.id === id);
    if (!r) return;
    const now = new Date().toISOString();
    await write(c, [{ ...r, deletedAt: now, updatedAt: now, dirty: 1 } as never]);
  }, [write]);

  const restore = useCallback(async (c: Collection, id: string) => {
    const r = raw.current[c].find((x) => x.id === id);
    if (!r) return;
    await write(c, [{ ...r, deletedAt: null, updatedAt: new Date().toISOString(), dirty: 1 } as never]);
  }, [write]);

  const removeMany = useCallback(async (c: Collection, ids: string[]) => {
    const now = new Date().toISOString();
    const set = new Set(ids);
    const recs = raw.current[c].filter((x) => set.has(x.id) && !x.deletedAt).map((r) => ({ ...r, deletedAt: now, updatedAt: now, dirty: 1 }));
    if (recs.length) await write(c, recs as never);
  }, [write]);

  const restoreMany = useCallback(async (c: Collection, ids: string[]) => {
    const now = new Date().toISOString();
    const set = new Set(ids);
    const recs = raw.current[c].filter((x) => set.has(x.id) && x.deletedAt).map((r) => ({ ...r, deletedAt: null, updatedAt: now, dirty: 1 }));
    if (recs.length) await write(c, recs as never);
  }, [write]);

  const factoryReset = useCallback(async () => {
    saveAuth(null);
    setAuthState(null);
    await clearAllData();
    try { for (const k of Object.keys(localStorage)) if (k.startsWith('tlak.')) localStorage.removeItem(k); } catch { /* ignore */ }
    await resetSyncCursor();
    await reload();
  }, [reload]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const cur = raw.current.settings.find((s) => s.id === 'main');
    const base = cur ? (cur as unknown as Settings) : defaultSettings();
    await save('settings', { ...base, ...patch, id: 'main' });
  }, [save]);

  const setAuth = useCallback(async (a: AuthState | null, opts?: { clearLocal?: boolean }) => {
    saveAuth(a);
    setAuthState(a);
    await resetSyncCursor();
    if (a) {
      // Sve lokalne zapise šaljemo na račun (spajanje po pravilu "zadnja izmjena pobjeđuje").
      await markAllDirty();
      await reload();
      await syncNow();
      await reload();
    } else if (opts?.clearLocal) {
      await clearAllData();
      await reload();
    } else {
      await markAllDirty();
      await reload();
    }
  }, [reload]);

  const restoreBackup = useCallback(async (b: Backup, mode: 'merge' | 'replace') => {
    const now = new Date().toISOString();
    if (mode === 'replace') {
      for (const c of COLLECTIONS) {
        const dead = raw.current[c].filter((r) => !r.deletedAt).map((r) => ({ ...r, deletedAt: now, updatedAt: now, dirty: 1 }));
        await putMany(c, dead as never);
      }
    }
    for (const c of COLLECTIONS) {
      const incoming = (b.data[c] || []) as SyncBase[];
      const recs = incoming.map((r) => ({ ...r, deletedAt: r.deletedAt ?? null, createdAt: r.createdAt || now, updatedAt: mode === 'replace' ? now : (r.updatedAt || now), dirty: 1 }));
      if (mode === 'merge') {
        // Zadržavamo noviju verziju istog zapisa.
        const filtered = recs.filter((r) => {
          const local = raw.current[c].find((x) => x.id === r.id);
          return !local || local.updatedAt < r.updatedAt;
        });
        await putMany(c, filtered as never);
      } else {
        await putMany(c, recs as never);
      }
    }
    await reload();
    scheduleSync();
  }, [reload]);

  const markBackup = useCallback(async () => {
    const now = new Date().toISOString();
    await setMeta('lastBackupAt', now);
    setLastBackupAt(now);
  }, []);

  const value = useMemo<Store>(() => ({ ready, data, sync, auth, lastBackupAt, unsynced, save, saveMany, remove, restore, removeMany, restoreMany, factoryReset, updateSettings, setAuth, restoreBackup, markBackup, reload }),
    [ready, data, sync, auth, lastBackupAt, unsynced, save, saveMany, remove, restore, removeMany, restoreMany, factoryReset, updateSettings, setAuth, restoreBackup, markBackup, reload]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
