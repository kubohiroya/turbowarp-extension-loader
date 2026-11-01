import {gzipBytes, gunzipBytes} from './cache-gzip.js';

export interface IndexedDBContentCacheOptions {
    indexedDB?: IDBFactory;
    databaseName?: string;
    /** Compressed bytes quota (default 32 MiB). */
    maxBytes?: number;
    /** Maximum decompressed JS size (default 8 MiB). */
    maxDecompressedBytes?: number;
    now?: () => number;
}
/** Persistent browser cache for SHA-256-addressed extension bytes. Requires IndexedDB. */
export type IndexedDBContentCache = Readonly<{
    get(key: string, options?: {signal?: AbortSignal}): Promise<Uint8Array | undefined>;
    put(key: string, bytes: Uint8Array, options?: {signal?: AbortSignal}): Promise<void>;
    clear(): Promise<void>;
    getSize(): Promise<{entries: number; bytes: number}>;
    close(): Promise<void>;
}>;

/** The shape put() writes. Stored records are still untrusted and checked by validRecord before use. */
interface CacheRecord {key: string; format: 'gzip-v1'; bytes: ArrayBuffer; originalBytes: number; lastAccess?: number}

/** Persistent, content-addressed cache. The Loader independently verifies SHA-256 on every hit.
 * Storage is untrusted: this adapter is not an authorization or integrity boundary.
 */
export function createIndexedDBContentCache({
    indexedDB = globalThis.indexedDB,
    databaseName = 'turbowarp-plus-extension-cache',
    maxBytes = 32 * 1024 * 1024,
    maxDecompressedBytes = 8 * 1024 * 1024,
    now = Date.now
}: IndexedDBContentCacheOptions = {}): IndexedDBContentCache {
    if (!indexedDB || typeof indexedDB.open !== 'function') throw new Error('IndexedDB unavailable');
    if (typeof databaseName !== 'string' || !databaseName || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
        !Number.isSafeInteger(maxDecompressedBytes) || maxDecompressedBytes < 1 ||
        typeof now !== 'function') throw new TypeError('Invalid IndexedDB cache options');

    let dbPromise: Promise<IDBDatabase> | undefined;
    function open(): Promise<IDBDatabase> {
        if (!dbPromise) {
            dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open(databaseName, 1);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains('content')) db.createObjectStore('content', {keyPath: 'key'});
                };
                request.onsuccess = () => {
                    const db = request.result;
                    db.onversionchange = () => db.close();
                    resolve(db);
                };
                request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
                request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
            }).catch(error => { dbPromise = undefined; throw error; });
        }
        return dbPromise;
    }
    function transaction<T = void>(db: IDBDatabase, mode: IDBTransactionMode,
        work: (store: IDBObjectStore, set: (result: T) => void, tx: IDBTransaction) => void): Promise<T> {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('content', mode);
            let value: T;
            tx.oncomplete = () => resolve(value);
            tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
            try { work(tx.objectStore('content'), result => { value = result; }, tx); }
            catch (error) { try { tx.abort(); } catch {} reject(error); }
        });
    }
    const keyValid = (key: unknown) => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
    const validBytes = (value: unknown) => value instanceof Uint8Array;
    const validRecord = (entry: CacheRecord | undefined) => !!entry && entry.format === 'gzip-v1' &&
        entry.bytes instanceof ArrayBuffer && Number.isSafeInteger(entry.originalBytes) &&
        entry.originalBytes >= 0 && entry.originalBytes <= maxDecompressedBytes &&
        entry.bytes.byteLength <= maxBytes;
    function sweep(store: IDBObjectStore, protectedKey: string | null = null) {
        const request = store.getAll();
        request.onsuccess = () => {
            let total = 0;
            const kept: CacheRecord[] = [];
            for (const record of request.result as CacheRecord[]) {
                if (!validRecord(record)) { store.delete(record.key); continue; }
                total += record.bytes.byteLength;
                kept.push(record);
            }
            kept.sort((a, b) => (a.lastAccess || 0) - (b.lastAccess || 0));
            for (const record of kept) {
                if (total <= maxBytes) break;
                if (record.key === protectedKey) continue;
                store.delete(record.key);
                total -= record.bytes.byteLength;
            }
        };
    }
    return Object.freeze({
        async get(key: string, {signal}: {signal?: AbortSignal} = {}) {
            if (!keyValid(key)) throw new TypeError('Invalid SHA-256 cache key');
            if (signal?.aborted) throw signal.reason;
            const db = await open();
            const record = await transaction<{bytes: ArrayBuffer; originalBytes: number} | undefined>(db, 'readwrite', (store, set) => {
                const request = store.get(key);
                request.onsuccess = () => {
                    const entry: CacheRecord | undefined = request.result;
                    if (!entry) { set(undefined); return; }
                    if (!validRecord(entry)) { store.delete(key); set(undefined); return; }
                    entry.lastAccess = now();
                    store.put(entry);
                    set({bytes: entry.bytes.slice(0), originalBytes: entry.originalBytes});
                };
            });
            if (signal?.aborted) throw signal.reason;
            if (!record) return undefined;
            const bytes = await gunzipBytes(new Uint8Array(record.bytes), maxDecompressedBytes);
            if (bytes.byteLength !== record.originalBytes) throw new Error('Cached decompressed length mismatch');
            if (signal?.aborted) throw signal.reason;
            return bytes;
        },
        async put(key: string, bytes: Uint8Array, {signal}: {signal?: AbortSignal} = {}) {
            if (!keyValid(key) || !validBytes(bytes)) throw new TypeError('Cache content requires a SHA-256 key and bytes');
            if (signal?.aborted) throw signal.reason;
            if (bytes.byteLength > maxDecompressedBytes) throw new RangeError('Cache input exceeds decompressed size limit');
            const originalBytes = bytes.byteLength;
            const compressed = await gzipBytes(bytes);
            if (signal?.aborted) throw signal.reason;
            const db = await open();
            return transaction(db, 'readwrite', store => {
                const time = now();
                if (compressed.byteLength <= maxBytes) {
                    store.put({key, format: 'gzip-v1', bytes: compressed.buffer, originalBytes,
                        lastAccess: time} satisfies CacheRecord);
                } else store.delete(key);
                sweep(store, compressed.byteLength <= maxBytes ? key : null);
            });
        },
        async clear() {
            const db = await open();
            return transaction(db, 'readwrite', store => { store.clear(); });
        },
        async getSize() {
            const db = await open();
            return transaction<{entries: number; bytes: number}>(db, 'readonly', (store, set) => {
                const request = store.getAll();
                request.onsuccess = () => set((request.result as Partial<CacheRecord>[]).reduce((size, record) => ({
                    entries: size.entries + 1, bytes: size.bytes + (record.bytes?.byteLength || 0)
                }), {entries: 0, bytes: 0}));
            });
        },
        async close() {
            if (dbPromise) { const db = await dbPromise; db.close(); dbPromise = undefined; }
        }
    });
}
