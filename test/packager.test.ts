import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Zip from '@turbowarp/jszip';
import type {FetchPort, ResolvedCode} from '@kubohiroya/turbowarp-extension-loader';
import {convertProjectSources, prepareOfflinePackage, migrateLegacyDataURL, restrictOfflineHTML,
    type OfflinePackageOptions, type PackagingPorts} from '@kubohiroya/turbowarp-extension-loader/packager';
const bytes = new TextEncoder().encode('﻿(function(Scratch){Scratch.extensions.register({getInfo(){return {id:"sample",blocks:[]}}});})(Scratch);\n');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const spec = {id: 'sample', execution: 'unsandboxed' as const, sha256,
    source: {type: 'remote' as const, url: 'https://example.test/extension.js'}, version: '1.0.0'};
/** The project fixture is deliberately loose: tests add IDs, URLs and specs the public types pin down. */
const project = () => ({targets: [{isStage: true, variables: {}, comments: {}}], extensions: ['sample', 'pen'],
    extensionURLs: {sample: spec.source.url} as Record<string, string>,
    turboWarpPlus: {schemaVersion: 1 as const, extensions: [{...spec}]}});
interface Host extends PackagingPorts {
    events: unknown[][];
    fetcher: {fetch: FetchPort['fetch']};
}
/** Declaring the resource dependencies as empty is the only way to ask for an offline package. */
const offline = (extra: Partial<OfflinePackageOptions> = {}): OfflinePackageOptions =>
    ({zip: Zip, resourceDependencies: {sample: []}, ...extra});
function ports(allowed = true): Host {
    const events: unknown[][] = [];
    return {events,
        fetcher: {async fetch(url: string) { events.push(['fetch', url]); return {bytes, finalURL: url, redirects: []}; }},
        trustProvider: {async authorize(code: ResolvedCode) { events.push(['authorize', code.id]); return {allowed, scope: 'digest' as const, sha256: code.sha256}; }}
    };
}

test('offline preparation reuses digest and approval, embeds exact BOM bytes and removes legacy Plus URL', async () => {
    const host = ports();
    const result = await prepareOfflinePackage(project(), host, offline({
        metadata: {sample: {license: 'MPL-2.0', copyright: 'Fixture author'}}}));
    assert.deepEqual(host.events, [['fetch', spec.source.url], ['authorize', 'sample']]);
    assert.equal(result.offline, true);
    const source = result.manifest.extensions[0].source;
    assert.ok(source.type === 'embedded');
    const archive = await Zip.loadAsync(result.projectBytes);
    assert.deepEqual(await archive.file(source.path)!.async('uint8array'), bytes);
    assert.deepEqual(result.artifacts.sample, bytes);
    const json = JSON.parse(await archive.file('project.json')!.async('string'));
    assert.deepEqual(json.extensionURLs, {});
    assert.equal(json.turboWarpPlusLock.extensions[0].originalSource.url, spec.source.url);
    assert.equal(json.turboWarpPlusLock.extensions[0].metadata.license, 'MPL-2.0');
    assert.equal(json.turboWarpPlus.extensions[0].sha256, sha256);
});

test('embedded to remote conversion supplies exact publish bytes and retains prior lock/license', async () => {
    const embedded = await prepareOfflinePackage(project(), ports(), offline({metadata: {sample: {license: 'MPL-2.0'}}}));
    const host = ports();
    const remote = await convertProjectSources(embedded.projectBytes, host, {zip: Zip,
        targets: {sample: {type: 'remote', url: 'https://cdn.example.test/pinned.js'}}});
    assert.deepEqual(host.events, [['authorize', 'sample']]);
    const source = remote.manifest.extensions[0].source;
    assert.ok(source.type === 'remote');
    assert.equal(source.url, 'https://cdn.example.test/pinned.js');
    assert.deepEqual(remote.artifacts.sample, bytes);
    const previous = (remote.lock.previousLock as typeof remote.lock).extensions[0].originalSource;
    assert.ok(previous.type === 'remote');
    assert.equal(previous.url, spec.source.url);
    assert.equal(remote.lock.extensions[0].metadata!.license, 'MPL-2.0');
});

test('package refusal cannot evaluate or publish unapproved, corrupted, redirected or unsafe sources', async () => {
    await assert.rejects(prepareOfflinePackage(project(), ports(false), offline()), {code: 'TRUST_DENIED'});
    const host = ports();
    host.fetcher.fetch = async url => ({bytes: new Uint8Array([1]), finalURL: url, redirects: []});
    await assert.rejects(prepareOfflinePackage(project(), host, offline()), {code: 'DIGEST_MISMATCH'});
    await assert.rejects(convertProjectSources(project(), ports(), {zip: Zip, targets: {sample: {type: 'remote', url: 'http://unsafe.test/code.js'}}}), {code: 'INVALID_SOURCE'});
});

