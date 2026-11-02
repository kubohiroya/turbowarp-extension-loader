import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Zip from '@turbowarp/jszip';
import type {ExtensionSource, FetchPort, FetchResult, ResolvedCode} from '@kubohiroya/turbowarp-extension-loader';
import {prepareCatalogExtensionChanges, readProjectAuthoringState, type CatalogExtensionRequest, type CatalogPorts}
    from '@kubohiroya/turbowarp-extension-loader/project-catalog';

declare global {
    /** The fixture sets this if anything ever evaluates it; the tests assert it stays unset. */
    var __catalogCodeExecuted: boolean | undefined;
}

const encoder = new TextEncoder();
const content = (id: string) => encoder.encode(`﻿globalThis.__catalogCodeExecuted=true;\nScratch.extensions.register({getInfo(){return {id:'${id}',blocks:[]}}});\n`);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const url = (id: string) => `https://catalog.test/${id}.js`;
/** Requests are also built with values the public types reject, which is what those cases verify. */
const request = (id: string, changes: Record<string, unknown> = {}) =>
    ({id, url: url(id), distribution: 'remote', execution: 'unsandboxed', ...changes}) as CatalogExtensionRequest;
/** Tests add a saved Manifest, a lock and legacy URLs, so the fixture stays wider than one save. */
interface ProjectFixture {
    targets: unknown[];
    extensions: string[];
    extensionURLs: Record<string, string>;
    meta: Record<string, unknown>;
    unknown: Record<string, unknown>;
    turboWarpPlus?: {schemaVersion: number; extensions: Record<string, unknown>[]};
    turboWarpPlusLock?: unknown;
}
const project = (): ProjectFixture => ({targets: [{isStage: true, name: 'Stage', blocks: {}, variables: {keep: ['original', 42]}}],
    extensions: ['pen'], extensionURLs: {}, meta: {agent: 'Catalog tests'}, unknown: {retain: true}});
async function archive(json: unknown = project(), entries: Record<string, string | Uint8Array> = {}): Promise<Uint8Array> {
    const zip = new Zip().file('project.json', JSON.stringify(json));
    for (const [name, bytes] of Object.entries(entries)) zip.file(name, bytes, {createFolders: false});
    return zip.generateAsync({type: 'uint8array', compression: 'STORE'});
}
async function decode(result: {projectBytes: Uint8Array}) {
    const zip = await Zip.loadAsync(result.projectBytes);
    return {zip, json: JSON.parse(await zip.file('project.json')!.async('string'))};
}
interface Host extends CatalogPorts {
    fetches: string[];
    approvals: ResolvedCode[];
    fetcher: {fetch: FetchPort['fetch']};
}
function host({allow = () => true, sources = new Map<string, Uint8Array>()}:
    {allow?: (code: ResolvedCode) => boolean; sources?: Map<string, Uint8Array>} = {}): Host {
    const fetches: string[] = [];
    const approvals: ResolvedCode[] = [];
    return {fetches, approvals,
        fetcher: {async fetch(source: string) {
            fetches.push(source);
            const id = new URL(source).pathname.split('/').pop()!.replace(/\.js$/, '');
            return {bytes: sources.get(source) || content(id), finalURL: source, redirects: []};
        }},
        trustProvider: {async authorize(code: ResolvedCode) {
            approvals.push(code);
            return {allowed: allow(code), scope: 'digest' as const, sha256: code.sha256};
        }}
    };
}
const embeddedPath = (source: ExtensionSource) => {
    assert.ok(source.type === 'embedded');
    return source.path;
};
/** A port that omits redirects or stalls is itself a rejected contract, so stubs are cast in deliberately. */
const stubFetch = (implementation: () => unknown) => implementation as unknown as FetchPort['fetch'];

