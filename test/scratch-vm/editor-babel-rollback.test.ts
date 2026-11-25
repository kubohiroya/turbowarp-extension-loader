// SPDX-License-Identifier: GPL-3.0-or-later
// From turbowarp-plus-editor/test/extension-host/babel-rollback.test.ts at 9c4d28d.
// The original test license is retained; see ../LICENSE.GPL-3.0.
import {hostError} from './test-errors.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createExtensionLoader as nativeLoader} from '@kubohiroya/turbowarp-extension-loader';

import {vmRequire, vmModules} from './vm.ts';

const require = vmRequire;
// The registrar's own import has to be the same copy of the Loader this test loads, or an
// authorization record issued by one copy is refused by the other — which is also why the site
// build resolves this package to a single copy.
const localRequire = createRequire(import.meta.url);
const VM = require('scratch-vm');

const {transformSync} = require('@babel/core');
// Resolve the built public entry, like a consumer; the registrar shares that core instance.
const loaderEntry = localRequire.resolve('@kubohiroya/turbowarp-extension-loader');
const source = await readFile(loaderEntry, 'utf8');
// Match the shared core's actual webpack 4 transpilation settings.
const {code: transpiled} = transformSync(source, {babelrc: false, configFile: false,
    presets: [[require.resolve('@babel/preset-env'), {targets: {ie: '11'}, modules: false}]]});
// A data: URL has no base to resolve the core's own relative imports against, so pin them to the package.
const code = transpiled.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,
    (match, quote, name) => `from '${new URL(name, pathToFileURL(loaderEntry)).href}'`);
const {createExtensionLoader: transpiledLoader} = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
// The registrar as the Loader publishes it, next to the core it imports: its relative import of
// the core is pinned to that same file, so both are the one copy loaded above.
const registrarFile = new URL('registrar.js', pathToFileURL(localRequire.resolve('@kubohiroya/turbowarp-extension-loader/scratch-vm')));
const registrarSource = (await readFile(registrarFile, 'utf8'))
    .replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (match, quote, name) => `from '${new URL(name, registrarFile).href}'`);
const {code: registrarCode} = transformSync(registrarSource, {babelrc: false, configFile: false,
    presets: [[require.resolve('@babel/preset-env'), {targets: {ie: '11'}, modules: false}]]});
const {createVMExtensionRegistrar: transpiledRegistrar} = await import(
    `data:text/javascript;base64,${Buffer.from(registrarCode).toString('base64')}`);
const bytes = new TextEncoder().encode('registration fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const manifest = {schemaVersion: 1, extensions: [{id: 'sample', execution: 'unsandboxed',
    source: {type: 'embedded-file', path: 'extensions/sample.js'}, sha256}]};

for (const [variant, createLoader] of [['native', nativeLoader], ['webpack4', transpiledLoader]]) {
    test(`${variant}: registration rejection with successful cleanup stays reusable`, async () => {
        const registrationError = Object.assign(new Error('getInfo ID mismatch'), {code: 'REGISTRATION_ID_MISMATCH'});
        let rejectRegistration = true;
        let rollbacks = 0;
        let commits = 0;
        const loader = createLoader({
            embeddedReader: {async read() { return bytes; }},
            trustProvider: {async authorize() { return {allowed: true, scope: 'digest', sha256}; }},
            registrar: {
                async begin() {
                    return {
                        async register(authorized) {
                            if (rejectRegistration) throw registrationError;
                            return {id: authorized.id};
                        },
                        async commit() { commits++; },
                        async rollback() { rollbacks++; }
                    };
                },
                async unload() {}
            }
        });
        await assert.rejects(loader.load(manifest), error => {
            assert.equal(hostError(error).code, 'LOAD_FAILED');
            assert.equal(hostError(error).cause, registrationError);
            return true;
        });
        assert.equal(rollbacks, 1);
        assert.deepEqual(loader.getState(), {status: 'idle', ids: []});
        rejectRegistration = false;
        await loader.load(manifest);
        assert.equal(commits, 1);
        assert.deepEqual(loader.getState(), {status: 'loaded', ids: ['sample']});
        await loader.unload();
    });

    test(`${variant}: actual cleanup failure retains both errors and requires recovery`, async () => {
        const registrationError = new Error('Registration failed');
        const cleanupError = new Error('Cleanup failed');
        let rollbacks = 0;
        const loader = createLoader({
            embeddedReader: {async read() { return bytes; }},
            trustProvider: {async authorize() { return {allowed: true, scope: 'digest', sha256}; }},
            registrar: {
                async begin() {
                    return {
                        async register() { throw registrationError; },
                        async commit() {},
                        async rollback() { rollbacks++; throw cleanupError; }
                    };
                },
                async unload() {}
            }
        });
        await assert.rejects(loader.load(manifest), error => {
            assert.equal(hostError(error).code, 'ROLLBACK_FAILED');
            assert.equal(hostError((hostError(error).cause as AggregateError).errors[0]).cause, registrationError);
            assert.equal((hostError(error).cause as AggregateError).errors[1], cleanupError);
            return true;
        });
        assert.equal(rollbacks, 1);
        assert.equal(loader.getState().status, 'failed');
        await assert.rejects(loader.unload(), {code: 'HOST_RECOVERY_REQUIRED'});
        await assert.rejects(loader.load(manifest), {code: 'BUSY'});
        assert.equal(rollbacks, 1);
    });
}

for (const execution of ['unsandboxed', 'sandboxed']) {
    test(`webpack4 registrar: ${execution} registration failure with clean rollback can retry`, async () => {
        const vm = new VM();
        let sandboxDisposals = 0;
        if (execution === 'sandboxed') {
            const port = vm.extensionManager.getExtensionServicePort();
            vm.extensionManager.getExtensionServicePort = () => ({...port, async loadSandboxed() {
                return {id: 'sample', service: 'extension.123.0', workerId: 123,
                    info: {id: 'sample', name: 'Sample', blocks: []},
                    dispose() { sandboxDisposals++; }};
            }});
        }
        const originalRegister = vm.runtime._registerExtensionPrimitives;
        const registrationError = new Error('Deliberate primitive registration failure');
        vm.runtime._registerExtensionPrimitives = () => { throw registrationError; };
        const codeBytes = new TextEncoder().encode('Scratch.extensions.register({getInfo(){return {id:"sample",name:"Sample",blocks:[]}}});');
        const sha256 = createHash('sha256').update(codeBytes).digest('hex');
        const loader = nativeLoader({embeddedReader: {async read() { return codeBytes; }},
            trustProvider: {async authorize() { return {allowed: true, scope: 'digest', sha256}; }},
            registrar: transpiledRegistrar(vm, {vmModules})});
        const request = {schemaVersion: 1, extensions: [{id: 'sample', execution, sha256,
            source: {type: 'embedded-file', path: 'extensions/sample.js'}}]};
        try {
            await assert.rejects(loader.load(request), error => {
                assert.equal(hostError(error).code, 'LOAD_FAILED');
                assert.equal(hostError(error).cause, registrationError);
                return true;
            });
            assert.equal(vm.extensionManager.isExtensionLoaded('sample'), false);
            vm.runtime._registerExtensionPrimitives = originalRegister;
            await loader.load(request);
            assert.equal(vm.extensionManager.isExtensionLoaded('sample'), true);
            await loader.unload();
            assert.equal(vm.extensionManager.isExtensionLoaded('sample'), false);
            if (execution === 'sandboxed') assert.equal(sandboxDisposals, 2);
        } finally { vm.runtime.dispose(); }
    });
}
