import type {PreparedExtensionAddition} from '@kubohiroya/turbowarp-extension-loader/project-authoring';
import {hostError} from './test-errors.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import Zip from '@turbowarp/jszip';
import {createExtensionAuthoringController} from '@kubohiroya/turbowarp-extension-loader/scratch-vm';
const spec = {id: 'example', sha256: 'a'.repeat(64)};
const prepared = {spec, projectBytes: new Uint8Array([2])};
const deferred = <Value>() => {
    let resolve: (value: Value) => void;
    let reject: (reason: unknown) => void;
    const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
};
function fixture(
    prepareAddition: () => Promise<typeof prepared> = async () => prepared,
    loadResult: (bytes: Uint8Array, count: number) => Promise<void> = async () => {}
) {
    const original = new Uint8Array([1]);
    const loads = [];
    let controller;
    const vm = Object.assign(new EventEmitter(), {
        saveProjectSb3: async () => original,
        loadProject: (bytes: Uint8Array) => {
            controller.projectLoadStarted(bytes);
            loads.push(bytes);
            return loadResult(bytes, loads.length);
        }
    });
    // This stub only returns the candidate bytes and the result read by the controller.
    controller = createExtensionAuthoringController(vm, {zip: Zip,
        prepareAddition: async () => await prepareAddition() as PreparedExtensionAddition
    });
    return {vm, original, loads, controller};
}

test('authoring applies only the core-approved candidate and marks the project dirty', async () => {
    const stage = deferred<typeof prepared>();
    const {vm, loads, controller} = fixture(() => stage.promise);
    let dirty = 0;
    vm.on('PROJECT_CHANGED', () => dirty++);
    const adding = controller.add({id: 'example'}, undefined);
    await Promise.resolve();
    assert.equal(loads.length, 0);
    await assert.rejects(controller.add({id: 'other'}, undefined), {code: 'PROJECT_BUSY'});
    stage.resolve(prepared);
    assert.equal(await adding, spec);
    assert.deepEqual(loads, [prepared.projectBytes]);
    assert.equal(dirty, 1);
    controller.dispose();
});

test('denied approval never mutates the VM', async () => {
    const {loads, controller} = fixture(async () => { throw Object.assign(new Error('Denied'), {code: 'TRUST_DENIED'}); });
    await assert.rejects(controller.add({id: 'example'}, undefined), {code: 'TRUST_DENIED'});
    assert.equal(loads.length, 0);
    controller.dispose();
});

test('a deferred own load stays authorized while a different deferred project still cancels it', async () => {
    for (const replace of [false, true]) {
        const loading = deferred<void>();
        const {vm, loads, controller} = fixture(undefined, () => loading.promise);
        const original = vm.loadProject;
        vm.loadProject = bytes => Promise.resolve().then(() => original(bytes));
        const adding = controller.add({id: 'example'}, undefined);
        while (!loads.length) await Promise.resolve();
        if (replace) {
            const replacing = vm.loadProject(new Uint8Array([9]));
            await Promise.resolve();
            loading.resolve();
            await replacing;
            await assert.rejects(adding, {code: 'PROJECT_CHANGED'});
            assert.equal(loads.length, 2);
        } else {
            loading.resolve();
            assert.equal(await adding, spec);
            assert.deepEqual(loads, [prepared.projectBytes]);
        }
        controller.dispose();
    }
});

test('registration failure restores the original SB3', async () => {
    const {original, loads, controller} = fixture(undefined, async (bytes, count) => {
        if (count === 1) throw Object.assign(new Error('Wrong ID'), {code: 'REGISTRATION_ID_MISMATCH'});
    });
    await assert.rejects(controller.add({id: 'example'}, undefined), {code: 'REGISTRATION_ID_MISMATCH'});
    assert.deepEqual(loads, [prepared.projectBytes, original]);
    controller.dispose();
});

test('failed recovery retains the original SB3 for explicit download', async () => {
    const {original, controller} = fixture(undefined, async () => { throw new Error('Registration failed'); });
    await assert.rejects(controller.add({id: 'example'}, undefined), error => {
        assert.equal(hostError(error).code, 'PROJECT_RECOVERY_REQUIRED');
        assert.ok(error instanceof Error && 'originalProject' in error);
        assert.equal(error.originalProject, original);
        return true;
    });
    controller.dispose();
});

test('project edits and project switches cancel pending preparation without restoring stale data', async () => {
    for (const change of ['edit', 'switch']) {
        const stage = deferred<typeof prepared>();
        const {vm, loads, controller} = fixture(() => stage.promise);
        const adding = controller.add({id: 'example'}, undefined);
        await Promise.resolve();
        if (change === 'edit') vm.emit('PROJECT_CHANGED');
        else await vm.loadProject(new Uint8Array([9]));
        stage.resolve(prepared);
        await assert.rejects(adding, {code: 'PROJECT_CHANGED'});
        assert.equal(loads.length, change === 'edit' ? 0 : 1);
        controller.dispose();
    }
});

test('a newer queued project is not overwritten after candidate loading fails', async () => {
    const loading = deferred<void>();
    const {vm, loads, controller} = fixture(undefined, async (bytes, count) => {
        if (count === 1) return loading.promise;
    });
    const adding = controller.add({id: 'example'}, undefined);
    while (loads.length === 0) await Promise.resolve();
    await vm.loadProject(new Uint8Array([9]));
    loading.reject(new Error('Registration failed'));
    await assert.rejects(adding);
    assert.equal(loads.length, 2);
    assert.deepEqual(loads[1], new Uint8Array([9]));
    controller.dispose();
});

test('abort and disposal invalidate prepared candidates', async () => {
    for (const action of ['abort', 'dispose']) {
        const stage = deferred<typeof prepared>();
        const {loads, controller} = fixture(() => stage.promise);
        const signal = new AbortController();
        const adding = controller.add({id: 'example'}, {signal: signal.signal});
        await Promise.resolve();
        if (action === 'abort') signal.abort();
        else controller.dispose();
        stage.resolve(prepared);
        await assert.rejects(adding, {code: 'PROJECT_CHANGED'});
        assert.equal(loads.length, 0);
        controller.dispose();
    }
});


test('a change the Loader could not prepare is reported, so a waiting indicator comes down', async () => {
    const events = [];
    const vm = Object.assign(new EventEmitter(), {
        saveProjectSb3: async () => new Uint8Array([1]),
        loadProject: async () => assert.fail('nothing is loaded')
    });
    const failed = Object.assign(new Error('Catalog extension could not be fetched'),
        {code: 'LOAD_FAILED', extensionId: 'example'});
    const controller = createExtensionAuthoringController(vm, {zip: Zip,
        prepareAddition: async () => { throw failed; }, diagnostics: event => events.push(event)});
    await assert.rejects(controller.add({id: 'example'}, undefined), error => error === failed);
    assert.deepEqual(events, [{type: 'error', code: 'LOAD_FAILED', id: 'example',
        message: 'Catalog extension could not be fetched'}]);
    controller.dispose();
    // Showing it cannot change the outcome.
    const quiet = createExtensionAuthoringController(vm, {zip: Zip,
        prepareAddition: async () => { throw failed; }, diagnostics: () => { throw new Error('presentation'); }});
    await assert.rejects(quiet.add({id: 'example'}, undefined), error => error === failed);
    quiet.dispose();
});