for (const execution of ['sandboxed', 'unsandboxed'] as const) {
    for (const distribution of ['embedded', 'remote'] as const) {
        test(`catalog ${execution}/${distribution} calculates SHA-256 and preserves plain SB3 assets without evaluation`, async () => {
            const id = 'sample';
            const input = await archive(project(), {'image.svg': '<svg/>', 'unknown/data.bin': new Uint8Array([1, 2, 3])});
            const original = input.slice();
            const ports = host();
            const result = await prepareCatalogExtensionChanges(input, [request(id, {execution, distribution, version: '1.0.0'})], ports, {zip: Zip});
            assert.deepEqual(input, original);
            assert.equal(result.manifest.extensions.length, 1);
            const [spec] = result.manifest.extensions;
            assert.equal(spec.id, id);
            assert.equal(spec.execution, execution);
            assert.equal(spec.source.type, distribution);
            assert.equal(spec.sha256, hash(content(id)));
            assert.equal(spec.version, '1.0.0');
            assert.deepEqual(ports.fetches, [url(id)]);
            assert.deepEqual(ports.approvals.map(code => [code.id, code.execution]), [[id, execution]]);
            assert.equal(globalThis.__catalogCodeExecuted, undefined);
            const {zip, json} = await decode(result);
            assert.deepEqual(json.targets, project().targets);
            assert.deepEqual(json.meta, project().meta);
            assert.deepEqual(json.unknown, project().unknown);
            assert.deepEqual(json.extensions, ['pen', id]);
            assert.equal(await zip.file('image.svg')!.async('string'), '<svg/>');
            assert.deepEqual(await zip.file('unknown/data.bin')!.async('uint8array'), new Uint8Array([1, 2, 3]));
            if (distribution === 'embedded') assert.deepEqual(await zip.file(embeddedPath(spec.source))!.async('uint8array'), content(id));
            else assert.deepEqual(spec.source, {type: 'remote', url: url(id)});
        });
    }
}

test('a second-entry denial does not change the input or execute either catalog extension', async () => {
    const input = await archive();
    const original = input.slice();
    const ports = host({allow: code => code.id !== 'second'});
    await assert.rejects(prepareCatalogExtensionChanges(input, [request('first'), request('second')], ports, {zip: Zip}), {code: 'TRUST_DENIED'});
    assert.deepEqual(ports.approvals.map(code => code.id), ['first', 'second']);
    assert.deepEqual(input, original);
    assert.equal(globalThis.__catalogCodeExecuted, undefined);
});

test('existing Embedded/Remote conversions retain SHA and exact BOM bytes while execution can change explicitly', async () => {
    const initial = await prepareCatalogExtensionChanges(await archive(), [request('sample', {distribution: 'embedded'})], host(), {zip: Zip});
    const original = initial.projectBytes.slice();
    const remotePorts = host();
    const remote = await prepareCatalogExtensionChanges(initial.projectBytes,
        [request('sample', {distribution: 'remote', execution: 'sandboxed'})], remotePorts, {zip: Zip});
    assert.equal(remote.manifest.extensions[0].sha256, initial.manifest.extensions[0].sha256);
    assert.equal(remote.manifest.extensions[0].execution, 'sandboxed');
    assert.deepEqual(remotePorts.fetches, [url('sample')]);
    assert.deepEqual(initial.projectBytes, original);
    const embedded = await prepareCatalogExtensionChanges(remote.projectBytes,
        [request('sample', {distribution: 'embedded', execution: 'sandboxed'})], host(), {zip: Zip});
    const spec = embedded.manifest.extensions[0];
    assert.equal(spec.sha256, hash(content('sample')));
    const {zip} = await decode(embedded);
    assert.deepEqual(await zip.file(embeddedPath(spec.source))!.async('uint8array'), content('sample'));
    assert.equal(globalThis.__catalogCodeExecuted, undefined);
});

test('switching distribution releases the copy the replaced entry kept', async () => {
    const names = async (result: {projectBytes: Uint8Array}) =>
        Object.keys((await decode(result)).zip.files).filter(name => name.startsWith('extensions/'));
    const copy = `extensions/sample-${hash(content('sample'))}.js`;
    const kept = await prepareCatalogExtensionChanges(await archive(project(), {'extensions/other.js': 'kept'}),
        [request('sample', {distribution: 'embedded'})], host(), {zip: Zip});
    assert.deepEqual((await names(kept)).sort(), ['extensions/other.js', copy]);
    const remote = await prepareCatalogExtensionChanges(kept.projectBytes, [request('sample')], host(), {zip: Zip});
    assert.deepEqual(await names(remote), ['extensions/other.js'], 'the retained copy is gone, unrelated entries stay');
    // Embedded again reuses the same path, so the copy must survive its own release.
    const again = await prepareCatalogExtensionChanges(kept.projectBytes,
        [request('sample', {distribution: 'embedded'})], host(), {zip: Zip});
    assert.deepEqual((await names(again)).sort(), ['extensions/other.js', copy]);
});

