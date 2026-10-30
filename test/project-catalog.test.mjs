import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Zip from '@turbowarp/jszip';
import {prepareCatalogExtensionChanges, readProjectAuthoringState} from '../src/project-catalog.js';

const encoder = new TextEncoder();
const content = id => encoder.encode(`\ufeffglobalThis.__catalogCodeExecuted=true;\nScratch.extensions.register({getInfo(){return {id:'${id}',blocks:[]}}});\n`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const url = id => `https://catalog.test/${id}.js`;
const request = (id, changes = {}) => ({id, url: url(id), distribution: 'remote', execution: 'unsandboxed', ...changes});
const project = () => ({targets: [{isStage: true, name: 'Stage', blocks: {}, variables: {keep: ['original', 42]}}],
    extensions: ['pen'], extensionURLs: {}, meta: {agent: 'Catalog tests'}, unknown: {retain: true}});
async function archive(json = project(), entries = {}) {
    const zip = new Zip().file('project.json', JSON.stringify(json));
    for (const [name, bytes] of Object.entries(entries)) zip.file(name, bytes, {createFolders: false});
    return zip.generateAsync({type: 'uint8array', compression: 'STORE'});
}
async function decode(result) {
    const zip = await Zip.loadAsync(result.projectBytes);
    return {zip, json: JSON.parse(await zip.file('project.json').async('string'))};
}
function host({allow = () => true, sources = new Map()} = {}) {
    const fetches = [];
    const approvals = [];
    return {fetches, approvals,
        fetcher: {async fetch(source) {
            fetches.push(source);
            const id = new URL(source).pathname.split('/').pop().replace(/\.js$/, '');
            return {bytes: sources.get(source) || content(id), finalURL: source, redirects: []};
        }},
        trustProvider: {async authorize(code) {
            approvals.push(code);
            return {allowed: allow(code), scope: 'digest', sha256: code.sha256};
        }}
    };
}

for (const execution of ['sandboxed', 'unsandboxed']) {
    for (const distribution of ['embedded', 'remote']) {
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
            assert.equal(await zip.file('image.svg').async('string'), '<svg/>');
            assert.deepEqual(await zip.file('unknown/data.bin').async('uint8array'), new Uint8Array([1, 2, 3]));
            if (distribution === 'embedded') assert.deepEqual(await zip.file(spec.source.path).async('uint8array'), content(id));
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
    assert.deepEqual(await zip.file(spec.source.path).async('uint8array'), content('sample'));
    assert.equal(globalThis.__catalogCodeExecuted, undefined);
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
    assert.deepEqual(json.turboWarpPlus.extensions.find(spec => spec.id === 'existing'), input.turboWarpPlus.extensions[0]);
    assert.deepEqual(json.turboWarpPlusLock, input.turboWarpPlusLock);
    assert.deepEqual(json.extensionURLs, input.extensionURLs);
    assert.deepEqual(await zip.file('extensions/existing.js').async('uint8array'), content('existing'));
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
    for (const [requests, code] of [
        [[request('sample', {url: 'http://catalog.test/sample.js'})], 'INVALID_SOURCE'],
        [[request('sample', {url: 'https://user:secret@catalog.test/sample.js'})], 'INVALID_SOURCE'],
        [[request('sample', {url: `${url('sample')}#fragment`})], 'INVALID_SOURCE'],
        [[request('sample', {execution: 'automatic'})], 'INVALID_EXECUTION'],
        [[request('sample'), request('sample')], 'INVALID_ADDITION'],
        [[request('pen')], 'INVALID_ID'],
        [[request('sample', {distribution: 'mixed'})], 'INVALID_ADDITION']
    ]) {
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
    let entered;
    const fetching = new Promise(resolve => { entered = resolve; });
    ports.fetcher.fetch = async () => { entered(); return new Promise(() => {}); };
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
    const dependencies = [];
    let entered;
    let release;
    const fetching = new Promise(resolve => { entered = resolve; });
    const resumed = new Promise(resolve => { release = resolve; });
    const ports = host();
    ports.fetcher.fetch = async source => { entered(); await resumed; return {bytes: content('sample'), finalURL: source, redirects: []}; };
    const running = prepareCatalogExtensionChanges(project(), [request('sample', {dependencies})], ports, {zip: Zip});
    await fetching;
    dependencies.push('mutated');
    release();
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
    for (const [response, code] of [
        [{bytes: content('sample'), finalURL: url('sample')}, 'REDIRECT_DENIED'],
        [{bytes: content('sample'), finalURL: url('other'), redirects: []}, 'REDIRECT_DENIED'],
        [{bytes: content('sample'), finalURL: url('sample'), redirects: [url('other')]}, 'REDIRECT_DENIED'],
        [{bytes: new Uint8Array(1024 * 1024 + 1), finalURL: url('sample'), redirects: []}, 'INVALID_BYTES'],
        [{bytes: new Uint8Array([0xff, 0xfe]), finalURL: url('sample'), redirects: []}, 'INVALID_ENCODING']
    ]) {
        const ports = host();
        ports.fetcher.fetch = async () => response;
        await assert.rejects(prepareCatalogExtensionChanges(project(), [request('sample')], ports, {zip: Zip}), {code});
        assert.deepEqual(ports.approvals, []);
    }
});
