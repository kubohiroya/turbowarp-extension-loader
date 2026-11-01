import {LoaderError, validateManifest, type ExtensionSource, type ExtensionSpec, type LoaderOptions, type LoaderPorts, type Manifest} from './index.js';
import {createProjectIO, type ArchiveLimits, type ZipConstructor} from './project-codec.js';
import {collectVerifiedCodes as collect} from './verified-code.js';
import {readPreparedProject as decodePrepared} from './project-data.js';

export interface DistributionMetadata {license?: string; copyright?: string; provenance?: string}
export interface ConversionOptions {
    zip: ZipConstructor;
    targets?: Record<string, ExtensionSource>;
    metadata?: Record<string, DistributionMetadata>;
    signal?: AbortSignal;
    loaderOptions?: LoaderOptions;
    archiveOptions?: ArchiveLimits;
}
export interface OfflinePackageOptions extends ConversionOptions {resourceDependencies: Record<string, readonly never[]>}
export interface PackageLockEntry {
    readonly id: string; readonly sha256: string; readonly byteLength: number;
    readonly originalSource: ExtensionSource; readonly source: ExtensionSource;
    readonly version: string | null; readonly publisher: string | null;
    readonly metadata: DistributionMetadata | null;
}
export type PackageLock = Readonly<{schemaVersion: 1; previousLock: unknown; extensions: readonly PackageLockEntry[]}>;
export interface ConvertedProject {
    readonly manifest: Manifest;
    readonly lock: PackageLock;
    readonly project: Record<string, unknown>;
    readonly projectBytes: Uint8Array;
    readonly artifacts: Readonly<Record<string, Uint8Array>>;
}
export type PackagingPorts = Pick<LoaderPorts, 'fetcher' | 'trustProvider' | 'cache' | 'diagnostics'>;
export interface LegacyDataURL {id: string; url: string; sha256: string; metadata?: DistributionMetadata}
export type MigratedDataURL = Readonly<{spec: ExtensionSpec; bytes: Uint8Array; metadata: DistributionMetadata | null}>;

const encoder = new TextEncoder();
function fail(code: string, message: string): never { throw new LoaderError(code, message); }
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) fail('CANCELLED', 'Package preparation cancelled'); };
const own = <T>(object: Record<string, T>, name: string, value: T) => Object.defineProperty(object, name, {
    value, writable: true, configurable: true, enumerable: true
});
const digest = async (bytes: BufferSource) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');

function metadataFor(metadata: Record<string, unknown> | undefined, id: string): DistributionMetadata | null {
    const data = metadata && Object.hasOwn(metadata, id) ? metadata[id] : undefined;
    if (data === undefined) return null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('INVALID_PACKAGE_METADATA', `Invalid metadata for ${id}`);
    const result: DistributionMetadata = {};
    for (const key of ['license', 'copyright', 'provenance'] as const) {
        const value = (data as Record<string, unknown>)[key];
        if (value !== undefined) {
            if (typeof value !== 'string' || value.length > 16384) fail('INVALID_PACKAGE_METADATA', `Invalid ${key} for ${id}`);
            result[key] = value;
        }
    }
    return Object.freeze(result);
}

/**
 * Change distribution sources without evaluating extension JavaScript.
 * Remote output also returns the exact artifacts the host must publish at the supplied URLs.
 */
