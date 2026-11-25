// SPDX-License-Identifier: GPL-3.0-or-later
// From turbowarp-plus-editor/test/extension-host/project-cache.test.ts at 8271124.
// The original test license is retained; see ../LICENSE.GPL-3.0.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Zip from '@turbowarp/jszip';
import {createProjectIO} from '@kubohiroya/turbowarp-extension-loader/project-codec';
import {installExtensionLoader} from '@kubohiroya/turbowarp-extension-loader/scratch-vm';

// Editor #741: save-time project addressing through the real codec and a VM stand-in.
const kept = 'https://published.example/works/kept.sb3';
const url = 'https://cdn.example.test/npm/@owner/example@1.0.0/dist/example.js';
const code = new TextEncoder().encode(
    "Scratch.extensions.register({getInfo(){return {id:'example',name:'Example',blocks:[]}}});");
const sha256 = createHash('sha256').update(code).digest('hex');
const spec = {id: 'example', source: {type: 'remote-cacheable', url}, execution: 'unsandboxed', sha256};

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"></svg>';
const assetId = createHash('md5').update(svg).digest('hex');
const sb3 = (manifest, extensions = manifest ? manifest.extensions.map(item => item.id) : []) => new Zip()
    .file('project.json', JSON.stringify({targets: [{isStage: true, name: 'Stage', variables: {}, lists: {},
        broadcasts: {}, blocks: {}, comments: {}, currentCostume: 0, sounds: [], volume: 100, layerOrder: 0,
        tempo: 60, costumes: [{name: 'Blank', assetId, dataFormat: 'svg', md5ext: `${assetId}.svg`,
            rotationCenterX: 240, rotationCenterY: 180}], videoTransparency: 50, videoState: 'off',
        textToSpeechLanguage: null}], monitors: [], extensions,
    meta: {semver: '3.0.0', vm: '2.0.0', agent: 'cache fixture'}, ...(manifest ? {turboWarpPlus: manifest} : {})}))
    .file(`${assetId}.svg`, svg)
    .generateAsync({type: 'uint8array'});
const remote = (uri?: string) => ({schemaVersion: 1, ...(uri ? {uri} : {}), extensions: [spec]});

function bridge({manifest, addressProject}) {
    const projectIO = createProjectIO({zip: Zip});
    let serialized;
    const vm = {
        async loadProject(project) {
            const archive = await Zip.loadAsync(project);
            serialized = JSON.parse(await archive.file('project.json').async('string'));
            await this._loadExtensions(new Set(serialized.extensions), new Map());
        },
        async _loadExtensions() {},
        toJSON(target?: string) { return target ? '{"sprite":true}' : JSON.stringify(serialized); },
        _saveProjectZip() { return new Zip().file('project.json', this.toJSON()); },
        saveProjectSb3DontZip() { return {'project.json': new TextEncoder().encode(this.toJSON())}; }
    };
    const loader = {async load (input) { return {ids: input.extensions.map(item => item.id)}; }, async unload () {}};
    const told = [];
    let issued = 0;
    installExtensionLoader({vm, projectIO, transactionalRegistration: true, onProjectURI: uri => told.push(uri),
        addressProject: addressProject && (() => {
            issued++;
            return addressProject(issued);
        })}, loader);
    const uriOf = json => JSON.parse(json).turboWarpPlus?.uri;
    return {vm, told, issued: () => issued, uriOf, load: async () => vm.loadProject(await sb3(manifest))};
}

const address = n => `https://editor.example/turbowarp-plus-projects/aa/00aa/0193f0a1-2b3c-7d4e-8f01-00000000000${n}.sb3`;

test('a manifest without an address is given one at the first save, and keeps it on the next', async () => {
    const f = bridge({manifest: remote(), addressProject: address});
    await f.load();
    assert.deepEqual(f.told, [undefined]);
    assert.equal(f.issued(), 0, 'opening a project names nothing');
    const first = f.uriOf(f.vm.toJSON());
    assert.equal(first, address(1));
    assert.equal(f.uriOf(f.vm.toJSON()), first);
    // The ZIP and file saves serialize through toJSON and restore with the same context.
    const zip = await Zip.loadAsync(await f.vm._saveProjectZip().generateAsync({type: 'uint8array'}));
    assert.equal(f.uriOf(await zip.file('project.json').async('string')), first);
    assert.equal(f.uriOf(new TextDecoder().decode(f.vm.saveProjectSb3DontZip()['project.json'])), first);
    assert.equal(f.issued(), 1);
    assert.deepEqual(f.told, [undefined, first], 'the cache hears the new address once');
});

test('the first save may be a ZIP or file save; a sprite export is never addressed', async () => {
    const f = bridge({manifest: remote(), addressProject: address});
    await f.load();
    assert.equal(f.vm.toJSON('sprite'), '{"sprite":true}');
    assert.equal(f.issued(), 0);
    const files = f.vm.saveProjectSb3DontZip();
    assert.equal(f.uriOf(new TextDecoder().decode(files['project.json'])), address(1));
    assert.equal(f.uriOf(f.vm.toJSON()), address(1));
    assert.equal(f.issued(), 1);
});

test('an address the project already has is never overwritten', async () => {
    const f = bridge({manifest: remote(kept), addressProject: address});
    await f.load();
    assert.equal(f.uriOf(f.vm.toJSON()), kept);
    assert.equal(f.uriOf(f.vm.toJSON()), kept);
    assert.equal(f.issued(), 0);
    assert.deepEqual(f.told, [kept]);
});

test('a project without a manifest is given nothing, and neither is one on a host that makes no address', async () => {
    const plain = bridge({manifest: null, addressProject: address});
    await plain.load();
    assert.equal(plain.uriOf(plain.vm.toJSON()), undefined);
    assert.equal(JSON.parse(plain.vm.toJSON()).turboWarpPlus, undefined);
    assert.equal(plain.issued(), 0);
    const none = bridge({manifest: remote(), addressProject: null});
    await none.load();
    assert.equal(none.uriOf(none.vm.toJSON()), undefined);
});

test('reopening forgets the address given to the previous project', async () => {
    const f = bridge({manifest: remote(), addressProject: address});
    await f.load();
    assert.equal(f.uriOf(f.vm.toJSON()), address(1));
    await f.load();
    assert.equal(f.told.at(-1), undefined);
    assert.equal(f.uriOf(f.vm.toJSON()), address(2), 'a different project opened later is its own');
});