test('Embedded to Remote refuses changed server content before requesting new host approval', async () => {
    const initial = await prepareCatalogExtensionChanges(await archive(), [request('sample', {distribution: 'embedded'})], host(), {zip: Zip});
    const original = initial.projectBytes.slice();
    const ports = host({sources: new Map([[url('sample'), encoder.encode('different code')]])});
    await assert.rejects(prepareCatalogExtensionChanges(initial.projectBytes, [request('sample')], ports, {zip: Zip}), {code: 'DIGEST_MISMATCH'});
    assert.deepEqual(ports.approvals, []);
    assert.deepEqual(initial.projectBytes, original);
});

test('unselected existing Plus entries and distribution lock metadata remain unchanged', async () => {
    const input = project();
    input.turboWarpPlus = {schemaVersion: 1, extensions: [{id: 'existing', execution: 'sandboxed',
        source: {type: 'embedded', path: 'extensions/existing.js'}, sha256: hash(content('existing')),
        version: '0.9.0', publisher: 'Fixture Author', capabilities: ['network'], dependencies: []}]};
    input.extensions.push('existing');
    input.extensionURLs.ordinary = 'https://ordinary.test/legacy.js';
    input.turboWarpPlusLock = {schemaVersion: 1, extensions: [{id: 'existing', metadata: {license: 'MIT'}}]};
    const ports = host();
    const result = await prepareCatalogExtensionChanges(await archive(input, {'extensions/existing.js': content('existing')}),
        [request('newentry')], ports, {zip: Zip});
    const {json, zip} = await decode(result);
    assert.deepEqual(json.turboWarpPlus.extensions.find((spec: {id: string}) => spec.id === 'existing'), input.turboWarpPlus.extensions[0]);
    assert.deepEqual(json.turboWarpPlusLock, input.turboWarpPlusLock);
    assert.deepEqual(json.extensionURLs, input.extensionURLs);
    assert.deepEqual(await zip.file('extensions/existing.js')!.async('uint8array'), content('existing'));
    assert.deepEqual(ports.approvals.map(code => code.id), ['existing', 'newentry']);
});

test('full candidate dependency order is validated before host approval and returned in dependency order', async () => {
    const ports = host();
    const result = await prepareCatalogExtensionChanges(await archive(), [request('parent', {dependencies: ['base']}), request('base')], ports, {zip: Zip});
    assert.deepEqual(result.manifest.extensions.map(spec => spec.id), ['base', 'parent']);
    assert.deepEqual(ports.approvals.map(code => code.id), ['base', 'parent']);
    const missing = host();
    await assert.rejects(prepareCatalogExtensionChanges(project(), [request('parent', {dependencies: ['missing']})], missing, {zip: Zip}), {code: 'MISSING_DEPENDENCY'});
    assert.deepEqual(missing.approvals, []);
    const cyclic = host();
    await assert.rejects(prepareCatalogExtensionChanges(project(), [request('parent', {dependencies: ['base']}), request('base', {dependencies: ['parent']})], cyclic, {zip: Zip}), {code: 'DEPENDENCY_CYCLE'});
    assert.deepEqual(cyclic.approvals, []);
});

test('unsafe URLs, unknown execution and duplicate requests fail before fetch or host approval', async () => {
    const cases: [CatalogExtensionRequest[], string][] = [
        [[request('sample', {url: 'http://catalog.test/sample.js'})], 'INVALID_SOURCE'],
        [[request('sample', {url: 'https://user:secret@catalog.test/sample.js'})], 'INVALID_SOURCE'],
        [[request('sample', {url: `${url('sample')}#fragment`})], 'INVALID_SOURCE'],
        [[request('sample', {execution: 'automatic'})], 'INVALID_EXECUTION'],
        [[request('sample'), request('sample')], 'INVALID_ADDITION'],
        [[request('pen')], 'INVALID_ID'],
        [[request('sample', {distribution: 'mixed'})], 'INVALID_ADDITION']
    ];
    for (const [requests, code] of cases) {
        const ports = host();
        await assert.rejects(prepareCatalogExtensionChanges(project(), requests, ports, {zip: Zip}), {code});
        assert.deepEqual(ports.fetches, []);
        assert.deepEqual(ports.approvals, []);
    }
});

