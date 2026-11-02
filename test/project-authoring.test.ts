import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Zip from '@turbowarp/jszip';
import {validateManifest} from '@kubohiroya/turbowarp-extension-loader';
import type {ExtensionSource, FetchPort, FetchResult, ResolvedCode} from '@kubohiroya/turbowarp-extension-loader';
import {createProjectUUID, defaultProjectURI, prepareExtensionAddition, type AuthoringPorts, type ExtensionAdditionRequest}
    from '@kubohiroya/turbowarp-extension-loader/project-authoring';
import {prepareOfflinePackage} from '@kubohiroya/turbowarp-extension-loader/packager';
import {createSessionTrustProvider} from '@kubohiroya/turbowarp-extension-loader/session-trust';

declare global {
    /** The fixture sets this if anything ever evaluates it; the tests assert it stays unset. */
    var __authoringExecuted: boolean | undefined;
}

const code = '﻿globalThis.__authoringExecuted = true;\nScratch.extensions.register({getInfo(){return {id:"sample",blocks:[]}}});\n';
const bytes = new TextEncoder().encode(code);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const url = 'https://example.test/sample.js';
const embedded = (id = 'sample', content: Uint8Array | Blob = bytes) => ({id, source: {type: 'embedded-file' as const}, bytes: content});
const remote = (id = 'sample', target = url) => ({id, source: {type: 'remote-cacheable' as const, url: target}});
/** Tests add IDs, legacy URLs and a prior lock, so the project fixture stays wider than one save. */
interface ProjectFixture {
    targets: unknown[];
    extensions: string[];
    extensionURLs: Record<string, string>;
    meta: Record<string, unknown>;
    unknown: Record<string, unknown>;
    turboWarpPlusLock?: unknown;
}
const project = (): ProjectFixture => ({targets: [{isStage: true, name: 'Stage', blocks: {}}], extensions: ['pen'],
    extensionURLs: {}, meta: {agent: 'Authoring fixture'}, unknown: {retain: [1, 2, 3]}});
async function archive(json: unknown = project(), entries: Record<string, string | Uint8Array> = {}): Promise<Uint8Array<ArrayBuffer>> {
    const zip = new Zip().file('project.json', JSON.stringify(json));
    for (const [name, value] of Object.entries(entries)) zip.file(name, value, {createFolders: false});
    return zip.generateAsync({type: 'uint8array', compression: 'STORE'}) as Promise<Uint8Array<ArrayBuffer>>;
}
interface Host extends AuthoringPorts {
    reviews: ResolvedCode[];
    fetches: string[];
    fetcher: {fetch: FetchPort['fetch']};
}
function ports(allowed = true): Host {
    const reviews: ResolvedCode[] = [];
    const fetches: string[] = [];
    return {reviews, fetches,
        fetcher: {async fetch(source: string) { fetches.push(source); return {bytes, finalURL: source, redirects: []}; }},
        trustProvider: createSessionTrustProvider({requestApproval: async record => { reviews.push(record); return allowed; }})};
}
async function jsonOf(result: {projectBytes: Uint8Array}) {
    const zip = await Zip.loadAsync(result.projectBytes);
    return {zip, json: JSON.parse(await zip.file('project.json')!.async('string'))};
}
const embeddedPath = (source: ExtensionSource) => {
    assert.ok(source.type === 'embedded-file');
    return source.path;
};

