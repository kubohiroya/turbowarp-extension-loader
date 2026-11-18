import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createProjectIO} from '@kubohiroya/turbowarp-extension-loader/project-codec';
import {gateProjectSize, measureOversizedProject} from '@kubohiroya/turbowarp-extension-loader/scratch-vm/project-size-gate';

const Zip = createRequire(import.meta.url)('@turbowarp/jszip');
const standard = {maxArchiveBytes: 4096, maxTotalBytes: 4096, maxProjectBytes: 4096, maxEntryBytes: 4096};
const ceiling = {maxArchiveBytes: 16384, maxTotalBytes: 16384, maxProjectBytes: 16384, maxEntryBytes: 16384};
const json = (size: number) => JSON.stringify({targets: [], padding: 'x'.repeat(size)});
const archive = (size: number): Promise<Uint8Array> => new Zip().file('project.json', json(size))
    .generateAsync({type: 'uint8array', compression: 'STORE'});

test('the question covers only inputs between the two configured limits', async () => {
    assert.equal(await measureOversizedProject(json(100), standard, ceiling), null);
    assert.equal(await measureOversizedProject(await archive(100), standard, ceiling), null);
    assert.deepEqual(await measureOversizedProject(json(8192), standard, ceiling),
        {bytes: json(8192).length, limit: standard.maxProjectBytes});
    const zip = await archive(8192);
    const measured = await measureOversizedProject(zip, standard, ceiling);
    assert.ok(measured && measured.bytes >= 8192 && measured.limit === standard.maxArchiveBytes);
    assert.deepEqual(await measureOversizedProject(new Blob([zip as Uint8Array<ArrayBuffer>]), standard, ceiling), measured);
    assert.equal(await measureOversizedProject(json(32768), standard, ceiling), null);
});

test('consent is per load and never raises the ceiling', async () => {
    let agreed = false;
    let questions = 0;
    const io = gateProjectSize(createProjectIO({zip: Zip, ...ceiling}), {standard, ceiling,
        confirm: async () => {questions++; return agreed;}});
    const zip = await archive(8192);
    await assert.rejects(io.prepare(zip), {code: 'INVALID_ARCHIVE'});
    agreed = true;
    assert.equal((await io.prepare(zip)).manifest, null);
    agreed = false;
    await assert.rejects(io.prepare(zip), {code: 'INVALID_ARCHIVE'});
    assert.equal(questions, 3);
    await assert.rejects(io.prepare(await archive(32768)), {code: 'INVALID_ARCHIVE'});
    assert.equal(questions, 3);
});

test('a failed question or cancellation cannot authorize an oversized load', async () => {
    const zip = await archive(8192);
    const failed = gateProjectSize(createProjectIO({zip: Zip, ...ceiling}), {standard, ceiling,
        confirm: async () => {throw new Error('closed');}});
    await assert.rejects(failed.prepare(zip), {code: 'INVALID_ARCHIVE'});
    const controller = new AbortController();
    const cancelled = gateProjectSize(createProjectIO({zip: Zip, ...ceiling}), {standard, ceiling,
        confirm: async () => {controller.abort(); return true;}});
    await assert.rejects(cancelled.prepare(zip, {signal: controller.signal}), {code: 'CANCELLED'});
});
