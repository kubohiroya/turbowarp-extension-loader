/** Persistent browser cache for SHA-256-addressed extension bytes. Requires IndexedDB. */
export function createIndexedDBContentCache(options?: {
    indexedDB?: IDBFactory;
    databaseName?: string;
    maxBytes?: number;
    ttlMs?: number;
    now?: () => number;
}): Readonly<{
    get(key: string, options?: {signal?: AbortSignal}): Promise<Uint8Array | undefined>;
    put(key: string, bytes: Uint8Array, options?: {signal?: AbortSignal}): Promise<void>;
    clear(): Promise<void>;
    getSize(): Promise<{entries: number; bytes: number}>;
    close(): Promise<void>;
}>;
