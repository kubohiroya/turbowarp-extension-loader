import {hostError} from './test-errors.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createExtensionLoader} from '@kubohiroya/turbowarp-extension-loader';
import {createVMExtensionRegistrar} from '@kubohiroya/turbowarp-extension-loader/scratch-vm';

import {vmRequire, vmModules} from './vm.ts';

const require = vmRequire;
const VM = require('scratch-vm');
const dispatch = require('scratch-vm/src/dispatch/central-dispatch.js');

const encode = code => new TextEncoder().encode(code);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const extension = (id = 'realfixture', body = '') => `(function(Scratch) {
    if (!Scratch.extensions.unsandboxed || !Scratch.vm.runtime) throw new Error('No privileged VM API');
    Scratch.vm.plusExecuted = (Scratch.vm.plusExecuted || 0) + 1;
    Scratch.extensions.register({
        getInfo() { return {id: '${id}', name: 'Real fixture', blocks: [
            {opcode: 'value', blockType: Scratch.BlockType.REPORTER, text: 'value'},
            {opcode: 'hat', blockType: Scratch.BlockType.HAT, text: 'hat'},
            {opcode: 'loop', blockType: Scratch.BlockType.LOOP, text: 'loop'}
        ]}; },
        value() { return Scratch.vm.plusExecuted; },
        hat() { return false; },
        loop() {},
        dispose() { Scratch.vm.plusDisposed = (Scratch.vm.plusDisposed || 0) + 1; }
    });
    ${body}
})(Scratch);`;

function setup({code = extension(), source = 'embedded', allow = true, registrarOptions, loaderOptions}: {
    code?: string; source?: string; allow?: boolean;
    registrarOptions?: Parameters<typeof createVMExtensionRegistrar>[1];
    loaderOptions?: Parameters<typeof createExtensionLoader>[1];
} = {}) {
    const vm = new VM();
    const bytes = encode(code);
    // The VM modules come from the checkout this VM came from, which is what the editor's GUI
    // passes through the integration: registration reaches the same central dispatch the VM uses.
    const registrar = createVMExtensionRegistrar(vm, {vmModules, ...registrarOptions});
    const sourceSpec = source === 'remote' ? {type: 'remote-cacheable', url: 'https://example.org/exact.js'} :
        {type: 'embedded-file', path: 'extensions/realfixture.js'};
    const spec = {id: 'realfixture', source: sourceSpec, execution: 'unsandboxed', sha256: sha(bytes)};
    const loader = createExtensionLoader({
        registrar,
        embeddedReader: {async read() { return bytes; }},
        fetcher: {async fetch(url) { return {bytes, finalURL: url, redirects: []}; }},
        trustProvider: {async authorize(resolved) { return {allowed: allow, scope: 'digest', sha256: resolved.sha256}; }}
    }, loaderOptions);
    return {vm, loader, registrar, manifest: {schemaVersion: 1, extensions: [spec]}};
}

function clean(vm) {
    vm.runtime.dispose();
}

test('real VM registers and executes authorized Embedded and Remote bytes with Scratch.vm', async () => {
    const beforeGlobal = globalThis.Scratch;
    for (const source of ['embedded', 'remote']) {
        const {vm, loader, manifest} = setup({source});
        const localeListeners = vm.listenerCount('LOCALE_CHANGED');
        try {
            assert.deepEqual((await loader.load(manifest)).ids, ['realfixture']);
            assert.equal(vm.plusExecuted, 1);
            assert.equal(vm.extensionManager.isExtensionLoaded('realfixture'), true);
            assert.equal(vm.runtime.getOpcodeFunction('realfixture_value')({}, {}), 1);
            assert.equal(vm.runtime._hats.realfixture_hat.edgeActivated, true);
            assert.ok(vm.runtime._flowing.realfixture_loop);
            assert.ok(vm.runtime._blockInfo.some(category => category.id === 'realfixture'));
            const service = vm.extensionManager._loadedExtensions.get('realfixture');
            assert.ok(dispatch.services[service]);
            await loader.unload();
            assert.equal(vm.plusDisposed, 1);
            assert.equal(vm.extensionManager.isExtensionLoaded('realfixture'), false);
            assert.equal(vm.runtime.getOpcodeFunction('realfixture_value'), undefined);
            assert.equal(vm.runtime._hats.realfixture_hat, undefined);
            assert.equal(vm.runtime._flowing.realfixture_loop, undefined);
            assert.equal(vm.runtime._blockInfo.some(category => category.id === 'realfixture'), false);
            assert.equal(dispatch.services[service], undefined);
            assert.equal(vm.listenerCount('LOCALE_CHANGED'), localeListeners);
        } finally { clean(vm); }
    }
    assert.equal(globalThis.Scratch, beforeGlobal);
});

