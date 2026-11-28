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

/** What a reference to cached bytes is used as, as far as the host that observed it could tell. */
export type CacheEntryKind = 'costume' | 'backdrop' | 'sound' | 'document' | 'extension' | 'other';

/**
 * What one project calls one cached entry, as observed by a host that opened it.
 *
 * Everything here is the project's own claim, recorded for display. It is never evidence that two
 * entries hold the same content (the digest is) and never a reason to run, keep or delete
 * anything. The same digest can carry many labels: one per project and reference.
 */
export interface CacheLabel {
    /**
     * Which reference inside the project this is, in the owner's own terms (an extension ID, an
     * asset or document reference). One label is kept per bucket, digest and `ref`; recording the
     * same `ref` again replaces it. An empty string is a reference the host could not name.
     */
    readonly ref: string;
    /** Absent when the host could not tell. */
    readonly kind?: CacheEntryKind;
    /** A display or file name the owning package supplied. */
    readonly name?: string;
    /** The public address the bytes were fetched from. Credentials, query and fragment are not kept. */
    readonly url?: string;
    /** The project's own title, as it called itself when observed. */
    readonly projectName?: string;
}
export interface CacheEntryLabel extends CacheLabel {
    /** The bucket (project URI or SHARED_BUCKET) whose claim this label describes. */
    readonly bucket: string;
    readonly observedAt: number;
    /**
     * The recorded URL had credentials, a query or a fragment removed. It may not fetch the same
     * bytes any more, so it is not a shareable source.
     */
    readonly urlRedacted?: true;
}
/** One bucket's claim on one entry. */
export interface CacheClaim {readonly bucket: string; readonly lastAccess: number}
/**
 * One stored entry with every claim and label on it.
 *
 * `bytes` is the compressed size of the single stored copy, whichever number of projects claim
 * it, so the sum over entries is what the cache occupies; summing per claim would count a shared
 * copy more than once. An entry stored before labels were recorded has none.
 */
export interface CacheEntry {
    readonly key: string;
    readonly bytes: number;
    readonly originalBytes: number;
    readonly lastAccess: number;
    readonly claims: readonly CacheClaim[];
    readonly labels: readonly CacheEntryLabel[];
}
/** One claim to release: the bucket and the digest. */
export interface CacheClaimKey {readonly bucket: string; readonly key: string}

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
     *
     * A host that keeps one cache while projects are opened and closed passes a function instead:
     * it is read at the time of each write, like `sharedDigests`, so each write is filed under the
     * project open at that moment. A function that returns `undefined` files that write as shared.
     */
    appURI?: string | (() => string | undefined);
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
    /** `label` is recorded on the claim this write makes, as the host observed it. */
    put(key: string, bytes: Uint8Array, options?: {signal?: AbortSignal; label?: CacheLabel}): Promise<void>;
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
    /**
     * Release any set of claims, across buckets, in one transaction, with the same rule: bytes go
     * only with the last claim on them. A claim that is already gone counts as nothing released,
     * so a stale list can be passed safely and the result says what actually happened.
     */
    releaseClaims(claims: readonly CacheClaimKey[]): Promise<{released: number; freed: number}>;
    /**
     * Record what a project calls entries it claims. A label is kept only where the bucket still
     * claims the digest; the call resolves with how many were recorded. `bucket` defaults to the
     * one a write would be filed under now.
     */
    describe(key: string, labels: CacheLabel | readonly CacheLabel[], options?: {bucket?: string}): Promise<number>;
    /** Every stored entry with its claims and labels, ordered by digest. */
    listEntries(): Promise<CacheEntry[]>;
    close(): Promise<void>;
}>;

/** The shape put() writes. Stored records are still untrusted and checked by validRecord before use. */
interface CacheRecord {key: string; format: 'gzip-v1'; bytes: ArrayBuffer; originalBytes: number; lastAccess?: number}
/** One project's claim on one entry. The bytes live once, in `content`. */
interface UsageRecord {bucket: string; key: string; lastAccess: number}
/** A label, kept in its own database. */
interface LabelRecord {
    bucket: string; key: string; ref: string; observedAt: number;
    kind?: CacheEntryKind; name?: string; url?: string; projectName?: string; urlRedacted?: true;
}

