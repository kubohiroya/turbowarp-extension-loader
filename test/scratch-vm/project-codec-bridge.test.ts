import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createExtensionLoader} from '@kubohiroya/turbowarp-extension-loader';
import {createProjectIO} from '@kubohiroya/turbowarp-extension-loader/project-codec';
import {editProjectURI, installExtensionLoader} from '@kubohiroya/turbowarp-extension-loader/scratch-vm';

import {vmRequire} from './vm.ts';


const bytes = new TextEncoder().encode('/* verified extension source; never evaluated by this test */');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const spec = {id: 'plus', source: {type: 'remote-cacheable', url: 'https://example.test/extension.js'}, execution: 'unsandboxed', sha256};
const manifest = {schemaVersion: 1, extensions: [spec]};
const Zip = vmRequire('@turbowarp/jszip');

function setup(allow) {
    const events = [];
    let serialized;
    const projectIO = createProjectIO({zip: Zip});
    const loader = createExtensionLoader({
        embeddedReader: projectIO.embeddedReader,
        fetcher: {async fetch(url) { return {bytes, finalURL: url, redirects: []}; }},
        trustProvider: {async authorize(code) {
            events.push('authorize');
            return {allowed: allow, scope: 'digest', sha256: code.sha256};
        }},
        registrar: {
            async begin() { return {
                async register(code) { events.push(['register', code.id]); return {id: code.id}; },
                async commit() { events.push('commit'); },
                async rollback() { events.push('rollback'); }
            }; },
            async unload(ids) { events.push(['unload', ids]); }
        }
    });
    const vm = {
        async loadProject(project) {
            if (project instanceof Uint8Array) {
                const archive = await Zip.loadAsync(project);
                project = JSON.parse(await archive.file('project.json').async('string'));
            }
            serialized = structuredClone(project);
            assert.equal(Object.hasOwn(project, 'turboWarpPlus'), false);
            assert.equal(Object.hasOwn(project.extensionURLs, 'plus'), false);
            await this._loadExtensions(project.extensions, new Map(Object.entries(project.extensionURLs)));
        },
        async _loadExtensions(ids, urls) { events.push(['legacy', [...ids], [...urls]]); },
        toJSON() { return JSON.stringify(serialized); },
        _saveProjectZip() { return new Zip().file('project.json', this.toJSON()); },
        saveProjectSb3DontZip() { return {'project.json': new TextEncoder().encode(this.toJSON())}; }
    };
    const addresses = [];
    const dispose = installExtensionLoader({vm, projectIO, transactionalRegistration: true,
        onProjectURI: uri => addresses.push(uri)}, loader);
    return {vm, loader, dispose, events, addresses};
}

test('core codec and bridge keep pinned remote manifest across save and reopen', async () => {
    const {vm, loader, dispose, events} = setup(true);
    const originalURL = 'https://legacy-metadata.test/plus.js';
    await vm.loadProject({targets: [], extensions: ['plus', 'pen'],
        extensionURLs: {plus: originalURL}, turboWarpPlus: manifest});
    assert.deepEqual(events, ['authorize', ['register', 'plus'], 'commit', ['legacy', ['pen'], []]]);
    const firstSave = JSON.parse(vm.toJSON());
    assert.equal(firstSave.turboWarpPlus.extensions[0].sha256, sha256);
    assert.equal(firstSave.extensionURLs.plus, originalURL);
    assert.deepEqual(firstSave.extensions, ['plus', 'pen']);
    const files = vm.saveProjectSb3DontZip();
    assert.deepEqual(JSON.parse(new TextDecoder().decode(files['project.json'])), firstSave);
    await vm.loadProject(firstSave);
    assert.deepEqual(JSON.parse(vm.toJSON()), firstSave);
    await dispose();
    await loader.unload();
});

test('core trust rejection cannot reach registration or legacy fallback', async () => {
    const {vm, dispose, events} = setup(false);
    await assert.rejects(vm.loadProject({targets: [], extensions: ['plus'], extensionURLs: {}, turboWarpPlus: manifest}),
        {code: 'TRUST_DENIED'});
    assert.deepEqual(events, ['authorize']);
    await dispose();
});

test('embedded ZIP bytes and source survive core verification, GUI ZIP save and reopen', async () => {
    const {vm, loader, dispose, events} = setup(true);
    const embeddedManifest = {schemaVersion: 1, extensions: [{...spec,
        source: {type: 'embedded-file', path: 'extensions/plus.js'}}]};
    const archive = new Zip().file('project.json', JSON.stringify({targets: [], extensions: ['plus', 'pen'],
        extensionURLs: {}, turboWarpPlus: embeddedManifest})).file('extensions/plus.js', bytes);
    await vm.loadProject(await archive.generateAsync({type: 'uint8array', compression: 'DEFLATE'}));
    assert.deepEqual(events, ['authorize', ['register', 'plus'], 'commit', ['legacy', ['pen'], []]]);
    const savedBytes = await vm._saveProjectZip().generateAsync({type: 'uint8array'});
    const saved = await Zip.loadAsync(savedBytes);
    assert.deepEqual(await saved.file('extensions/plus.js').async('uint8array'), bytes);
    const savedProject = JSON.parse(await saved.file('project.json').async('string'));
    assert.equal(savedProject.turboWarpPlus.extensions[0].source.type, 'embedded-file');
    assert.equal(savedProject.turboWarpPlus.extensions[0].sha256, sha256);
    await vm.loadProject(savedBytes);
    assert.equal(JSON.parse(vm.toJSON()).turboWarpPlus.extensions[0].sha256, sha256);
    await dispose();
    await loader.unload();
});

test('URI edits keep other project data and reject a draft after switching projects', async () => {
    const {vm, dispose, addresses} = setup(true);
    const original = {targets: [], extensions: ['pen'], extensionURLs: {}};
    await vm.loadProject(original);
    const edit = editProjectURI(vm);
    assert.equal(edit.uri, '');
    await assert.rejects(edit.apply('https://example.test/project.sb3#fragment'), {code: 'INVALID_PROJECT_URI'});
    assert.deepEqual(JSON.parse(vm.toJSON()), original);
    const uri = 'https://example.test/project.sb3';
    await edit.apply(uri);
    const files = vm.saveProjectSb3DontZip();
    const saved = JSON.parse(new TextDecoder().decode(files['project.json']));
    assert.deepEqual(saved, {...original, turboWarpPlus: {schemaVersion: 1, uri, extensions: []}});
    assert.deepEqual(addresses, [undefined, uri]);
    await vm.loadProject(saved);
    assert.equal(editProjectURI(vm).uri, uri);
    await assert.rejects(edit.apply('https://example.test/stale.sb3'), {code: 'PROJECT_CHANGED'});
    assert.deepEqual(JSON.parse(vm.toJSON()), saved);
    await dispose();
});