test('denied authorization and forged authorization records never evaluate on a real VM', async () => {
    const {vm, loader, registrar, manifest} = setup({allow: false});
    try {
        await assert.rejects(loader.load(manifest), {code: 'TRUST_DENIED'});
        assert.equal(vm.plusExecuted, undefined);
        const transaction = await registrar.begin();
        // A forged record, shaped like an authorization the Loader did not issue.
        const forged = Object.freeze({
            ...manifest.extensions[0], code: extension(),
            authorization: Object.freeze({allowed: true, scope: 'digest', sha256: manifest.extensions[0].sha256})
        });
        await assert.rejects(transaction.register(forged as never), {code: 'INVALID_AUTHORIZATION'});
        await transaction.rollback();
        assert.equal(vm.plusExecuted, undefined);
    } finally { clean(vm); }
});

test('getInfo ID mismatch is rejected before VM tables or services are registered', async () => {
    const {vm, loader, manifest} = setup({code: extension('impostor')});
    const before = Object.keys(dispatch.services);
    const listeners = vm.listenerCount('LOCALE_CHANGED');
    try {
        await assert.rejects(loader.load(manifest), error => hostError(error).cause?.code === 'REGISTRATION_ID_MISMATCH');
        assert.equal(vm.extensionManager._loadedExtensions.size, 0);
        assert.equal(vm.runtime._blockInfo.some(info => info.id === 'impostor'), false);
        assert.equal(vm.plusDisposed, 1);
        assert.equal(vm.listenerCount('LOCALE_CHANGED'), listeners);
        assert.deepEqual(Object.keys(dispatch.services), before);
    } finally { clean(vm); }
});

test('existing custom and core opcode IDs cannot be impersonated or overwritten', async () => {
    const {vm, loader, manifest} = setup();
    try {
        vm.runtime._primitives.realfixture_existing = () => 'keep';
        await assert.rejects(loader.load(manifest), error => hostError(error).cause?.code === 'ID_CONFLICT');
        assert.equal(vm.plusExecuted, undefined);
        assert.equal(vm.runtime._primitives.realfixture_existing(), 'keep');
        delete vm.runtime._primitives.realfixture_existing;
        vm.extensionManager._loadedExtensions.set('realfixture', 'host-owned');
        await assert.rejects(loader.load(manifest), error => hostError(error).cause?.code === 'ID_CONFLICT');
        assert.equal(vm.extensionManager._loadedExtensions.get('realfixture'), 'host-owned');
    } finally { clean(vm); }
});

test('a later extension failure rolls earlier real VM registration back', async () => {
    const {vm, registrar} = setup();
    const scripts = new Map([['first', encode(extension('first'))], ['second', encode(extension('wrong'))]]);
    const loader = createExtensionLoader({
        registrar,
        embeddedReader: {async read(path) { return scripts.get(path.split('/')[1].split('.')[0]); }},
        trustProvider: {async authorize(code) { return {allowed: true, scope: 'digest', sha256: code.sha256}; }}
    });
    try {
        await assert.rejects(loader.load({schemaVersion: 1, extensions: [...scripts].map(([id, bytes]) => ({
            id, source: {type: 'embedded-file', path: `extensions/${id}.js`}, execution: 'unsandboxed', sha256: sha(bytes)
        }))}));
        assert.equal(vm.extensionManager._loadedExtensions.size, 0);
        assert.equal(vm.runtime.getOpcodeFunction('first_value'), undefined);
        assert.equal(vm.runtime._blockInfo.some(info => info.id === 'first'), false);
        assert.equal(vm.plusDisposed, 2);
    } finally { clean(vm); }
});

