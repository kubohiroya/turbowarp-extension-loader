import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import JSZip from '@turbowarp/jszip';
import {createExtensionLoader, createFetchPort, isWorthAskingAgain, withFetchRetry, LoaderError,
    type FetchPort, type FetchResult, type LoaderPorts} from '@kubohiroya/turbowarp-extension-loader';
import {prepareCatalogExtensionChanges, type CatalogExtensionRequest} from '@kubohiroya/turbowarp-extension-loader/project-catalog';

const fixture = new Uint8Array(await readFile(new URL('./fixtures/extension.js', import.meta.url)));
const sha256 = createHash('sha256').update(fixture).digest('hex');
const url = 'https://example.org/fixture.js';
/** A browser reports every transport failure with no response as one opaque TypeError. */
const connectionFailed = () => new TypeError('Failed to fetch');

const failingPort = (error: () => unknown): FetchPort => ({async fetch(): Promise<FetchResult> { throw error(); }});
const serving = (bytes: Uint8Array, finalURL = url): FetchPort =>
    ({async fetch() { return {bytes, finalURL, redirects: []}; }});
const remote = (id = 'remote') => ({id, source: {type: 'remote-cacheable', url}, execution: 'unsandboxed', sha256});
const allow: LoaderPorts['trustProvider'] = {async authorize(code) { return {allowed: true, scope: 'digest', sha256: code.sha256}; }};

function ports(fetcher: FetchPort, overrides: Partial<LoaderPorts> = {}): LoaderPorts {
    return {
        fetcher,
        trustProvider: allow,
        registrar: {
            async begin() {
                return {async register(code) { return {id: code.id}; }, async commit() {}, async rollback() {}};
            },
            async unload() {}
        },
        ...overrides
    };
}

/** The failure a whole `load()` rejects with, which is what a host actually holds. */
async function loadFailure(fetcher: FetchPort, overrides: Partial<LoaderPorts> = {}, spec: unknown = remote()): Promise<unknown> {
    const loader = createExtensionLoader(ports(fetcher, overrides), {timeoutMs: 1000});
    try { await loader.load({schemaVersion: 1, extensions: [spec]}); }
    catch (error) { return error; }
    assert.fail('the load was expected to fail');
}

/** A `fetch` implementation answering every request with one status. */
const status = (code: number) => (async (target: string) => ({ok: false, status: code, statusText: '', url: target,
    redirected: false, headers: new Headers(), body: null})) as unknown as typeof fetch;

test('a browser transport failure wrapped in LOAD_FAILED is worth asking again', async () => {
    const error = await loadFailure(withFetchRetry(failingPort(connectionFailed), {retries: 0}));
    assert.ok(error instanceof LoaderError && error.code === 'LOAD_FAILED');
    // The fetch-port classifier sees only the wrapper and says no; that is the case this exists for.
    assert.equal(isWorthAskingAgain(error), true);
});

test('an HTTP answer is worth asking again only when it is a transient one', async () => {
    for (const code of [408, 425, 429, 500, 503]) {
        assert.equal(isWorthAskingAgain(await loadFailure(createFetchPort(status(code), {retries: 0}))), true, `HTTP ${code}`);
    }
    for (const code of [400, 403, 404, 410]) {
        assert.equal(isWorthAskingAgain(await loadFailure(createFetchPort(status(code), {retries: 0}))), false, `HTTP ${code}`);
    }
});

test('a refusal that asking again would repeat is not worth asking again', async () => {
    const tampered = new Uint8Array(fixture);
    tampered[0] = tampered[0]! ^ 1;
    const cases: [string, unknown][] = [
        ['DIGEST_MISMATCH', await loadFailure(serving(tampered))],
        ['REDIRECT_DENIED', await loadFailure(serving(fixture, 'https://example.org/elsewhere.js'))],
        ['TRUST_DENIED', await loadFailure(serving(fixture), {trustProvider: {async authorize() { return {allowed: false}; }}})],
        ['CACHE_INTEGRITY', await loadFailure(serving(fixture), {cache: {async get() { return tampered; }, async put() {}}})],
        ['INVALID_SOURCE', await loadFailure(serving(fixture), {}, {...remote(), source: {type: 'remote-cacheable', url: 'http://example.org/x.js'}})]
    ];
    for (const [code, error] of cases) {
        assert.ok(error instanceof LoaderError && error.code === code, `expected ${code}, got ${String(error)}`);
        assert.equal(isWorthAskingAgain(error), false, code);
    }
    const unsupported = createExtensionLoader(ports(serving(fixture)));
    await assert.rejects(unsupported.load({schemaVersion: 2, extensions: []}), (error: unknown) =>
        error instanceof LoaderError && error.code === 'UNSUPPORTED_SCHEMA' && !isWorthAskingAgain(error));
});