test('offline output rejects undeclared resources, resource dependencies and ordinary remote extension URLs', async () => {
    const host = ports();
    await assert.rejects(prepareOfflinePackage(project(), host, {zip: Zip} as unknown as OfflinePackageOptions), {code: 'UNBUNDLED_DEPENDENCY'});
    await assert.rejects(prepareOfflinePackage(project(), host, offline({
        resourceDependencies: {sample: ['model.bin']} as unknown as OfflinePackageOptions['resourceDependencies']})),
    {code: 'UNBUNDLED_DEPENDENCY'});
    assert.deepEqual(host.events, []);
    const legacy = project();
    legacy.extensionURLs.custom = 'https://unreviewed.test/extension.js';
    await assert.rejects(prepareOfflinePackage(legacy, ports(), offline()), {code: 'UNBUNDLED_LEGACY_EXTENSION'});
});

test('explicit Data URL migration pins, validates and asks host approval instead of trusting metadata', async () => {
    for (const url of [`data:text/javascript;,${encodeURIComponent(new TextDecoder('utf-8', {ignoreBOM: true}).decode(bytes))}`,
        `data:application/javascript;base64,${Buffer.from(bytes).toString('base64')}`]) {
        const host = ports();
        const result = await migrateLegacyDataURL({id: 'sample', url, sha256, metadata: {license: 'MIT'}}, host);
        assert.deepEqual(result.bytes, bytes);
        assert.deepEqual(host.events, [['authorize', 'sample']]);
        assert.equal(result.metadata!.license, 'MIT');
    }
    await assert.rejects(migrateLegacyDataURL({id: 'sample', url: 'data:text/javascript,alert(1)', sha256}, ports()), {code: 'DIGEST_MISMATCH'});
    await assert.rejects(migrateLegacyDataURL({id: 'sample', url: 'data:text/javascript;base64,%%%%', sha256}, ports()), {code: 'INVALID_ENCODING'});
});

test('archive conversion retains unrelated data and cancellation prevents approval', async () => {
    const archive = new Zip().file('project.json', JSON.stringify(project())).file('unknown/data.bin', new Uint8Array([3, 2, 1]));
    const result = await prepareOfflinePackage(await archive.generateAsync({type: 'uint8array'}), ports(), offline());
    assert.deepEqual(await (await Zip.loadAsync(result.projectBytes)).file('unknown/data.bin')!.async('uint8array'), new Uint8Array([3, 2, 1]));
    const host = ports();
    await assert.rejects(prepareOfflinePackage(project(), host, offline({signal: AbortSignal.abort()})), {code: 'CANCELLED'});
    assert.deepEqual(host.events, []);
});

test('offline HTML policy precedes stock permissive CSP and blocks remote code/resources', () => {
    const html = restrictOfflineHTML('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body></body></html>');
    assert.ok(html.indexOf("connect-src 'none'") < html.indexOf('default-src *'));
    assert.ok(html.includes("base-uri 'none'"));
    assert.throws(() => restrictOfflineHTML('<script>bad</script>'), TypeError);
});

test('conversion rejects two embedded output IDs sharing a path and refuses unrelated content overwrite', async () => {
    const input = project();
    input.turboWarpPlus.extensions.push({...spec, id: 'second'});
    await assert.rejects(convertProjectSources(input, ports(), {zip: Zip, targets: {
        sample: {type: 'embedded', path: 'extensions/shared.js'},
        second: {type: 'embedded', path: 'extensions/shared.js'}
    }}), {code: 'DUPLICATE_EMBEDDED_PATH'});
    const archive = new Zip().file('project.json', JSON.stringify(project())).file('extensions/existing.js', 'do not overwrite');
    await assert.rejects(convertProjectSources(await archive.generateAsync({type: 'uint8array'}), ports(), {zip: Zip,
        targets: {sample: {type: 'embedded', path: 'extensions/existing.js'}}}), {code: 'SOURCE_PATH_COLLISION'});
});

test('prototype-named IDs do not inherit conversion targets or distribution metadata', async () => {
    const input = project();
    input.turboWarpPlus.extensions[0] = {...spec, id: 'constructor'};
    input.extensions = ['constructor'];
    input.extensionURLs = {};
    const result = await convertProjectSources(input, ports(), {zip: Zip});
    assert.equal(result.manifest.extensions[0].id, 'constructor');
    assert.equal(result.manifest.extensions[0].source.type, 'remote');
    assert.equal(Object.hasOwn(result.artifacts, 'constructor'), true);
    assert.equal(result.lock.extensions[0].metadata, null);
});
