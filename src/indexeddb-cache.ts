import {gzipBytes, gunzipBytes} from './cache-gzip.js';
import {DEFAULT_ENTRY_BYTES} from './limits.js';

/** Which projects an entry is kept for, so one project's share can be listed and released. */
export interface CacheUsage {
    /** The project URI an entry is filed under, or SHARED_BUCKET. */
    readonly bucket: string;
    readonly key: string;
    readonly bytes: number;
    readonly originalBytes: number;
    readonly lastAccess: number;
}
export interface CacheBucket {readonly bucket: string; readonly entries: number; readonly bytes: number}

/**
 * The bucket for bytes that belong to no one project.
 *
 * A catalog extension is pinned to a version and shared by many projects, so filing it under
 * whichever project happened to fetch it first would make that project look responsible for
 * storage every other one reuses, and releasing that project would evict bytes the rest still
 * want. It is not a URI, so no project can name it.
 */
export const SHARED_BUCKET = 'shared';

export interface IndexedDBContentCacheOptions {
    indexedDB?: IDBFactory;
    databaseName?: string;
    /**
     * The URI of the project being opened, which entries fetched for it are filed under.
     *
     * Without one, everything is filed as shared: a host that cannot say which project it is
     * opening cannot have per-project accounting, and guessing a name would be worse than
     * admitting there is none.
     */
    appURI?: string;
    /**
     * Digests that belong to no one project, read at the time of each write.
     *
     * The host knows which extensions came from the catalog; this module cannot. Passing a set
     * the host keeps updating is enough, since it is consulted per write.
     */
    sharedDigests?: ReadonlySet<string>;
    /** Compressed bytes quota (default 32 MiB). */
    maxBytes?: number;
    /** Maximum decompressed JS size (default 16 MiB, the largest default extension). */
    maxDecompressedBytes?: number;
    now?: () => number;
}
/** Persistent browser cache for SHA-256-addressed extension bytes. Requires IndexedDB. */
export type IndexedDBContentCache = Readonly<{
    get(key: string, options?: {signal?: AbortSignal}): Promise<Uint8Array | undefined>;
    put(key: string, bytes: Uint8Array, options?: {signal?: AbortSignal}): Promise<void>;
    clear(): Promise<void>;
    getSize(): Promise<{entries: number; bytes: number}>;
    /** Every bucket that holds something, with what it accounts for. */
    listBuckets(): Promise<CacheBucket[]>;
    /** What one bucket holds. SHARED_BUCKET lists what belongs to no one project. */
    listBucket(bucket: string): Promise<CacheUsage[]>;
    /**
     * Release one bucket, and with it any bytes nothing else still refers to.
     *
     * Bytes shared with another bucket stay: they are one copy, referred to twice, and the other
     * project did not ask to lose them.
     * @returns {Promise<{released: number; freed: number}>} Entries dropped and bytes reclaimed.
     */
    deleteBucket(bucket: string): Promise<{released: number; freed: number}>;
    /** Release named digests from one bucket, with the same rule. */
    deleteFromBucket(bucket: string, keys: readonly string[]): Promise<{released: number; freed: number}>;
    close(): Promise<void>;
}>;

/** The shape put() writes. Stored records are still untrusted and checked by validRecord before use. */
interface CacheRecord {key: string; format: 'gzip-v1'; bytes: ArrayBuffer; originalBytes: number; lastAccess?: number}
/** One project's claim on one entry. The bytes live once, in `content`. */
interface UsageRecord {bucket: string; key: string; lastAccess: number}

/** Persistent, content-addressed cache. The Loader independently verifies SHA-256 on every hit.
 * Storage is untrusted: this adapter is not an authorization or integrity boundary.
 */
