// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import {test} from 'node:test';
import loadCatalog, {type CatalogLoadEntry, type CatalogLoadPermissions}
    from '@kubohiroya/turbowarp-extension-loader/scratch-vm/catalog-load';

test('legacy catalog failure releases reviewed modes, keeps earlier dependencies, and allows a new review', async () => {
    const entries: CatalogLoadEntry[] = [
        {id: 'source', url: 'https://catalog.test/source.js', dependencies: []},
        {id: 'filter', url: 'https://catalog.test/filter.js', dependencies: ['source']},
        {id: 'view', url: 'https://catalog.test/view.js', dependencies: ['filter']}
    ];
    const security = {};
    const registered = new Set<string>();
    const nativeCalls: [string, string | undefined][] = [];
    const policyCalls: string[] = [];
    const failed = new Error('Native extension load failed');
    let rejectNativeLoad = true;
    let currentModes: Map<string, string> | undefined;
    let reviewsOpened = 0;
    let reviewsReleased = 0;
    const ports: CatalogLoadPermissions = {
        beginReview(securityManager, modes) {
            assert.equal(securityManager, security);
            assert.equal(currentModes, undefined);
            assert.equal(modes.size, 0);
            currentModes = modes;
            reviewsOpened++;
            return () => {
                assert.equal(currentModes, modes);
                currentModes = undefined;
                reviewsReleased++;
            };
        },
        async canLoad(securityManager, url) {
            assert.equal(securityManager, security);
            assert.ok(currentModes);
            assert.equal(currentModes.has(url), false, 'must consult host approval before exposing a mode');
            policyCalls.push(url);
            return true;
        }
    };
    const vm = {extensionManager: {
        securityManager: security,
        isExtensionLoaded: (id: string) => registered.has(id),
        async loadExtensionURL(url: string) {
            const entry = entries.find(item => item.url === url);
            assert.ok(entry);
            assert.ok(entry.dependencies.every(id => registered.has(id)));
            nativeCalls.push([entry.id, currentModes?.get(url)]);
            if (entry.id === 'filter' && rejectNativeLoad) throw failed;
            registered.add(entry.id);
        }
    }};
    const choices = (filterMode: string) => new Map(entries.map(entry => [entry.url,
        entry.id === 'filter' ? filterMode : 'sandboxed']));

    await assert.rejects(loadCatalog(vm, entries, choices('unsandboxed'), ports), error => error === failed);
    assert.deepEqual([...registered], ['source'], 'do not roll back a working dependency');
    assert.deepEqual(nativeCalls, [['source', 'iframe'], ['filter', 'unsandboxed']]);
    assert.deepEqual(policyCalls, entries.slice(0, 2).map(entry => entry.url));
    assert.equal(currentModes, undefined);
    assert.equal(reviewsReleased, 1);

    rejectNativeLoad = false;
    assert.deepEqual(await loadCatalog(vm, entries, choices('sandboxed'), ports), ['source', 'filter', 'view']);
    assert.deepEqual([...registered], ['source', 'filter', 'view']);
    assert.deepEqual(nativeCalls, [
        ['source', 'iframe'], ['filter', 'unsandboxed'],
        ['filter', 'iframe'], ['view', 'iframe']
    ], 'retry skips the working dependency and uses the newly reviewed mode');
    assert.deepEqual(policyCalls, [entries[0].url, entries[1].url, entries[1].url, entries[2].url]);
    assert.equal(currentModes, undefined);
    assert.equal(reviewsOpened, 2);
    assert.equal(reviewsReleased, 2);
});
