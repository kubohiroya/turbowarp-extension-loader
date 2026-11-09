import {hostError} from './test-errors.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {installExtensionLoader} from '@kubohiroya/turbowarp-extension-loader/scratch-vm';


// Marking a failure as an extension failure is the host's own bookkeeping, read back by its
// project-error paths, so the host passes the marker in and so does this test.
const failures = new WeakSet<object>();
const markExtensionLoadFailure = (error: unknown) => {
    const marked = error !== null && typeof error === 'object' ? error : new Error(String(error));
    failures.add(marked);
    return marked;
};
const isExtensionLoadFailure = (error: unknown) => error !== null && typeof error === 'object' && failures.has(error);

function fixture({manifest = {schemaVersion: 1, extensions: []}, failLoad = false} = {}) {
    const events = [];
    const context = {};
    const vm = {
        async loadProject(input) {
            events.push(['vm.load', input]);
            events.push(['vm.clear']);
            await this._loadExtensions(new Set(['plus', 'pen', 'custom']),
                new Map([['plus', 'https://plus.test/ext.js'], ['custom', 'https://custom.test/ext.js']]));
            if (failLoad) throw new Error('VM failed');
            return 'loaded';
        },
        async _loadExtensions(ids, urls) { events.push(['legacy', [...ids], [...urls]]); },
        toJSON(target?: string): string { return target ? 'sprite' : 'project'; },
        _saveProjectZip() { return {json: this.toJSON()}; },
        saveProjectSb3DontZip() { return {'project.json': this.toJSON()}; }
    };
    const loader = {
        async load(input, {signal}) {
            assert.equal(input, manifest);
            assert.equal(signal.aborted, false);
            events.push(['loader.load']);
            return {ids: ['plus']};
        },
        async unload() { events.push(['loader.unload']); }
    };
    const host = {
        onDiagnostic: undefined as ((event: Parameters<NonNullable<import('@kubohiroya/turbowarp-extension-loader/scratch-vm').ProjectLoaderHost['onDiagnostic']>>[0]) => void) | undefined,
        vm, transactionalRegistration: true as const, markFailure: markExtensionLoadFailure,
        projectIO: {
            async prepare(input: unknown, _options?: {signal: AbortSignal}): Promise<{manifest: typeof manifest; input: unknown; context?: object}> { events.push(['prepare']); return {manifest, input, context: manifest ? context : null}; },
            activate(value) { assert.equal(value, manifest ? context : null); },
            restoreJSON(json: string, value: object): string | Promise<string> { assert.equal(value, context); return `${json}:retained`; },
            restoreArchive(zip, value) { assert.equal(value, context); return {...zip, embedded: true}; },
            restoreFiles(files, value) { assert.equal(value, context); return {...files, embedded: true}; }
        }
    };
    return {host, vm, loader, events, context};
}

test('registers after VM clear and delegates ordinary IDs and URLs to the existing hook', async () => {
    const f = fixture();
    installExtensionLoader(f.host, f.loader);
    assert.equal(await f.vm.loadProject('input'), 'loaded');
    assert.deepEqual(f.events, [
        ['prepare'], ['vm.load', 'input'], ['vm.clear'], ['loader.load'],
        ['legacy', ['pen', 'custom'], [['custom', 'https://custom.test/ext.js']]]
    ]);
    assert.equal(f.vm.toJSON(), 'project:retained');
    assert.equal(f.vm.toJSON('sprite-id'), 'sprite');
    assert.deepEqual(f.vm._saveProjectZip(), {json: 'project:retained', embedded: true});
    assert.deepEqual(f.vm.saveProjectSb3DontZip(), {'project.json': 'project:retained', embedded: true});
});

test('projects without a manifest retain the legacy path and serializers', async () => {
    const f = fixture({manifest: null});
    installExtensionLoader(f.host, f.loader);
    await f.vm.loadProject('input');
    assert.equal(f.events.some(event => event[0] === 'loader.load'), false);
    assert.deepEqual(f.events.at(-1), ['legacy', ['plus', 'pen', 'custom'],
        [['plus', 'https://plus.test/ext.js'], ['custom', 'https://custom.test/ext.js']]]);
    assert.equal(f.vm.toJSON(), 'project');
    assert.deepEqual(f.vm._saveProjectZip(), {json: 'project'});
});

test('rejected trust prevents the legacy loader from seeing Plus URLs or project execution', async () => {
    const f = fixture();
    f.loader.load = async () => { throw Object.assign(new Error('denied'), {code: 'TRUST_DENIED'}); };
    installExtensionLoader(f.host, f.loader);
    await assert.rejects(f.vm.loadProject('input'), {code: 'TRUST_DENIED'});
    assert.equal(f.events.some(event => event[0] === 'legacy'), false);
    assert.equal(f.vm.toJSON(), 'project');
});

