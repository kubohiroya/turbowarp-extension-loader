import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {createProjectIO, inspectZip} from '../src/project-codec.js';
const require = createRequire(import.meta.url);
const Zip = require('@turbowarp/jszip');
const code = new TextEncoder().encode('Scratch.extensions.register({getInfo(){return {id:"sample"}}});');
const manifest = {schemaVersion: 1, extensions: [{id: 'sample', execution: 'unsandboxed',
    source: {type: 'embedded', path: 'extensions/sample.js'}, sha256: createHash('sha256').update(code).digest('hex')}]};
async function fixture(project = {targets: [], extensions: ['pen', 'sample'], extensionURLs: {sample: 'https://untrusted.invalid/a.js'}, turboWarpPlus: manifest}) {
    return new Zip().file('project.json', JSON.stringify(project)).file('extensions/sample.js', code)
        .file('unknown/data.bin', new Uint8Array([1, 2, 3])).generateAsync({type: 'uint8array', compression: 'DEFLATE'});
}
const decode = bytes => JSON.parse(new TextDecoder().decode(bytes));

test('real ZIP preparation and two save paths preserve manifest, embedded bytes and unknown entries', async () => {
    const io = createProjectIO({zip: Zip});
    const prepared = await io.prepare(await fixture());
    assert.equal(prepared.manifest.extensions[0].id, 'sample');
    const legacy = await Zip.loadAsync(prepared.input);
    const project = JSON.parse(await legacy.file('project.json').async('string'));
    assert.equal(project.turboWarpPlus, undefined);
    assert.equal(project.extensionURLs.sample, undefined);
    assert.ok(project.extensions.includes('sample'));
    io.activate(prepared.context);
    const bytes = await io.embeddedReader.read('extensions/sample.js', {maxBytes: 1024});
    assert.deepEqual(bytes, code);
    bytes[0] = 0;
    assert.deepEqual(await io.embeddedReader.read('extensions/sample.js'), code);
    const restored = io.restoreFiles({'project.json': new TextEncoder().encode('{"targets":[],"extensions":["pen"]}')}, prepared.context);
    const restoredProject = decode(restored['project.json']);
    assert.equal(restoredProject.turboWarpPlus.extensions[0].sha256, manifest.extensions[0].sha256);
    assert.deepEqual(restoredProject.extensions, ['pen', 'sample']);
    assert.equal(restoredProject.extensionURLs.sample, 'https://untrusted.invalid/a.js');
    assert.deepEqual(restored['extensions/sample.js'], code);
    assert.deepEqual(restored['unknown/data.bin'], new Uint8Array([1, 2, 3]));
    const archive = new Zip().file('project.json', io.restoreJSON('{"targets":[]}', prepared.context));
    io.restoreArchive(archive, prepared.context);
    const reopened = await io.prepare(await archive.generateAsync({type: 'uint8array'}));
    assert.equal(reopened.manifest.extensions[0].id, 'sample');
});

test('manifestless project delegates exact original input; contexts cannot be forged', async () => {
    const io = createProjectIO({zip: Zip});
    for (const input of [{targets: []}, '{"targets":[]}', await fixture({targets: []})]) {
        const result = await io.prepare(input);
        assert.equal(result.input, input);
        assert.equal(result.manifest, null);
    }
    assert.throws(() => io.activate({}), /Unknown project context/);
    const files = {'project.json': new Uint8Array()};
    assert.equal(io.restoreFiles(files, null), files);
});

test('remote-only JSON needs no ZIP dependency and malformed manifest fails closed', async () => {
    const remote = structuredClone(manifest);
    remote.extensions[0].source = {type: 'remote', url: 'https://example.org/a.js'};
    const io = createProjectIO();
    const input = {targets: [], turboWarpPlus: remote};
    const result = await io.prepare(input);
    assert.equal(result.manifest.extensions[0].source.type, 'remote');
    assert.equal(result.input.turboWarpPlus, undefined);
    await assert.rejects(io.prepare({turboWarpPlus: {schemaVersion: 999, extensions: []}}), error => error.code === 'UNSUPPORTED_SCHEMA');
    await assert.rejects(io.prepare({turboWarpPlus: manifest}), /Missing embedded/);
});