test('a TypeError the host itself threw is not mistaken for a transport failure', async () => {
    // Same class and wrapper as the browser's transport failure, but it never came out of a fetch port.
    const error = await loadFailure(serving(fixture), {registrar: {
        async begin() { throw new TypeError('host bug'); },
        async unload() {}
    }});
    assert.ok(error instanceof LoaderError && error.code === 'LOAD_FAILED');
    assert.equal(isWorthAskingAgain(error), false);
});

test('a person cancelling is final, while running out of time is worth asking again', async () => {
    const hanging: FetchPort = {fetch: (_url, {signal}) => new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {once: true}))};
    const controller = new AbortController();
    const cancelled = createExtensionLoader(ports(hanging)).load({schemaVersion: 1, extensions: [remote()]}, {signal: controller.signal});
    controller.abort(new DOMException('The person cancelled', 'AbortError'));
    await assert.rejects(cancelled, (error: unknown) =>
        error instanceof LoaderError && error.code === 'CANCELLED' && !isWorthAskingAgain(error));

    const timedOut = createExtensionLoader(ports(hanging), {timeoutMs: 20}).load({schemaVersion: 1, extensions: [remote()]});
    await assert.rejects(timedOut, (error: unknown) =>
        error instanceof LoaderError && error.code === 'TIMEOUT' && isWorthAskingAgain(error));
});

test('one permanent refusal anywhere in the chain outweighs a transient one', () => {
    const transient = new LoaderError('FETCH_FAILED', 'Remote response is unavailable (HTTP 503)', undefined, {status: 503});
    const permanent = new LoaderError('DIGEST_MISMATCH', 'Extension bytes do not match the digest', 'x');
    assert.equal(isWorthAskingAgain(transient), true);
    assert.equal(isWorthAskingAgain(new AggregateError([transient, transient])), true);
    assert.equal(isWorthAskingAgain(new AggregateError([transient, permanent])), false);
    assert.equal(isWorthAskingAgain(new AggregateError([])), false);
    // A failed rollback leaves the host needing recovery, which asking for the load again cannot give.
    assert.equal(isWorthAskingAgain(new LoaderError('ROLLBACK_FAILED', 'x', undefined, new AggregateError([transient, new Error('rollback')]))), false);
});

test('anything the Loader cannot account for is not worth asking again', () => {
    for (const value of [undefined, null, 'offline', 42, {}, new Error('unknown'), new TypeError('Failed to fetch'),
        new LoaderError('LOAD_FAILED', 'no cause')]) {
        assert.equal(isWorthAskingAgain(value), false, String(value));
    }
    // A cycle in the cause chain ends the walk instead of overflowing the stack.
    const looped = new LoaderError('LOAD_FAILED', 'loop');
    Object.defineProperty(looped, 'cause', {value: looped});
    assert.equal(isWorthAskingAgain(looped), false);
});

test('catalog changes report a transport failure the same way a load does', async () => {
    const project = await new JSZip().file('project.json', JSON.stringify({targets: [{isStage: true, name: 'Stage', blocks: {}}],
        extensions: [], extensionURLs: {}, meta: {}})).generateAsync({type: 'uint8array'});
    const failing = withFetchRetry(failingPort(connectionFailed), {retries: 0});
    const request = {id: 'remote', url, distribution: 'remote-cacheable', execution: 'unsandboxed'} as CatalogExtensionRequest;
    let error: unknown;
    try {
        await prepareCatalogExtensionChanges(project, [request], {fetcher: failing, trustProvider: allow}, {zip: JSZip});
    } catch (caught) { error = caught; }
    assert.ok(error !== undefined, 'the catalog change was expected to fail');
    assert.equal(isWorthAskingAgain(error), true);
});