test('abort before or during remote fetch returns no candidate, does not prompt and preserves input', async () => {
    const input = await archive();
    const original = input.slice();
    const ports = host();
    await assert.rejects(prepareCatalogExtensionChanges(input, [request('sample')], ports,
        {zip: Zip, signal: AbortSignal.abort()}), {code: 'CANCELLED'});
    assert.deepEqual(ports.fetches, []);
    let entered: (() => void) | undefined;
    const fetching = new Promise<void>(resolve => { entered = resolve; });
    ports.fetcher.fetch = stubFetch(async () => { entered!(); return new Promise(() => {}); });
    const controller = new AbortController();
    const running = prepareCatalogExtensionChanges(input, [request('sample')], ports, {zip: Zip, signal: controller.signal});
    await fetching;
    controller.abort();
    await assert.rejects(running, {code: 'CANCELLED'});
    assert.deepEqual(ports.approvals, []);
    assert.deepEqual(input, original);
});

test('authoring state inspection reads saved sources and execution without fetching or approving code', async () => {
    assert.equal(await readProjectAuthoringState(await archive(), {zip: Zip}), null);
    const result = await prepareCatalogExtensionChanges(await archive(),
        [request('sample', {distribution: 'embedded', execution: 'sandboxed'})], host(), {zip: Zip});
    const state = await readProjectAuthoringState(result.projectBytes, {zip: Zip});
    assert.deepEqual(state, result.manifest);
    assert.equal(Object.isFrozen(state), true);
    assert.equal(globalThis.__catalogCodeExecuted, undefined);
});

test('catalog dependency arrays are snapshotted before asynchronous fetch work begins', async () => {
    const dependencies: string[] = [];
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const fetching = new Promise<void>(resolve => { entered = resolve; });
    const resumed = new Promise<void>(resolve => { release = resolve; });
    const ports = host();
    ports.fetcher.fetch = async (source: string) => { entered!(); await resumed; return {bytes: content('sample'), finalURL: source, redirects: []}; };
    const running = prepareCatalogExtensionChanges(project(), [request('sample', {dependencies})], ports, {zip: Zip});
    await fetching;
    dependencies.push('mutated');
    release!();
    const result = await running;
    assert.deepEqual(result.manifest.extensions[0].dependencies, []);
});

test('invalid catalog limits reject before source fetching', async () => {
    for (const loaderOptions of [{maxBytes: 0}, {maxTotalBytes: -1}, {maxExtensions: 0}, {timeoutMs: -1}]) {
        const ports = host();
        await assert.rejects(prepareCatalogExtensionChanges(project(), [request('sample')], ports,
            {zip: Zip, loaderOptions}), {code: 'INVALID_OPTIONS'});
        assert.deepEqual(ports.fetches, []);
        assert.deepEqual(ports.approvals, []);
    }
});

test('unproven fetch responses, oversized bodies and invalid UTF-8 never reach the approval callback', async () => {
    const cases: [Partial<FetchResult>, string][] = [
        [{bytes: content('sample'), finalURL: url('sample')}, 'REDIRECT_DENIED'],
        [{bytes: content('sample'), finalURL: url('other'), redirects: []}, 'REDIRECT_DENIED'],
        [{bytes: content('sample'), finalURL: url('sample'), redirects: [url('other')]}, 'REDIRECT_DENIED'],
        [{bytes: new Uint8Array(16 * 1024 * 1024 + 1), finalURL: url('sample'), redirects: []}, 'INVALID_BYTES'],
        [{bytes: new Uint8Array([0xff, 0xfe]), finalURL: url('sample'), redirects: []}, 'INVALID_ENCODING']
    ];
    for (const [response, code] of cases) {
        const ports = host();
        ports.fetcher.fetch = stubFetch(async () => response);
        await assert.rejects(prepareCatalogExtensionChanges(project(), [request('sample')], ports, {zip: Zip}), {code});
        assert.deepEqual(ports.approvals, []);
    }
});
