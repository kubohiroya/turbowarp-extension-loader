const DEFAULTS = Object.freeze({maxExtensions: 64, maxBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, timeoutMs: 30000});
const RESERVED_IDS = new Set(['pen', 'music', 'videoSensing', 'text2speech', 'translate', 'microbit', 'ev3', 'boost', 'wedo2', 'gdxfor', 'makeymakey']);
const ID = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const authorizations = new WeakSet();

/** Host adapters accept only immutable records issued after core authorization. */
export const isAuthorizedCode = value => authorizations.has(value);

export class LoaderError extends Error {
    constructor(code, message, extensionId, cause) {
        super(message, {cause});
        this.name = 'LoaderError';
        this.code = code;
        if (extensionId !== undefined) this.extensionId = extensionId;
    }
}

const fail = (code, message, id) => { throw new LoaderError(code, message, id); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, allowed, label) => {
    if (!object(value)) fail('INVALID_MANIFEST', `${label} must be an object`);
    if (Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_MANIFEST', `${label} has unknown fields`);
};
const validId = id => typeof id === 'string' && ID.test(id) && !RESERVED_IDS.has(id);
const string = (value, label, max = 256) => {
    if (typeof value !== 'string' || value.length < 1 || value.length > max) fail('INVALID_MANIFEST', `Invalid ${label}`);
    return value;
};

function remoteURL(value) {
    let url;
    try { url = new URL(value); } catch { fail('INVALID_SOURCE', 'Remote source must be an absolute HTTPS URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('INVALID_SOURCE', 'Remote source requires HTTPS without credentials or fragment');
    return url.href;
}

function sourceOf(source) {
    if (!object(source)) fail('INVALID_SOURCE', 'Missing extension source');
    if (source.type === 'remote') {
        keys(source, ['type', 'url'], 'source');
        return Object.freeze({type: 'remote', url: remoteURL(string(source.url, 'URL', 4096))});
    }
    if (source.type === 'embedded') {
        keys(source, ['type', 'path'], 'source');
        const path = string(source.path, 'embedded path', 256);
        if (!/^extensions\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.js$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) fail('INVALID_SOURCE', 'Unsafe embedded path');
        return Object.freeze({type: 'embedded', path});
    }
    fail('INVALID_SOURCE', 'Unsupported source type');
}

/** Validate and snapshot untrusted data; execution is only a request. */
export function validateManifest(input, options = {}) {
    keys(input, ['schemaVersion', 'extensions'], 'manifest');
    if (input.schemaVersion !== 1) fail('UNSUPPORTED_SCHEMA', 'Only schemaVersion 1 is supported');
    const maxExtensions = options.maxExtensions ?? DEFAULTS.maxExtensions;
    if (!Array.isArray(input.extensions) || input.extensions.length > maxExtensions) fail('INVALID_MANIFEST', 'Invalid extension list');
    const ids = new Set();
    const extensions = input.extensions.map(spec => {
        keys(spec, ['id', 'source', 'execution', 'sha256', 'version', 'publisher', 'capabilities', 'dependencies'], 'extension');
        if (!validId(spec.id) || ids.has(spec.id)) fail('INVALID_ID', 'Invalid, reserved, or duplicate extension ID', spec.id);
        ids.add(spec.id);
        if (spec.execution !== 'unsandboxed') fail('INVALID_EXECUTION', 'Only explicit unsandboxed requests are supported', spec.id);
        if (typeof spec.sha256 !== 'string' || !SHA256.test(spec.sha256)) fail('INVALID_DIGEST', 'A lowercase SHA-256 pin is required', spec.id);
        const result = {id: spec.id, source: sourceOf(spec.source), execution: spec.execution, sha256: spec.sha256};
        for (const key of ['version', 'publisher']) if (spec[key] !== undefined) result[key] = string(spec[key], key);
        for (const key of ['capabilities', 'dependencies']) {
            const values = spec[key] ?? [];
            if (!Array.isArray(values) || values.length > 64 || values.some(value => typeof value !== 'string' || !ID.test(value)) || new Set(values).size !== values.length) fail('INVALID_MANIFEST', `Invalid ${key}`, spec.id);
            result[key] = Object.freeze([...values]);
        }
        return Object.freeze(result);
    });
    const ordered = [];
    const visited = new Set();
    const active = new Set();
    const byId = new Map(extensions.map(spec => [spec.id, spec]));
    const visit = spec => {
        if (visited.has(spec.id)) return;
        if (active.has(spec.id)) fail('DEPENDENCY_CYCLE', 'Cyclic extension dependency', spec.id);
        active.add(spec.id);
        for (const dependency of spec.dependencies) {
            if (!byId.has(dependency)) fail('MISSING_DEPENDENCY', 'Dependency is absent from the manifest', spec.id);
            visit(byId.get(dependency));
        }
        active.delete(spec.id);
        visited.add(spec.id);
        ordered.push(spec);
    };
    extensions.forEach(visit);
    return Object.freeze({schemaVersion: 1, extensions: Object.freeze(ordered)});
}

export function discoverManifest(project, options) {
    if (!object(project)) fail('INVALID_PROJECT', 'Project must be a parsed object');
    if (!Object.hasOwn(project, 'turboWarpPlus')) return null;
    return validateManifest(project.turboWarpPlus, options);
}

export const parseManifest = validateManifest;

function snapshotBytes(input, maxBytes, id) {
    if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > maxBytes) fail('INVALID_BYTES', 'Extension bytes are empty, oversized, or invalid', id);
    return new Uint8Array(input);
}

async function digest(bytes) {
    const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

function checkSignal(signal) {
    if (signal.aborted) throw new LoaderError(signal.reason?.code === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED', 'Extension load interrupted', undefined, signal.reason);
}

async function guarded(task, signal) {
    checkSignal(signal);
    let abort;
    const cancelled = new Promise((resolve, reject) => {
        abort = () => {
            try { checkSignal(signal); } catch (error) { reject(error); }
        };
        signal.addEventListener('abort', abort, {once: true});
    });
    try { return await Promise.race([Promise.resolve().then(task), cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
}

/** Browser fetch port rejects redirects and streams with a byte limit. */
export function createFetchPort(fetchImpl = globalThis.fetch) {
    return Object.freeze({
        async fetch(url, {signal, maxBytes}) {
            const response = await fetchImpl(remoteURL(url), {signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer'});
            if (!response.ok || response.redirected || response.type === 'opaque' || response.url !== remoteURL(url)) fail('FETCH_FAILED', 'Remote response is unavailable or redirected');
            const declared = response.headers.get('content-length');
            if (declared !== null && Number(declared) > maxBytes) fail('INVALID_BYTES', 'Remote extension exceeds byte limit');
            if (!response.body) fail('FETCH_FAILED', 'Remote response has no readable body');
            const reader = response.body.getReader();
            const parts = [];
            let size = 0;
            try {
                while (true) {
                    checkSignal(signal);
                    const {done, value} = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > maxBytes) fail('INVALID_BYTES', 'Remote extension exceeds byte limit');
                    parts.push(value);
                }
            } catch (error) {
                await reader.cancel().catch(() => {});
                throw error;
            } finally { reader.releaseLock(); }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
            return {bytes, finalURL: response.url, redirects: []};
        }
    });
}

/** The host owns all ports, especially trust decisions and privileged execution. */
export function createExtensionLoader(ports, options = {}) {
    const limits = {...DEFAULTS, ...options};
    for (const key of Object.keys(DEFAULTS)) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) fail('INVALID_OPTIONS', `Invalid ${key}`);
    if (typeof ports?.trustProvider?.authorize !== 'function' || typeof ports?.registrar?.begin !== 'function' || typeof ports?.registrar?.unload !== 'function') fail('INVALID_PORT', 'Explicit host trust and transactional registrar ports are required');
    let state = 'idle';
    let loaded = [];
    const report = event => { try { ports.diagnostics?.(Object.freeze({...event})); } catch { /* Diagnostics must not alter authorization. */ } };

    async function resolve(spec, signal, budget) {
        let bytes;
        let cached = false;
        if (ports.cache) {
            const entry = await guarded(() => ports.cache.get(spec.sha256, {signal}), signal);
            if (entry !== undefined && entry !== null) {
                const candidate = snapshotBytes(entry, limits.maxBytes, spec.id);
                if (await guarded(() => digest(candidate), signal) !== spec.sha256) fail('CACHE_INTEGRITY', 'Cached bytes do not match the digest', spec.id);
                bytes = candidate;
                cached = true;
            }
        }
        if (!bytes) {
            if (spec.source.type === 'embedded') {
                if (typeof ports.embeddedReader?.read !== 'function') fail('INVALID_PORT', 'Embedded reader is unavailable', spec.id);
                bytes = snapshotBytes(await guarded(() => ports.embeddedReader.read(spec.source.path, {signal, maxBytes: limits.maxBytes}), signal), limits.maxBytes, spec.id);
            } else {
                if (typeof ports.fetcher?.fetch !== 'function') fail('INVALID_PORT', 'Remote fetch port is unavailable', spec.id);
                const response = await guarded(() => ports.fetcher.fetch(spec.source.url, {signal, maxBytes: limits.maxBytes}), signal);
                if (!response || !Array.isArray(response.redirects) || response.redirects.length || response.finalURL !== spec.source.url) fail('REDIRECT_DENIED', 'Unproven or redirected remote source', spec.id);
                bytes = snapshotBytes(response.bytes, limits.maxBytes, spec.id);
            }
        }
        budget.bytes += bytes.byteLength;
        if (budget.bytes > limits.maxTotalBytes) fail('TOTAL_SIZE_LIMIT', 'Project extension bytes exceed total limit', spec.id);
        const actual = await guarded(() => digest(bytes), signal);
        if (actual !== spec.sha256) fail('DIGEST_MISMATCH', 'Extension bytes do not match the digest', spec.id);
        let code;
        try { code = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
        catch (cause) { throw new LoaderError('INVALID_ENCODING', 'Extension must contain valid UTF-8', spec.id, cause); }
        if (!cached && ports.cache) await guarded(() => ports.cache.put(spec.sha256, new Uint8Array(bytes), {signal}), signal);
        const result = Object.freeze({...spec, code, byteLength: bytes.byteLength, actualSHA256: actual, cached});
        report({type: 'verified', id: spec.id, sha256: actual, cached});
        return result;
    }

    async function load(input, {signal: externalSignal} = {}) {
        if (state !== 'idle') fail('BUSY', 'Unload the previous project before another load');
        const manifest = validateManifest(input, limits);
        const controller = new AbortController();
        const abort = () => controller.abort(externalSignal.reason);
        if (externalSignal?.aborted) abort();
        else externalSignal?.addEventListener('abort', abort, {once: true});
        const timer = setTimeout(() => controller.abort(new LoaderError('TIMEOUT', 'Extension load timed out')), limits.timeoutMs);
        const signal = controller.signal;
        let transaction;
        const authorized = [];
        state = 'loading';
        try {
            const budget = {bytes: 0};
            for (const spec of manifest.extensions) {
                const code = await resolve(spec, signal, budget);
                const decision = await guarded(() => ports.trustProvider.authorize(code, {signal}), signal);
                if (decision?.allowed !== true || decision.scope !== 'digest' || decision.sha256 !== code.sha256) fail('TRUST_DENIED', 'Host did not approve this exact extension digest', spec.id);
                const approved = Object.freeze({...code, authorization: Object.freeze({allowed: true, scope: 'digest', sha256: code.sha256})});
                authorizations.add(approved);
                authorized.push(approved);
                report({type: 'authorized', id: spec.id, sha256: code.sha256});
            }
            checkSignal(signal);
            if (authorized.length) {
                // Registrar calls are awaited even after cancellation so rollback cannot race a late registration.
                transaction = await ports.registrar.begin({signal});
                if (!transaction || ['register', 'commit', 'rollback'].some(key => typeof transaction[key] !== 'function')) fail('INVALID_PORT', 'Registrar must support register, commit, and rollback');
                for (const code of authorized) {
                    checkSignal(signal);
                    const registered = await transaction.register(code, {signal});
                    checkSignal(signal);
                    if (registered?.id !== code.id) fail('REGISTRATION_ID_MISMATCH', 'Registered ID differs from the manifest', code.id);
                }
                checkSignal(signal);
                await transaction.commit({signal});
                checkSignal(signal);
            }
            loaded = authorized.map(code => code.id);
            state = 'loaded';
            report({type: 'loaded', ids: Object.freeze([...loaded])});
            return Object.freeze({ids: Object.freeze([...loaded]), manifest});
        } catch (cause) {
            let error = cause instanceof LoaderError ? cause : new LoaderError('LOAD_FAILED', 'Extension load failed', undefined, cause);
            if (transaction) {
                try { await transaction.rollback(); }
                catch (rollbackError) { state = 'failed'; error = new LoaderError('ROLLBACK_FAILED', 'Host could not restore registration state', undefined, new AggregateError([error, rollbackError])); }
            }
            if (state !== 'failed') state = 'idle';
            report({type: 'error', code: error.code, id: error.extensionId});
            throw error;
        } finally {
            // Authorization proofs are valid only during this registration transaction.
            for (const code of authorized) authorizations.delete(code);
            clearTimeout(timer);
            externalSignal?.removeEventListener('abort', abort);
        }
    }

    return Object.freeze({
        load,
        async loadProject(project, options) {
            if (state !== 'idle') fail('BUSY', 'Unload the previous project before another load');
            const manifest = discoverManifest(project, limits);
            return manifest === null ? Object.freeze({ids: Object.freeze([]), manifest: null}) : load(manifest, options);
        },
        async unload() {
            if (state === 'loading' || state === 'unloading') fail('BUSY', 'A loader operation is in progress');
            if (state === 'failed') fail('HOST_RECOVERY_REQUIRED', 'Recover the host after failed rollback');
            if (state === 'idle') return;
            state = 'unloading';
            try { await ports.registrar.unload([...loaded].reverse()); loaded = []; state = 'idle'; }
            catch (cause) { state = 'failed'; throw new LoaderError('UNLOAD_FAILED', 'Host could not unload extensions', undefined, cause); }
        },
        getState: () => Object.freeze({status: state, ids: Object.freeze([...loaded])})
    });
}
