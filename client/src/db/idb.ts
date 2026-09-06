import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { COLLECTIONS, type Collection, type CollectionMap, type SyncBase } from '../types.ts';

/** Zapis u lokalnoj bazi: sinkronizirani zapis + zastavica lokalne izmjene. */
export type Stored<T extends SyncBase> = T & { dirty: 0 | 1 };

interface TlakDB extends DBSchema {
  measurements: { key: string; value: Stored<CollectionMap['measurements']>; indexes: { measuredAt: string } };
  targets: { key: string; value: Stored<CollectionMap['targets']> };
  devices: { key: string; value: Stored<CollectionMap['devices']> };
  medications: { key: string; value: Stored<CollectionMap['medications']> };
  events: { key: string; value: Stored<CollectionMap['events']> };
  settings: { key: string; value: Stored<CollectionMap['settings']> };
  meta: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<TlakDB>> | null = null;

export function db(): Promise<IDBPDatabase<TlakDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TlakDB>('tlak', 1, {
      upgrade(d) {
        const m = d.createObjectStore('measurements', { keyPath: 'id' });
        m.createIndex('measuredAt', 'measuredAt');
        d.createObjectStore('targets', { keyPath: 'id' });
        d.createObjectStore('devices', { keyPath: 'id' });
        d.createObjectStore('medications', { keyPath: 'id' });
        d.createObjectStore('events', { keyPath: 'id' });
        d.createObjectStore('settings', { keyPath: 'id' });
        d.createObjectStore('meta');
      },
    });
  }
  return dbPromise;
}

export async function getAll<C extends Collection>(c: C): Promise<Stored<CollectionMap[C]>[]> {
  const d = await db();
  return (await d.getAll(c)) as Stored<CollectionMap[C]>[];
}

export async function putRecord<C extends Collection>(c: C, rec: Stored<CollectionMap[C]>): Promise<void> {
  const d = await db();
  await d.put(c, rec as never);
}

export async function putMany<C extends Collection>(c: C, recs: Stored<CollectionMap[C]>[]): Promise<void> {
  if (!recs.length) return;
  const d = await db();
  const tx = d.transaction(c, 'readwrite');
  for (const r of recs) tx.store.put(r as never);
  await tx.done;
}

export async function getRecord<C extends Collection>(c: C, id: string): Promise<Stored<CollectionMap[C]> | undefined> {
  const d = await db();
  return (await d.get(c, id)) as Stored<CollectionMap[C]> | undefined;
}

export async function getDirty(): Promise<{ collection: Collection; record: Stored<SyncBase> }[]> {
  const d = await db();
  const out: { collection: Collection; record: Stored<SyncBase> }[] = [];
  for (const c of COLLECTIONS) {
    for (const r of await d.getAll(c)) if ((r as Stored<SyncBase>).dirty) out.push({ collection: c, record: r as Stored<SyncBase> });
  }
  return out;
}

export async function markAllDirty(): Promise<void> {
  const d = await db();
  for (const c of COLLECTIONS) {
    const tx = d.transaction(c, 'readwrite');
    let cur = await tx.store.openCursor();
    while (cur) { await cur.update({ ...cur.value, dirty: 1 } as never); cur = await cur.continue(); }
    await tx.done;
  }
}

export async function clearAllData(): Promise<void> {
  const d = await db();
  for (const c of [...COLLECTIONS, 'meta'] as const) await d.clear(c);
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return (await d.get('meta', key)) as T | undefined;
}
export async function setMeta(key: string, value: unknown): Promise<void> {
  const d = await db();
  await d.put('meta', value, key);
}