test('synchronous runtime registration errors restore partial primitives and services', async () => {
    const {vm, loader, manifest} = setup();
    const original = vm.runtime._registerExtensionPrimitives;
    vm.runtime._registerExtensionPrimitives = function(info) {
        original.call(this, info);
        throw new Error('registration observer failed');
    };
    try {
        await assert.rejects(loader.load(manifest));
        assert.equal(vm.runtime.getOpcodeFunction('realfixture_value'), undefined);
        assert.equal(vm.extensionManager.isExtensionLoaded('realfixture'), false);
        assert.equal(vm.runtime._blockInfo.some(info => info.id === 'realfixture'), false);
        assert.equal(Object.keys(dispatch.services).some(key => key.endsWith('.realfixture')), false);
    } finally { clean(vm); }
});

test('a script that does not register times out and closes its scoped registration API', async () => {
    const code = 'Scratch.vm.lateRegister = () => Scratch.extensions.register({getInfo(){return {id:"realfixture"}}});';
    const {vm, loader, manifest} = setup({code, registrarOptions: {registrationTimeoutMs: 10}});
    const listeners = vm.listenerCount('LOCALE_CHANGED');
    try {
        await assert.rejects(loader.load(manifest), error => hostError(error).cause?.code === 'REGISTRATION_TIMEOUT' &&
            hostError(error).cause.extensionId === 'realfixture');
        assert.throws(vm.lateRegister, {code: 'REGISTRATION_CLOSED'});
        assert.equal(vm.listenerCount('LOCALE_CHANGED'), listeners);
        assert.equal(vm.extensionManager._loadedExtensions.size, 0);
    } finally { clean(vm); }
});

test('an extension that throws while registering is named in the failure', async () => {
    const {vm, loader, manifest} = setup({code: 'throw new Error("Fixture must run unsandboxed.");'});
    try {
        await assert.rejects(loader.load(manifest), error => hostError(error).cause?.extensionId === 'realfixture' &&
            hostError(error).cause.message === 'Fixture must run unsandboxed.');
    } finally { clean(vm); }
});

test('a load that times out while an extension registers reports the timeout, not a cancellation', async () => {
    const {vm, loader, manifest} = setup({code: 'Scratch.vm.neverRegisters = true;',
        registrarOptions: {registrationTimeoutMs: 5000}, loaderOptions: {timeoutMs: 20}});
    try {
        await assert.rejects(loader.load(manifest), error => hostError(error).cause?.code === 'CANCELLED' &&
            hostError(error).cause.extensionId === 'realfixture' && hostError(error).cause.cause?.code === 'TIMEOUT');
    } finally { clean(vm); }
});

test('cancellation while waiting for asynchronous registration cannot register late', async () => {
    const code = 'Scratch.vm.lateRegister = () => Scratch.extensions.register({getInfo(){return {id:"realfixture"}}});';
    const {vm, loader, manifest} = setup({code});
    const controller = new AbortController();
    try {
        const loading = loader.load(manifest, {signal: controller.signal});
        while (!vm.lateRegister) await new Promise(resolve => setImmediate(resolve));
        controller.abort();
        await assert.rejects(loading);
        assert.throws(vm.lateRegister, {code: 'REGISTRATION_CLOSED'});
        assert.equal(vm.extensionManager._loadedExtensions.size, 0);
    } finally { clean(vm); }
});

