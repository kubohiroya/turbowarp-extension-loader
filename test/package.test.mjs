import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access, readFile} from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const modules = Object.entries(pkg.exports).filter(([, target]) => typeof target === 'object');

test('package exports resolve to built JavaScript and declarations that are published', async () => {
    assert.ok(pkg.files.includes('dist'), 'git installs pack only listed files, and dist is gitignored');
    for (const [subpath, target] of modules) {
        await access(new URL(target.default, root));
        await access(new URL(target.types, root));
        assert.ok(target.default.startsWith('./dist/') && target.types.startsWith('./dist/'), subpath);
    }
    await access(new URL(pkg.types, root));
});

test('webpack 4 entry points load the same built modules as package exports', async () => {
    // webpack 4 ignores "exports": it reads "module" or "main" and resolves subpaths as root files.
    assert.equal(pkg.main, pkg.module);
    assert.equal(await import(new URL(pkg.module, root).href), await import(pkg.name));
    for (const [subpath] of modules.filter(([subpath]) => subpath !== '.')) {
        const file = `${subpath.slice(2)}.js`;
        assert.ok(pkg.files.includes(file), `${file} is published`);
        const shim = await import(new URL(file, root).href);
        const exported = await import(`${pkg.name}/${subpath.slice(2)}`);
        assert.deepEqual(Object.keys(shim).sort(), Object.keys(exported).sort(), subpath);
        for (const name of Object.keys(exported)) assert.equal(shim[name], exported[name], `${subpath} ${name}`);
    }
});
