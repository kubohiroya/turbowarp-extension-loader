// SPDX-License-Identifier: GPL-3.0-or-later
// From turbowarp-plus-editor/test/extension-host/project-size-gate.test.ts at 5bc644f.
// The original test license is retained; see LICENSE.GPL-3.0 in this directory.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createProjectIO} from '@kubohiroya/turbowarp-extension-loader/project-codec';
import {gateProjectSize, measureOversizedProject} from '@kubohiroya/turbowarp-extension-loader/scratch-vm/project-size-gate';

const Zip = createRequire(import.meta.url)('@turbowarp/jszip');
const MiB = 1024 * 1024;
const project = {targets: [{isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {},
    comments: {}, currentCostume: 0, costumes: [], sounds: [], volume: 100, layerOrder: 0, tempo: 60,
    videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null}], monitors: [], extensions: [],
    meta: {semver: '3.0.0', vm: '0.2.0', agent: 'size gate test'}};
// The bulk is a stage variable, which the VM keeps, so a test can tell which project is open.
const json = (bulkBytes: number) => JSON.stringify({...project,
    targets: [{...project.targets[0], variables: {bulk: ['bulk', 'x'.repeat(bulkBytes)]}}]});
const stored = (text: string): Promise<Uint8Array<ArrayBuffer>> => new Zip().file('project.json', text).generateAsync({type: 'uint8array', compression: 'STORE'});

// Small limits keep these unit cases cheap; Editor retains its host integration check.
const standard = {maxArchiveBytes: MiB, maxTotalBytes: MiB, maxProjectBytes: MiB, maxEntryBytes: MiB};
const ceiling = {maxArchiveBytes: 4 * MiB, maxTotalBytes: 4 * MiB, maxProjectBytes: 4 * MiB, maxEntryBytes: 4 * MiB};

test('only a project between the standard and ceiling limits is put to the person', async () => {
    assert.equal(await measureOversizedProject(json(1000), standard, ceiling), null);
    assert.equal(await measureOversizedProject(await stored(json(1000)), standard, ceiling), null);

    const legacy = json(2 * MiB);
    assert.deepEqual(await measureOversizedProject(legacy, standard, ceiling), {bytes: legacy.length, limit: MiB});
    const bytes = new TextEncoder().encode(legacy);
    assert.deepEqual(await measureOversizedProject(bytes, standard, ceiling), {bytes: bytes.length, limit: MiB});
    const archive = await stored(legacy);
    const measured = await measureOversizedProject(archive, standard, ceiling);
    assert.ok(measured && measured.bytes >= legacy.length && measured.limit === MiB);
    assert.deepEqual(await measureOversizedProject(new Blob([archive]), standard, ceiling), measured);

    // Over the ceiling, or over the compression ratio, is refused by prepare without a question.
    assert.equal(await measureOversizedProject(json(5 * MiB), standard, ceiling), null);
    assert.equal(await measureOversizedProject(await stored(json(5 * MiB)), standard, ceiling), null);
    const bomb = await new Zip().file('project.json', json(10)).file('zeros.bin', new Uint8Array(2 * MiB))
        .generateAsync({type: 'uint8array', compression: 'DEFLATE'});
    assert.equal(await measureOversizedProject(bomb, standard, ceiling), null);
});

test('the gate opens an oversized project only when the person agrees, and keeps the ratio check', async () => {
    const asked: unknown[] = [];
    let answer = false;
    const io = gateProjectSize(createProjectIO({zip: Zip, ...ceiling}), {standard, ceiling,
        confirm: async question => { asked.push(question); return answer; }});
    const archive = await stored(json(2 * MiB));
    await assert.rejects(io.prepare(archive), {code: 'INVALID_ARCHIVE'});
    assert.equal(asked.length, 1);
    answer = true;
    assert.equal((await io.prepare(archive)).manifest, null);
    assert.equal(asked.length, 2);
    // The agreement was for that load only.
    answer = false;
    await assert.rejects(io.prepare(archive), {code: 'INVALID_ARCHIVE'});
    assert.equal(asked.length, 3);

    const bomb = await new Zip().file('project.json', json(10)).file('zeros.bin', new Uint8Array(2 * MiB))
        .generateAsync({type: 'uint8array', compression: 'DEFLATE'});
    answer = true;
    await assert.rejects(io.prepare(bomb), {code: 'INVALID_ARCHIVE'});
    await assert.rejects(io.prepare(await stored(json(5 * MiB))), {code: 'INVALID_ARCHIVE'});
    assert.equal(asked.length, 3);
    assert.equal((await io.prepare(json(1000))).manifest, null);
    assert.equal(asked.length, 3);

    // A question that fails, or a load cancelled while it is open, does not open the project.
    const failing = gateProjectSize(createProjectIO({zip: Zip, ...ceiling}), {standard, ceiling,
        confirm: async () => { throw new Error('no dialog'); }});
    await assert.rejects(failing.prepare(archive), {code: 'INVALID_ARCHIVE'});
    const controller = new AbortController();
    const cancelled = gateProjectSize(createProjectIO({zip: Zip, ...ceiling}), {standard, ceiling,
        confirm: async () => { controller.abort(); return true; }});
    await assert.rejects(cancelled.prepare(archive, {signal: controller.signal}), {code: 'CANCELLED'});
});
