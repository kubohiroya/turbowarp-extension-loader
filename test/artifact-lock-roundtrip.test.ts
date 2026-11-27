import {test} from 'node:test';
import assert from 'node:assert/strict';
import Zip from '@turbowarp/jszip';
import {buildStandardExtension} from '@kubohiroya/sb3-toolchain/standard-extension-build';
import {lockStandardExtensionBuild} from '@kubohiroya/sb3-toolchain';
import {unpackSb3} from '@kubohiroya/sb3-toolchain/browser';
import {prepareExtensionAddition} from '@kubohiroya/turbowarp-extension-loader/project-authoring';
import {prepareCatalogExtensionChanges} from '@kubohiroya/turbowarp-extension-loader/project-catalog';
import {createProjectIO} from '@kubohiroya/turbowarp-extension-loader/project-codec';

test('a real standard build retains its receipt through Loader SB3 save; raw Plus import stays explicitly unsupported', async () => {
    const encode = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
    const source = new Map([
        ['extension-build.json', encode({formatVersion: 1, profile: 'turbowarp-typescript-v1', entry: 'src/index.ts',
            settings: 'src/extension-config.json', blocks: 'src/block-definitions.json', lockfile: 'pnpm-lock.yaml', dependencies: 'none'})],
        ['package.json', encode({name: 'loader-lock-fixture', scripts: {prepare: 'exit 41', build: 'exit 42'}})],
        ['pnpm-lock.yaml', encode("lockfileVersion: '9.0'")],
        ['src/extension-config.json', encode({id: 'sample', slug: 'sample', name: 'Sample', description: 'Loader fixture',
            author: 'Test', license: 'MPL-2.0', unsandboxed: false, docsURI: 'https://example.test/',
            blockIconURI: 'data:image/svg+xml;base64,PHN2Zy8+'})],
        ['src/block-definitions.json', encode({extensionName: 'Sample', blocks: [{opcode: 'value', blockType: 'REPORTER', text: 'value'}]})],
        ['src/index.ts', encode('globalThis.__loaderArtifactLockExecuted = true; Scratch.extensions.register({value: 41});')]
    ]);
    const built = await buildStandardExtension(source);
    const artifactLock = lockStandardExtensionBuild(built);
    const bytes = built.files.get('sample.js')!;
    let approvals = 0;
    const ports = {trustProvider: {async authorize(spec: {sha256: string}) {
        approvals++; return {allowed: true, scope: 'digest' as const, sha256: spec.sha256};
    }}, fetcher: {async fetch(url: string) {return {bytes, finalURL: url, redirects: []};}}};
    const added = await prepareExtensionAddition({targets: [{isStage: true, name: 'Stage', blocks: {}, costumes: [], sounds: []}], extensions: []},
        {id: 'sample', execution: 'sandboxed', source: {type: 'embedded-file'}, bytes, artifactLock}, ports, {zip: Zip});
    // The standard-host carrier is the existing catalog conversion; no new source type is introduced.
    const carried = await prepareCatalogExtensionChanges(added.projectBytes, [{id: 'sample', execution: 'sandboxed',
        distribution: 'embedded-data', url: 'https://example.test/sample.js'}], ports, {zip: Zip});
    const io = createProjectIO({zip: Zip});
    const reopened = await io.prepare(carried.projectBytes);
    const saved = new Zip().file('project.json', io.restoreJSON('{"targets":[]}', reopened.context));
    io.restoreArchive(saved, reopened.context);
    const metadata = JSON.parse(await saved.file('tw-plus/extension-locks.json')!.async('string'));
    assert.deepEqual(metadata, {formatVersion: 1, extensions: [{id: 'sample', artifactLock}]});
    // Toolchain deliberately refuses Plus manifests; this remains a separate, unfinished integration.
    assert.throws(() => unpackSb3(carried.projectBytes), {code: 'unsupported-project'});
    assert.equal(approvals, 2);
    assert.equal('__loaderArtifactLockExecuted' in globalThis, false);
});
