/** Gzip utilities for persistent extension caches. The caller remains responsible for SHA-256 verification. */
export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected Uint8Array');
    if (typeof CompressionStream !== 'function') throw new Error('CompressionStream gzip unavailable');
    // BlobPart excludes shared-memory views; as in JavaScript, Blob itself decides what it accepts.
    return new Uint8Array(await new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream()
        .pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
export async function gunzipBytes(compressed: Uint8Array<ArrayBuffer>, maxOutputBytes: number): Promise<Uint8Array<ArrayBuffer>> {
    if (!(compressed instanceof Uint8Array) || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
        throw new TypeError('Invalid compressed bytes or output limit');
    }
    if (typeof DecompressionStream !== 'function') throw new Error('DecompressionStream gzip unavailable');
    const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxOutputBytes) throw new Error('Decompressed cache exceeds byte limit');
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
    } finally {
        reader.releaseLock();
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
}
