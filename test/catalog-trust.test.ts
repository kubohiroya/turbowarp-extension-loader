import assert from 'node:assert/strict';
import test from 'node:test';

import {createTrustedCatalog, listTrustedDigests} from '@kubohiroya/turbowarp-extension-loader/catalog-trust';
import {parseExtensionCatalog} from '@kubohiroya/turbowarp-extension-security-dialog';
const createPlusTrustedCatalog = (options: Omit<Parameters<typeof createTrustedCatalog>[0], 'parseCatalog'>) => createTrustedCatalog({...options, parseCatalog: parseExtensionCatalog});

const listed = 'https://cdn.example.test/npm/@owner/listed@1.0.0/dist/listed.js';
const digest = 'a'.repeat(64);
const catalog = (extra: object = {}) => ({schemaVersion: 1, extensions: [{id: 'listed', name: 'Listed',
    version: '1.0.0', url: listed, dependencies: [], ...extra}]});
const code = (source: {type: string; url?: string; path?: string}, actualSHA256: string) => ({id: 'listed', execution: 'unsandboxed', source,
    sha256: actualSHA256, actualSHA256, capabilities: [], dependencies: []});

test('a URL listed in the catalog is trusted and an unlisted URL is not', async () => {
    const trusted = createPlusTrustedCatalog({readCatalog: async () => catalog()});
    assert.equal(await trusted.isTrustedURL(listed), true);
    assert.equal(await trusted.isTrustedURL('https://cdn.example.test/npm/@owner/other@1.0.0/dist/other.js'), false);
    assert.equal(await trusted.isTrustedURL('data:text/javascript,1'), false);
});

test('listed remote code must match the listed SHA-256 when the catalog has one', async () => {
    const trusted = createPlusTrustedCatalog({readCatalog: async () => catalog({sha256: digest})});
    assert.equal(await trusted.isTrustedCode(code({type: 'remote-cacheable', url: listed}, digest)), true);
    assert.equal(await trusted.isTrustedCode(code({type: 'remote-cacheable', url: listed}, 'b'.repeat(64))), false);
});

test('embedded code is trusted only by a listed SHA-256', async () => {
    const withDigest = createPlusTrustedCatalog({readCatalog: async () => catalog({sha256: digest})});
    assert.equal(await withDigest.isTrustedCode(code({type: 'embedded-file', path: 'extensions/listed.js'}, digest)), true);
    assert.equal(await withDigest.isTrustedCode(
        code({type: 'embedded-file', path: 'extensions/listed.js'}, 'c'.repeat(64))), false);
    const withoutDigest = createPlusTrustedCatalog({readCatalog: async () => catalog()});
    assert.equal(await withoutDigest.isTrustedCode(
        code({type: 'embedded-file', path: 'extensions/listed.js'}, digest)), false);
});

test('an unreadable or invalid catalog trusts nothing and is read again on the next check', async () => {
    let reads = 0;
    const trusted = createPlusTrustedCatalog({readCatalog: async () => {
        reads++;
        if (reads === 1) throw new Error('offline');
        if (reads === 2) return {schemaVersion: 2, extensions: []};
        return catalog();
    }});
    assert.equal(await trusted.isTrustedURL(listed), false);
    assert.equal(await trusted.isTrustedURL(listed), false);
    assert.equal(await trusted.isTrustedURL(listed), true);
    assert.equal(await trusted.isTrustedURL(listed), true);
    assert.equal(reads, 3);
});

test('packaging embeds the digests of the project extensions that the catalog lists', async () => {
    const trusted = createPlusTrustedCatalog({readCatalog: async () => catalog({sha256: digest})});
    const manifest = {schemaVersion: 1, extensions: [
        {id: 'listed', execution: 'unsandboxed', sha256: digest, source: {type: 'embedded-file', path: 'extensions/a.js'}},
        {id: 'other', execution: 'sandboxed', sha256: 'b'.repeat(64), source: {type: 'embedded-file', path: 'extensions/b.js'}}
    ]};
    assert.deepEqual(await listTrustedDigests(trusted, manifest), [digest]);
    const unreadable = createPlusTrustedCatalog({readCatalog: async () => {
        throw new Error('offline');
    }});
    assert.deepEqual(await listTrustedDigests(unreadable, manifest), []);
});

test('every build a catalog item lists as a variant is trusted by its own address and digest', async () => {
    const playback = 'https://cdn.example.test/npm/@owner/listed@1.0.0/dist/listed-playback.js';
    const variantDigest = 'd'.repeat(64);
    const trusted = createPlusTrustedCatalog({readCatalog: async () => catalog({sha256: digest, variants: [
        {url: playback, sha256: variantDigest}
    ]})});
    assert.equal(await trusted.isTrustedCode(code({type: 'embedded-file', path: 'extensions/listed.js'}, variantDigest)), true);
    assert.equal(await trusted.isTrustedCode(code({type: 'remote-cacheable', url: playback}, variantDigest)), true);
    assert.equal(await trusted.isTrustedCode(code({type: 'remote-cacheable', url: playback}, digest)), false);
    assert.equal(await trusted.isTrustedURL(playback), true);
    assert.equal(trusted.listedDigests.has(variantDigest), true);
});

test('the Editor fails closed when catalog validation rejects a variant', async () => {
    const rejectedVariant = {url: 'https://cdn.example.test/short.js', sha256: 'f'};
    const trusted = createPlusTrustedCatalog({readCatalog: async () => catalog({sha256: digest,
        variants: [rejectedVariant]})});
    assert.equal(await trusted.isTrustedURL(listed), false);
    assert.equal(await trusted.isTrustedURL(rejectedVariant.url), false);
    assert.equal(await trusted.isTrustedCode(code({type: 'embedded-file', path: 'extensions/listed.js'}, digest)), false);
    assert.equal(trusted.listedDigests.size, 0);
});
