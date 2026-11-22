import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {configurePlusPackager, packagePlusHTML} from '@kubohiroya/turbowarp-extension-loader/packager';
import {prepareOfflinePackage} from '@kubohiroya/turbowarp-extension-loader/packager';
import Zip from '@turbowarp/jszip';
const require = createRequire(import.meta.url);
const {Packager} = require('@turbowarp/packager');
const bytes = new TextEncoder().encode('Scratch.extensions.register({getInfo(){return {id:"sample",blocks:[]}}});');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const project = {targets: [{isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {},
    currentCostume: 0, costumes: [], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null}],
    monitors: [], extensions: ['sample'], extensionURLs: {}, meta: {semver: '3.0.0', vm: '2.0.0', agent: 'Plus fixture'},
    turboWarpPlus: {schemaVersion: 1, extensions: [{id: 'sample', execution: 'unsandboxed', sha256, source: {type: 'remote-cacheable', url: 'https://example.test/code.js'}}]}};
const ports: Parameters<typeof prepareOfflinePackage>[1] = {
    fetcher: {async fetch(url) { return {bytes, finalURL: url, redirects: []}; }},
    trustProvider: {async authorize(code) { return {allowed: true, scope: 'digest', sha256: code.sha256}; }}
};
// The Editor's limits (64 MiB project and entry); they travel with the HTML.
const archiveOptions = {maxProjectBytes: 64 * 1024 * 1024, maxEntryBytes: 64 * 1024 * 1024};
const prepare = () => prepareOfflinePackage(project, ports, {zip: Zip, resourceDependencies: {sample: [] as never[]}});

test('actual TurboWarp Packager embeds an opaque verified SB3, runtime bootstrap and restrictive CSP into single HTML', async () => {
    const prepared = await prepare();
    const packager = new Packager();
    const result = await packagePlusHTML(packager, prepared, {archiveOptions, runtimeBundle: 'globalThis.TurboWarpPlusExtensionHost={installPlusExtensionHost:()=>({enabled:true})};'});
    assert.equal(result.type, 'text/html');
    const html = new TextDecoder().decode(result.data);
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('Plus runtime bootstrap did not complete'));
    assert.ok(html.includes("connect-src 'none'"));
    assert.ok(!html.includes('https://example.test/code.js'));
    assert.equal(packager.project.type, 'blob');
    assert.equal(packager.options.cloudVariables.mode, 'none');
    assert.deepEqual(packager.project.analysis.extensions, []);
});

test('actual Packager resource assembly preserves double-quoted iframe script terminators', async () => {
    const prepared = await prepare();
    const packager = new Packager();
    const source = 'globalThis.iframeEnd = "</script></body>";';
    configurePlusPackager(packager, prepared, {archiveOptions, runtimeBundle: 'trusted();',
        scaffoldingAssets: {scaffolding: source, 'scaffolding-min': source, addons: source}});
    await packager.loadResources();
    assert.equal(packager.script.includes("</scri'+'pt>"), false);
    assert.equal(packager.script.toLowerCase().includes('</script>'), false);
    const state: {iframeEnd?: string} = {};
    new Function('globalThis', packager.script)(state);
    assert.equal(state.iframeEnd, '</script></body>');
});

test('packaging refuses missing trusted bootstrap, prior custom JS and reused instances', async () => {
    const prepared = await prepare();
    assert.throws(() => configurePlusPackager(new Packager(), prepared, {archiveOptions}), {code: 'MISSING_BOOTSTRAP'});
    const packager = new Packager();
    packager.options.custom.js = 'unreviewed()';
    assert.throws(() => configurePlusPackager(packager, prepared, {archiveOptions, runtimeBundle: 'trusted()'}), {code: 'UNREVIEWED_CUSTOM_CODE'});
    packager.used = true;
    assert.throws(() => configurePlusPackager(packager, prepared, {archiveOptions, runtimeBundle: 'trusted()'}), {code: 'PACKAGE_BUSY'});
});

test('packaging embeds only valid digests of the project extensions for the recipient runtime', async () => {
    const prepared = await prepare();
    const packager = new Packager();
    configurePlusPackager(packager, prepared, {archiveOptions, runtimeBundle: 'trusted();', trustedDigests: [sha256]});
    // The archive limits travel with the HTML: the runtime bundle it carries is built by the
    // distributing host and holds no copy of them, so the bootstrap states what this build accepts.
    const limits = '"archiveOptions":{"maxProjectBytes":67108864,"maxEntryBytes":67108864}';
    assert.ok(packager.options.custom.js.includes(
        `installPlusExtensionHost(vm, {"enabled":true,"locale":"ja","trustedDigests":["${sha256}"],${limits}})`));
    for (const trustedDigests of [['a'.repeat(64)], ['not a digest'], 'nope']) {
        assert.throws(() => configurePlusPackager(new Packager(), prepared, {archiveOptions, runtimeBundle: 'trusted();', trustedDigests: trustedDigests as string[]}),
            {code: 'INVALID_TRUSTED_DIGESTS'});
    }
    const untrusted = new Packager();
    configurePlusPackager(untrusted, prepared, {archiveOptions, runtimeBundle: 'trusted();'});
    assert.ok(untrusted.options.custom.js.includes(
        `installPlusExtensionHost(vm, {"enabled":true,"locale":"ja","trustedDigests":[],${limits}})`));
});

test('the archive limits given by the host travel with the HTML bootstrap', async () => {
    const packager = new Packager();
    configurePlusPackager(packager, await prepare(), {archiveOptions, runtimeBundle: 'trusted();'});
    assert.match(packager.options.custom.js, /"archiveOptions":\{"maxProjectBytes":67108864,"maxEntryBytes":67108864\}/);
});