export function convertProjectSources(input: unknown, ports: PackagingPorts, options: ConversionOptions): Promise<ConvertedProject>;
export async function convertProjectSources(input: unknown, ports: PackagingPorts, {
    zip: Zip, targets = {}, metadata = {}, signal, loaderOptions, archiveOptions
}: Partial<ConversionOptions> = {}): Promise<ConvertedProject> {
    if (typeof Zip !== 'function' || typeof Zip.loadAsync !== 'function') throw new TypeError('A compatible JSZip constructor is required');
    cancelled(signal);
    const io = createProjectIO({zip: Zip, ...archiveOptions});
    const prepared = await io.prepare(input, {signal});
    if (!prepared.manifest) fail('MANIFEST_REQUIRED', 'Source conversion requires a Plus manifest');
    io.activate(prepared.context);
    const records = await collect(prepared.manifest, {...ports, embeddedReader: io.embeddedReader}, loaderOptions, signal);
    cancelled(signal);
    const {project, files} = await decodePrepared(prepared, io, Zip);
    // A previous lock is untrusted project data; only matching entries contribute metadata.
    const previousLock = project.turboWarpPlusLock as {extensions?: unknown} | null | undefined;
    const artifacts: Record<string, Uint8Array> = {};
    const lockEntries: PackageLockEntry[] = [];
    const extensions: unknown[] = [];
    const outputPaths = new Set<string>();
    for (const record of records) {
        const source = Object.hasOwn(targets, record.id) ? targets[record.id] : record.source;
        const spec: Record<string, unknown> = {...record, source};
        for (const key of ['code', 'byteLength', 'actualSHA256', 'cached', 'authorization']) delete spec[key];
        // Reuse the public schema, including source paths and HTTPS policy, for conversion targets.
        const validated = validateManifest({schemaVersion: 1, extensions: [{...spec, dependencies: []}]}).extensions[0];
        const bytes = encoder.encode(record.code);
        if (await digest(bytes) !== record.sha256) fail('CONVERSION_INTEGRITY', 'UTF-8 conversion changed verified source bytes');
        own(artifacts, record.id, new Uint8Array(bytes));
        // Embedded and cached both keep a copy in the archive, so both need their entry written.
        if (validated.source.type !== 'remote') {
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
                (Array.isArray(previousLock?.extensions) ? previousLock.extensions : []).find(entry => entry && entry.id === record.id && entry.sha256 === record.sha256)?.metadata}, record.id)}));
    }
    for (const id of Object.keys(targets)) if (!records.some(record => record.id === id)) fail('UNKNOWN_EXTENSION', `Unknown conversion target ${id}`);
    const manifest = validateManifest({schemaVersion: 1, extensions});
    const lock: PackageLock = Object.freeze({schemaVersion: 1, previousLock: project.turboWarpPlusLock ?? null, extensions: Object.freeze(lockEntries)});
    project.turboWarpPlus = manifest;
    project.turboWarpPlusLock = lock;
    const legacyURLs = {...(project.extensionURLs || {})};
    // A Plus source is resolved only by the Loader, never by an unsandboxed legacy URL loader.
    for (const spec of manifest.extensions) delete legacyURLs[spec.id];
    project.extensionURLs = legacyURLs;
    files['project.json'] = encoder.encode(JSON.stringify(project));
    const archive = new Zip();
    for (const [path, bytes] of Object.entries(files)) archive.file(path, bytes, {dir: path.endsWith('/'), createFolders: false});
    const projectBytes: Uint8Array = await archive.generateAsync({type: 'uint8array', compression: 'STORE'});
    cancelled(signal);
    // Generated output must satisfy the same archive limits as projects opened by the runtime.
    await io.prepare(projectBytes, {signal});
    return Object.freeze({manifest, lock, project, projectBytes, artifacts: Object.freeze(artifacts)});
}

/** Build an offline SB3: every Plus source is embedded, and external dependencies must be declared absent. */
export function prepareOfflinePackage(input: unknown, ports: PackagingPorts, options: OfflinePackageOptions): Promise<ConvertedProject & {readonly offline: true}>;
export async function prepareOfflinePackage(input: unknown, ports: PackagingPorts, options: Partial<OfflinePackageOptions> = {}): Promise<ConvertedProject & {readonly offline: true}> {
    const {zip: Zip, resourceDependencies, signal} = options;
    const io = createProjectIO({zip: Zip, ...options.archiveOptions});
    const prepared = await io.prepare(input, {signal});
    if (!prepared.manifest) fail('MANIFEST_REQUIRED', 'Offline Plus packaging requires a manifest');
    const targets: Record<string, ExtensionSource> = {};
    for (const spec of prepared.manifest.extensions) {
        if (!Object.hasOwn(resourceDependencies || {}, spec.id) || !Array.isArray(resourceDependencies![spec.id]) ||
            resourceDependencies![spec.id].length) {
            fail('UNBUNDLED_DEPENDENCY', `Declare an empty external resource dependency list for ${spec.id}; external resources are not yet bundled`);
        }
        own(targets, spec.id, {type: 'embedded', path: `extensions/${spec.id}-${spec.sha256}.js`});
    }
    // Options pass through unchanged; convertProjectSources reports a missing ZIP implementation.
    const result = await convertProjectSources(input, ports, {...options, targets} as ConversionOptions);
    if (Object.keys(result.project.extensionURLs || {}).length) {
        fail('UNBUNDLED_LEGACY_EXTENSION', 'Offline Plus packaging refuses legacy custom URLs; migrate them explicitly first');
    }
    return Object.freeze({...result, offline: true});
}

/** Migrate a legacy Data URL only after the host explicitly pins and approves its bytes. */
export async function migrateLegacyDataURL({id, url, sha256, metadata}: LegacyDataURL, ports: PackagingPorts,
    options: {signal?: AbortSignal; loaderOptions?: LoaderOptions} = {}): Promise<MigratedDataURL> {
    if (typeof url !== 'string' || url.length > 4 * 1024 * 1024) fail('INVALID_SOURCE', 'Invalid or oversized legacy Data URL');
    const match = /^data:(?:application|text)\/(?:javascript|x-javascript)(?:;charset=utf-8)?(;base64)?;?,([\s\S]*)$/i.exec(url);
    if (!match) fail('INVALID_SOURCE', 'Only explicit JavaScript Data URLs can be migrated');
    let bytes: Uint8Array;
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
export function restrictOfflineHTML(html: string): string {
    if (typeof html !== 'string' || !/<head(?:\s[^>]*)?>/i.test(html)) throw new TypeError('A complete HTML document is required');
    const policy = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; worker-src blob:; child-src blob:; base-uri 'none'; form-action 'none'";
    // Multiple CSP policies intersect: the Packager's permissive CSP cannot loosen this one.
    return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n<meta http-equiv="Content-Security-Policy" content="${policy}">`);
}
