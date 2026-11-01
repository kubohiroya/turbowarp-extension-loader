import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createIndexedDBContentCache} from '@kubohiroya/turbowarp-extension-loader/indexeddb-cache';

const key = 'a'.repeat(64);
test('IndexedDB cache rejects unavailable storage and invalid settings', () => {
    assert.throws(() => createIndexedDBContentCache({indexedDB: undefined}), /IndexedDB unavailable/);
    assert.throws(() => createIndexedDBContentCache({indexedDB: {open() {}}, maxBytes: 0}), /Invalid/);
});
test('IndexedDB cache uses content-addressed keys and validates bytes before opening', async () => {
    let opens = 0;
    const cache = createIndexedDBContentCache({indexedDB: {open() { opens++; throw Error('unexpected'); }}});
    await assert.rejects(cache.get('not-a-digest'), /SHA-256/);
    await assert.rejects(cache.put(key, 'not bytes'), /SHA-256/);
    assert.equal(opens, 0);
});
test('IndexedDB cache signals cancellation before opening a transaction', async () => {
    const cache = createIndexedDBContentCache({indexedDB: {open() { throw Error('unexpected'); }}});
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await assert.rejects(cache.get(key, {signal: controller.signal}), /cancelled/);
    await assert.rejects(cache.put(key, new Uint8Array([1]), {signal: controller.signal}), /cancelled/);
});

test('gzip cache codec round-trips JS and rejects excessive decompression', async () => {
    const {gzipBytes, gunzipBytes} = await import('../dist/cache-gzip.js');
    const input = new TextEncoder().encode('const value = 42;\\n'.repeat(400));
    const compressed = await gzipBytes(input);
    assert.ok(compressed.byteLength < input.byteLength);
    assert.deepEqual(await gunzipBytes(compressed, input.byteLength), input);
    await assert.rejects(gunzipBytes(compressed, input.byteLength - 1), /limit/);
    await assert.rejects(gunzipBytes(new Uint8Array([1, 2, 3]), input.byteLength), /./);
});
