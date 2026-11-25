// SPDX-License-Identifier: GPL-3.0-or-later
// From turbowarp-plus-editor/test/extension-host/project-uri.test.ts at 439f0c8.
// The original test license is retained; see ../LICENSE.GPL-3.0.
import type {PreparedExtensionAddition, ExtensionAdditionOptions} from '@kubohiroya/turbowarp-extension-loader/project-authoring';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import Zip from '@turbowarp/jszip';
import {createExtensionAuthoringController} from '@kubohiroya/turbowarp-extension-loader/scratch-vm';

/**
 * A project gets its address when its manifest is first written (issue #55, stage 1): adding an
 * extension or keeping one through the catalog. The address is made from where the editor was
 * opened, only over HTTPS, and never replaces one the project already has.
 */

const UUID = '0193f0a1-2b3c-7d4e-8f01-2233445566aa';
const SHAPE = /^https:\/\/editor\.example\/turbowarp-plus-projects\/([0-9a-f]{2})\/([0-9a-f]{4})\/([0-9a-f-]{36})\.sb3$/;
const existing = 'https://published.example/works/kept.sb3';

const sb3 = manifest => new Zip().file('project.json', JSON.stringify({targets: [], monitors: [], extensions: [],
    ...(manifest ? {turboWarpPlus: manifest} : {})})).generateAsync({type: 'uint8array'});

function fixture({origin, project, uuids = [UUID]}) {
    const calls: ExtensionAdditionOptions[] = [];
    let controller: ReturnType<typeof createExtensionAuthoringController>;
    const vm = Object.assign(new EventEmitter(), {
        saveProjectSb3: async () => project,
        loadProject: async () => controller.projectLoadStarted(undefined),
        extensionManager: {isExtensionLoaded: () => false}
    });
    const prepare = async (input, request, ports, options: ExtensionAdditionOptions) => {
        calls.push(options);
        return {spec: {id: 'example'}, projectBytes: new Uint8Array([2])} as PreparedExtensionAddition;
    };
    let issued = 0;
    controller = createExtensionAuthoringController(vm, {prepareAddition: prepare, zip: Zip, origin,
        createUUID: () => uuids[issued++]});
    return {controller, calls, prepare, issued: () => issued};
}

test('a project without an address is given one under the HTTPS origin, in the agreed shape', async () => {
    const {controller, calls, issued} = fixture({origin: 'https://editor.example', project: await sb3(null)});
    await controller.add({id: 'example'}, undefined);
    assert.equal(issued(), 1);
    const match = SHAPE.exec(calls[0].uri);
    assert.ok(match, calls[0].uri);
    assert.equal(match[3], UUID);
    assert.equal(match[2], UUID.replaceAll('-', '').slice(-4));
    assert.equal(match[1], match[2].slice(0, 2));
    controller.dispose();
});

test('a manifest without an address is addressed too; a path in the origin is ignored', async () => {
    const {controller, calls} = fixture({origin: 'https://editor.example/turbowarp-plus-editor/editor.html',
        project: await sb3({schemaVersion: 1, extensions: []})});
    await controller.add({id: 'example'}, undefined);
    assert.match(calls[0].uri, SHAPE);
    controller.dispose();
});

test('an existing address is never overwritten: nothing is passed and the Loader keeps it', async () => {
    const {controller, calls, issued, prepare} = fixture({origin: 'https://editor.example',
        project: await sb3({schemaVersion: 1, uri: existing, extensions: []})});
    await controller.add({id: 'example'}, undefined);
    // `configure` is `apply` with the catalog's preparation; the stand-in takes its place here.
    await controller.apply([{id: 'example', url: 'https://x.example/e.js', distribution: 'remote-cacheable', execution: 'sandboxed'}],
        {}, prepare);
    assert.equal(issued(), 0);
    assert.deepEqual(calls.map(options => Object.hasOwn(options, 'uri')), [false, false]);
    controller.dispose();
});

test('no address is made on a non-HTTPS origin, or without an origin', async () => {
    for (const origin of ['http://localhost:8080', 'http://127.0.0.1', 'null', 'file://', undefined]) {
        const {controller, calls, issued} = fixture({origin, project: await sb3(null)});
        await controller.add({id: 'example'}, undefined);
        assert.equal(issued(), 0, String(origin));
        assert.equal(Object.hasOwn(calls[0], 'uri'), false, String(origin));
        controller.dispose();
    }
});

test('a catalog selection that keeps nothing introduces no address', async () => {
    const {controller, calls, issued, prepare} = fixture({origin: 'https://editor.example', project: await sb3(null)});
    await controller.apply([], {}, prepare);
    assert.equal(issued(), 0);
    assert.equal(Object.hasOwn(calls[0], 'uri'), false);
    controller.dispose();
});