test('extension failures are marked for the GUI without replacing the original error', async () => {
    const loaderFailure = Object.assign(new Error('Extension load failed'), {code: 'LOAD_FAILED'});
    const f = fixture();
    f.loader.load = async () => { throw loaderFailure; };
    installExtensionLoader(f.host, f.loader);
    await assert.rejects(f.vm.loadProject('input'), error => error === loaderFailure && isExtensionLoadFailure(error));

    const legacyFailure = new Error('Unknown extension: custom');
    const legacy = fixture({manifest: null});
    legacy.vm._loadExtensions = async () => { throw legacyFailure; };
    installExtensionLoader(legacy.host, legacy.loader);
    await assert.rejects(legacy.vm.loadProject('input'), error => error === legacyFailure && isExtensionLoadFailure(error));
});

test('project failures outside extension loading are not marked as extension failures', async () => {
    const f = fixture({failLoad: true});
    installExtensionLoader(f.host, f.loader);
    await assert.rejects(f.vm.loadProject('input'), error => /VM failed/.test(hostError(error).message) && !isExtensionLoadFailure(error));
    f.host.projectIO.prepare = async () => { throw Object.assign(new Error('bad ZIP'), {code: 'INVALID_ZIP'}); };
    await assert.rejects(f.vm.loadProject('invalid'), error => hostError(error).code === 'INVALID_ZIP' && !isExtensionLoadFailure(error));
});

test('cleans registrations after VM failure and does not retain a failed manifest', async () => {
    const f = fixture({failLoad: true});
    installExtensionLoader(f.host, f.loader);
    await assert.rejects(f.vm.loadProject('input'), /VM failed/);
    assert.equal(f.events.at(-1)[0], 'loader.unload');
    assert.equal(f.vm.toJSON(), 'project');
});

test('invalid input cannot touch the VM or strip a previously saved manifest', async () => {
    const f = fixture();
    installExtensionLoader(f.host, f.loader);
    await f.vm.loadProject('valid');
    f.events.length = 0;
    f.host.projectIO.prepare = async () => { throw Object.assign(new Error('bad ZIP'), {code: 'INVALID_ZIP'}); };
    await assert.rejects(f.vm.loadProject('invalid'), {code: 'INVALID_ZIP'});
    assert.deepEqual(f.events, []);
    assert.equal(f.vm.toJSON(), 'project:retained');
});

test('disposal leaves a failing guard installed until an in-flight VM load drains', async () => {
    const f = fixture();
    let enter;
    let proceed;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { proceed = resolve; });
    f.vm.loadProject = async function() {
        enter();
        await gate;
        return this._loadExtensions(['plus'], new Map([['plus', 'https://unverified.test/code.js']]));
    };
    const originalHook = f.vm._loadExtensions;
    const dispose = installExtensionLoader(f.host, f.loader);
    const loading = f.vm.loadProject('input');
    await entered;
    const draining = dispose();
    assert.notEqual(f.vm._loadExtensions, originalHook);
    proceed();
    await assert.rejects(loading, {code: 'LOADER_DISPOSED'});
    await draining;
    assert.equal(f.vm._loadExtensions, originalHook);
    assert.equal(f.events.some(event => event[0] === 'legacy'), false);
});

test('queues project opens and refuses partial saves during loading', async () => {
    const f = fixture();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const originalPrepare = f.host.projectIO.prepare;
    f.host.projectIO.prepare = async (...args) => { await gate; return originalPrepare(...args); };
    installExtensionLoader(f.host, f.loader);
    const first = f.vm.loadProject('first');
    const second = f.vm.loadProject('second');
    assert.throws(() => f.vm.toJSON(), {code: 'PROJECT_BUSY'});
    assert.throws(() => f.vm._saveProjectZip(), {code: 'PROJECT_BUSY'});
    assert.throws(() => f.vm.saveProjectSb3DontZip(), {code: 'PROJECT_BUSY'});
    release();
    await Promise.all([first, second]);
    assert.deepEqual(f.events.filter(event => ['vm.load', 'loader.unload'].includes(event[0])),
        [['vm.load', 'first'], ['loader.unload'], ['vm.load', 'second']]);
});

test('dispose aborts work, restores owned hooks and does not overwrite later integrations', async () => {
    const f = fixture();
    const original = f.vm.loadProject;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    f.host.projectIO.prepare = async (input, {signal}) => {
        entered();
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
        return {input, manifest: null};
    };
    const dispose = installExtensionLoader(f.host, f.loader);
    const load = f.vm.loadProject('input');
    await started;
    const laterHook = () => 'later';
    f.vm.toJSON = laterHook;
    const drained = dispose();
    assert.equal(dispose(), drained);
    await assert.rejects(load, /aborted/);
    await drained;
    assert.equal(f.vm.loadProject, original);
    assert.equal(f.vm.toJSON, laterHook);
});

test('refuses a VM without an explicitly supplied transactional registration host', () => {
    const f = fixture();
    delete f.host.transactionalRegistration;
    assert.throws(() => installExtensionLoader(f.host, f.loader), {code: 'UNSUPPORTED_HOST'});
});

