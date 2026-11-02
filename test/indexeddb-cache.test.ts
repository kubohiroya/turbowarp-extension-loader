import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createIndexedDBContentCache} from '@kubohiroya/turbowarp-extension-loader/indexeddb-cache';

/** The adapter only ever calls open(); a stub stands in for the rest of IDBFactory. */
const stubIndexedDB = (open: () => unknown) => ({open}) as unknown as IDBFactory;
const key = 'a'.repeat(64);
test('IndexedDB cache rejects unavailable storage and invalid settings', () => {
    assert.throws(() => createIndexedDBContentCache({indexedDB: undefined}), /IndexedDB unavailable/);
    assert.throws(() => createIndexedDBContentCache({indexedDB: stubIndexedDB(() => {}), maxBytes: 0}), /Invalid/);
});
test('IndexedDB cache uses content-addressed keys and validates bytes before opening', async () => {
    let opens = 0;
    const cache = createIndexedDBContentCache({indexedDB: stubIndexedDB(() => { opens++; throw Error('unexpected'); })});
    await assert.rejects(cache.get('not-a-digest'), /SHA-256/);
    await assert.rejects(cache.put(key, 'not bytes' as unknown as Uint8Array), /SHA-256/);
    assert.equal(opens, 0);
});
test('IndexedDB cache signals cancellation before opening a transaction', async () => {
    const cache = createIndexedDBContentCache({indexedDB: stubIndexedDB(() => { throw Error('unexpected'); })});
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await assert.rejects(cache.get(key, {signal: controller.signal}), /cancelled/);
    await assert.rejects(cache.put(key, new Uint8Array([1]), {signal: controller.signal}), /cancelled/);
});

test('gzip cache codec round-trips JS and rejects excessive decompression', async () => {
    // Not a package export: the gzip codec is an internal module, so it is unit-tested from source.
    const {gzipBytes, gunzipBytes} = await import('../src/cache-gzip.ts');
    const input = new TextEncoder().encode('const value = 42;\\n'.repeat(400));
    const compressed = await gzipBytes(input);
    assert.ok(compressed.byteLength < input.byteLength);
    assert.deepEqual(await gunzipBytes(compressed, input.byteLength), input);
    await assert.rejects(gunzipBytes(compressed, input.byteLength - 1), /limit/);
    await assert.rejects(gunzipBytes(new Uint8Array([1, 2, 3]), input.byteLength), /./);
});

// A real IndexedDB, not a stub: what the bucket rules depend on is the order nested requests run
// in and when a transaction completes, and a fake written to match this module's assumptions
// would only confirm them.
const {IDBFactory} = await import('fake-indexeddb');
const digestOf = (seed: string) => seed.repeat(64).slice(0, 64);
const bytesOf = (text: string) => new TextEncoder().encode(text);
let database = 0;
const realCache = (options: Record<string, unknown> = {}) => createIndexedDBContentCache({
    indexedDB: new IDBFactory() as unknown as IDBFactory,
    databaseName: `test-${database++}`, ...options
});

test('bytes are filed under the project they were fetched for', async () => {
    const shared = new Set<string>();
    const cache = realCache({appURI: 'https://example.test/p/one.sb3', sharedDigests: shared});
    await cache.put(digestOf('a'), bytesOf('one'));
    shared.add(digestOf('b'));
    // The host says which digests belong to no one project, and it is read per write.
    await cache.put(digestOf('b'), bytesOf('catalog'));
    const buckets = new Map((await cache.listBuckets()).map(row => [row.bucket, row]));
    assert.deepEqual([...buckets.keys()].sort(), ['https://example.test/p/one.sb3', 'shared']);
    assert.equal(buckets.get('https://example.test/p/one.sb3')!.entries, 1);
    assert.equal(buckets.get('shared')!.entries, 1);
    assert.ok(buckets.get('shared')!.bytes > 0);
    assert.deepEqual((await cache.listBucket('shared')).map(row => row.key), [digestOf('b')]);
    await cache.close();
});

test('a host that cannot name the project files everything as shared', async () => {
    const cache = realCache();
    await cache.put(digestOf('a'), bytesOf('one'));
    assert.deepEqual((await cache.listBuckets()).map(row => row.bucket), ['shared']);
    await cache.close();
});

test('releasing one project leaves bytes another project still refers to', async () => {
    const factory = new IDBFactory() as unknown as IDBFactory;
    const name = `test-${database++}`;
    const shared = digestOf('a');
    const only = digestOf('c');
    const forProject = (uri: string) => createIndexedDBContentCache({indexedDB: factory, databaseName: name, appURI: uri});
    const one = forProject('https://example.test/p/one.sb3');
    await one.put(shared, bytesOf('both use this'));
    await one.put(only, bytesOf('only one uses this'));
    await one.close();
    const two = forProject('https://example.test/p/two.sb3');
    await two.put(shared, bytesOf('both use this'));
    await two.close();

    const manage = forProject('https://example.test/p/one.sb3');
    const released = await manage.deleteBucket('https://example.test/p/one.sb3');
    assert.equal(released.released, 2, 'both of its claims go');
    assert.ok(released.freed > 0, 'the bytes nothing else refers to are reclaimed');
    // One copy, referred to twice. The other project did not ask to lose it.
    assert.ok(await manage.get(shared), 'the shared bytes stay');
    assert.equal(await manage.get(only), undefined, 'the unshared bytes are gone');
    assert.deepEqual((await manage.listBuckets()).map(row => row.bucket), ['https://example.test/p/two.sb3']);
    await manage.close();
});

test('named digests can be released from one project without touching the rest', async () => {
    const uri = 'https://example.test/p/one.sb3';
    const cache = realCache({appURI: uri});
    await cache.put(digestOf('a'), bytesOf('first'));
    await cache.put(digestOf('c'), bytesOf('second'));
    const released = await cache.deleteFromBucket(uri, [digestOf('a')]);
    assert.equal(released.released, 1);
    assert.equal(await cache.get(digestOf('a')), undefined);
    assert.ok(await cache.get(digestOf('c')));
    await assert.rejects(cache.deleteFromBucket(uri, ['not-a-digest']), /SHA-256/);
    await assert.rejects(cache.deleteBucket(''), /bucket name/);
    await cache.close();
});

test('an eviction takes the claims on it, so a project never lists bytes that are gone', async () => {
    const uri = 'https://example.test/p/one.sb3';
    // Small enough that the second write evicts the first.
    const cache = realCache({appURI: uri, maxBytes: 200});
    await cache.put(digestOf('a'), bytesOf('x'.repeat(400)));
    await cache.put(digestOf('c'), bytesOf('y'.repeat(400)));
    const rows = await cache.listBucket(uri);
    const size = await cache.getSize();
    assert.equal(rows.length, size.entries, 'the claims and the entries agree');
    for (const row of rows) assert.ok(await cache.get(row.key), `${row.key} is still there`);
    await cache.close();
});

test('clearing takes the claims with the bytes', async () => {
    const cache = realCache({appURI: 'https://example.test/p/one.sb3'});
    await cache.put(digestOf('a'), bytesOf('one'));
    await cache.clear();
    assert.deepEqual(await cache.listBuckets(), []);
    assert.deepEqual((await cache.getSize()).entries, 0);
    await cache.close();
});
