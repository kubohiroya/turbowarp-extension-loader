/** Persistent, content-addressed cache. The Loader independently verifies SHA-256 on every hit.
 * Storage is untrusted: this adapter is not an authorization or integrity boundary.
 */
export function createIndexedDBContentCache({
    indexedDB = globalThis.indexedDB,
    databaseName = 'turbowarp-plus-extension-cache',
    maxBytes = 32 * 1024 * 1024,
    ttlMs = 30 * 24 * 60 * 60 * 1000,
    now = Date.now
} = {}) {
    if (!indexedDB || typeof indexedDB.open !== 'function') throw new Error('IndexedDB unavailable');
    if (typeof databaseName !== 'string' || !databaseName || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 1 || typeof now !== 'function') throw new TypeError('Invalid IndexedDB cache options');

    let dbPromise;
    function open() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
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
    function transaction(db, mode, work) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('content', mode);
            let value;
            tx.oncomplete = () => resolve(value);
            tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
            try { work(tx.objectStore('content'), result => { value = result; }, tx); }
            catch (error) { try { tx.abort(); } catch {} reject(error); }
        });
    }
    const keyValid = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
    const validBytes = value => value instanceof Uint8Array;
    const requestPromise = request => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
    async function sweep(store, time, protectedKey = null) {
        const records = await requestPromise(store.getAll());
        let total = 0;
        const kept = [];
        for (const record of records) {
            if (!record || !keyValid(record.key) || !(record.bytes instanceof ArrayBuffer) ||
                !Number.isFinite(record.expires) || record.expires <= time ||
                record.bytes.byteLength > maxBytes) {
                if (record?.key !== undefined) store.delete(record.key);
                continue;
            }
            total += record.bytes.byteLength;
            kept.push(record);
        }
        kept.sort((a, b) => a.lastAccess - b.lastAccess);
        for (const entry of kept) {
            if (total <= maxBytes) break;
            if (entry.key === protectedKey) continue;
            store.delete(entry.key);
            total -= entry.bytes.byteLength;
        }
        return {entries: kept.length, bytes: total};
    }
    return Object.freeze({
        async get(key, {signal} = {}) {
            if (!keyValid(key)) throw new TypeError('Invalid SHA-256 cache key');
            if (signal?.aborted) throw signal.reason;
            const db = await open();
            return transaction(db, 'readwrite', (store, set) => {
                const request = store.get(key);
                request.onsuccess = () => {
                    const entry = request.result;
                    if (!entry) { set(undefined); return; }
                    if (!(entry.bytes instanceof ArrayBuffer) || entry.expires <= now()) {
                        store.delete(key);
                        set(undefined);
                        return;
                    }
                    entry.lastAccess = now();
                    store.put(entry);
                    set(new Uint8Array(entry.bytes.slice(0)));
                };
            });
        },
        async put(key, bytes, {signal} = {}) {
            if (!keyValid(key) || !validBytes(bytes)) throw new TypeError('Cache content requires a SHA-256 key and bytes');
            if (signal?.aborted) throw signal.reason;
            const db = await open();
            // One readwrite transaction serializes concurrent writers and LRU eviction.
            return transaction(db, 'readwrite', (store, set) => {
                const time = now();
                if (bytes.byteLength <= maxBytes) {
                    const copy = bytes.slice().buffer;
                    store.put({key, bytes: copy, expires: time + ttlMs, lastAccess: time});
                } else store.delete(key);
                sweep(store, time, bytes.byteLength <= maxBytes ? key : null)
                    .then(set).catch(error => { try { store.transaction.abort(); } catch {} });
            });
        },
        async clear() {
            const db = await open();
            return transaction(db, 'readwrite', store => { store.clear(); });
        },
        async getSize() {
            const db = await open();
            return transaction(db, 'readonly', (store, set) => {
                const request = store.getAll();
                request.onsuccess = () => set(request.result.reduce((size, record) => ({
                    entries: size.entries + 1, bytes: size.bytes + (record.bytes?.byteLength || 0)
                }), {entries: 0, bytes: 0}));
            });
        },
        async close() {
            if (dbPromise) { const db = await dbPromise; db.close(); dbPromise = undefined; }
        }
    });
}
