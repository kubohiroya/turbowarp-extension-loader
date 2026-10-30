import {createExtensionLoader, discoverManifest, LoaderError, validateManifest} from './index.js';
import {createProjectIO} from './project-codec.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const fail = (code, message) => { throw new LoaderError(code, message); };
const cancelled = signal => { if (signal?.aborted) fail('CANCELLED', 'Package preparation cancelled'); };
const own = (object, name, value) => Object.defineProperty(object, name, {
    value, writable: true, configurable: true, enumerable: true
});
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');

/** Collect bytes through the same verification, policy and ordering used for execution. */
async function collect(manifest, ports, options, signal) {
    const result = [];
    const loader = createExtensionLoader({...ports, registrar: {
        async begin() {
            const staged = [];
            return {
                async register(code) { staged.push(code); return {id: code.id}; },
                async commit() { result.push(...staged); },
                async rollback() { staged.length = 0; result.length = 0; }
            };
        },
        async unload() {}
    }}, options);
    await loader.load(manifest, {signal});
    await loader.unload();
    return result;
}

async function decodePrepared(prepared, io, Zip) {
    let project;
    if (prepared.input instanceof Uint8Array) {
        const archive = await Zip.loadAsync(prepared.input, {checkCRC32: false});
        project = JSON.parse(await archive.file('project.json').async('string'));
    } else if (typeof prepared.input === 'string') project = JSON.parse(prepared.input);
    else project = prepared.input;
    // The Loader-owned codec restores original bytes and unknown metadata from its private context.
    const files = io.restoreFiles({'project.json': encoder.encode(JSON.stringify(project))}, prepared.context);
    return {project: JSON.parse(decoder.decode(files['project.json'])), files};
}

function metadataFor(metadata, id) {
    const data = metadata && Object.hasOwn(metadata, id) ? metadata[id] : undefined;
    if (data === undefined) return null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('INVALID_PACKAGE_METADATA', `Invalid metadata for ${id}`);
    const result = {};
    for (const key of ['license', 'copyright', 'provenance']) {
        if (data[key] !== undefined) {
            if (typeof data[key] !== 'string' || data[key].length > 16384) fail('INVALID_PACKAGE_METADATA', `Invalid ${key} for ${id}`);
            result[key] = data[key];
        }
    }
    return Object.freeze(result);
}

/**
 * Change distribution sources without evaluating extension JavaScript.
 * Remote output also returns the exact artifacts the host must publish at the supplied URLs.
 */
export async function convertProjectSources(input, ports, {
    zip: Zip, targets = {}, metadata = {}, signal, loaderOptions, archiveOptions
} = {}) {
    if (typeof Zip !== 'function' || typeof Zip.loadAsync !== 'function') throw new TypeError('A compatible JSZip constructor is required');
    cancelled(signal);
    const io = createProjectIO({zip: Zip, ...archiveOptions});
    const prepared = await io.prepare(input, {signal});
    if (!prepared.manifest) fail('MANIFEST_REQUIRED', 'Source conversion requires a Plus manifest');
    io.activate(prepared.context);
    const records = await collect(prepared.manifest, {...ports, embeddedReader: io.embeddedReader}, loaderOptions, signal);
    cancelled(signal);
    const {project, files} = await decodePrepared(prepared, io, Zip);
    const artifacts = {};
    const lockEntries = [];
    const extensions = [];
    const outputPaths = new Set();
    for (const record of records) {
        const source = Object.hasOwn(targets, record.id) ? targets[record.id] : record.source;
        const spec = {...record, source};
        for (const key of ['code', 'byteLength', 'actualSHA256', 'cached', 'authorization']) delete spec[key];
        // Reuse the public schema, including source paths and HTTPS policy, for conversion targets.
        const validated = validateManifest({schemaVersion: 1, extensions: [{...spec, dependencies: []}]}).extensions[0];
        const bytes = encoder.encode(record.code);
        if (await digest(bytes) !== record.sha256) fail('CONVERSION_INTEGRITY', 'UTF-8 conversion changed verified source bytes');
        own(artifacts, record.id, new Uint8Array(bytes));
        if (validated.source.type === 'embedded') {
            const path = validated.source.path;
            if (outputPaths.has(path)) fail('DUPLICATE_EMBEDDED_PATH', 'Each extension needs a distinct embedded output path');
            outputPaths.add(path);
            if (Object.hasOwn(files, path) && await digest(files[path]) !== record.sha256) {
                fail('SOURCE_PATH_COLLISION', 'The target path would overwrite unrelated archive content');
            }
            own(files, path, new Uint8Array(bytes));
        }
        extensions.push({...spec, source: validated.source});
        lockEntries.push(Object.freeze({id: record.id, sha256: record.sha256,
            byteLength: bytes.length, originalSource: record.source, source: validated.source,
            version: record.version ?? null, publisher: record.publisher ?? null,
            metadata: metadataFor(metadata, record.id) ?? metadataFor({[record.id]:
                (Array.isArray(project.turboWarpPlusLock?.extensions) ? project.turboWarpPlusLock.extensions : []).find(entry => entry && entry.id === record.id && entry.sha256 === record.sha256)?.metadata}, record.id)}));
    }
    for (const id of Object.keys(targets)) if (!records.some(record => record.id === id)) fail('UNKNOWN_EXTENSION', `Unknown conversion target ${id}`);
    const manifest = validateManifest({schemaVersion: 1, extensions});
    const lock = Object.freeze({schemaVersion: 1, previousLock: project.turboWarpPlusLock ?? null, extensions: Object.freeze(lockEntries)});
    project.turboWarpPlus = manifest;
    project.turboWarpPlusLock = lock;
    const legacyURLs = {...(project.extensionURLs || {})};
    // A Plus source is resolved only by the Loader, never by an unsandboxed legacy URL loader.
    for (const spec of manifest.extensions) delete legacyURLs[spec.id];
    project.extensionURLs = legacyURLs;
    files['project.json'] = encoder.encode(JSON.stringify(project));
    const archive = new Zip();
    for (const [path, bytes] of Object.entries(files)) archive.file(path, bytes, {dir: path.endsWith('/'), createFolders: false});
    const projectBytes = await archive.generateAsync({type: 'uint8array', compression: 'STORE'});
    cancelled(signal);
    // Generated output must satisfy the same archive limits as projects opened by the runtime.
    await io.prepare(projectBytes, {signal});
    return Object.freeze({manifest, lock, project, projectBytes, artifacts: Object.freeze(artifacts)});
}

