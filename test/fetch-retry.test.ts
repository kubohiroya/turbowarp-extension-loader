import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createExtensionLoader, createFetchPort, withFetchRetry, isTransientFetchFailure,
    DEFAULT_FETCH_RETRY, LoaderError, type FetchPort, type FetchResult, type LoaderPorts,
    type ReadOptions} from '@kubohiroya/turbowarp-extension-loader';

const fixture = new Uint8Array(await readFile(new URL('./fixtures/extension.js', import.meta.url)));
const sha256 = createHash('sha256').update(fixture).digest('hex');
const url = 'https://example.org/fixture.js';
const codeIs = (code: string) => (error: unknown) => error instanceof LoaderError && error.code === code;
const reading = (signal: AbortSignal): ReadOptions => ({signal, maxBytes: 1024 * 1024});
const succeed = (): FetchResult => ({bytes: fixture, finalURL: url, redirects: []});
/** A browser reports every transport failure with no response as one opaque TypeError. */
const connectionFailed = () => new TypeError('Failed to fetch');

/** Counts attempts, failing the first `failures` of them with whatever `error` produces. */
function flaky(failures: number, error: () => unknown = connectionFailed): FetchPort & {attempts: number} {
    const port = {
        attempts: 0,
        async fetch(): Promise<FetchResult> {
            port.attempts += 1;
            if (port.attempts <= failures) throw error();
            return succeed();
        }
    };
    return port;
}

/** Responses are shaped the way the port reads them, which is narrower than the real interface. */
const responding = (...statuses: number[]) => {
    const calls: number[] = [];
    const impl = (async (target: string) => {
        const status = statuses[Math.min(calls.length, statuses.length - 1)]!;
        calls.push(status);
        return {ok: status < 400, status, statusText: '', url: target, redirected: false,
            headers: new Headers(), body: new Response(fixture).body};
    }) as unknown as typeof fetch;
    return {impl, calls};
};

test('a transient transport failure is retried and the recovered bytes are returned', async () => {
    const port = flaky(2);
    const retrying = withFetchRetry(port, {baseDelayMs: 1});
    const controller = new AbortController();
    assert.deepEqual((await retrying.fetch(url, reading(controller.signal))).bytes, fixture);
    // The default two retries are exactly what it took; a third failure would have been reported.
    assert.equal(port.attempts, 3);
    assert.equal(DEFAULT_FETCH_RETRY.retries, 2);
    const hopeless = flaky(Infinity);
    await assert.rejects(withFetchRetry(hopeless, {baseDelayMs: 1}).fetch(url, reading(controller.signal)),
        (error: unknown) => error instanceof TypeError);
    assert.equal(hopeless.attempts, 3);
});

test('only an answer worth repeating is repeated, and the request count proves it', async () => {
    const controller = new AbortController();
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
        const {impl, calls} = responding(status, 200);
        assert.deepEqual((await createFetchPort(impl, {baseDelayMs: 1}).fetch(url, reading(controller.signal))).bytes, fixture);
        assert.deepEqual(calls, [status, 200]);
    }
    // A permanent answer is asked for once: repeating it only asks the same question again.
    for (const status of [400, 401, 403, 404, 410, 451]) {
        const {impl, calls} = responding(status);
        await assert.rejects(createFetchPort(impl, {baseDelayMs: 1}).fetch(url, reading(controller.signal)), codeIs('FETCH_FAILED'));
        assert.deepEqual(calls, [status]);
    }
    assert.equal(isTransientFetchFailure(new LoaderError('FETCH_FAILED', 'x', undefined, {status: 503})), true);
    assert.equal(isTransientFetchFailure(new LoaderError('FETCH_FAILED', 'x', undefined, {status: 404})), false);
    assert.equal(isTransientFetchFailure(connectionFailed()), true);
});

test('a policy refusal, a byte limit and a cancellation are never retried', async () => {
    const controller = new AbortController();
    for (const error of [
        () => new LoaderError('REDIRECT_DENIED', 'redirected'),
        () => new LoaderError('INVALID_BYTES', 'too large'),
        () => new LoaderError('INVALID_SOURCE', 'not HTTPS'),
        () => new LoaderError('CANCELLED', 'interrupted'),
        () => new LoaderError('TIMEOUT', 'timed out'),
        () => Object.assign(new Error('aborted'), {name: 'AbortError'})
    ]) {
        const port = flaky(Infinity, error);
        await assert.rejects(withFetchRetry(port, {baseDelayMs: 1}).fetch(url, reading(controller.signal)));
        assert.equal(port.attempts, 1);
        assert.equal(isTransientFetchFailure(error()), false);
    }
    // A redirected or bodyless response carries no status, so it is a refusal and not an outage.
    let attempts = 0;
    const redirecting = (async () => {
        attempts += 1;
        return {ok: true, status: 200, url: 'https://cdn.example.org/fixture.js', redirected: true,
            headers: new Headers(), body: new Response(fixture).body};
    }) as unknown as typeof fetch;
    await assert.rejects(createFetchPort(redirecting, {baseDelayMs: 1}).fetch(url, reading(controller.signal)), codeIs('FETCH_FAILED'));
    assert.equal(attempts, 1);
});

