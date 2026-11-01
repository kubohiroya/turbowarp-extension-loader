import {gzipBytes, gunzipBytes} from './cache-gzip.js';

export interface IndexedDBCacheOptions {
    indexedDB?: IDBFactory;
    databaseName?: string;
    maxBytes?: number;
    maxDecompressedBytes?: number;
    now?: () => number;
}
export interface IndexedDBContentCache {
    get(key: string, options?: {signal?: AbortSignal}): Promise<Uint8Array | undefined>;
    put(key: string, bytes: Uint8Array, options?: {signal?: AbortSignal}): Promise<void>;
    clear(): Promise<void>;
    getSize(): Promise<{entries: number; bytes: number}>;
    close(): Promise<void>;
}
interface CompressedEntry {
    key: string;
    format: 'gzip-v1';
    bytes: ArrayBuffer;
    originalBytes: number;
    lastAccess: number;
}
type StoredEntry = CompressedEntry & {expires?: number};
const isEntry = (value: unknown): value is StoredEntry =>
    !!value && typeof value === 'object' && 'key' in value && typeof value.key === 'string';

/** Persistent content-addressed gzip cache. Core verifies SHA-256 after every read. */
export function createIndexedDBContentCache({
    indexedDB = globalThis.indexedDB,
    databaseName = 'turbowarp-plus-extension-cache',
    maxBytes = 32 * 1024 * 1024,
    maxDecompressedBytes = 8 * 1024 * 1024,
    now = Date.now
}: IndexedDBCacheOptions = {}): Readonly<IndexedDBContentCache> {
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
    function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode,
        work: (store: IDBObjectStore, set: (value: T) => void) => void): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const tx = db.transaction('content', mode);
            let value: T;
            tx.oncomplete = () => resolve(value);
            tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
            try { work(tx.objectStore('content'), result => { value = result; }); }
            catch (error) { try { tx.abort(); } catch {} reject(error); }
        });
    }
    const keyValid = (key: string): boolean => /^[a-f0-9]{64}$/.test(key);
    const validRecord = (entry: unknown): entry is StoredEntry => {
        if (!isEntry(entry)) return false;
        return entry.format === 'gzip-v1' && entry.bytes instanceof ArrayBuffer &&
            Number.isSafeInteger(entry.originalBytes) && entry.originalBytes >= 0 &&
            entry.originalBytes <= maxDecompressedBytes && entry.bytes.byteLength <= maxBytes;
    };
    function sweep(store: IDBObjectStore, protectedKey: string | null = null): void {
        const request = store.getAll();
        request.onsuccess = () => {
            let total = 0;
            const kept: StoredEntry[] = [];
            for (const candidate of request.result as unknown[]) {
                if (!validRecord(candidate)) {
                    if (isEntry(candidate)) store.delete(candidate.key);
                    continue;
                }
                total += candidate.bytes.byteLength;
                kept.push(candidate);
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
        async get(key: string, {signal}: {signal?: AbortSignal} = {}): Promise<Uint8Array | undefined> {
            if (!keyValid(key)) throw new TypeError('Invalid SHA-256 cache key');
            if (signal?.aborted) throw signal.reason;
            const db = await open();
            const record = await transaction<{bytes: ArrayBuffer; originalBytes: number} | undefined>(
                db, 'readwrite', (store, set) => {
                    const request = store.get(key);
                    request.onsuccess = () => {
                        const entry: unknown = request.result;
                        if (!validRecord(entry)) {
                            if (entry !== undefined) store.delete(key);
                            set(undefined);
                            return;
                        }
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
        async put(key: string, bytes: Uint8Array, {signal}: {signal?: AbortSignal} = {}): Promise<void> {
            if (!keyValid(key) || !(bytes instanceof Uint8Array)) throw new TypeError('Cache content requires a SHA-256 key and bytes');
            if (signal?.aborted) throw signal.reason;
            if (bytes.byteLength > maxDecompressedBytes) throw new RangeError('Cache input exceeds decompressed size limit');
            const originalBytes = bytes.byteLength;
            const compressed = await gzipBytes(bytes);
            if (signal?.aborted) throw signal.reason;
            const db = await open();
            return transaction<void>(db, 'readwrite', store => {
                if (compressed.byteLength <= maxBytes) {
                    const entry: CompressedEntry = {
                        key, format: 'gzip-v1', bytes: compressed.slice().buffer,
                        originalBytes, lastAccess: now()
                    };
                    store.put(entry);
                } else store.delete(key);
                sweep(store, compressed.byteLength <= maxBytes ? key : null);
            });
        },
        async clear(): Promise<void> {
            const db = await open();
            return transaction<void>(db, 'readwrite', store => { store.clear(); });
        },
        async getSize(): Promise<{entries: number; bytes: number}> {
            const db = await open();
            return transaction(db, 'readonly', (store, set) => {
                const request = store.getAll();
                request.onsuccess = () => set((request.result as unknown[]).reduce(
                    (size, record) => {
                        if (validRecord(record)) { size.entries++; size.bytes += record.bytes.byteLength; }
                        return size;
                    }, {entries: 0, bytes: 0}));
            });
        },
        async close(): Promise<void> {
            if (dbPromise) { const db = await dbPromise; db.close(); dbPromise = undefined; }
        }
    });
}
