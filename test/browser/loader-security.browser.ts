import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';
import {DEFAULT_FETCH_RETRY} from '@kubohiroya/turbowarp-extension-loader';
import {chromium, type Page} from 'playwright';

const extension = `
Scratch.vm.browserFixtureExecutions = (Scratch.vm.browserFixtureExecutions || 0) + 1;
Scratch.extensions.register({
    getInfo() { return {id: 'browserfixture', name: 'Browser fixture', blocks: [
        {opcode: 'value', blockType: Scratch.BlockType.REPORTER, text: 'value'}
    ]}; },
    value() { return 42; }
});`;
const sha256 = createHash('sha256').update(extension).digest('hex');

test('the Loader respects browser security with the real scratch-vm registrar', {timeout: 30000}, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'tw-loader-tls-'));
    t.after(() => rm(directory, {force: true, recursive: true}));
    const key = join(directory, 'key.pem');
    const cert = join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
        '-out', cert, '-days', '1', '-subj', '/CN=localhost'], {stdio: 'ignore'});
    const requests: string[] = [];
    const server = createServer({key: await readFile(key), cert: await readFile(cert)}, (request, response) => {
        const path = request.url ?? '';
        requests.push(path);
        response.setHeader('cache-control', 'no-store');
        if (path === '/redirect') {
            response.writeHead(302, {'access-control-allow-origin': '*', location: '/extension.js'}).end();
            return;
        }
        if (path === '/extension.js' || path === '/no-cors') {
            response.writeHead(200, {'content-type': 'application/javascript',
                ...(path === '/extension.js' ? {'access-control-allow-origin': '*'} : {})}).end(extension);
            return;
        }
        response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
    }));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `https://127.0.0.1:${address.port}`;

    const runtime = await serveEditorRuntime({script: fileURLToPath(new URL('./loader-page.ts', import.meta.url))});
    t.after(() => runtime.close());
    const args = ['--enable-unsafe-swiftshader'];
    if (process.platform === 'darwin') args.push('--single-process', '--no-zygote', '--disable-crash-reporter');
    const browser = await chromium.launch({headless: true, args});
    t.after(() => browser.close());
    const page = await browser.newPage({ignoreHTTPSErrors: true});
    const open = () => page.goto(runtime.url);
    const load = (page: Page, path: string) => page.evaluate(({url, digest}) => window.loadBrowserExtension(url, digest),
        {url: origin + path, digest: sha256});

    await t.test('an approved CORS response registers and runs a real VM primitive', async () => {
        const before = requests.length;
        await open();
        assert.deepEqual(await load(page, '/extension.js'),
            {code: null, cause: null, authorized: 1, executed: 1, registered: true, value: 42});
        assert.deepEqual(requests.slice(before), ['/extension.js']);
    });

    for (const [name, path] of [['a response without CORS permission', '/no-cors'], ['a real HTTPS redirect', '/redirect']]) {
        await t.test(`rejects ${name} before authorizing or executing code`, async () => {
            const before = requests.length;
            await open();
            assert.deepEqual(await load(page, path),
                {code: 'LOAD_FAILED', cause: 'TypeError', authorized: 0, executed: 0, registered: false, value: null});
            // Chromium reports both refusals as fetch TypeErrors. The retry must only hit the requested URL.
            assert.deepEqual(requests.slice(before), Array(DEFAULT_FETCH_RETRY.retries + 1).fill(path));
        });
    }

    await t.test('CSP blocks dynamic evaluation after authorization', async () => {
        await open();
        await page.evaluate(() => {
            const meta = document.createElement('meta');
            meta.httpEquiv = 'Content-Security-Policy';
            meta.content = "script-src 'self'";
            document.head.appendChild(meta);
        });
        assert.deepEqual(await load(page, '/extension.js'),
            {code: 'LOAD_FAILED', cause: 'EvalError', authorized: 1, executed: 0, registered: false, value: null});
    });
});
