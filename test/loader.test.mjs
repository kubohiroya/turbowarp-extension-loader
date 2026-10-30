import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createExtensionLoader, createFetchPort, validateManifest, discoverManifest, LoaderError} from '../src/index.js';

const fixture = new Uint8Array(await readFile(new URL('./fixtures/extension.js', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const spec = (id = 'fixture', source = {type: 'embedded', path: 'extensions/fixture.js'}) => ({id, source, execution: 'unsandboxed', sha256: hash(fixture)});
const manifest = (...extensions) => ({schemaVersion: 1, extensions: extensions.length ? extensions : [spec()]});
const codeIs = code => error => error instanceof LoaderError && error.code === code;

function host(overrides = {}, options) {
    const calls = [];
    const ports = {
        embeddedReader: {async read(path) { calls.push(['read', path]); return fixture; }},
        fetcher: {async fetch(url) { calls.push(['fetch', url]); return {bytes: fixture, finalURL: url, redirects: []}; }},
        trustProvider: {async authorize(code) { calls.push(['authorize', code.id]); return {allowed: true, scope: 'digest', sha256: code.sha256}; }},
        registrar: {
            async begin() {
                calls.push(['begin']);
                return {
                    async register(code) { calls.push(['register', code.id, code.code]); return {id: code.id}; },
                    async commit() { calls.push(['commit']); },
                    async rollback() { calls.push(['rollback']); }
                };
            },
            async unload(ids) { calls.push(['unload', ids]); }
        },
        diagnostics(event) { calls.push(['diagnostic', event]); },
        ...overrides
    };
    return {loader: createExtensionLoader(ports, options), calls, ports};
}

test('missing manifest does not touch host ports or legacy extension URLs', async () => {
    const {loader, calls} = host();
    assert.equal(discoverManifest({extensions: ['pen'], extensionURLs: {custom: 'data:text/javascript,alert(1)'}}), null);
    assert.deepEqual(await loader.loadProject({}), {ids: [], manifest: null});
    assert.deepEqual(calls, []);
});

test('embedded and remote exact bytes both require explicit host digest approval', async () => {
    for (const source of [{type: 'embedded', path: 'extensions/fixture.js'}, {type: 'remote', url: 'https://example.org/fixture.js'}]) {
        const {loader, calls} = host();
        assert.deepEqual((await loader.load(manifest(spec('fixture', source)))).ids, ['fixture']);
        const register = calls.find(call => call[0] === 'register');
        assert.equal(register[2], new TextDecoder().decode(fixture));
        assert.ok(calls.findIndex(call => call[0] === 'authorize') < calls.findIndex(call => call[0] === 'begin'));
        assert.equal(loader.getState().status, 'loaded');
        await assert.rejects(loader.load(manifest()), codeIs('BUSY'));
        await assert.rejects(loader.loadProject({}), codeIs('BUSY'));
        await loader.unload();
        assert.equal(loader.getState().status, 'idle');
    }
});

test('all extensions are verified and authorized before any registration, in dependency order', async () => {
    const a = spec('a'); a.dependencies = ['b'];
    const {loader, calls} = host();
    await loader.load(manifest(a, spec('b')));
    assert.deepEqual(calls.filter(call => call[0] === 'authorize').map(call => call[1]), ['b', 'a']);
    assert.ok(calls.findLastIndex(call => call[0] === 'authorize') < calls.findIndex(call => call[0] === 'begin'));
    await loader.unload();
    assert.deepEqual(calls.find(call => call[0] === 'unload')[1], ['a', 'b']);
});

test('execution mode remains exact across Embedded and Remote validation, approval and registration', async () => {
    for (const execution of ['sandboxed', 'unsandboxed']) {
        for (const source of [{type: 'embedded', path: 'extensions/fixture.js'},
            {type: 'remote', url: 'https://example.org/fixture.js'}]) {
            let reviewed = 0;
            let registered = 0;
            const {loader} = host({trustProvider: {async authorize(code) {
                assert.equal(code.execution, execution);
                assert.deepEqual(code.source, source);
                reviewed++;
                return {allowed: true, scope: 'digest', sha256: code.sha256};
            }}, registrar: {async begin() { return {
                async register(code) {
                    assert.equal(code.execution, execution);
                    assert.equal(reviewed, 1);
                    registered++;
                    return {id: code.id};
                }, async commit() {}, async rollback() {}
            }; }, async unload() {}}});
            await loader.load(manifest({...spec('fixture', source), execution}));
            assert.equal(registered, 1);
            await loader.unload();
        }
    }
});

test('manifest is copied and deeply frozen before asynchronous host calls', async () => {
    const input = manifest();
    const {loader} = host({trustProvider: {async authorize(code) {
        assert.ok(Object.isFrozen(code));
        assert.ok(Object.isFrozen(code.source));
        assert.throws(() => { code.source.path = 'evil'; }, TypeError);
        input.extensions[0].id = 'evil';
        return {allowed: true, scope: 'digest', sha256: code.sha256};
    }}});
    assert.deepEqual((await loader.load(input)).ids, ['fixture']);
});

test('malformed manifests cannot claim trust, alternate source, fallback or execution', () => {
    const cases = [
        [{...manifest(), schemaVersion: 2}, 'UNSUPPORTED_SCHEMA'],
        [{...manifest(), trusted: true}, 'INVALID_MANIFEST'],
        [manifest({...spec(), source: {type: 'embedded', path: 'extensions/../fixture.js'}}), 'INVALID_SOURCE'],
        [manifest({...spec(), source: {type: 'embedded', path: 'extensions//fixture.js'}}), 'INVALID_SOURCE'],
        [manifest({...spec(), source: {type: 'embedded', path: 'extensions/%2e%2e/fixture.js'}}), 'INVALID_SOURCE'],
        [manifest({...spec(), source: {type: 'remote', url: 'http://example.org/a.js'}}), 'INVALID_SOURCE'],
        [manifest({...spec(), source: {type: 'remote', url: 'data:text/javascript,alert(1)'}}), 'INVALID_SOURCE'],
        [manifest({...spec(), source: {type: 'remote', url: 'https://user:pass@example.org/a.js'}}), 'INVALID_SOURCE'],
        [manifest({...spec(), source: {type: 'remote', url: 'https://example.org/a.js', path: 'extensions/a.js'}}), 'INVALID_MANIFEST'],
        [manifest({...spec(), execution: 'automatic'}), 'INVALID_EXECUTION'],
        [manifest({...spec(), sha256: 'x'.repeat(64)}), 'INVALID_DIGEST'],
        [manifest(spec('pen')), 'INVALID_ID'],
        [manifest(spec(), spec()), 'INVALID_ID'],
        [manifest({...spec(), dependencies: ['absent']}), 'MISSING_DEPENDENCY'],
        [manifest({...spec('a'), dependencies: ['b']}, {...spec('b'), dependencies: ['a']}), 'DEPENDENCY_CYCLE']
    ];
    for (const [input, code] of cases) assert.throws(() => validateManifest(input), codeIs(code));
});

test('unapproved or wrong-scope digest never reaches registration', async () => {
    for (const decision of [undefined, false, {allowed: true}, {allowed: true, scope: 'origin'}, {allowed: true, scope: 'digest', sha256: '0'.repeat(64)}, {allowed: false}]) {
        const {loader, calls} = host({trustProvider: {async authorize() { return decision; }}});
        await assert.rejects(loader.load(manifest()), codeIs('TRUST_DENIED'));
        assert.equal(calls.some(call => call[0] === 'begin'), false);
    }
});

test('late trust refusal prevents earlier approved code from being registered', async () => {
    const {loader, calls} = host({trustProvider: {async authorize(code) { return {allowed: code.id === 'a', scope: 'digest', sha256: code.sha256}; }}});
    await assert.rejects(loader.load(manifest(spec('a'), spec('b'))), codeIs('TRUST_DENIED'));
    assert.equal(calls.some(call => call[0] === 'begin'), false);
});

test('tampered bytes, invalid UTF-8, excessive size, and missing embedded input fail closed', async () => {
    for (const [bytes, code, options] of [[new Uint8Array([1]), 'DIGEST_MISMATCH'], [fixture, 'INVALID_BYTES', {maxBytes: 2}], [new Uint8Array(), 'INVALID_BYTES']]) {
        const {loader, calls} = host({embeddedReader: {async read() { return bytes; }}}, options);
        await assert.rejects(loader.load(manifest()), codeIs(code));
        assert.equal(calls.some(call => call[0] === 'authorize'), false);
    }
    const bad = new Uint8Array([0xc0, 0xaf]);
    const {loader} = host({embeddedReader: {async read() { return bad; }}});
    await assert.rejects(loader.load(manifest({...spec(), sha256: hash(bad)})), codeIs('INVALID_ENCODING'));
});

test('remote response requires exact final URL and no redirects', async () => {
    const remote = spec('fixture', {type: 'remote', url: 'https://example.org/fixture.js'});
    for (const response of [{bytes: fixture}, {bytes: fixture, finalURL: remote.source.url, redirects: ['https://evil.test/']}, {bytes: fixture, finalURL: 'https://evil.test/', redirects: []}]) {
        const {loader, calls} = host({fetcher: {async fetch() { return response; }}});
        await assert.rejects(loader.load(manifest(remote)), codeIs('REDIRECT_DENIED'));
        assert.equal(calls.some(call => call[0] === 'authorize'), false);
    }
});

test('verified cache works offline but still needs trust; corrupted cache fails closed', async () => {
    let fetches = 0;
    const remote = spec('fixture', {type: 'remote', url: 'https://example.org/fixture.js'});
    const {loader, calls} = host({cache: {async get() { return fixture; }, async put() { assert.fail('cache hit should not be rewritten'); }}, fetcher: {async fetch() { fetches++; throw Error('offline'); }}});
    await loader.load(manifest(remote));
    assert.equal(fetches, 0);
    assert.equal(calls.filter(call => call[0] === 'authorize').length, 1);
    const bad = host({cache: {async get() { return new Uint8Array([1]); }, async put() {}}});
    await assert.rejects(bad.loader.load(manifest()), codeIs('CACHE_INTEGRITY'));
});

test('offline cache miss preserves cause and never registers', async () => {
    const failure = new TypeError('Network unavailable');
    const {loader, calls} = host({cache: {async get() { return null; }, async put() {}}, fetcher: {async fetch() { throw failure; }}});
    await assert.rejects(loader.load(manifest(spec('fixture', {type: 'remote', url: 'https://example.org/fixture.js'}))), error => error.code === 'LOAD_FAILED' && error.cause === failure);
    assert.equal(calls.some(call => call[0] === 'begin'), false);
});

test('cache receives a private verified byte copy', async () => {
    const {loader, calls} = host({cache: {async get() { return undefined; }, async put(digest, bytes) { assert.equal(digest, hash(fixture)); bytes.fill(0); }}});
    await loader.load(manifest());
    assert.equal(calls.find(call => call[0] === 'register')[2], new TextDecoder().decode(fixture));
});

test('ID mismatch causes host rollback and no successful commit', async () => {
    const calls = [];
    const {loader} = host({registrar: {async begin() { return {async register() { return {id: 'spoof'}; }, async commit() { calls.push('commit'); }, async rollback() { calls.push('rollback'); }}; }, async unload() {}}});
    await assert.rejects(loader.load(manifest()), codeIs('REGISTRATION_ID_MISMATCH'));
    assert.deepEqual(calls, ['rollback']);
    assert.equal(loader.getState().status, 'idle');
});

test('rollback failure poisons loader until host recovery', async () => {
    const {loader} = host({registrar: {async begin() { return {async register() { throw Error('register failed'); }, async commit() {}, async rollback() { throw Error('cannot rollback'); }}; }, async unload() {}}});
    await assert.rejects(loader.load(manifest()), codeIs('ROLLBACK_FAILED'));
    assert.equal(loader.getState().status, 'failed');
    await assert.rejects(loader.unload(), codeIs('HOST_RECOVERY_REQUIRED'));
    await assert.rejects(loader.load(manifest()), codeIs('BUSY'));
});

test('commit failure rolls back and unload failure requires host recovery', async () => {
    let rollbacks = 0;
    const {loader} = host({registrar: {async begin() { return {async register(code) { return {id: code.id}; }, async commit() { throw Error('commit failed'); }, async rollback() { rollbacks++; }}; }, async unload() {}}});
    await assert.rejects(loader.load(manifest()), codeIs('LOAD_FAILED'));
    assert.equal(rollbacks, 1);
    const failed = host({registrar: {async begin() { return {async register(code) { return {id: code.id}; }, async commit() {}, async rollback() {}}; }, async unload() { throw Error('unload failed'); }}});
    await failed.loader.load(manifest());
    await assert.rejects(failed.loader.unload(), codeIs('UNLOAD_FAILED'));
    assert.equal(failed.loader.getState().status, 'failed');
    await assert.rejects(failed.loader.load(manifest()), codeIs('BUSY'));
});

test('cancellation and timeout before authorization prevent registration', async () => {
    const controller = new AbortController(); controller.abort();
    const cancelled = host();
    await assert.rejects(cancelled.loader.load(manifest(), {signal: controller.signal}), codeIs('CANCELLED'));
    assert.equal(cancelled.calls.some(call => call[0] === 'begin'), false);
    const hanging = host({embeddedReader: {async read() { return new Promise(() => {}); }}}, {timeoutMs: 10});
    await assert.rejects(hanging.loader.load(manifest()), codeIs('TIMEOUT'));
    assert.equal(hanging.calls.some(call => call[0] === 'begin'), false);
});

test('registration is awaited before cancellation rollback, preventing late registration race', async () => {
    const controller = new AbortController();
    const calls = [];
    const {loader} = host({registrar: {async begin() { return {async register(code) { calls.push('start'); controller.abort(); await new Promise(resolve => setTimeout(resolve, 5)); calls.push('end'); return {id: code.id}; }, async commit() {}, async rollback() { calls.push('rollback'); }}; }, async unload() {}}});
    await assert.rejects(loader.load(manifest(), {signal: controller.signal}), codeIs('CANCELLED'));
    assert.deepEqual(calls, ['start', 'end', 'rollback']);
});

test('parallel project loads are rejected before host invocation', async () => {
    let resume;
    const {loader} = host({embeddedReader: {read() { return new Promise(resolve => { resume = resolve; }); }}});
    const first = loader.load(manifest());
    await assert.rejects(loader.load(manifest()), codeIs('BUSY'));
    resume(fixture);
    await first;
});

test('aggregate extension size limit applies across cache and source', async () => {
    const {loader, calls} = host({}, {maxTotalBytes: fixture.length});
    await assert.rejects(loader.load(manifest(spec('a'), spec('b'))), codeIs('TOTAL_SIZE_LIMIT'));
    assert.equal(calls.some(call => call[0] === 'begin'), false);
});

test('diagnostic callback exceptions do not bypass verification', async () => {
    const {loader} = host({diagnostics() { throw Error('UI failure'); }});
    await loader.load(manifest());
});

test('fetch port disables redirects/credentials and streams a bounded response', async () => {
    let request;
    const fetcher = createFetchPort(async (url, options) => {
        request = {url, options};
        return {ok: true, url, redirected: false, headers: new Headers(), body: new Response(fixture).body};
    });
    const controller = new AbortController();
    const result = await fetcher.fetch('https://example.org/fixture.js', {signal: controller.signal, maxBytes: 1024});
    assert.deepEqual(result.bytes, fixture);
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.referrerPolicy, 'no-referrer');
    await assert.rejects(fetcher.fetch('https://example.org/fixture.js', {signal: controller.signal, maxBytes: 2}), codeIs('INVALID_BYTES'));
});
