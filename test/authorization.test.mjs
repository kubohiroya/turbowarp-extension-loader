import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createExtensionLoader, isAuthorizedCode} from '../src/index.js';

test('authorization proof cannot be forged with manifest fields or a copied record', async () => {
    const bytes = new TextEncoder().encode('/* approved bytes */');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let issued;
    let validDuringRegistration;
    assert.equal(isAuthorizedCode({authorization: {allowed: true, scope: 'digest', sha256}}), false);
    const loader = createExtensionLoader({
        embeddedReader: {read: async () => bytes},
        trustProvider: {authorize: async () => ({allowed: true, scope: 'digest', sha256})},
        registrar: {
            begin: async () => ({
                register: async value => { issued = value; validDuringRegistration = isAuthorizedCode(value); return {id: value.id}; },
                commit: async () => {}, rollback: async () => {}
            }), unload: async () => {}
        }
    });
    await loader.load({schemaVersion: 1, extensions: [{id: 'proof', execution: 'unsandboxed', sha256,
        source: {type: 'embedded', path: 'extensions/proof.js'}}]});
    assert.equal(validDuringRegistration, true);
    assert.equal(isAuthorizedCode(issued), false);
    assert.equal(isAuthorizedCode({...issued}), false);
    assert.equal(Object.isFrozen(issued), true);
    await loader.unload();
});
