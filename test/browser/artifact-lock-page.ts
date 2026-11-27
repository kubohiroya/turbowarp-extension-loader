import Zip from '@turbowarp/jszip';
import {prepareExtensionAddition} from '@kubohiroya/turbowarp-extension-loader/project-authoring';
import {createProjectIO} from '@kubohiroya/turbowarp-extension-loader/project-codec';
import type {ExtensionArtifactLock} from '@kubohiroya/sb3-toolchain/web-distribution';

async function checkArtifactLock(lock: ExtensionArtifactLock, data: number[], allowed: boolean) {
    let approved = 0;
    try {
        const result = await prepareExtensionAddition({targets: []}, {id: 'sample', execution: 'sandboxed',
            source: {type: 'embedded-file'}, bytes: new Uint8Array(data), artifactLock: lock}, {
            trustProvider: {async authorize(spec) {
                approved++;
                return {allowed, scope: 'digest', sha256: spec.sha256};
            }}
        }, {zip: Zip});
        const io = createProjectIO({zip: Zip});
        const prepared = await io.prepare(result.projectBytes);
        const archive = new Zip().file('project.json', io.restoreJSON('{"targets":[]}', prepared.context));
        io.restoreArchive(archive, prepared.context);
        const again = await io.prepare(await archive.generateAsync({type: 'uint8array'}));
        const files = io.restoreFiles({'project.json': new TextEncoder().encode('{"targets":[]}')}, again.context);
        return {approved, saved: JSON.parse(new TextDecoder().decode(files['tw-plus/extension-locks.json'])), code: null,
            executed: '__loaderArtifactLockExecuted' in globalThis};
    } catch (error) {
        return {approved, code: (error as {code: string}).code, saved: null,
            executed: '__loaderArtifactLockExecuted' in globalThis};
    }
}
declare global { interface Window { checkArtifactLock: typeof checkArtifactLock } }
window.checkArtifactLock = checkArtifactLock;
