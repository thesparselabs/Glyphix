// Minimal promise wrapper over IndexedDB (no dependency). One database, four stores:
//   projects: { id, name, createdAt, updatedAt, doc (JSON), thumbnail?: Blob }
//   assets:   { id, blob }            — image files by asset id, shared across projects
//   meta:     { key, value }          — e.g. the last opened project
//   presets:  AnimPreset              — the user's saved animations (added in v2)

const DB_NAME = 'glyphix';
const DB_VERSION = 2;

export type StoreName = 'projects' | 'assets' | 'meta' | 'presets';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('presets')) db.createObjectStore('presets', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Glyphix storage is blocked by another open tab'));
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return wrap(db.transaction(store, 'readonly').objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return wrap(db.transaction(store, 'readonly').objectStore(store).getAll()) as Promise<T[]>;
}

export async function getAllKeys(store: StoreName): Promise<IDBValidKey[]> {
  const db = await openDb();
  return wrap(db.transaction(store, 'readonly').objectStore(store).getAllKeys());
}

/** Put several records into one store in a single transaction. */
export async function putMany(store: StoreName, values: unknown[]): Promise<void> {
  if (!values.length) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  values.forEach((v) => os.put(v));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted (storage full?)'));
  });
}

export const put = (store: StoreName, value: unknown) => putMany(store, [value]);

export async function del(store: StoreName, keys: IDBValidKey[]): Promise<void> {
  if (!keys.length) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  keys.forEach((k) => tx.objectStore(store).delete(k));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
