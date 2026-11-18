// SPDX-License-Identifier: MPL-2.0
import type {CatalogEntry, ReviewDecision} from '@kubohiroya/turbowarp-extension-loader/scratch-vm/catalog-settings';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import Zip from '@turbowarp/jszip';
import {applyPlusCatalogSettings, readPlusCatalogSettings} from '@kubohiroya/turbowarp-extension-loader/scratch-vm/catalog-settings';
import {createExtensionAuthoringController, setExtensionAuthoringHost} from '@kubohiroya/turbowarp-extension-loader/scratch-vm';

const entry = (id, dependencies = []) => ({id, key: id, ids: [id], url: `https://catalog.test/${id}.js`, dependencies,
    metadata: {name: id, version: '1.2.3'}});
// The Loader's four forms: a source either names a URL or carries the bytes. The review screen
// spells them the same way, so what `readPlusCatalogSettings` returns and what
// `applyPlusCatalogSettings` takes is the screen's `ReviewDecision` with no translation.
const spec = (id, type = 'remote-cacheable', execution = 'unsandboxed') => ({id, execution,
    sha256: 'a'.repeat(64),
    source: type.startsWith('remote-') ? {type, url: entry(id).url} : {type, path: `extensions/${id}.js`}});
function vmFixture(services = [], loadedIds = services.map(([id]) => id)) {
    return {extensionManager: {_loadedExtensions: new Map(services),
        isExtensionLoaded(id) { return loadedIds.includes(id); }}};
}
/** `decisions` as `[id, execution, loading]`; a missing loading stays missing. */
const selection = (entries: CatalogEntry[], decisions: [string, ReviewDecision['execution'], ReviewDecision['loading']?][]) =>
    ({entries, decisions: new Map<string, ReviewDecision>(decisions.map(([id, execution, loading]) =>
        [id, loading === undefined ? {execution} : {execution, loading}]))});
const deferred = <Value = void>() => {
    let resolve: (value: Value) => void;
    const promise = new Promise<Value>(yes => { resolve = yes; });
    return {promise, resolve};
};
async function plainSB3() {
    return new Zip().file('project.json', JSON.stringify({targets: [{isStage: true, name: 'Stage', blocks: {}}],
        extensions: [], meta: {agent: 'Catalog adapter tests'}})).file('keep.bin', new Uint8Array([1, 3, 7]))
        .generateAsync({type: 'uint8array', compression: 'STORE'});
}

// Each test installs a stand-in with only the authoring method the library calls.
test('actual VM service prefixes restore execution while the manifest restores the loading form', async () => {
    const entries = [entry('outside'), entry('inside')];
    const vm = vmFixture([['outside', 'unsandboxed.1.outside'], ['inside', 'extension.2.inside']]);
    const manifest = {extensions: [spec('outside', 'embedded-file', 'sandboxed'), spec('inside', 'remote-cacheable', 'unsandboxed')]};
    setExtensionAuthoringHost(vm, {inspect: async () => manifest} as never);
    const {decisions} = await readPlusCatalogSettings(vm, entries);
    // What is running wins over what the manifest requested, and the form is read as it is spelled.
    assert.deepEqual([...decisions], [['outside', {execution: 'unsandboxed', loading: 'embedded-file'}],
        ['inside', {execution: 'sandboxed', loading: 'remote-cacheable'}]]);
    setExtensionAuthoringHost(vm, null);
});

test('every one of the four forms passes through unchanged, and a running entry with no manifest has no form', async () => {
    const forms = ['remote-non-cacheable', 'remote-cacheable', 'embedded-file', 'embedded-data'];
    const entries = forms.map(form => entry(form));
    const vm = vmFixture([['legacy', 'extension.2.legacy']]);
    setExtensionAuthoringHost(vm, {inspect: async () => ({extensions: forms.map(form => spec(form, form))})} as never);
    const {decisions} = await readPlusCatalogSettings(vm, [...entries, entry('legacy')]);
    assert.deepEqual(forms.map(form => decisions.get(form).loading), forms);
    // The screen offers its own default form for a row the project has not recorded one for.
    assert.deepEqual(decisions.get('legacy'), {execution: 'sandboxed'});
    setExtensionAuthoringHost(vm, null);
});

