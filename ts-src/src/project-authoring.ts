import {LoaderError, validateManifest} from './index.js';
import {createProjectIO} from './project-codec.js';
import {readPreparedProject} from './project-data.js';
import {collectVerifiedCodes} from './verified-code.js';

const encoder = new TextEncoder();
const fail = (code, message, id) => { throw new LoaderError(code, message, id); };
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');

function snapshotProject(input) {
    if (input instanceof Uint8Array) return new Uint8Array(input);
    if (input instanceof ArrayBuffer) return input.slice(0);
    if (typeof input === 'string' || input instanceof Blob) return input;
    return JSON.stringify(input);
}

/**
 * Add a file-backed Embedded or URL-backed Remote extension without evaluating it.
 * A host approval is required before the candidate is returned; the original is untouched.
 */
export async function prepareExtensionAddition(input, request, ports, {
    zip: Zip, signal: externalSignal, loaderOptions = {}, archiveOptions
} = {}) {
    if (typeof Zip !== 'function' || typeof Zip.loadAsync !== 'function') throw new TypeError('A compatible JSZip constructor is required');
    if (!plainObject(request) || Object.keys(request).some(key => !['id', 'source', 'bytes', 'execution'].includes(key))) {
        fail('INVALID_ADDITION', 'An extension ID and file or URL source are required');
    }
    if (typeof ports?.trustProvider?.authorize !== 'function') fail('INVALID_PORT', 'An explicit host trust provider is required');
    const limits = {maxBytes: 1024 * 1024, timeoutMs: 30000, ...loaderOptions};
    for (const key of ['maxBytes', 'maxTotalBytes', 'maxExtensions', 'timeoutMs']) {
        if (limits[key] !== undefined && (!Number.isSafeInteger(limits[key]) || limits[key] < 1)) fail('INVALID_OPTIONS', `Invalid ${key}`);
    }
    const source = plainObject(request.source) && request.source.type === 'embedded' && request.source.path === undefined ?
        {...request.source, path: `extensions/${request.id}.js`} : request.source;
    // Reuse the runtime schema before any bytes are read or network requests begin.
    const draft = validateManifest({schemaVersion: 1, extensions: [{id: request.id, source,
        execution: request.execution === undefined ? 'unsandboxed' : request.execution,
        sha256: '0'.repeat(64)}]}, loaderOptions).extensions[0];
    if (draft.source.type === 'remote' && request.bytes !== undefined) fail('INVALID_ADDITION', 'Remote sources must be fetched from their URL', draft.id);
    if (request.bytes instanceof Uint8Array && (request.bytes.byteLength < 1 || request.bytes.byteLength > limits.maxBytes)) {
        fail('INVALID_BYTES', 'Extension file is empty or exceeds the byte limit', draft.id);
    }
    const suppliedBytes = request.bytes instanceof Uint8Array ? new Uint8Array(request.bytes) : request.bytes;
    if (draft.source.type === 'embedded' && !(suppliedBytes instanceof Uint8Array) && !(suppliedBytes instanceof Blob)) {
        fail('INVALID_BYTES', 'Embedded additions require a JavaScript file', draft.id);
    }
    if (suppliedBytes instanceof Blob && (suppliedBytes.size < 1 || suppliedBytes.size > limits.maxBytes)) {
        fail('INVALID_BYTES', 'Extension file is empty or exceeds the byte limit', draft.id);
    }
    const controller = new AbortController();
    const abort = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener('abort', abort, {once: true});
    const signal = controller.signal;
    const check = () => {
        if (signal.aborted) fail(signal.reason?.code === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED', 'Extension addition interrupted', draft.id);
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
    const timer = setTimeout(() => controller.abort(new LoaderError('TIMEOUT', 'Extension addition timed out')), limits.timeoutMs);
    try {
        const io = createProjectIO({zip: Zip, ...archiveOptions});
        const prepared = await wait(() => io.prepare(snapshotProject(input), {signal}));
        const {project, files} = await wait(() => readPreparedProject(prepared, io, Zip));
        if (project.extensions !== undefined && (!Array.isArray(project.extensions) || project.extensions.some(id => typeof id !== 'string'))) {
            fail('INVALID_PROJECT', 'Project extensions must be an ID array');
        }
        if (project.extensionURLs !== undefined && !plainObject(project.extensionURLs)) fail('INVALID_PROJECT', 'Project extensionURLs must be an object');
        const previous = prepared.manifest?.extensions || [];
        if (previous.some(spec => spec.id === draft.id) || (project.extensions || []).includes(draft.id) ||
            Object.hasOwn(project.extensionURLs || {}, draft.id)) fail('DUPLICATE_EXTENSION', 'This extension ID already belongs to the project', draft.id);
        validateManifest({schemaVersion: 1, extensions: [...previous, draft]}, loaderOptions);
        if (draft.source.type === 'embedded' && Object.hasOwn(files, draft.source.path)) {
            fail('SOURCE_PATH_COLLISION', 'The embedded path already exists in this project', draft.id);
        }
        let bytes;
        if (draft.source.type === 'embedded') {
            bytes = suppliedBytes instanceof Blob ? new Uint8Array(await wait(() => suppliedBytes.arrayBuffer())) : suppliedBytes;
        } else {
            if (typeof ports.fetcher?.fetch !== 'function') fail('INVALID_PORT', 'Remote fetch port is unavailable', draft.id);
            let response;
            try { response = await wait(() => ports.fetcher.fetch(draft.source.url, {signal, maxBytes: limits.maxBytes})); }
            catch (cause) {
                if (cause instanceof LoaderError) throw cause;
                throw new LoaderError('LOAD_FAILED', 'Remote extension could not be fetched', draft.id, cause);
            }
            if (!response || !Array.isArray(response.redirects) || response.redirects.length || response.finalURL !== draft.source.url) {
                fail('REDIRECT_DENIED', 'Unproven or redirected remote source', draft.id);
            }
            bytes = response.bytes;
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > limits.maxBytes) {
            fail('INVALID_BYTES', 'Extension bytes are empty, oversized, or invalid', draft.id);
        }
        bytes = new Uint8Array(bytes);
        const sha256 = await wait(() => digest(bytes));
        const manifest = validateManifest({schemaVersion: 1, extensions: [...previous, {...draft, sha256}]}, loaderOptions);
        const spec = manifest.extensions.find(item => item.id === draft.id);
        project.turboWarpPlus = manifest;
        project.extensions = [...(project.extensions || []), spec.id];
        files['project.json'] = encoder.encode(JSON.stringify(project));
        if (spec.source.type === 'embedded') files[spec.source.path] = bytes;
        const archive = new Zip();
        for (const [path, content] of Object.entries(files)) archive.file(path, content, {dir: path.endsWith('/'), createFolders: false});
        const projectBytes = await wait(() => archive.generateAsync({type: 'uint8array', compression: 'STORE'}));
        const candidate = await wait(() => io.prepare(projectBytes, {signal}));
        io.activate(candidate.context);
        // Only the newly fetched URL is snapshotted. Other pinned sources keep the host's fetch policy.
        const fetcher = spec.source.type === 'remote' ? {
            fetch(url, options) {
                if (url === spec.source.url) return Promise.resolve({bytes: new Uint8Array(bytes), finalURL: url, redirects: []});
                return ports.fetcher.fetch(url, options);
            }
        } : ports.fetcher;
        await wait(() => collectVerifiedCodes(manifest, {...ports, fetcher, embeddedReader: io.embeddedReader}, loaderOptions, signal));
        check();
        return Object.freeze({projectBytes, spec, manifest});
    } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', abort);
    }
}
