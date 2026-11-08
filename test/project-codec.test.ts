import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash, randomBytes} from 'node:crypto';
import {createProjectIO, inspectZip} from '@kubohiroya/turbowarp-extension-loader/project-codec';
const require = createRequire(import.meta.url);
const Zip = require('@turbowarp/jszip');
const code = new TextEncoder().encode('Scratch.extensions.register({getInfo(){return {id:"sample"}}});');
/** Manifest fixtures are rewritten field by field, including into shapes the public types forbid. */
const manifest: {schemaVersion: number; extensions: Record<string, unknown>[]} = {
    schemaVersion: 1, extensions: [{id: 'sample', execution: 'unsandboxed',
        source: {type: 'embedded-file', path: 'extensions/sample.js'}, sha256: createHash('sha256').update(code).digest('hex')}]};
const hasCode = (expected: string) => (error: unknown) => (error as {code?: string}).code === expected;
async function fixture(project: unknown = {targets: [], extensions: ['pen', 'sample'],
    extensionURLs: {sample: 'https://untrusted.invalid/a.js'}, turboWarpPlus: manifest}) {
    return new Zip().file('project.json', JSON.stringify(project)).file('extensions/sample.js', code)
        .file('unknown/data.bin', new Uint8Array([1, 2, 3])).generateAsync({type: 'uint8array', compression: 'DEFLATE'});
}
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));

