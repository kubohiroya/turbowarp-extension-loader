/** Persistent browser cache for SHA-256-addressed extension bytes. Requires IndexedDB. */
export function createIndexedDBContentCache(options?: {
    indexedDB?: IDBFactory;
    databaseName?: string;
    /** Compressed bytes quota (default 32 MiB). */
    maxBytes?: number;
    /** Maximum decompressed JS size (default 8 MiB). */
    maxDecompressedBytes?: number;
    ttlMs?: number;
    now?: () => number;
}): Readonly<{
    get(key: string, options?: {signal?: AbortSignal}): Promise<Uint8Array | undefined>;
    put(key: string, bytes: Uint8Array, options?: {signal?: AbortSignal}): Promise<void>;
    clear(): Promise<void>;
    getSize(): Promise<{entries: number; bytes: number}>;
    close(): Promise<void>;
}>;
