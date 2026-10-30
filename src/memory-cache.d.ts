export function createMemoryContentCache(options?: {maxBytes?: number; ttlMs?: number; now?: () => number}): Readonly<{
    get(key: string): Promise<Uint8Array | undefined>;
    put(key: string, bytes: Uint8Array): Promise<void>;
    clear(): void;
    getSize(): Readonly<{entries: number; bytes: number}>;
}>;
