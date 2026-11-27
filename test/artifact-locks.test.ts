import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Zip from '@turbowarp/jszip';
import {buildLock} from './artifact-lock-fixture.ts';
import {prepareExtensionAddition} from '@kubohiroya/turbowarp-extension-loader/project-authoring';
import {createProjectIO} from '@kubohiroya/turbowarp-extension-loader/project-codec';
import {prepareCatalogExtensionChanges} from '@kubohiroya/turbowarp-extension-loader/project-catalog';

const entry = 'tw-plus/extension-locks.json';
const bytes = new TextEncoder().encode('globalThis.__loaderArtifactLockExecuted = true;');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sha256 = hash(bytes);
const makeLock = () => buildLock('sample', bytes);
const spec = {id: 'sample', execution: 'sandboxed' as const, sha256, artifactLockFormatVersion: 1 as const,
    source: {type: 'embedded-file' as const, path: 'extensions/sample.js'}};
const envelope = (lock: unknown = makeLock()) => ({formatVersion: 1, extensions: [{id: 'sample', artifactLock: lock}]});
const project = () => ({targets: [], extensions: ['sample'], turboWarpPlus: {schemaVersion: 1, extensions: [spec]}});
const archive = async (metadata: unknown = envelope(), json: unknown = project(), code = bytes) =>
    new Zip().file('project.json', JSON.stringify(json)).file(spec.source.path, code)
        .file(entry, JSON.stringify(metadata)).generateAsync({type: 'uint8array'});
const invalid = {code: 'INVALID_ARTIFACT_LOCK'};
const ports = (allowed = true) => {
    const approvals: string[] = [];
    return {approvals, trustProvider: {async authorize(value: {id: string; sha256: string}) {
        approvals.push(value.id); return {allowed, scope: 'digest' as const, sha256: value.sha256};
    }}};
};
const request = (lock = makeLock()) => ({id: 'sample', execution: 'sandboxed' as const,
    source: {type: 'embedded-file' as const}, bytes, artifactLock: lock});

test('addition stores a shared validated lock without executing it or inheriting author trust', async () => {
    const host = ports();
    const lock = makeLock();
    const addition = prepareExtensionAddition({targets: [], extensions: []}, request(lock), host, {zip: Zip});
    (lock as {bundleSHA256: string}).bundleSHA256 = '0'.repeat(64);
    const result = await addition;
    const zip = await Zip.loadAsync(result.projectBytes);
    assert.deepEqual(JSON.parse(await zip.file(entry)!.async('string')), envelope());
    assert.deepEqual(host.approvals, ['sample']);
    assert.equal('__loaderArtifactLockExecuted' in globalThis, false);
    const denied = ports(false);
    await assert.rejects(prepareExtensionAddition({targets: []}, request(), denied, {zip: Zip}), {code: 'TRUST_DENIED'});
    assert.deepEqual(denied.approvals, ['sample']);
    assert.equal('__loaderArtifactLockExecuted' in globalThis, false);
});

test('both SB3 save paths restore only the verified lock and remain readable after roundtrip', async () => {
    const io = createProjectIO({zip: Zip});
    const prepared = await io.prepare(await archive());
    const serialized = io.restoreFiles({'project.json': new TextEncoder().encode('{"targets":[]}'),
        [entry]: new TextEncoder().encode('unverified replacement')}, prepared.context);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(serialized[entry])), envelope());
    const zip = new Zip();
    zip.file('project.json', io.restoreJSON('{"targets":[]}', prepared.context));
    zip.file(entry, 'unverified replacement');
    io.restoreArchive(zip, prepared.context);
    const again = await io.prepare(await zip.generateAsync({type: 'uint8array'}));
    const saved = io.restoreFiles({'project.json': new TextEncoder().encode('{"targets":[]}')}, again.context);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(saved[entry])), envelope());
    assert.deepEqual(saved[spec.source.path], bytes);
});