test('cancelling during a backoff wait interrupts it instead of waiting it out', async () => {
    const port = flaky(Infinity);
    const controller = new AbortController();
    const started = Date.now();
    const retrying = withFetchRetry(port, {retries: 4, baseDelayMs: 10_000, maxDelayMs: 10_000, budgetMs: 60_000,
        onRetry: () => setTimeout(() => controller.abort(), 5)});
    await assert.rejects(retrying.fetch(url, reading(controller.signal)), codeIs('CANCELLED'));
    assert.ok(Date.now() - started < 2_000, 'the pending backoff delay was abandoned, not awaited');
    assert.equal(port.attempts, 1);
    // An already aborted signal never reaches the port at all once the first attempt has failed.
    const aborted = AbortSignal.abort(new LoaderError('TIMEOUT', 'Extension load timed out'));
    const second = flaky(Infinity);
    await assert.rejects(withFetchRetry(second, {baseDelayMs: 1}).fetch(url, reading(aborted)), codeIs('TIMEOUT'));
    assert.equal(second.attempts, 1);
});

test('the retry budget caps the total wait well below the load deadline', async () => {
    const port = flaky(Infinity);
    const controller = new AbortController();
    const started = Date.now();
    // Five retries are allowed, but the budget covers the waiting, so it is spent first.
    await assert.rejects(withFetchRetry(port, {retries: 5, baseDelayMs: 50, maxDelayMs: 50, budgetMs: 120})
        .fetch(url, reading(controller.signal)), (error: unknown) => error instanceof TypeError);
    const elapsed = Date.now() - started;
    assert.equal(port.attempts, 3);
    assert.ok(elapsed >= 100 && elapsed < 1_000, `two 50 ms waits and no third: ${elapsed}ms`);
    // The default budget is a fraction of the 30 second fetch and authorization deadline.
    assert.ok(DEFAULT_FETCH_RETRY.budgetMs * DEFAULT_FETCH_RETRY.retries < 30_000);
    assert.throws(() => withFetchRetry(port, {retries: -1}), codeIs('INVALID_OPTIONS'));
    assert.throws(() => withFetchRetry(port, {budgetMs: 1.5}), codeIs('INVALID_OPTIONS'));
    assert.throws(() => withFetchRetry({} as FetchPort), codeIs('INVALID_PORT'));
    // A host that wants the previous single attempt asks for it explicitly.
    const once = flaky(1);
    await assert.rejects(withFetchRetry(once, {retries: 0}).fetch(url, reading(controller.signal)),
        (error: unknown) => error instanceof TypeError);
    assert.equal(once.attempts, 1);
});

test('a load survives a recovered fetch and a final failure still stops the entries left', async () => {
    const spec = (id: string, source: unknown) => ({id, source, execution: 'unsandboxed', sha256});
    const ports = (fetcher: FetchPort, captured: {signal?: AbortSignal}): LoaderPorts => ({
        embeddedReader: {async read(_path, {signal}) { captured.signal = signal; return fixture; }},
        fetcher,
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
        }
    });
    const recovered = flaky(2);
    const captured: {signal?: AbortSignal} = {};
    const loader = createExtensionLoader(ports(withFetchRetry(recovered, {baseDelayMs: 1}), captured));
    assert.deepEqual((await loader.load({schemaVersion: 1, extensions: [spec('remote', {type: 'remote', url})]})).ids, ['remote']);
    assert.equal(recovered.attempts, 3);
    await loader.unload();

    // Entries are resolved one at a time, so the ones after a final failure are never fetched;
    // the operation's own signal is aborted as well, so port work already running stops.
    const hopeless = flaky(Infinity);
    const second: {signal?: AbortSignal} = {};
    const failing = createExtensionLoader(ports(withFetchRetry(hopeless, {baseDelayMs: 1}), second));
    const later = flaky(Infinity);
    await assert.rejects(failing.load({schemaVersion: 1, extensions: [
        spec('first', {type: 'embedded', path: 'extensions/fixture.js'}),
        spec('broken', {type: 'remote', url}),
        spec('never', {type: 'remote', url: 'https://example.org/never.js'})
    ]}), codeIs('LOAD_FAILED'));
    assert.equal(hopeless.attempts, 3, 'only the failing entry was fetched, three times');
    assert.equal(later.attempts, 0);
    assert.equal(second.signal?.aborted, true);
    assert.equal(failing.getState().status, 'idle');
});
