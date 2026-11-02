import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createExtensionLoader} from '@kubohiroya/turbowarp-extension-loader';
import {createHash} from 'node:crypto';

const bytes = new TextEncoder().encode('Scratch.extensions.register({});');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const manifest = (ids: string[]) => ({
    schemaVersion: 1,
    extensions: ids.map(id => ({
        id, execution: 'sandboxed' as const, sha256,
        source: {type: 'remote' as const, url: `https://example.test/${id}.js`}
    }))
});

function ports() {
    const store = new Map<string, Uint8Array>();
    const reads: string[] = [];
    const writes: string[] = [];
    const fetched: string[] = [];
    return {
        store, reads, writes, fetched,
        cache: {
            async get(key: string) {
                reads.push(key);
                return store.get(key) ?? null;
            },
            async put(key: string, value: Uint8Array) {
                writes.push(key);
                store.set(key, value);
            }
        },
        fetcher: {
            async fetch(url: string) {
                fetched.push(url);
                return {bytes, finalURL: url, redirects: []};
            }
        },
        trustProvider: {async authorize(code: {sha256: string}) {
            return {allowed: true as const, scope: 'digest' as const, sha256: code.sha256};
        }},
        registrar: {
            async begin() {
                return {
                    async register(code: {id: string}) { return {id: code.id}; },
                    async commit() {}, async rollback() {}
                };
            },
            async unload() {}
        }
    };
}

test('an extension left to itself is cached, as every caller got before this existed', async () => {
    const p = ports();
    const loader = createExtensionLoader(p);
    await loader.load(manifest(['a']));
    assert.deepEqual(p.reads, [sha256]);
    assert.deepEqual(p.writes, [sha256]);
    await loader.unload();
});

test('remote neither reads nor writes the cache: nothing is left in this browser', async () => {
    const p = ports();
    const loader = createExtensionLoader(p);
    await loader.load(manifest(['a']), {caching: new Map([['a', 'remote']])});
    assert.deepEqual(p.reads, []);
    assert.deepEqual(p.writes, []);
    assert.deepEqual(p.fetched, ['https://example.test/a.js']);
    await loader.unload();
});

test('the choice is made for each extension, not for the project', async () => {
    const p = ports();
    const loader = createExtensionLoader(p);
    await loader.load(manifest(['keep', 'pass']), {caching: new Map([['pass', 'remote']])});
    assert.deepEqual(p.reads, [sha256]);
    assert.deepEqual(p.writes, [sha256]);
    assert.deepEqual(p.fetched.length, 2);
    await loader.unload();
});

test('a remote extension is fetched again even when the cache already holds those bytes', async () => {
    const p = ports();
    const first = createExtensionLoader(p);
    await first.load(manifest(['a']));
    await first.unload();
    assert.equal(p.store.size, 1);

    const second = createExtensionLoader(p);
    p.fetched.length = 0;
    p.reads.length = 0;
    await second.load(manifest(['a']), {caching: new Map([['a', 'remote']])});
    // The bytes are in the browser, but this person asked not to use what is kept.
    assert.deepEqual(p.reads, []);
    assert.deepEqual(p.fetched, ['https://example.test/a.js']);
    await second.unload();
});
