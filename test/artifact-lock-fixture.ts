import {createHash} from 'node:crypto';
import {validateExtensionArtifactLock, type ExtensionArtifactLock} from '@kubohiroya/sb3-toolchain/web-distribution';

/** Synthetic observations for schema tests; no compiler or extension code is executed. */
export function buildLock(id: string, bytes: Uint8Array): ExtensionArtifactLock {
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const apiJSON = JSON.stringify({formatVersion: 1, id, blocks: [], menus: []});
    const lock: ExtensionArtifactLock = {formatVersion: 1, bundleSHA256: hash(bytes), apiJSON,
        provenance: {kind: 'build', receipt: {formatVersion: 1, profile: 'turbowarp-typescript-v1', execution: 'sandboxed',
            compiler: {name: 'rolldown', version: '1.3.4', integrity: 'sha512-' + 'A'.repeat(86) + '=='},
            snapshotSHA256: 'a'.repeat(64), lockfileSHA256: 'b'.repeat(64),
            source: {kind: 'github', repository: 'outside-editor/fixture', commit: 'c'.repeat(40)},
            outputs: {[`${id}.js`]: hash(bytes), [`${id}.js.map`]: 'd'.repeat(64),
                'extension-manifest.json': hash(new TextEncoder().encode(apiJSON)), 'extension-development.json': 'e'.repeat(64)}}}};
    validateExtensionArtifactLock(lock, id, bytes);
    return lock;
}
