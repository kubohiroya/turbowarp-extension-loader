/** Bounded host-session storage; the Loader re-verifies bytes on every cache hit. */
export function createMemoryContentCache({maxBytes = 8 * 1024 * 1024, ttlMs = 60 * 60 * 1000, now = Date.now} = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || typeof now !== 'function') {
        throw new TypeError('Invalid cache capacity or expiry');
    }
    const entries = new Map();
    let size = 0;
    const remove = key => {
        const entry = entries.get(key);
        if (entry) { size -= entry.bytes.byteLength; entries.delete(key); }
    };
    return Object.freeze({
        async get(key) {
            const entry = entries.get(key);
            if (!entry) return undefined;
            if (entry.expires <= now()) { remove(key); return undefined; }
            entries.delete(key); entries.set(key, entry);
            return new Uint8Array(entry.bytes);
        },
        async put(key, bytes) {
            if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key) || !(bytes instanceof Uint8Array)) {
                throw new TypeError('Cache content requires a SHA-256 key and bytes');
            }
            remove(key);
            if (bytes.byteLength > maxBytes) return;
            for (const [candidate, entry] of entries) if (entry.expires <= now()) remove(candidate);
            while (size + bytes.byteLength > maxBytes) remove(entries.keys().next().value);
            entries.set(key, {bytes: new Uint8Array(bytes), expires: now() + ttlMs});
            size += bytes.byteLength;
        },
        clear() { entries.clear(); size = 0; },
        getSize() { return Object.freeze({entries: entries.size, bytes: size}); }
    });
}