test('limits, cancellation, UTF-8 errors and corruption are diagnosed', async () => {
    const bytes = await fixture();
    await assert.rejects(createProjectIO({zip: Zip, maxArchiveBytes: 30}).prepare(bytes), /oversized/);
    await assert.rejects(createProjectIO({zip: Zip, maxTotalBytes: 10}).prepare(bytes), /expansion/);
    await assert.rejects(createProjectIO({zip: Zip}).prepare(bytes, {signal: AbortSignal.abort()}), error => error.code === 'CANCELLED');
    await assert.rejects(createProjectIO().prepare(new Uint8Array([0xff])), error => error.code === 'INVALID_PROJECT');
    const corrupt = new Uint8Array(bytes);
    const view = new DataView(corrupt.buffer);
    for (let i = 0; i < corrupt.length - 46; i++) {
        if (view.getUint32(i, true) === 0x02014b50) {
            view.setUint32(i + 16, 0x12345678, true);
            const local = view.getUint32(i + 42, true);
            view.setUint32(local + 14, 0x12345678, true);
            break;
        }
    }
    await assert.rejects(createProjectIO({zip: Zip}).prepare(corrupt), /CRC mismatch/);
});

test('preflight rejects duplicate paths, traversal, ZIP64, and misleading expansion metadata before loading', async () => {
    const bytes = await fixture();
    const mutate = callback => {
        const copy = new Uint8Array(bytes);
        const view = new DataView(copy.buffer);
        const headers = [];
        for (let i = 0; i < copy.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) headers.push(i);
        callback(copy, view, headers);
        return copy;
    };
    const badPath = mutate((copy, view, headers) => {
        const h = headers.find(h => view.getUint16(h + 28, true) === 'unknown/data.bin'.length);
        const local = view.getUint32(h + 42, true);
        const name = new TextEncoder().encode('../evil/data.bin');
        assert.equal(name.length, view.getUint16(h + 28, true));
        copy.set(name, h + 46); copy.set(name, local + 30);
    });
    assert.throws(() => inspectZip(badPath), /entry name/);
    const zip64 = mutate((copy, view, headers) => view.setUint32(headers[0] + 24, 0xffffffff, true));
    assert.throws(() => inspectZip(zip64), /Unsupported ZIP entry/);
    const bomb = mutate((copy, view, headers) => view.setUint32(headers[0] + 24, 0x4000000, true));
    assert.throws(() => inspectZip(bomb), /expansion/);
    const duplicate = new Zip().file('project.json', '{}').file('aaaaaaaaaaaa', '1').file('bbbbbbbbbbbb', '2');
    const duplicateBytes = await duplicate.generateAsync({type: 'uint8array'});
    const dv = new DataView(duplicateBytes.buffer);
    for (let i = 0; i < duplicateBytes.length - 46; i++) {
        if (dv.getUint32(i, true) === 0x02014b50 && dv.getUint16(i + 28, true) === 12) {
            const local = dv.getUint32(i + 42, true);
            duplicateBytes.set(new TextEncoder().encode('aaaaaaaaaaaa'), i + 46);
            duplicateBytes.set(new TextEncoder().encode('aaaaaaaaaaaa'), local + 30);
        }
    }
    assert.throws(() => inspectZip(duplicateBytes), /Duplicate/);
});

test('actual inflation exceeding bounded metadata is stopped', async () => {
    const bytes = await new Zip().file('project.json', '{}').file('payload', 'a'.repeat(10000)).generateAsync({type: 'uint8array', compression: 'DEFLATE'});
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < bytes.length - 46; i++) {
        if (view.getUint32(i, true) === 0x02014b50 && view.getUint16(i + 28, true) === 7) {
            const local = view.getUint32(i + 42, true);
            view.setUint32(i + 24, 1, true); view.setUint32(local + 22, 1, true);
        }
    }
    await assert.rejects(createProjectIO({zip: Zip}).prepare(bytes), /Actual ZIP expansion/);
});


test('arbitrary preserved ZIP names cannot mutate the serialized file map prototype', async () => {
    const original = await Zip.loadAsync(await fixture());
    for (const name of ['__proto__', 'constructor', 'toString']) original.file(name, new Uint8Array([123]));
    const io = createProjectIO({zip: Zip});
    const {context} = await io.prepare(await original.generateAsync({type: 'uint8array'}));
    const result = io.restoreFiles({'project.json': new TextEncoder().encode('{}')}, context);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    for (const name of ['__proto__', 'constructor', 'toString']) {
        assert.equal(Object.hasOwn(result, name), true);
        assert.deepEqual(result[name], new Uint8Array([123]));
    }
    assert.throws(() => inspectZip(new Uint8Array(), {maxArchiveBytes: NaN}), /Invalid maxArchiveBytes/);
});