test('read-only hooks reject installation without leaving partial mutations', () => {
    const f = fixture();
    const originalLoad = f.vm.loadProject;
    const originalExtensions = f.vm._loadExtensions;
    Object.defineProperty(f.vm, 'toJSON', {writable: false, configurable: false});
    assert.throws(() => installExtensionLoader(f.host, f.loader), {code: 'UNSUPPORTED_HOST'});
    assert.equal(f.vm.loadProject, originalLoad);
    assert.equal(f.vm._loadExtensions, originalExtensions);
});

test('an unexpected install failure rolls already replaced hooks back', () => {
    const f = fixture();
    const realVM = f.vm;
    const originalLoad = realVM.loadProject;
    const originalExtensions = realVM._loadExtensions;
    f.host.vm = new Proxy(realVM, {defineProperty(target, name, descriptor) {
        if (name === 'toJSON') throw new Error('host refused hook');
        return Reflect.defineProperty(target, name, descriptor);
    }});
    assert.throws(() => installExtensionLoader(f.host, f.loader), {code: 'UNSUPPORTED_HOST'});
    assert.equal(realVM.loadProject, originalLoad);
    assert.equal(realVM._loadExtensions, originalExtensions);
});

test('uninstall unloads registrations before restoring persistence and retains guards on failure', async () => {
    const f = fixture();
    const originalJSON = f.vm.toJSON;
    const dispose = installExtensionLoader(f.host, f.loader);
    await f.vm.loadProject('input');
    f.loader.unload = async () => {
        assert.notEqual(f.vm.toJSON, originalJSON);
        throw new Error('unload failed');
    };
    await assert.rejects(dispose(), /unload failed/);
    assert.notEqual(f.vm.toJSON, originalJSON);
    assert.throws(() => f.vm.toJSON(), {code: 'LOADER_DISPOSED'});
});

test('serializer failure and asynchronous codec results cannot silently fall back', async () => {
    const f = fixture();
    installExtensionLoader(f.host, f.loader);
    await f.vm.loadProject('input');
    f.host.projectIO.restoreJSON = () => { throw new Error('retention failed'); };
    assert.throws(() => f.vm.toJSON(), /retention failed/);
    assert.throws(() => f.vm._saveProjectZip(), /retention failed/);
    assert.throws(() => f.vm.saveProjectSb3DontZip(), /retention failed/);
    f.host.projectIO.restoreJSON = async () => 'bad';
    assert.throws(() => f.vm.toJSON(), {code: 'INVALID_PROJECT_CODEC'});
});

test('refuses double installation and a VM that skips the extension lifecycle', async () => {
    const f = fixture();
    f.vm.loadProject = async () => 'loaded';
    const dispose = installExtensionLoader(f.host, f.loader);
    assert.throws(() => installExtensionLoader(f.host, f.loader), {code: 'ALREADY_INSTALLED'});
    await assert.rejects(f.vm.loadProject('input'), {code: 'UNSUPPORTED_HOST'});
    await dispose();
});

test('the project-error diagnostic carries the Loader\'s judgement of asking again, and showing it changes nothing', async () => {
    const {LoaderError, isWorthAskingAgain} = await import('@kubohiroya/turbowarp-extension-loader');
    const cases: [Error & {code?: string}, boolean][] = [
        [new LoaderError('TIMEOUT', 'The operation timed out'), true],
        [new LoaderError('DIGEST_MISMATCH', 'Digest mismatch', 'plus'), false],
        // The same code on both sides: what it wraps decides, so this side never reads the code.
        [new LoaderError('LOAD_FAILED', 'Wrapped', 'plus', new LoaderError('TIMEOUT', 'late')), true],
        [new LoaderError('LOAD_FAILED', 'Wrapped', 'plus', new Error('registered the wrong ID')), false],
        [new Error('not the Loader\'s'), false]
    ];
    for (const [error, retryable] of cases) {
        assert.equal(isWorthAskingAgain(error), retryable);
        const f = fixture();
        const events = [];
        f.host.onDiagnostic = event => events.push(event);
        f.loader.load = async () => { throw error; };
        installExtensionLoader(f.host, f.loader);
        await assert.rejects(f.vm.loadProject('input'), caught => caught === error && isExtensionLoadFailure(caught));
        assert.deepEqual(events, [{type: 'project-error', code: error.code || 'LOAD_FAILED',
            message: error.message, retryable}]);
    }
    // A screen that fails to show the diagnostic does not change what loading decided.
    const f = fixture();
    const error = new LoaderError('TIMEOUT', 'The operation timed out');
    f.host.onDiagnostic = () => { throw new Error('presentation failed'); };
    f.loader.load = async () => { throw error; };
    installExtensionLoader(f.host, f.loader);
    await assert.rejects(f.vm.loadProject('input'), caught => caught === error && isExtensionLoadFailure(caught));
});
