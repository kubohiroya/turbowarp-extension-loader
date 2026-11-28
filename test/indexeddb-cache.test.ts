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

test('a function appURI is read at each write, so one cache follows the project that is open', async () => {
    let current: string | undefined = 'https://example.test/p/one.sb3';
    let reads = 0;
    const cache = realCache({appURI: () => { reads++; return current; }});
    await cache.put(digestOf('a'), bytesOf('one'));
    current = 'https://example.test/p/two.sb3';
    await cache.put(digestOf('b'), bytesOf('two'));
    // A function that cannot name the project files that write as shared.
    current = undefined;
    await cache.put(digestOf('c'), bytesOf('nobody'));
    assert.equal(reads, 3, 'read once per write');
    assert.deepEqual((await cache.listBucket('https://example.test/p/one.sb3')).map(row => row.key), [digestOf('a')]);
    assert.deepEqual((await cache.listBucket('https://example.test/p/two.sb3')).map(row => row.key), [digestOf('b')]);
    assert.deepEqual((await cache.listBucket('shared')).map(row => row.key), [digestOf('c')]);
    await cache.close();
});

test('a function appURI still leaves catalog digests shared', async () => {
    const cache = realCache({appURI: () => 'https://example.test/p/one.sb3', sharedDigests: new Set([digestOf('b')])});
    await cache.put(digestOf('b'), bytesOf('catalog'));
    assert.deepEqual((await cache.listBuckets()).map(row => row.bucket), ['shared']);
    await cache.close();
});

test('an appURI that is neither a string nor a function is rejected', async () => {
    assert.throws(() => createIndexedDBContentCache({indexedDB: stubIndexedDB(() => {}),
        appURI: 42 as unknown as string}), /Invalid/);
    const cache = realCache({appURI: () => 42});
    await assert.rejects(cache.put(digestOf('a'), bytesOf('one')), /appURI/);
    await cache.close();
});

const one = 'https://example.test/p/one.sb3';
const two = 'https://example.test/p/two.sb3';
/** Two caches over one database, as two projects opened one after the other would see it. */
function sharedDatabase() {
    const factory = new IDBFactory() as unknown as IDBFactory;
    const databaseName = `test-${database++}`;
    return (uri?: string) => createIndexedDBContentCache({indexedDB: factory, databaseName, ...(uri ? {appURI: uri} : {})});
}

test('one stored copy lists every project, name and address that refers to it', async () => {
    const open = sharedDatabase();
    const first = open(one);
    await first.put(digestOf('a'), bytesOf('a cat'), {label: {ref: 'costume:cat', kind: 'costume', name: 'cat.svg',
        url: 'https://assets.example.test/cat.svg', projectName: 'One'}});
    await first.close();
    const second = open(two);
    await second.put(digestOf('a'), bytesOf('a cat'), {label: {ref: 'backdrop:wall', kind: 'backdrop', name: 'wall',
        url: 'https://user:secret@assets.example.test/wall.svg?token=abc#x'}});
    const [entry, ...rest] = await second.listEntries();
    assert.equal(rest.length, 0, 'one copy, listed once');
    assert.equal(entry!.key, digestOf('a'));
    assert.equal(entry!.bytes, (await second.getSize()).bytes, 'its size counts the copy once');
    assert.deepEqual(entry!.claims.map(claim => claim.bucket).sort(), [one, two]);
    const labels = new Map(entry!.labels.map(label => [label.bucket, label]));
    assert.deepEqual({...labels.get(one), observedAt: 0}, {bucket: one, ref: 'costume:cat', kind: 'costume',
        name: 'cat.svg', projectName: 'One', url: 'https://assets.example.test/cat.svg', observedAt: 0});
    // A credential or a one-time token is never stored, and the address says it was cut.
    assert.equal(labels.get(two)!.url, 'https://assets.example.test/wall.svg');
    assert.equal(labels.get(two)!.urlRedacted, true);
    await second.close();
});