test('Embedded addition calculates SHA from exact BOM bytes, preserves plain SB3 assets and never executes JS', async () => {
    const asset = new Uint8Array([1, 7, 9]);
    const input = await archive(project(), {'image.svg': '<svg/>', 'unknown/blob.bin': asset});
    const original = input.slice();
    const host = ports();
    const result = await prepareExtensionAddition(new Blob([input]), embedded('sample', new Blob([bytes])), host, {zip: Zip});
    assert.equal(result.spec.sha256, sha256);
    assert.equal(embeddedPath(result.spec.source), 'extensions/sample.js');
    assert.equal(host.reviews.length, 1);
    assert.equal(host.reviews[0].code, code);
    assert.equal(host.reviews[0].actualSHA256, sha256);
    assert.equal(host.fetches.length, 0);
    assert.equal(globalThis.__authoringExecuted, undefined);
    assert.deepEqual(input, original);
    const {zip, json} = await jsonOf(result);
    assert.deepEqual(await zip.file('extensions/sample.js')!.async('uint8array'), bytes);
    assert.deepEqual(await zip.file('unknown/blob.bin')!.async('uint8array'), asset);
    assert.equal(await zip.file('image.svg')!.async('string'), '<svg/>');
    assert.deepEqual(json.unknown, project().unknown);
    assert.deepEqual(json.meta, project().meta);
    assert.deepEqual(json.extensions, ['pen', 'sample']);
    assert.deepEqual(json.turboWarpPlus, result.manifest);
});

test('Remote addition fetches once, computes the pin and remains Remote until offline Packager conversion', async () => {
    const host = ports();
    const result = await prepareExtensionAddition(await archive(), remote(), host, {zip: Zip});
    assert.deepEqual(host.fetches, [url]);
    assert.equal(result.spec.sha256, sha256);
    assert.deepEqual(result.spec.source, {type: 'remote-cacheable', url});
    const {zip} = await jsonOf(result);
    assert.equal(zip.file('extensions/sample.js'), null);
    assert.equal(host.reviews.length, 1);
    const offline = await prepareOfflinePackage(result.projectBytes, host, {zip: Zip, resourceDependencies: {sample: []}});
    assert.equal(offline.offline, true);
    assert.equal(offline.manifest.extensions[0].source.type, 'embedded-file');
    const bundled = await Zip.loadAsync(offline.projectBytes);
    assert.deepEqual(await bundled.file(embeddedPath(offline.manifest.extensions[0].source))!.async('uint8array'), bytes);
    assert.equal(host.reviews.length, 1, 'host session approval is reused for the same exact source and bytes');
    assert.equal(globalThis.__authoringExecuted, undefined);
});

test('adding another extension preserves existing Manifest, bytes, lock and ordinary custom URL metadata', async () => {
    const host = ports();
    const initial = project();
    initial.extensionURLs.legacy = 'https://ordinary.test/extension.js';
    initial.turboWarpPlusLock = {schemaVersion: 1, extensions: [{id: 'sample', metadata: {license: 'MIT'}}]};
    const first = await prepareExtensionAddition(await archive(initial), embedded(), host, {zip: Zip});
    const second = await prepareExtensionAddition(first.projectBytes, remote('second'), host, {zip: Zip});
    const {json, zip} = await jsonOf(second);
    assert.deepEqual(json.turboWarpPlusLock, initial.turboWarpPlusLock);
    assert.deepEqual(json.extensionURLs, initial.extensionURLs);
    assert.deepEqual(json.turboWarpPlus.extensions.map((spec: {id: string}) => spec.id), ['sample', 'second']);
    assert.deepEqual(await zip.file('extensions/sample.js')!.async('uint8array'), bytes);
    assert.equal(host.reviews.length, 2);
});

test('reserved, existing, legacy URL and existing Plus IDs are rejected before fetch or consent', async () => {
    for (const existing of [
        {...project(), extensions: ['sample']},
        {...project(), extensionURLs: {sample: url}}
    ]) {
        const host = ports();
        await assert.rejects(prepareExtensionAddition(await archive(existing), remote(), host, {zip: Zip}), {code: 'DUPLICATE_EXTENSION'});
        assert.deepEqual(host.fetches, []);
        assert.deepEqual(host.reviews, []);
    }
    const host = ports();
    await assert.rejects(prepareExtensionAddition(project(), remote('pen'), host, {zip: Zip}), {code: 'INVALID_ID'});
    const first = await prepareExtensionAddition(await archive(), embedded(), host, {zip: Zip});
    await assert.rejects(prepareExtensionAddition(first.projectBytes, remote(), host, {zip: Zip}), {code: 'DUPLICATE_EXTENSION'});
    assert.deepEqual(host.fetches, []);
});

