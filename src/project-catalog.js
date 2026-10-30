import {LoaderError, validateManifest} from './index.js';
import {createProjectIO} from './project-codec.js';
import {readPreparedProject} from './project-data.js';
import {collectVerifiedCodes} from './verified-code.js';

const encoder = new TextEncoder();
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    value => value.toString(16).padStart(2, '0')).join('');
const fail = (code, message, id) => { throw new LoaderError(code, message, id); };

/** Read project-owned distribution requests; these records never grant execution permission. */
export async function readProjectAuthoringState(input, {zip, signal, archiveOptions} = {}) {
    const io = createProjectIO({zip, ...archiveOptions});
    const prepared = await io.prepare(input, {signal});
    return prepared.manifest;
}

/** Stage an entire catalog selection before the host changes its active project. */
export async function prepareCatalogExtensionChanges(input, requests, ports, {
    zip: Zip, signal: externalSignal, loaderOptions = {}, archiveOptions
} = {}) {
    const limits = {maxExtensions: 64, maxBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024,
        timeoutMs: 30000, ...loaderOptions};
    for (const key of ['maxExtensions', 'maxBytes', 'maxTotalBytes', 'timeoutMs']) {
        if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) fail('INVALID_OPTIONS', `Invalid ${key}`);
    }
    if (!Array.isArray(requests) || requests.length > limits.maxExtensions) {
        fail('INVALID_ADDITION', 'A bounded catalog selection is required');
    }
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
        if (input.byteLength > (archiveOptions?.maxArchiveBytes ?? 64 * 1024 * 1024)) {
            fail('ARCHIVE_SIZE_LIMIT', 'Project exceeds the archive byte limit');
        }
        input = input.slice(0);
    } else if (typeof input !== 'string' && !(input instanceof Blob)) input = JSON.stringify(input);
    const controller = new AbortController();
    const abort = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener('abort', abort, {once: true});
    const signal = controller.signal;
    const check = () => {
        if (signal.aborted) fail(signal.reason?.code === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED', 'Catalog changes interrupted');
    };
    const wait = async task => {
        check();
        let cancel;
        const cancelled = new Promise((resolve, reject) => {
            cancel = () => { try { check(); } catch (error) { reject(error); } };
            signal.addEventListener('abort', cancel, {once: true});
        });
        try { return await Promise.race([Promise.resolve().then(task), cancelled]); }
        finally { signal.removeEventListener('abort', cancel); }
    };
    const maxBytes = limits.maxBytes;
    const timer = setTimeout(() => controller.abort(new LoaderError('TIMEOUT', 'Catalog changes timed out')),
        limits.timeoutMs);
    try {
        const seen = new Set();
        const choices = requests.map(request => {
            if (!request || !['remote', 'embedded'].includes(request.distribution) || seen.has(request.id)) {
                fail('INVALID_ADDITION', 'Invalid or duplicate catalog selection', request?.id);
            }
            seen.add(request.id);
            const execution = request.execution;
            const spec = validateManifest({schemaVersion: 1, extensions: [{id: request.id,
                source: {type: 'remote', url: request.url}, execution, sha256: '0'.repeat(64),
                ...(request.version ? {version: request.version} : {})}]}, loaderOptions).extensions[0];
            if (request.dependencies !== undefined && (!Array.isArray(request.dependencies) ||
                request.dependencies.some(id => typeof id !== 'string'))) fail('INVALID_ADDITION', 'Invalid catalog dependencies', spec.id);
            return {...spec, distribution: request.distribution, dependencies: [...(request.dependencies || [])]};
        });
        const io = createProjectIO({zip: Zip, ...archiveOptions});
        const prepared = await wait(() => io.prepare(input, {signal}));
        io.activate(prepared.context);
        const {project, files} = await wait(() => readPreparedProject(prepared, io, Zip));
        if (project.extensions !== undefined && (!Array.isArray(project.extensions) ||
            project.extensions.some(id => typeof id !== 'string'))) fail('INVALID_PROJECT', 'Project extensions must be an ID array');
        // Inspect fixed existing bytes without evaluating them or granting host execution consent.
        const oldRecords = prepared.manifest ? await wait(() => collectVerifiedCodes(prepared.manifest,
            {...ports, diagnostics: undefined, embeddedReader: io.embeddedReader,
                trustProvider: {async authorize(code) { return {allowed: true, scope: 'digest', sha256: code.sha256}; }}},
            loaderOptions, signal)) : [];
        const previous = new Map(oldRecords.map(record => [record.id, record]));
        const extensions = new Map((prepared.manifest?.extensions || []).map(spec => [spec.id, spec]));
        const fetched = new Map();
        async function fetchBytes(url) {
            if (fetched.has(url)) return fetched.get(url);
            if (typeof ports.fetcher?.fetch !== 'function') fail('INVALID_PORT', 'A catalog fetch port is required');
            let response;
            try { response = await wait(() => ports.fetcher.fetch(url, {signal, maxBytes})); }
            catch (cause) {
                if (cause instanceof LoaderError) throw cause;
                throw new LoaderError('LOAD_FAILED', 'Catalog extension could not be fetched', undefined, cause);
            }
            if (!response || response.finalURL !== url || !Array.isArray(response.redirects) || response.redirects.length) {
                fail('REDIRECT_DENIED', 'Unproven or redirected catalog source');
            }
            if (!(response.bytes instanceof Uint8Array) || !response.bytes.length || response.bytes.length > maxBytes) {
                fail('INVALID_BYTES', 'Catalog extension is empty or exceeds the byte limit');
            }
            const bytes = new Uint8Array(response.bytes);
            fetched.set(url, bytes);
            return bytes;
        }
        for (const choice of choices) {
            const old = previous.get(choice.id);
            const bytes = old ? encoder.encode(old.code) : await fetchBytes(choice.source.url);
            const sha256 = await wait(() => digest(bytes));
            if (old && old.sha256 !== sha256) fail('CONVERSION_INTEGRITY', 'Source conversion changed bytes', choice.id);
            const source = choice.distribution === 'embedded' ?
                {type: 'embedded', path: `extensions/${choice.id}-${sha256}.js`} : choice.source;
            if (source.type === 'remote') {
                const remoteBytes = old ? await fetchBytes(source.url) : bytes;
                if (await wait(() => digest(remoteBytes)) !== sha256) {
                    fail('DIGEST_MISMATCH', 'Remote source does not serve the currently pinned bytes', choice.id);
                }
            } else {
                if (Object.hasOwn(files, source.path) && await wait(() => digest(files[source.path])) !== sha256) {
                    fail('SOURCE_PATH_COLLISION', 'The embedded path belongs to different content', choice.id);
                }
                files[source.path] = new Uint8Array(bytes);
            }
            extensions.set(choice.id, {id: choice.id, source, execution: choice.execution, sha256,
                ...((old?.version || choice.version) ? {version: old?.version || choice.version} : {}),
                ...(old?.publisher ? {publisher: old.publisher} : {}),
                capabilities: old?.capabilities || [], dependencies: choice.dependencies});
        }
        const manifest = validateManifest({schemaVersion: 1, extensions: [...extensions.values()]}, loaderOptions);
        project.turboWarpPlus = manifest;
        project.extensions = [...new Set([...(project.extensions || []), ...manifest.extensions.map(spec => spec.id)])];
        const urls = {...(project.extensionURLs || {})};
        for (const spec of manifest.extensions) delete urls[spec.id];
        project.extensionURLs = urls;
        files['project.json'] = encoder.encode(JSON.stringify(project));
        const archive = new Zip();
        for (const [name, content] of Object.entries(files)) archive.file(name, content, {dir: name.endsWith('/'), createFolders: false});
        const projectBytes = await wait(() => archive.generateAsync({type: 'uint8array', compression: 'STORE'}));
        const candidate = await wait(() => io.prepare(projectBytes, {signal}));
        io.activate(candidate.context);
        const fetcher = {fetch(url, options) {
            return fetched.has(url) ? Promise.resolve({bytes: new Uint8Array(fetched.get(url)), finalURL: url, redirects: []}) :
                ports.fetcher.fetch(url, options);
        }};
        // The common Loader validates the full dependency graph and asks the host about every final request.
        await wait(() => collectVerifiedCodes(manifest, {...ports, fetcher, embeddedReader: io.embeddedReader}, loaderOptions, signal));
        check();
        return Object.freeze({projectBytes, manifest});
    } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', abort);
    }
}