test('a missing Loader host does not invent a form, and an unrecorded entry gets no decision', async () => {
    const vm = vmFixture([['legacy', 'extension.2.legacy']]);
    const {decisions} = await readPlusCatalogSettings(vm, [entry('legacy'), entry('newentry')]);
    assert.deepEqual([...decisions], [['legacy', {execution: 'sandboxed'}]]);
});

test('unknown or absent VM service names do not silently restore a sandbox mode', async () => {
    const entries = [entry('unknown'), entry('missing')];
    const vm = vmFixture([['unknown', 'unexpected-service']], ['unknown', 'missing']);
    const {decisions} = await readPlusCatalogSettings(vm, entries);
    // Nothing running can be read, so the default the screen shows stands for both.
    assert.deepEqual([...decisions], []);
});

test('apply forwards every selected and loaded row together with execution, form, dependencies, version and signal', async () => {
    const vm = vmFixture([['base', 'extension.1.base']]);
    const entries = [entry('base'), entry('parent', ['base'])];
    const calls = [];
    const signal = new AbortController().signal;
    setExtensionAuthoringHost(vm, {configure: async (...args) => calls.push(args)} as never);
    const result = await applyPlusCatalogSettings(vm, selection(entries,
        [['base', 'sandboxed', 'embedded-data'], ['parent', 'unsandboxed', 'remote-non-cacheable']]), {signal});
    assert.deepEqual(result, ['base', 'parent']);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0], [
        {id: 'base', url: entries[0].url, execution: 'sandboxed', distribution: 'embedded-data', dependencies: [], version: '1.2.3'},
        {id: 'parent', url: entries[1].url, execution: 'unsandboxed', distribution: 'remote-non-cacheable', dependencies: ['base'], version: '1.2.3'}
    ]);
    assert.equal(calls[0][1].signal, signal);
    setExtensionAuthoringHost(vm, null);
});

test('an empty selection does not call configure and forged deny choices reject the entire batch', async () => {
    const vm = vmFixture();
    const entries = [entry('denied'), entry('allowed')];
    const calls = [];
    setExtensionAuthoringHost(vm, {configure: async requests => calls.push(requests)} as never);
    assert.deepEqual(await applyPlusCatalogSettings(vm, selection([], [])), []);
    await assert.rejects(applyPlusCatalogSettings(vm,
        selection(entries, [['denied', 'deny', 'remote-cacheable'], ['allowed', 'sandboxed', 'remote-cacheable']])),
    {code: 'MISSING_EXECUTION'});
    assert.equal(calls.length, 0);
    setExtensionAuthoringHost(vm, null);
});

test('denial of an already-loaded extension is rejected instead of claiming it stopped running', async () => {
    const vm = vmFixture([['loaded', 'extension.1.loaded']]);
    let calls = 0;
    setExtensionAuthoringHost(vm, {configure: async () => { calls++; }} as never);
    await assert.rejects(applyPlusCatalogSettings(vm, selection([entry('loaded')], [['loaded', 'deny', 'remote-cacheable']])),
        {code: 'MISSING_EXECUTION'});
    assert.equal(calls, 0);
    assert.equal(vm.extensionManager.isExtensionLoaded('loaded'), true);
    setExtensionAuthoringHost(vm, null);
});

test('missing or unknown execution prevents the entire batch from reaching configure', async () => {
    for (const mode of [undefined, 'automatic']) {
        const vm = vmFixture();
        let calls = 0;
        setExtensionAuthoringHost(vm, {configure: async () => { calls++; }} as never);
        await assert.rejects(applyPlusCatalogSettings(vm, selection([entry('first'), entry('second')],
            [['first', 'sandboxed', 'remote-cacheable'], ['second', mode as ReviewDecision['execution'], 'remote-cacheable']])), {code: 'MISSING_EXECUTION'});
        assert.equal(calls, 0);
        setExtensionAuthoringHost(vm, null);
    }
});