export function createIndexedDBContentCache({
    indexedDB = globalThis.indexedDB,
    databaseName = 'turbowarp-plus-extension-cache',
    appURI,
    sharedDigests,
    maxBytes = 32 * 1024 * 1024,
    maxDecompressedBytes = DEFAULT_ENTRY_BYTES,
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
                const request = indexedDB.open(databaseName, 2);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains('content')) db.createObjectStore('content', {keyPath: 'key'});
                    if (!db.objectStoreNames.contains('usage')) {
                        const usage = db.createObjectStore('usage', {keyPath: ['bucket', 'key']});
                        // Finding every claim on one digest is what decides whether releasing a
                        // project may take its bytes with it.
                        usage.createIndex('key', 'key');
                        usage.createIndex('bucket', 'bucket');
                        // Entries written before there were buckets have no owner, and inventing
                        // one would make a project answer for storage it never asked for. This is
                        // a cache: dropping it costs a fetch, which is cheaper than a wrong name.
                        request.transaction!.objectStore('content').clear();
                    }
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
        work: (store: IDBObjectStore, set: (result: T) => void, tx: IDBTransaction) => void,
        stores: string | string[] = 'content'): Promise<T> {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(stores, mode);
            let value: T;
            tx.oncomplete = () => resolve(value);
            tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
            try { work(tx.objectStore(typeof stores === 'string' ? stores : stores[0]!), result => { value = result; }, tx); }
            catch (error) { try { tx.abort(); } catch {} reject(error); }
        });
    }
    const keyValid = (key: unknown) => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
    const validBytes = (value: unknown) => value instanceof Uint8Array;
    const validRecord = (entry: CacheRecord | undefined) => !!entry && entry.format === 'gzip-v1' &&
        entry.bytes instanceof ArrayBuffer && Number.isSafeInteger(entry.originalBytes) &&
        entry.originalBytes >= 0 && entry.originalBytes <= maxDecompressedBytes &&
        entry.bytes.byteLength <= maxBytes;
    const dropClaims = (usage: IDBObjectStore, key: string) => {
        const claims = usage.index('key').getAllKeys(key);
        claims.onsuccess = () => {
            for (const claim of claims.result) usage.delete(claim);
        };
    };
    function sweep(store: IDBObjectStore, usage: IDBObjectStore, protectedKey: string | null = null) {
        const request = store.getAll();
        request.onsuccess = () => {
            let total = 0;
            const kept: CacheRecord[] = [];
            for (const record of request.result as CacheRecord[]) {
                if (!validRecord(record)) { store.delete(record.key); dropClaims(usage, record.key); continue; }
                total += record.bytes.byteLength;
                kept.push(record);
            }
            kept.sort((a, b) => (a.lastAccess || 0) - (b.lastAccess || 0));
            for (const record of kept) {
                if (total <= maxBytes) break;
                if (record.key === protectedKey) continue;
                store.delete(record.key);
                dropClaims(usage, record.key);
                total -= record.bytes.byteLength;
            }
        };
    }
    async function release(bucket: string, keys: readonly string[] | null): Promise<{released: number; freed: number}> {
        if (typeof bucket !== 'string' || !bucket) throw new TypeError('A bucket name is required');
        if (keys !== null && (!Array.isArray(keys) || keys.some(key => !keyValid(key)))) {
            throw new TypeError('Cache keys must be SHA-256 digests');
        }
        const wanted = keys === null ? null : new Set(keys);
        const db = await open();
        return transaction<{released: number; freed: number}>(db, 'readwrite', (store, set, tx) => {
            const usage = tx.objectStore('usage');
            // The same object the transaction resolves with, filled in as the nested requests
            // below run: every one of them completes before the transaction does.
            const result = {released: 0, freed: 0};
            set(result);
            const mine = usage.index('bucket').getAll(bucket);
            mine.onsuccess = () => {
                for (const claim of mine.result as UsageRecord[]) {
                    if (wanted !== null && !wanted.has(claim.key)) continue;
                    usage.delete([bucket, claim.key]);
                    result.released++;
                    // One copy, referred to more than once. Another project did not ask to lose
                    // it, so the bytes only follow the last claim on them.
                    const others = usage.index('key').getAll(claim.key);
                    others.onsuccess = () => {
                        if ((others.result as UsageRecord[]).some(other => other.bucket !== bucket)) return;
                        const record = store.get(claim.key);
                        record.onsuccess = () => {
                            const entry: CacheRecord | undefined = record.result;
                            if (!entry) return;
                            result.freed += entry.bytes?.byteLength || 0;
                            store.delete(claim.key);
                        };
                    };
                }
            };
        }, ['content', 'usage']);
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
            const bucket = appURI === undefined || sharedDigests?.has(key) ? SHARED_BUCKET : appURI;
            return transaction(db, 'readwrite', (store, _set, tx) => {
                const usage = tx.objectStore('usage');
                const time = now();
                if (compressed.byteLength <= maxBytes) {
                    store.put({key, format: 'gzip-v1', bytes: compressed.buffer, originalBytes,
                        lastAccess: time} satisfies CacheRecord);
                    usage.put({bucket, key, lastAccess: time} satisfies UsageRecord);
                } else {
                    store.delete(key);
                    usage.delete([bucket, key]);
                }
                sweep(store, usage, compressed.byteLength <= maxBytes ? key : null);
            }, ['content', 'usage']);
        },
        async clear() {
            const db = await open();
            return transaction(db, 'readwrite', (store, _set, tx) => {
                store.clear();
                tx.objectStore('usage').clear();
            }, ['content', 'usage']);
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
        async listBuckets() {
            const db = await open();
            return transaction<CacheBucket[]>(db, 'readonly', (store, set, tx) => {
                const claims = tx.objectStore('usage').getAll();
                const records = store.getAll();
                claims.onsuccess = () => {
                    records.onsuccess = () => {
                        const sizes = new Map((records.result as CacheRecord[])
                            .map(record => [record.key, record.bytes?.byteLength || 0]));
                        const totals = new Map<string, {entries: number; bytes: number}>();
                        for (const claim of claims.result as UsageRecord[]) {
                            const total = totals.get(claim.bucket) || {entries: 0, bytes: 0};
                            total.entries++;
                            total.bytes += sizes.get(claim.key) || 0;
                            totals.set(claim.bucket, total);
                        }
                        set([...totals].map(([bucket, total]) => Object.freeze({bucket, ...total})));
                    };
                };
            }, ['content', 'usage']);
        },
        async listBucket(bucket: string) {
            if (typeof bucket !== 'string' || !bucket) throw new TypeError('A bucket name is required');
            const db = await open();
            return transaction<CacheUsage[]>(db, 'readonly', (store, set, tx) => {
                const claims = tx.objectStore('usage').index('bucket').getAll(bucket);
                const records = store.getAll();
                claims.onsuccess = () => {
                    records.onsuccess = () => {
                        const byKey = new Map((records.result as CacheRecord[]).map(record => [record.key, record]));
                        set((claims.result as UsageRecord[]).flatMap(claim => {
                            const record = byKey.get(claim.key);
                            if (!record) return [];
                            return [Object.freeze({bucket, key: claim.key, bytes: record.bytes?.byteLength || 0,
                                originalBytes: record.originalBytes, lastAccess: claim.lastAccess})];
                        }));
                    };
                };
            }, ['content', 'usage']);
        },
        deleteBucket(bucket: string) {
            return release(bucket, null);
        },
        deleteFromBucket(bucket: string, keys: readonly string[]) {
            return release(bucket, keys);
        },
        async close() {
            if (dbPromise) { const db = await dbPromise; db.close(); dbPromise = undefined; }
        }
    });
}