test('unknown versions, hidden credentials, mismatched API/code/mode, duplicate IDs and orphan records fail closed', async () => {
    const io = createProjectIO({zip: Zip});
    const badLocks = [
        {...makeLock(), formatVersion: 99}, {...makeLock(), token: 'private'},
        {...makeLock(), bundleSHA256: '0'.repeat(64)},
        {...makeLock(), apiJSON: '{"formatVersion":1,"id":"other","blocks":[],"menus":[]}'}
    ];
    for (const lock of badLocks) await assert.rejects(io.prepare(await archive(envelope(lock))), invalid);
    const valid = envelope();
    for (const metadata of [{...valid, formatVersion: 2}, {...valid, approval: true},
        {...valid, extensions: [...valid.extensions, ...valid.extensions]},
        {...valid, extensions: [{...valid.extensions[0], id: 'other'}]}]) {
        await assert.rejects(io.prepare(await archive(metadata)), invalid);
    }
    await assert.rejects(io.prepare(await archive(envelope(), project(), new TextEncoder().encode('different bytes'))), invalid);
    await assert.rejects(io.prepare(await archive(envelope(), {targets: []})), invalid);
    const changed = {...project(), turboWarpPlus: {schemaVersion: 1, extensions: [{...spec, execution: 'unsandboxed'}]}};
    await assert.rejects(io.prepare(await archive(envelope(), changed)), invalid);
    const host = ports();
    await assert.rejects(prepareExtensionAddition({targets: []}, {...request(), execution: 'unsandboxed'}, host, {zip: Zip}), invalid);
    assert.deepEqual(host.approvals, []);
});

test('explicit edits remove stale provenance but keep unrelated validated records', async () => {
    const input = await archive();
    const host = {...ports(), fetcher: {async fetch(url: string) {
        return {bytes, finalURL: url, redirects: []};
    }}};
    const result = await prepareCatalogExtensionChanges(input, [{id: 'sample', url: 'https://example.test/sample.js',
        execution: 'unsandboxed', distribution: 'embedded-file'}], host, {zip: Zip});
    const zip = await Zip.loadAsync(result.projectBytes);
    assert.equal(zip.file(entry), null);
    const other = await prepareExtensionAddition(input, {id: 'second', execution: 'sandboxed',
        source: {type: 'embedded-file'}, bytes}, ports(), {zip: Zip});
    assert.deepEqual(JSON.parse(await (await Zip.loadAsync(other.projectBytes)).file(entry)!.async('string')), envelope());
    const updated = await prepareExtensionAddition(input, {id: 'sample', execution: 'sandboxed',
        source: {type: 'embedded-file'}, bytes}, ports(), {zip: Zip, developmentBuild: {sha256, previousSHA256: sha256}});
    assert.equal((await Zip.loadAsync(updated.projectBytes)).file(entry), null);
});

test('legacy projects without locks remain readable and unverified save-time metadata is rejected', async () => {
    const io = createProjectIO({zip: Zip});
    const legacy = project();
    legacy.turboWarpPlus.extensions = [{...spec}];
    delete (legacy.turboWarpPlus.extensions[0] as {artifactLockFormatVersion?: 1}).artifactLockFormatVersion;
    const zip = new Zip().file('project.json', JSON.stringify(legacy)).file(spec.source.path, bytes);
    const prepared = await io.prepare(await zip.generateAsync({type: 'uint8array'}));
    assert.ok(prepared.manifest);
    assert.throws(() => io.restoreFiles({'project.json': new TextEncoder().encode('{"targets":[]}'),
        [entry]: new TextEncoder().encode('{}')}, prepared.context), invalid);
    assert.throws(() => io.restoreArchive(new Zip().file(entry, '{}'), prepared.context), invalid);
    const withoutSidecar = new Zip().file('project.json', JSON.stringify(project())).file(spec.source.path, bytes);
    await assert.rejects(io.prepare(await withoutSidecar.generateAsync({type: 'uint8array'})), invalid);
    await assert.rejects(io.prepare(await archive(envelope(), legacy)), invalid);
});
