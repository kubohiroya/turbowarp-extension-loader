import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createExtensionLoader, validateManifest, LoaderError,
    type DiagnosticEvent, type LoaderPorts} from '@kubohiroya/turbowarp-extension-loader';

const fixture = new Uint8Array(await readFile(new URL('./fixtures/extension.js', import.meta.url)));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const codeIs = (code: string) => (error: unknown) => error instanceof LoaderError && error.code === code;

const url = 'https://example.test/fixture.js';
const path = 'extensions/fixture.js';
const embeddedWithURL = () => retained();
const embedded = () => retained({type: 'embedded', path});
const retained = (source: Record<string, unknown> = {type: 'embedded', url, path}) =>
    ({schemaVersion: 1, extensions: [{id: 'fixture', source, execution: 'unsandboxed', sha256: hash(fixture)}]});

type Call = unknown[];
function host(overrides: Record<string, unknown> = {}) {
    const calls: Call[] = [];
    const events: DiagnosticEvent[] = [];
    const base: LoaderPorts = {
        embeddedReader: {async read(requested) { calls.push(['read', requested]); return fixture; }},
        fetcher: {async fetch(requested) { calls.push(['fetch', requested]); return {bytes: fixture, finalURL: requested, redirects: []}; }},
        trustProvider: {async authorize(code) { return {allowed: true, scope: 'digest', sha256: code.sha256}; }},
        registrar: {
            async begin() {
                return {
                    async register(code) { return {id: code.id}; },
                    async commit() {},
                    async rollback() {}
                };
            },
            async unload() {}
        },
        diagnostics(event) { events.push(event); }
    };
    const ports = {...base, ...overrides} as unknown as LoaderPorts;
    return {loader: createExtensionLoader(ports), calls, events};
}

test('the spelling an older version used is refused by name, not translated', () => {
    const legacy = () => retained({type: 'cached', url, path});
    assert.throws(() => validateManifest(legacy()), codeIs('INVALID_SOURCE'));
    // A reader has to be able to act on it, so the message says what it is now.
    assert.throws(() => validateManifest(legacy()), /embedded source with a url/);
});

test('an embedded source may record where its bytes came from, or not', () => {
    const withURL = validateManifest(embeddedWithURL());
    assert.deepEqual(withURL.extensions[0]!.source, {type: 'embedded', url, path});
    const withoutURL = validateManifest(embedded());
    assert.deepEqual(withoutURL.extensions[0]!.source, {type: 'embedded', path});
});

test('an embedded source resolves from the retained copy without reaching the network', async () => {
    const {loader, calls} = host();
    assert.deepEqual((await loader.load(retained())).ids, ['fixture']);
    assert.deepEqual(calls, [['read', path]], 'the retained copy alone satisfies the load');
});

test('a missing retained copy falls back to the canonical URL and says so', async () => {
    const {loader, calls, events} = host({
        embeddedReader: {async read() { throw new Error('no such entry'); }}
    });
    assert.deepEqual((await loader.load(retained())).ids, ['fixture']);
    assert.deepEqual(calls, [['fetch', url]]);
    assert.ok(
        events.some(event => event.type === 'retained-copy-unavailable' && event.id === 'fixture'),
        'the fallback is reported rather than silent'
    );
});

test('a retained copy that is not the pinned code fails instead of being substituted', async () => {
    const {loader} = host({
        embeddedReader: {async read() { return new TextEncoder().encode('// different code\n'); }}
    });
    await assert.rejects(loader.load(retained()), codeIs('DIGEST_MISMATCH'));
});

test('a recorded URL follows the same policy as a remote one', async () => {
    assert.throws(() => validateManifest(retained({type: 'embedded', url: 'http://example.test/x.js', path})), codeIs('INVALID_SOURCE'));
    assert.throws(() => validateManifest(retained({type: 'embedded', url: `${url}#fragment`, path})), codeIs('INVALID_SOURCE'));
    const {loader} = host({
        embeddedReader: {async read() { throw new Error('no such entry'); }},
        fetcher: {async fetch(requested: string) { return {bytes: fixture, finalURL: `${requested}?redirected`, redirects: []}; }}
    });
    await assert.rejects(loader.load(retained()), codeIs('REDIRECT_DENIED'));
});

test('an embedded source follows the same path and field policies it always did', () => {
    for (const unsafe of ['../outside.js', 'extensions/../../x.js', 'elsewhere/fixture.js', 'extensions/fixture.txt']) {
        assert.throws(() => validateManifest(retained({type: 'embedded', url, path: unsafe})), codeIs('INVALID_SOURCE'));
    }
    // A missing field is reported by the shared field validator, as it is for the other forms.
    assert.throws(() => validateManifest(retained({type: 'embedded', url})), codeIs('INVALID_MANIFEST'));
    assert.throws(() => validateManifest(retained({type: 'embedded', url, path, extra: 1})), codeIs('INVALID_MANIFEST'));
});

test('a verified cache entry still wins over the retained copy and the URL', async () => {
    const store = new Map([[hash(fixture), fixture]]);
    const {loader, calls} = host({
        cache: {
            async get(key: string) { return store.get(key); },
            async put() {}
        }
    });
    assert.deepEqual((await loader.load(retained())).ids, ['fixture']);
    assert.deepEqual(calls, [], 'neither the archive nor the network is read');
});
