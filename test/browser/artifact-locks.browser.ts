import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';
import {buildLock} from '../artifact-lock-fixture.ts';
import type {} from './artifact-lock-page.ts';

test('the browser authoring and codec preserve provenance without Node, execution or inherited consent', {timeout: 30000}, async t => {
    const runtime = await serveEditorRuntime({script: fileURLToPath(new URL('./artifact-lock-page.ts', import.meta.url))});
    t.after(() => runtime.close());
    const args = process.platform === 'darwin' ? ['--single-process', '--no-zygote', '--disable-crash-reporter'] : [];
    const browser = await chromium.launch({headless: true, args});
    t.after(() => browser.close());
    const page = await browser.newPage();
    const origin = new URL(runtime.url).origin;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(runtime.url);
    await page.waitForFunction(() => typeof window.checkArtifactLock === 'function');
    const bytes = new TextEncoder().encode('globalThis.__loaderArtifactLockExecuted = true;');
    const lock = buildLock('sample', bytes);
    const run = (value: unknown, allowed = true) => page.evaluate(({lock, bytes, allowed}) =>
        window.checkArtifactLock(lock as Parameters<typeof window.checkArtifactLock>[0], bytes, allowed),
    {lock: value, bytes: [...bytes], allowed});
    const result = await run(lock);
    assert.deepEqual(result, {approved: 1, saved: {formatVersion: 1, extensions: [{id: 'sample', artifactLock: lock}]},
        code: null, executed: false});
    assert.deepEqual(await run(lock, false), {approved: 1, code: 'TRUST_DENIED', saved: null, executed: false});
    assert.deepEqual(await run({...lock, formatVersion: 99}), {approved: 0, code: 'INVALID_ARTIFACT_LOCK', saved: null, executed: false});
    assert.equal(await page.evaluate(() => 'process' in window || 'require' in window), false);
});