/** Build an offline SB3: every Plus source is embedded, and external dependencies must be declared absent. */
export async function prepareOfflinePackage(input, ports, options = {}) {
    const {zip: Zip, resourceDependencies, signal} = options;
    const io = createProjectIO({zip: Zip, ...options.archiveOptions});
    const prepared = await io.prepare(input, {signal});
    if (!prepared.manifest) fail('MANIFEST_REQUIRED', 'Offline Plus packaging requires a manifest');
    const targets = {};
    for (const spec of prepared.manifest.extensions) {
        if (!Object.hasOwn(resourceDependencies || {}, spec.id) || !Array.isArray(resourceDependencies[spec.id]) ||
            resourceDependencies[spec.id].length) {
            fail('UNBUNDLED_DEPENDENCY', `Declare an empty external resource dependency list for ${spec.id}; external resources are not yet bundled`);
        }
        own(targets, spec.id, {type: 'embedded', path: `extensions/${spec.id}-${spec.sha256}.js`});
    }
    const result = await convertProjectSources(input, ports, {...options, targets});
    if (Object.keys(result.project.extensionURLs || {}).length) {
        fail('UNBUNDLED_LEGACY_EXTENSION', 'Offline Plus packaging refuses legacy custom URLs; migrate them explicitly first');
    }
    return Object.freeze({...result, offline: true});
}

/** Migrate a legacy Data URL only after the host explicitly pins and approves its bytes. */
export async function migrateLegacyDataURL({id, url, sha256, metadata}, ports, options = {}) {
    if (typeof url !== 'string' || url.length > 4 * 1024 * 1024) fail('INVALID_SOURCE', 'Invalid or oversized legacy Data URL');
    const match = /^data:(?:application|text)\/(?:javascript|x-javascript)(?:;charset=utf-8)?(;base64)?;?,([\s\S]*)$/i.exec(url);
    if (!match) fail('INVALID_SOURCE', 'Only explicit JavaScript Data URLs can be migrated');
    let bytes;
    try {
        if (match[1]) {
            if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(match[2])) throw new Error('Invalid base64');
            bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0));
        } else {
            // decodeURIComponent would reject arbitrary non-UTF8 bytes before the shared validator can diagnose them.
            const text = decodeURIComponent(match[2]);
            bytes = encoder.encode(text);
        }
    } catch (cause) { throw new LoaderError('INVALID_ENCODING', 'Invalid legacy Data URL encoding', id, cause); }
    const path = `extensions/${id}.js`;
    const manifest = validateManifest({schemaVersion: 1, extensions: [{id, source: {type: 'embedded', path}, execution: 'unsandboxed', sha256}]});
    const [record] = await collect(manifest, {...ports, embeddedReader: {async read() { return bytes; }}}, options.loaderOptions, options.signal);
    return Object.freeze({spec: manifest.extensions[0], bytes: encoder.encode(record.code), metadata: metadataFor({[id]: metadata}, id)});
}

/** Additional policy for a generated single HTML document. The runtime still requires user approval. */
export function restrictOfflineHTML(html) {
    if (typeof html !== 'string' || !/<head(?:\s[^>]*)?>/i.test(html)) throw new TypeError('A complete HTML document is required');
    const policy = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; worker-src blob:; child-src blob:; base-uri 'none'; form-action 'none'";
    // Multiple CSP policies intersect: the Packager's permissive CSP cannot loosen this one.
    return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n<meta http-equiv="Content-Security-Policy" content="${policy}">`);
}