test('labels are recorded only where the project still claims the bytes', async () => {
    const cache = realCache({appURI: one});
    await cache.put(digestOf('a'), bytesOf('one'));
    assert.equal(await cache.describe(digestOf('a'), [{ref: 'sound:pop', kind: 'sound', name: 'pop'}]), 1);
    assert.equal(await cache.describe(digestOf('a'), {ref: 'sound:pop', name: 'pop 2'}), 1, 'the same ref is replaced');
    assert.equal(await cache.describe(digestOf('c'), {ref: 'sound:pop'}), 0, 'nothing is claimed, nothing recorded');
    assert.equal(await cache.describe(digestOf('a'), {ref: 'x'}, {bucket: two}), 0, 'another project does not claim it');
    const [entry] = await cache.listEntries();
    assert.deepEqual(entry!.labels.map(label => [label.ref, label.name, label.kind]), [['sound:pop', 'pop 2', undefined]]);
    await assert.rejects(cache.describe(digestOf('a'), {ref: 'x', kind: 'script' as never}), /kind/);
    await assert.rejects(cache.put(digestOf('c'), bytesOf('two'), {label: {} as never}), /ref/);
    assert.equal((await cache.getSize()).entries, 1, 'an invalid label stops the write before it starts');
    await cache.close();
});

test('an entry stored before labels existed is listed with none', async () => {
    const open = sharedDatabase();
    const before = open(one);
    await before.put(digestOf('a'), bytesOf('old'));
    await before.close();
    const after = open(one);
    const [entry] = await after.listEntries();
    assert.deepEqual(entry!.labels, []);
    assert.deepEqual(entry!.claims.map(claim => claim.bucket), [one]);
    await after.close();
});

test('claims across projects are released together, and bytes go with the last one', async () => {
    const open = sharedDatabase();
    const first = open(one);
    await first.put(digestOf('a'), bytesOf('both'), {label: {ref: 'a'}});
    await first.put(digestOf('c'), bytesOf('only one'), {label: {ref: 'c'}});
    await first.close();
    const second = open(two);
    await second.put(digestOf('a'), bytesOf('both'), {label: {ref: 'a'}});

    const partial = await second.releaseClaims([{bucket: one, key: digestOf('a')}, {bucket: one, key: digestOf('a')}]);
    assert.deepEqual(partial, {released: 1, freed: 0}, 'the other project still refers to the copy');
    const shared = (await second.listEntries()).find(entry => entry.key === digestOf('a'))!;
    assert.deepEqual(shared.labels.map(label => label.bucket), [two], 'the released claim takes its label');

    const rest = await second.releaseClaims([
        {bucket: two, key: digestOf('a')},
        {bucket: one, key: digestOf('c')},
        {bucket: one, key: digestOf('a')} // already gone: counted as nothing
    ]);
    assert.equal(rest.released, 2);
    assert.ok(rest.freed > 0);
    assert.deepEqual(await second.listEntries(), []);
    await assert.rejects(second.releaseClaims([{bucket: '', key: digestOf('a')}]), /bucket/);
    await second.close();
});

test('releasing a whole project takes its labels and leaves the content database at its version', async () => {
    const factory = new IDBFactory() as unknown as IDBFactory;
    const databaseName = `test-${database++}`;
    const cache = createIndexedDBContentCache({indexedDB: factory, databaseName, appURI: one});
    await cache.put(digestOf('a'), bytesOf('one'), {label: {ref: 'a', name: 'A'}});
    await cache.deleteBucket(one);
    await cache.put(digestOf('a'), bytesOf('one'));
    const [entry] = await cache.listEntries();
    assert.deepEqual(entry!.labels, [], 'a new claim does not bring back the old label');
    await cache.close();
    // A tab still running an older Loader opens the content database at the version it knows.
    const versions = new Map((await factory.databases()).map(info => [info.name, info.version]));
    assert.equal(versions.get(databaseName), 2);
    assert.equal(versions.get(`${databaseName}-labels`), 1);
});