test('real ZIP preparation and two save paths preserve manifest, embedded bytes and unknown entries', async () => {
    const io = createProjectIO({zip: Zip});
    const prepared = await io.prepare(await fixture());
    assert.equal(prepared.manifest!.extensions[0].id, 'sample');
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
    assert.equal(reopened.manifest!.extensions[0].id, 'sample');
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

test('verified archive views share unchanged JSON and isolate ZIP reads and rewritten extension URLs', async () => {
    const io = createProjectIO({zip: Zip});
    const plain = await io.prepare(await fixture({targets: []}), {shareArchive: true});
    assert.equal(plain.vmArchive, plain.originalArchive);
    assert.deepEqual(plain.vmArchive!.project, {targets: []});
    assert.equal(plain.vmArchive!.parserText, undefined);

    const compatibility = await io.prepare(await fixture({targets: [], name: 'old\bname'}), {shareArchive: true});
    assert.match(compatibility.vmArchive!.parserText!, /\\b/);
    for (const zip of [new Zip().file('project.json', '\ufeff{"targets":[]}'),
        new Zip().file('folder/project.json', '{"targets":[]}').file('project.json', '{"targets":[]}')]) {
        const input = await zip.generateAsync({type: 'uint8array'});
        const prepared = await io.prepare(input, {shareArchive: true});
        assert.equal(prepared.input, input);
        assert.equal(prepared.originalArchive, undefined);
    }

    const result = await io.prepare(await fixture(), {shareArchive: true});
    const source = result.originalArchive!.openZip();
    const vm = result.vmArchive!.openZip();
    const original = JSON.parse(await source.file('project.json').async('string'));
    const rewritten = JSON.parse(await vm.file('project.json').async('string'));
    assert.equal(original.extensionURLs.sample, 'https://untrusted.invalid/a.js');
    assert.equal(rewritten.extensionURLs.sample, undefined);
    assert.deepEqual(rewritten, JSON.parse(result.vmArchive!.parserText!));
    const bytes = await vm.file('extensions/sample.js').async('uint8array');
    bytes[0] = 0;
    io.activate(result.context);
    assert.deepEqual(await io.embeddedReader.read('extensions/sample.js'), code);
    assert.deepEqual(await source.file('extensions/sample.js').async('uint8array'), code);
});

test('large DEFLATE entries preserve bytes and enforce CRC and actual expansion with or without native streams', async () => {
    const content = Uint8Array.from(randomBytes(300 * 1024));
    const bytes: Uint8Array = await new Zip().file('project.json', '{"targets":[]}')
        .file('stored.bin', Uint8Array.of(1, 2), {compression: 'STORE'}).file('deflated.bin', content)
        .generateAsync({type: 'uint8array', compression: 'DEFLATE'});
    const prepare = (input: Uint8Array) => createProjectIO({zip: Zip}).prepare(input, {shareArchive: true});
    const read = async () => {
        const zip = (await prepare(bytes)).vmArchive!.openZip();
        assert.deepEqual(await zip.file('stored.bin').async('uint8array'), Uint8Array.of(1, 2));
        assert.deepEqual(await zip.file('deflated.bin').async('uint8array'), content);
    };
    await read();
    const native = Object.getOwnPropertyDescriptor(globalThis, 'DecompressionStream')!;
    Object.defineProperty(globalThis, 'DecompressionStream', {configurable: true, value: undefined});
    try { await read(); }
    finally { Object.defineProperty(globalThis, 'DecompressionStream', native); }

    const mutated = (field: 'crc' | 'size', value: number) => {
        const bad = bytes.slice();
        const view = new DataView(bad.buffer);
        for (let offset = 0; offset < bad.length - 46; offset++) {
            if (view.getUint32(offset, true) !== 0x02014b50 ||
                new TextDecoder().decode(bad.subarray(offset + 46, offset + 58)) !== 'deflated.bin') continue;
            const local = view.getUint32(offset + 42, true);
            view.setUint32(offset + (field === 'crc' ? 16 : 24), value, true);
            view.setUint32(local + (field === 'crc' ? 14 : 22), value, true);
            return bad;
        }
        throw Error('Missing DEFLATE fixture entry');
    };
    await assert.rejects(prepare(mutated('crc', 0)), /CRC mismatch/);
    await assert.rejects(prepare(mutated('size', content.length - 1)), /expansion exceeds declared size/);
});

test('remote-only JSON needs no ZIP dependency and malformed manifest fails closed', async () => {
    const remote = structuredClone(manifest);
    remote.extensions[0].source = {type: 'remote-cacheable', url: 'https://example.org/a.js'};
    const io = createProjectIO();
    const input = {targets: [], turboWarpPlus: remote};
    const result = await io.prepare(input);
    assert.equal(result.manifest!.extensions[0].source.type, 'remote-cacheable');
    assert.equal((result.input as {turboWarpPlus?: unknown}).turboWarpPlus, undefined);
    await assert.rejects(io.prepare({turboWarpPlus: {schemaVersion: 999, extensions: []}}), hasCode('UNSUPPORTED_SCHEMA'));
    await assert.rejects(io.prepare({turboWarpPlus: manifest}), /Missing embedded/);
});

test('limits, cancellation, UTF-8 errors and corruption are diagnosed', async () => {
    const bytes = await fixture();
    await assert.rejects(createProjectIO({zip: Zip, maxArchiveBytes: 30}).prepare(bytes), /oversized/);
    await assert.rejects(createProjectIO({zip: Zip, maxTotalBytes: 10}).prepare(bytes), /expansion/);
    await assert.rejects(createProjectIO({zip: Zip}).prepare(bytes, {signal: AbortSignal.abort()}), hasCode('CANCELLED'));
    await assert.rejects(createProjectIO().prepare(new Uint8Array([0xff])), hasCode('INVALID_PROJECT'));
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
    await assert.rejects(createProjectIO({zip: Zip}).prepare(corrupt, {shareArchive: true}), /CRC mismatch/);
});

test('preflight rejects duplicate paths, traversal, ZIP64, and misleading expansion metadata before loading', async () => {
    const bytes: Uint8Array = await fixture();
    const mutate = (callback: (copy: Uint8Array, view: DataView, headers: number[]) => void) => {
        const copy = new Uint8Array(bytes);
        const view = new DataView(copy.buffer);
        const headers: number[] = [];
        for (let i = 0; i < copy.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) headers.push(i);
        callback(copy, view, headers);
        return copy;
    };
    const badPath = mutate((copy, view, headers) => {
        const h = headers.find(h => view.getUint16(h + 28, true) === 'unknown/data.bin'.length)!;
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
    const duplicateBytes: Uint8Array = await duplicate.generateAsync({type: 'uint8array'});
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
    const bytes: Uint8Array = await new Zip().file('project.json', '{}').file('payload', 'a'.repeat(10000)).generateAsync({type: 'uint8array', compression: 'DEFLATE'});
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

test('a project without an address gets one at its first save and keeps it on the next', async () => {
    const io = createProjectIO({zip: Zip});
    const prepared = await io.prepare(await fixture());
    assert.equal(prepared.manifest!.uri, undefined);
    const uri = 'https://example.test/turbowarp-plus-projects/66/66aa/0193f0a1-2b3c-7d4e-8f01-2233445566aa.sb3';
    const saved = io.assignProjectURI(prepared.context!, uri);
    assert.notEqual(saved, prepared.context);
    for (const json of [io.restoreJSON('{"targets":[]}', saved), io.restoreJSON('{"targets":[],"extensions":[]}', saved)]) {
        const project = JSON.parse(json);
        assert.equal(project.turboWarpPlus.uri, uri);
        assert.equal(project.turboWarpPlus.extensions[0].id, 'sample');
    }
    const files = io.restoreFiles({'project.json': new TextEncoder().encode('{"targets":[]}')}, saved);
    assert.equal(decode(files['project.json']).turboWarpPlus.uri, uri);
    assert.deepEqual(files['extensions/sample.js'], code);
    // The context passed in is left as it was.
    assert.equal(JSON.parse(io.restoreJSON('{"targets":[]}', prepared.context)).turboWarpPlus.uri, undefined);
    // Asking for the same address again changes nothing.
    assert.equal(io.assignProjectURI(saved, uri), saved);
    // The saved project reopens with that address.
    const archive = new Zip().file('project.json', io.restoreJSON('{"targets":[]}', saved));
    io.restoreArchive(archive, saved);
    const reopened = await io.prepare(await archive.generateAsync({type: 'uint8array'}));
    assert.equal(reopened.manifest!.uri, uri);
});

test('an address a project has is replaced only when asked', async () => {
    const io = createProjectIO({zip: Zip});
    const first = 'https://example.test/p/first.sb3';
    const prepared = await io.prepare(await fixture({targets: [], turboWarpPlus: {...manifest, uri: first}}));
    assert.equal(prepared.manifest!.uri, first);
    assert.throws(() => io.assignProjectURI(prepared.context!, 'https://example.test/p/second.sb3'), hasCode('PROJECT_URI_CONFLICT'));
    assert.throws(() => io.assignProjectURI(prepared.context!, 'https://example.test/p/second.sb3', {replace: false}), hasCode('PROJECT_URI_CONFLICT'));
    assert.equal(io.assignProjectURI(prepared.context!, first), prepared.context);
    const moved = io.assignProjectURI(prepared.context!, 'https://example.test/p/second.sb3', {replace: true});
    assert.equal(JSON.parse(io.restoreJSON('{"targets":[]}', moved)).turboWarpPlus.uri, 'https://example.test/p/second.sb3');
    assert.equal(JSON.parse(io.restoreJSON('{"targets":[]}', prepared.context)).turboWarpPlus.uri, first);
});

test('an address is checked like every other project address before it is assigned', async () => {
    const io = createProjectIO({zip: Zip});
    const prepared = await io.prepare(await fixture());
    for (const uri of ['http://example.test/p.sb3', 'https://user:pw@example.test/p.sb3', 'https://example.test/p.sb3#x',
        'not a url', '', 42 as unknown as string]) {
        assert.throws(() => io.assignProjectURI(prepared.context!, uri), hasCode('INVALID_PROJECT_URI'), String(uri));
    }
    // Normalized as the Manifest would record it.
    const saved = io.assignProjectURI(prepared.context!, 'https://EXAMPLE.test/p.sb3');
    assert.equal(JSON.parse(io.restoreJSON('{"targets":[]}', saved)).turboWarpPlus.uri, 'https://example.test/p.sb3');
    assert.throws(() => io.assignProjectURI(null as unknown as object, 'https://example.test/p.sb3'), /no address/);
    assert.throws(() => io.assignProjectURI({}, 'https://example.test/p.sb3'), /Unknown project context/);
});