const kinds: ReadonlySet<string> = new Set(['costume', 'backdrop', 'sound', 'document', 'extension', 'other']);
const maxLabelText = 1024;
const maxLabelsPerCall = 256;

/** Keep only a URL that can be shown without leaking a credential or a one-time token. */
function sanitizeURL(value: string): {url?: string; urlRedacted?: true} {
    let url: URL;
    try { url = new URL(value); } catch { return {}; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return {};
    const redacted = !!(url.username || url.password || url.search || url.hash);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return redacted ? {url: url.href, urlRedacted: true} : {url: url.href};
}

function labelRecord(bucket: string, key: string, label: CacheLabel, observedAt: number): LabelRecord {
    if (!label || typeof label !== 'object' || typeof label.ref !== 'string' || label.ref.length > maxLabelText) {
        throw new TypeError('A cache label needs a string ref');
    }
    const text = (field: 'name' | 'url' | 'projectName') => {
        const value = label[field];
        if (value === undefined) return undefined;
        if (typeof value !== 'string' || value.length > maxLabelText) throw new TypeError(`Invalid cache label ${field}`);
        return value;
    };
    if (label.kind !== undefined && !kinds.has(label.kind)) throw new TypeError('Invalid cache label kind');
    const name = text('name');
    const projectName = text('projectName');
    const url = text('url');
    return {
        bucket, key, ref: label.ref, observedAt,
        ...(label.kind === undefined ? {} : {kind: label.kind}),
        ...(name === undefined ? {} : {name}),
        ...(projectName === undefined ? {} : {projectName}),
        ...(url === undefined ? {} : sanitizeURL(url))
    };
}


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
        typeof now !== 'function' ||
        (appURI !== undefined && typeof appURI !== 'string' && typeof appURI !== 'function')) {
        throw new TypeError('Invalid IndexedDB cache options');
    }
    /** The project a write is filed under, read when it happens. */
    function currentAppURI(): string | undefined {
        const uri = typeof appURI === 'function' ? appURI() : appURI;
        if (uri !== undefined && typeof uri !== 'string') throw new TypeError('appURI must return a string or undefined');
        return uri;
    }

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
    // Labels live in their own database so the content database keeps its version: a tab still
    // running an older Loader opens it as before, and adding display data discards no bytes.
    let labelsPromise: Promise<IDBDatabase> | undefined;
    function openLabels(): Promise<IDBDatabase> {
        if (!labelsPromise) {
            labelsPromise = new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open(`${databaseName}-labels`, 1);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains('labels')) {
                        // `claim` finds every label of one bucket's claim on one digest, which is
                        // what a release has to take with it.
                        db.createObjectStore('labels', {keyPath: ['bucket', 'key', 'ref']})
                            .createIndex('claim', ['bucket', 'key']);
                    }
                };
                request.onsuccess = () => {
                    const db = request.result;
                    db.onversionchange = () => db.close();
                    resolve(db);
                };
                request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
                request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
            }).catch(error => { labelsPromise = undefined; throw error; });
        }
        return labelsPromise;
    }
    /**
     * Drop the labels of claims that were released. Best effort: a label whose claim is gone is
     * never listed, so a failure here leaves nothing visible behind.
     */
    async function forgetLabels(claims: readonly CacheClaimKey[]) {
        if (!claims.length) return;
        try {
            const db = await openLabels();
            await transaction(db, 'readwrite', store => {
                for (const {bucket, key} of claims) {
                    const request = store.index('claim').getAllKeys([bucket, key]);
                    request.onsuccess = () => { for (const label of request.result) store.delete(label); };
                }
            }, 'labels');
        } catch {}
    }
    /** The bucket a write is filed under now. */
    const bucketFor = (key: string) => {
        const uri = currentAppURI();
        return uri === undefined || sharedDigests?.has(key) ? SHARED_BUCKET : uri;
    };
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
    /**
     * Release claims that exist, then free the bytes no claim is left on. Every delete is issued
     * before any check of what remains, so releasing two claims on one digest frees it once.
     */
    function releaseExisting(store: IDBObjectStore, usage: IDBObjectStore, claims: readonly CacheClaimKey[],
        result: {released: number; freed: number}) {
        for (const {bucket, key} of claims) {
            usage.delete([bucket, key]);
            result.released++;
        }
        for (const key of new Set(claims.map(claim => claim.key))) {
            // One copy, referred to more than once. Another project did not ask to lose it, so
            // the bytes only follow the last claim on them.
            const others = usage.index('key').count(key);
            others.onsuccess = () => {
                if (others.result > 0) return;
                const record = store.get(key);
                record.onsuccess = () => {
                    const entry: CacheRecord | undefined = record.result;
                    if (!entry) return;
                    result.freed += entry.bytes?.byteLength || 0;
                    store.delete(key);
                };
            };
        }
    }
    async function release(bucket: string, keys: readonly string[] | null): Promise<{released: number; freed: number}> {
        if (typeof bucket !== 'string' || !bucket) throw new TypeError('A bucket name is required');
        if (keys !== null && (!Array.isArray(keys) || keys.some(key => !keyValid(key)))) {
            throw new TypeError('Cache keys must be SHA-256 digests');
        }
        const wanted = keys === null ? null : new Set(keys);
        const db = await open();
        const releasedClaims: CacheClaimKey[] = [];
        const outcome = await transaction<{released: number; freed: number}>(db, 'readwrite', (store, set, tx) => {
            const usage = tx.objectStore('usage');
            // The same object the transaction resolves with, filled in as the nested requests
            // below run: every one of them completes before the transaction does.
            const result = {released: 0, freed: 0};
            set(result);
            const mine = usage.index('bucket').getAll(bucket);
            mine.onsuccess = () => {
                const claims = (mine.result as UsageRecord[])
                    .filter(claim => wanted === null || wanted.has(claim.key))
                    .map(claim => ({bucket, key: claim.key}));
                releasedClaims.push(...claims);
                releaseExisting(store, usage, claims, result);
            };
        }, ['content', 'usage']);
        await forgetLabels(releasedClaims);
        return outcome;
    }
    async function releaseClaims(claims: readonly CacheClaimKey[]): Promise<{released: number; freed: number}> {
        if (!Array.isArray(claims) || claims.some(claim => !claim || typeof claim.bucket !== 'string' ||
            !claim.bucket || !keyValid(claim.key))) {
            throw new TypeError('Each claim needs a bucket and a SHA-256 digest');
        }
        const unique = [...new Map(claims.map(claim => [JSON.stringify([claim.bucket, claim.key]),
            {bucket: claim.bucket, key: claim.key}])).values()];
        const db = await open();
        const releasedClaims: CacheClaimKey[] = [];
        const outcome = await transaction<{released: number; freed: number}>(db, 'readwrite', (store, set, tx) => {
            const usage = tx.objectStore('usage');
            const result = {released: 0, freed: 0};
            set(result);
            if (!unique.length) return;
            let pending = unique.length;
            const existing: CacheClaimKey[] = [];
            for (const claim of unique) {
                const request = usage.getKey([claim.bucket, claim.key]);
                request.onsuccess = () => {
                    if (request.result !== undefined) existing.push(claim);
                    if (--pending) return;
                    releasedClaims.push(...existing);
                    releaseExisting(store, usage, existing, result);
                };
            }
        }, ['content', 'usage']);
        await forgetLabels(releasedClaims);
        return outcome;
    }
    /** Record labels where `bucket` still claims `key`. */
    async function describeIn(bucket: string, key: string, labels: readonly CacheLabel[]): Promise<number> {
        if (labels.length > maxLabelsPerCall) throw new RangeError('Too many cache labels in one call');
        const time = now();
        const records = labels.map(label => labelRecord(bucket, key, label, time));
        if (!records.length) return 0;
        const claimed = await transaction<boolean>(await open(), 'readonly', (store, set) => {
            const request = store.getKey([bucket, key]);
            request.onsuccess = () => set(request.result !== undefined);
        }, 'usage');
        if (!claimed) return 0;
        await transaction(await openLabels(), 'readwrite', store => {
            for (const record of records) store.put(record);
        }, 'labels');
        return records.length;
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
        async put(key: string, bytes: Uint8Array, {signal, label}: {signal?: AbortSignal; label?: CacheLabel} = {}) {
            if (!keyValid(key) || !validBytes(bytes)) throw new TypeError('Cache content requires a SHA-256 key and bytes');
            // Checked before anything is written, so an invalid label never leaves a half-done put.
            if (label !== undefined) labelRecord(SHARED_BUCKET, key, label, 0);
            if (signal?.aborted) throw signal.reason;
            if (bytes.byteLength > maxDecompressedBytes) throw new RangeError('Cache input exceeds decompressed size limit');
            // Read when put() is called, not after compressing: the project open now is the one
            // these bytes were fetched for, even if another is opened before the write lands.
            const uri = currentAppURI();
            const originalBytes = bytes.byteLength;
            const compressed = await gzipBytes(bytes);
            if (signal?.aborted) throw signal.reason;
            const db = await open();
            const bucket = uri === undefined || sharedDigests?.has(key) ? SHARED_BUCKET : uri;
            await transaction(db, 'readwrite', (store, _set, tx) => {
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
            if (label !== undefined) await describeIn(bucket, key, [label]);
        },
        async clear() {
            const db = await open();
            await transaction(db, 'readwrite', (store, _set, tx) => {
                store.clear();
                tx.objectStore('usage').clear();
            }, ['content', 'usage']);
            try {
                await transaction(await openLabels(), 'readwrite', store => store.clear(), 'labels');
            } catch {}
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
        releaseClaims,
        async describe(key: string, labels: CacheLabel | readonly CacheLabel[], {bucket}: {bucket?: string} = {}) {
            if (!keyValid(key)) throw new TypeError('Invalid SHA-256 cache key');
            if (bucket !== undefined && (typeof bucket !== 'string' || !bucket)) throw new TypeError('A bucket name is required');
            const list: readonly CacheLabel[] = Array.isArray(labels) ? labels : [labels as CacheLabel];
            return describeIn(bucket ?? bucketFor(key), key, list);
        },
        async listEntries() {
            const db = await open();
            const {records, claims} = await transaction<{records: CacheRecord[]; claims: UsageRecord[]}>(db, 'readonly',
                (store, set, tx) => {
                    const claims = tx.objectStore('usage').getAll();
                    const records = store.getAll();
                    claims.onsuccess = () => {
                        records.onsuccess = () => set({records: records.result as CacheRecord[],
                            claims: claims.result as UsageRecord[]});
                    };
                }, ['content', 'usage']);
            // Labels are display data. Failing to read them must not hide what the cache holds.
            let labels: LabelRecord[] = [];
            try {
                labels = await transaction<LabelRecord[]>(await openLabels(), 'readonly', (store, set) => {
                    const request = store.getAll();
                    request.onsuccess = () => set(request.result as LabelRecord[]);
                }, 'labels');
            } catch {}
            const claimsByKey = new Map<string, UsageRecord[]>();
            for (const claim of claims) claimsByKey.set(claim.key, [...claimsByKey.get(claim.key) || [], claim]);
            const claimed = new Set(claims.map(claim => JSON.stringify([claim.bucket, claim.key])));
            const labelsByKey = new Map<string, LabelRecord[]>();
            for (const label of labels) {
                // A label outlives its claim only until the next release clears it; never show one.
                if (!claimed.has(JSON.stringify([label.bucket, label.key]))) continue;
                labelsByKey.set(label.key, [...labelsByKey.get(label.key) || [], label]);
            }
            return records.filter(validRecord).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(record => {
                const mine = claimsByKey.get(record.key) || [];
                return Object.freeze({
                    key: record.key,
                    bytes: record.bytes.byteLength,
                    originalBytes: record.originalBytes,
                    lastAccess: Math.max(record.lastAccess || 0, ...mine.map(claim => claim.lastAccess)),
                    claims: Object.freeze(mine.map(claim => Object.freeze({bucket: claim.bucket, lastAccess: claim.lastAccess}))),
                    labels: Object.freeze((labelsByKey.get(record.key) || []).map(label => {
                        const {key: _key, ...rest} = label;
                        return Object.freeze(rest);
                    }))
                });
            });
        },
        async close() {
            if (dbPromise) { const db = await dbPromise; db.close(); dbPromise = undefined; }
            if (labelsPromise) {
                try { (await labelsPromise).close(); } catch {}
                labelsPromise = undefined;
            }
        }
    });
}