test('unsafe URLs, byte-supplied Remote sources and archive path collisions fail before fetch', async () => {
    const host = ports();
    for (const source of ['http://example.test/code.js', 'https://user:password@example.test/code.js', `${url}#fragment`]) {
        await assert.rejects(prepareExtensionAddition(project(), {id: 'sample', source: {type: 'remote-cacheable', url: source}}, host, {zip: Zip}), {code: 'INVALID_SOURCE'});
    }
    // Supplying bytes for a Remote source is exactly what the API must refuse, so the types forbid it too.
    await assert.rejects(prepareExtensionAddition(project(), {...remote(), bytes} as unknown as ExtensionAdditionRequest, host, {zip: Zip}), {code: 'INVALID_ADDITION'});
    await assert.rejects(prepareExtensionAddition(await archive(project(), {'extensions/sample.js': 'keep'}), embedded(), host, {zip: Zip}), {code: 'SOURCE_PATH_COLLISION'});
    assert.deepEqual(host.fetches, []);
    assert.deepEqual(host.reviews, []);
});

test('unproven redirects and non-UTF8 content cannot reach the approval UI', async () => {
    for (const response of [
        {bytes, finalURL: url},
        {bytes, finalURL: 'https://other.test/code.js', redirects: []},
        {bytes, finalURL: url, redirects: [url]}
    ]) {
        const host = ports();
        // A port that omits redirects is itself a rejected contract, so the stub is cast in deliberately.
        host.fetcher.fetch = (async () => response) as unknown as FetchPort['fetch'];
        await assert.rejects(prepareExtensionAddition(project(), remote(), host, {zip: Zip}), {code: 'REDIRECT_DENIED'});
        assert.deepEqual(host.reviews, []);
    }
    const host = ports();
    await assert.rejects(prepareExtensionAddition(project(), embedded('sample', new Uint8Array([0xff, 0xfe])), host, {zip: Zip}), {code: 'INVALID_ENCODING'});
    assert.deepEqual(host.reviews, []);
});

test('denial leaves the original project and source bytes unchanged and never executes code', async () => {
    const input = await archive();
    const original = input.slice();
    const originalBytes = bytes.slice();
    const host = ports(false);
    await assert.rejects(prepareExtensionAddition(input, embedded(), host, {zip: Zip}), {code: 'TRUST_DENIED'});
    assert.equal(host.reviews.length, 1);
    assert.deepEqual(input, original);
    assert.deepEqual(bytes, originalBytes);
    assert.equal(globalThis.__authoringExecuted, undefined);
});

test('cancellation and a stalled fetch timeout do not change input or prompt', async () => {
    const input = await archive();
    const original = input.slice();
    const host = ports();
    await assert.rejects(prepareExtensionAddition(input, embedded(), host, {zip: Zip, signal: AbortSignal.abort()}), {code: 'CANCELLED'});
    host.fetcher.fetch = () => new Promise<FetchResult>(() => {});
    await assert.rejects(prepareExtensionAddition(input, remote(), host, {zip: Zip, loaderOptions: {timeoutMs: 20}}), {code: 'TIMEOUT'});
    assert.deepEqual(input, original);
    assert.deepEqual(host.reviews, []);
});

test('oversized Blob is rejected without reading it, and total byte limits include existing extensions', async () => {
    let read = false;
    class Oversized extends Blob {
        override get size() { return 16 * 1024 * 1024 + 1; }
        override arrayBuffer(): Promise<ArrayBuffer> { read = true; throw new Error('must not read'); }
    }
    const host = ports();
    await assert.rejects(prepareExtensionAddition(project(), embedded('sample', new Oversized(['a'])), host, {zip: Zip}), {code: 'INVALID_BYTES'});
    assert.equal(read, false);
    const initial = await prepareExtensionAddition(await archive(), embedded(), host, {zip: Zip});
    await assert.rejects(prepareExtensionAddition(initial.projectBytes, remote('second'), host,
        {zip: Zip, loaderOptions: {maxTotalBytes: bytes.length + 1}}), {code: 'TOTAL_SIZE_LIMIT'});
    assert.equal(host.reviews.length, 1);
});