test('a missing form, or a retired spelling, is refused rather than defaulted or translated', async () => {
    for (const loading of [undefined, 'remote', 'embedded', 'cached', 'automatic']) {
        const vm = vmFixture();
        let calls = 0;
        setExtensionAuthoringHost(vm, {configure: async () => { calls++; }} as never);
        await assert.rejects(applyPlusCatalogSettings(vm, selection([entry('first')], [['first', 'sandboxed', loading as ReviewDecision['loading']]])),
            {code: 'MISSING_LOADING'}, String(loading));
        assert.equal(calls, 0);
        setExtensionAuthoringHost(vm, null);
    }
});

test('the disabled Loader host refuses distribution writes', async () => {
    await assert.rejects(applyPlusCatalogSettings(vmFixture(), selection([entry('sample')], [['sample', 'sandboxed', 'remote-cacheable']])), {code: 'LOADER_DISABLED'});
});

test('configure and inspect connect the real core batch API to one project apply without executing JS', async () => {
    let current = await plainSB3();
    const approvals = [];
    const loads = [];
    let controller;
    const vm = Object.assign(new EventEmitter(), {
        extensionManager: {isExtensionLoaded: () => false},
        saveProjectSb3: async () => current.slice().buffer,
        loadProject: async (bytes: ArrayBuffer) => {
            controller.projectLoadStarted();
            loads.push(bytes);
            current = new Uint8Array(bytes);
        }
    });
    controller = createExtensionAuthoringController(vm, {zip: Zip, ports: {
        fetcher: {async fetch(url) { return {bytes: new TextEncoder().encode('globalThis.__catalogAdapterExecuted=true;'), finalURL: url, redirects: []}; }},
        trustProvider: {async authorize(code) { approvals.push([code.id, code.execution, code.source.type]); return {allowed: true, scope: 'digest', sha256: code.sha256}; }}
    }});
    const configured = await controller.configure([
        {id: 'first', url: entry('first').url, distribution: 'embedded-file', execution: 'sandboxed', dependencies: [], version: '1.2.3'},
        {id: 'second', url: entry('second').url, distribution: 'remote-cacheable', execution: 'unsandboxed', dependencies: ['first'], version: '1.2.3'}
    ], undefined);
    assert.deepEqual(approvals, [['first', 'sandboxed', 'embedded-file'], ['second', 'unsandboxed', 'remote-cacheable']]);
    assert.equal(loads.length, 1);
    assert.deepEqual(await controller.inspect(), configured);
    assert.equal(globalThis.__catalogAdapterExecuted, undefined);
    const saved = await Zip.loadAsync(current);
    assert.deepEqual(await saved.file('keep.bin').async('uint8array'), new Uint8Array([1, 3, 7]));
    controller.dispose();
});

test('inspect rejects pending configuration and project changes during asynchronous serialization', async () => {
    const current = await plainSB3();
    const fetching = deferred();
    const resume = deferred();
    const vm = Object.assign(new EventEmitter(), {
        extensionManager: {isExtensionLoaded: () => false},
        saveProjectSb3: async () => current,
        loadProject: async () => {}
    });
    const controller = createExtensionAuthoringController(vm, {zip: Zip, ports: {
        fetcher: {async fetch(url) { fetching.resolve(); await resume.promise; return {bytes: new TextEncoder().encode('/* code */'), finalURL: url, redirects: []}; }},
        trustProvider: {async authorize(code) { return {allowed: true, scope: 'digest', sha256: code.sha256}; }}
    }});
    const pending = controller.configure([{id: 'sample', url: entry('sample').url, distribution: 'remote-cacheable', execution: 'sandboxed'}], undefined);
    await fetching.promise;
    await assert.rejects(controller.inspect(), {code: 'PROJECT_BUSY'});
    resume.resolve();
    await pending;
    const serialized = deferred<typeof current>();
    vm.saveProjectSb3 = () => serialized.promise;
    const inspecting = controller.inspect();
    vm.emit('PROJECT_CHANGED');
    serialized.resolve(current);
    await assert.rejects(inspecting, {code: 'PROJECT_CHANGED'});
    controller.dispose();
});