test('asynchronous registration and VM permission helpers preserve scoped behavior', async () => {
    const code = `
        Scratch.vm.scopedAPI = Scratch;
        Promise.resolve().then(() => {
            Scratch.extensions.register({getInfo(){ return {id:'realfixture',blocks:[]}; }});
        });
    `;
    const {vm, loader, manifest} = setup({code});
    const requested = [];
    const guiAPI = {hostOwned: true};
    vm.on('CREATE_UNSANDBOXED_EXTENSION_API', Scratch => { Scratch.gui = guiAPI; });
    vm.securityManager.canFetch = async url => { requested.push(url); return false; };
    vm.securityManager.canRecordAudio = async () => false;
    try {
        await loader.load(manifest);
        assert.equal(vm.scopedAPI.gui, guiAPI);
        assert.equal(await vm.scopedAPI.canFetch('https://example.org/a'), false);
        assert.deepEqual(requested, ['https://example.org/a']);
        assert.equal(await vm.scopedAPI.canFetch('data:text/plain,local'), true);
        assert.equal(await vm.scopedAPI.canOpenWindow('javascript:alert(1)'), false);
        assert.equal(await vm.scopedAPI.canRecordAudio(), false);
        await assert.rejects(vm.scopedAPI.fetch('https://example.org/a'), {code: 'PERMISSION_DENIED'});
        await loader.unload();
        assert.throws(() => vm.scopedAPI.extensions.register({}), {code: 'REGISTRATION_CLOSED'});
    } finally { clean(vm); }
});

test('multiple registrations are rejected without partial VM registration', async () => {
    const code = `Scratch.extensions.register({getInfo(){ return {id:'realfixture',blocks:[]}; }});
        Scratch.extensions.register({getInfo(){ return {id:'otherfixture',blocks:[]}; }});`;
    const {vm, loader, manifest} = setup({code});
    try {
        await assert.rejects(loader.load(manifest), error => hostError(error).cause?.code === 'REGISTRATION_FAILED');
        assert.equal(vm.extensionManager._loadedExtensions.size, 0);
        assert.equal(vm.runtime._blockInfo.length, 0);
    } finally { clean(vm); }
});

test('unload failure removes VM registration and poisons the host for explicit recovery', async () => {
    const code = extension().replace('dispose() {', 'dispose() { throw new Error("dispose failed");');
    const {vm, loader, registrar, manifest} = setup({code});
    try {
        await loader.load(manifest);
        await assert.rejects(loader.unload(), {code: 'UNLOAD_FAILED'});
        assert.equal(vm.extensionManager.isExtensionLoaded('realfixture'), false);
        assert.equal(vm.runtime.getOpcodeFunction('realfixture_value'), undefined);
        await assert.rejects(registrar.begin(), {code: 'HOST_RECOVERY_REQUIRED'});
    } finally { clean(vm); }
});

test('the VM-owned service port refuses foreign services and detects provider replacement', () => {
    const vm = new VM();
    const port = vm.extensionManager.getExtensionServicePort();
    const provider = {};
    const name = 'unsandboxed.999.portfixture';
    try {
        assert.equal(port, vm.extensionManager.getExtensionServicePort());
        assert.equal(port.get('runtime'), undefined);
        assert.throws(() => port.set('runtime', provider));
        assert.throws(() => port.remove('runtime', vm.runtime));
        port.set(name, provider);
        assert.equal(port.get(name), provider);
        assert.throws(() => port.set(name, {}));
        dispatch.services[name] = {};
        assert.throws(() => port.get(name), /ownership changed/);
        assert.throws(() => port.remove(name, provider), /ownership changed/);
        dispatch.services[name] = provider;
        port.remove(name, provider);
        assert.equal(dispatch.services[name], undefined);
    } finally { delete dispatch.services[name]; clean(vm); }
});

test('an unpatched separately bundled VM fails closed instead of using foreign dispatch', () => {
    const vm = new VM();
    const original = dispatch.services.runtime;
    vm.extensionManager.getExtensionServicePort = undefined;
    try {
        dispatch.services.runtime = {};
        assert.throws(() => createVMExtensionRegistrar(vm, {vmModules}), {code: 'UNSUPPORTED_HOST'});
    } finally { dispatch.services.runtime = original; clean(vm); }
});