test('malformed archive and unsafe path fail without approval or fetch', async () => {
    const host = ports();
    const unsafe = {...embedded(), source: {type: 'embedded-file' as const, path: 'extensions/../code.js'}};
    await assert.rejects(prepareExtensionAddition(project(), unsafe, host, {zip: Zip}), {code: 'INVALID_SOURCE'});
    await assert.rejects(prepareExtensionAddition(new Uint8Array([0x50, 0x4b, 1, 2]), remote(), host, {zip: Zip}), {code: 'INVALID_ARCHIVE'});
    assert.deepEqual(host.fetches, []);
    assert.deepEqual(host.reviews, []);
});

test('a project identifier sorts by when it was made, and still shards evenly', () => {
    const ids = Array.from({length: 200}, createProjectUUID);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(new Set(ids).size, ids.length);
    // Version 7 puts the clock first, so the identifiers are already in creation order.
    assert.deepEqual([...ids].sort(), ids.map(id => id).sort());
    assert.ok(ids[0]! <= ids.at(-1)!);
    // The shard comes from the random tail. Sharding on the leading characters would put every
    // one of these in a single directory, because the clock's top byte barely moves.
    const shardOf = (uri: string) => uri.split('/').at(-3)!;
    const leading = new Set(ids.map(id => id.slice(0, 2)));
    const shards = new Set(ids.map(id => shardOf(defaultProjectURI('https://example.test/editor/', id))));
    assert.equal(leading.size, 1, 'the leading characters are all the same');
    assert.ok(shards.size > 50, `the tail divides them: ${shards.size} directories`);
});

test('an unchosen address claims only the origin that assigned it', () => {
    const uuid = '0193f0a1-2b3c-7d4e-8f01-2233445566aa';
    assert.equal(defaultProjectURI('https://example.test/editor/', uuid),
        `https://example.test/editor/turbowarp-plus-projects/66/66aa/${uuid}.sb3`);
    // A trailing slash is the author's, not a second path segment.
    assert.equal(defaultProjectURI('https://example.test/editor', uuid),
        defaultProjectURI('https://example.test/editor/', uuid));
    assert.equal(defaultProjectURI('https://example.test', uuid),
        `https://example.test/turbowarp-plus-projects/66/66aa/${uuid}.sb3`);
    // The same rule as every other address this family records.
    for (const origin of ['http://example.test/', 'https://user:pass@example.test/', 'not a url']) {
        assert.throws(() => defaultProjectURI(origin, uuid), {code: 'INVALID_PROJECT_URI'});
    }
    // A version 4 UUID would not sort, so it is refused rather than quietly accepted.
    assert.throws(() => defaultProjectURI('https://example.test/', '0193f0a1-2b3c-4d4e-8f01-2233445566aa'),
        {code: 'INVALID_PROJECT_URI'});
});

test('a project URI is validated like any other address, and is optional', () => {
    const base = {schemaVersion: 1, extensions: []};
    assert.equal(validateManifest(base).uri, undefined);
    const uri = 'https://example.test/editor/turbowarp-plus-projects/66/66aa/0193f0a1-2b3c-7d4e-8f01-2233445566aa.sb3';
    assert.equal(validateManifest({...base, uri}).uri, uri);
    for (const bad of ['http://example.test/a.sb3', 'https://example.test/a.sb3#x', 'https://u:p@example.test/a.sb3', 7]) {
        assert.throws(() => validateManifest({...base, uri: bad}), {code: 'INVALID_PROJECT_URI'});
    }
});