test('custom extension commands run through the actual TurboWarp compiler compatibility path', async () => {
    const code = `Scratch.extensions.register({
        getInfo(){return {id:'realfixture',blocks:[{opcode:'record',blockType:Scratch.BlockType.COMMAND,text:'record'}]};},
        record(){Scratch.vm.compiledCalls=(Scratch.vm.compiledCalls||0)+1;}
    });`;
    const {vm, loader, manifest} = setup({code});
    try {
        await vm.loadProject(JSON.stringify({targets: [{isStage: true, name: 'Stage', variables: {}, lists: {},
            broadcasts: {}, blocks: {}, comments: {}, currentCostume: 0, costumes: [], sounds: [], volume: 100,
            layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null}],
        monitors: [], extensions: [], meta: {semver:'3.0.0',vm:'0.2.0',agent:'compiler test'}}));
        await loader.load(manifest);
        const stage = vm.runtime.getTargetForStage();
        stage.blocks.createBlock({id:'flag',opcode:'event_whenflagclicked',next:'call',parent:null,
            inputs:{},fields:{},shadow:false,topLevel:true,x:0,y:0});
        stage.blocks.createBlock({id:'call',opcode:'realfixture_record',next:null,parent:'flag',
            inputs:{},fields:{},shadow:false,topLevel:false});
        vm.setCompilerOptions({enabled:true});
        vm.greenFlag();
        const thread = vm.runtime.threads.find(item => item.topBlock === 'flag');
        assert.ok(thread);
        for (let i = 0; i < 5 && !vm.compiledCalls; i++) vm.runtime._step();
        assert.equal(thread.triedToCompile, true);
        assert.equal(thread.isCompiled, true);
        assert.equal(vm.compiledCalls, 1);
        await loader.unload();
        assert.equal(vm.runtime.threads.length, 0);
        assert.equal(vm.runtime.getOpcodeFunction('realfixture_record'), undefined);
    } finally { clean(vm); }
});

const selfPublishing = (id = 'realfixture') => `(function(Scratch) {
    class Ext {
        constructor() { Scratch.vm.runtime['ext_${id}'] = this; }
        getInfo() { return {id: '${id}', name: 'Self', blocks: [{opcode: 'value', blockType: Scratch.BlockType.REPORTER, text: 'value'}]}; }
        value() { return 1; }
    }
    Scratch.extensions.register(new Ext());
})(Scratch);`;

test('an extension that publishes itself at runtime.ext_<id> registers, and rollback removes only that object', async () => {
    const {vm, loader, manifest} = setup({code: selfPublishing()});
    try {
        assert.deepEqual((await loader.load(manifest)).ids, ['realfixture']);
        const object = vm.runtime.ext_realfixture;
        assert.ok(object && typeof object.getInfo === 'function');
        assert.equal(vm.extensionManager.isExtensionLoaded('realfixture'), true);
        await loader.unload();
        assert.equal(Object.hasOwn(vm.runtime, 'ext_realfixture'), false);
    } finally { clean(vm); }
});

test('a different pre-existing runtime.ext_<id> still conflicts and is left intact', async () => {
    const {vm, loader, manifest} = setup({code: selfPublishing()});
    const foreign = {host: true};
    try {
        vm.runtime.ext_realfixture = foreign;
        await assert.rejects(loader.load(manifest), error => hostError(error).cause?.code === 'ID_CONFLICT');
        assert.equal(vm.runtime.ext_realfixture, foreign);
    } finally { clean(vm); }
});

test('a foreign object placed at runtime.ext_<id> during evaluation conflicts and survives rollback', async () => {
    const code = `(function(Scratch) {
        Scratch.vm.runtime.ext_realfixture = {foreign: true};
        Scratch.extensions.register({getInfo() { return {id: 'realfixture', name: 'X', blocks: []}; }});
    })(Scratch);`;
    const {vm, loader, manifest} = setup({code});
    try {
        await assert.rejects(loader.load(manifest), error => hostError(error).cause?.code === 'ID_CONFLICT');
        assert.deepEqual(vm.runtime.ext_realfixture, {foreign: true});
        assert.equal(vm.extensionManager.isExtensionLoaded('realfixture'), false);
    } finally { clean(vm); }
});
