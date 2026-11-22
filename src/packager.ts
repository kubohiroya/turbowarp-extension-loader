import {LoaderError, validateManifest, type ExtensionSource, type ExtensionSpec, type LoaderOptions, type LoaderPorts, type Manifest} from './index.js';
import {createProjectIO, type ArchiveLimits, type ZipConstructor} from './project-codec.js';
import {collectVerifiedCodes as collect} from './verified-code.js';
import {readPreparedProject as decodePrepared} from './project-data.js';
import {MAX_LEGACY_DATA_URL_LENGTH} from './limits.js';

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
        // A `data:` carrier lives in the project document, and packaging refuses that document's
        // legacy URLs outright, so there would be nowhere to put the bytes.
        if (validated.source.type === 'embedded-data') fail('UNSUPPORTED_SOURCE', 'Packaging cannot write a data: carrier');
        // Only a file carrier has an archive entry to write.
        if (validated.source.type === 'embedded-file') {
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
    // The project keeps its address through a conversion: it is the same work, served from the
    // same place, however its extensions are now held.
    const manifest = validateManifest({schemaVersion: 1,
        ...(prepared.manifest.uri === undefined ? {} : {uri: prepared.manifest.uri}), extensions});
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
        own(targets, spec.id, {type: 'embedded-file', path: `extensions/${spec.id}-${spec.sha256}.js`});
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
    if (typeof url !== 'string' || url.length > MAX_LEGACY_DATA_URL_LENGTH) fail('INVALID_SOURCE', 'Invalid or oversized legacy Data URL');
    const match = /^data:(?:application|text)\/(?:javascript|x-javascript)(?:;charset=utf-8)?(;base64)?;?,([\s\S]*)$/i.exec(url);
    if (!match) fail('INVALID_SOURCE', 'Only explicit JavaScript Data URLs can be migrated');
    let bytes: Uint8Array;
    try {
        if (match[1]) {
            // A repeated group overflows the regex stack on a multi-MiB payload; this form is linear.
            if (match[2].length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(match[2])) throw new Error('Invalid base64');
            bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0));
        } else {
            // decodeURIComponent would reject arbitrary non-UTF8 bytes before the shared validator can diagnose them.
            const text = decodeURIComponent(match[2]);
            bytes = encoder.encode(text);
        }
    } catch (cause) { throw new LoaderError('INVALID_ENCODING', 'Invalid legacy Data URL encoding', id, cause); }
    const path = `extensions/${id}.js`;
    const manifest = validateManifest({schemaVersion: 1, extensions: [{id, source: {type: 'embedded-file', path}, execution: 'unsandboxed', sha256}]});
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
export {packagerPageMessages} from './packager-messages.js';

/** How a single offline Plus HTML is configured. */
export interface PlusPackagerOptions {
    /** The trusted bundle with the Loader, VM registrar and permission UI; it installs `TurboWarpPlusExtensionHost`. */
    runtimeBundle?: string;
    locale?: string;
    /** Patched scaffolding the build inlines instead of fetching. */
    scaffoldingAssets?: Record<string, string>;
    /** SHA-256 digests of packaged extensions the recipient runs without approval. */
    trustedDigests?: string[];
    embeddedProjectData?: boolean;
    /** The archive limits the recipient's Loader applies; they travel with the HTML. */
    archiveOptions: Record<string, number>;
}

/**
 * Write a project out as a single HTML.
 *
 * Moved from the Plus Editor's `site/packager/html.ts` (kubohiroya/turbowarp-plus-editor#741), and before that from the fork's `src/lib/tw-plus-packager.js`. It configures an actual TurboWarp Packager
 * instance, which arrives as an argument: the upstream Packager stays an upstream dependency this
 * repository pins and checks out, and nothing here imports it.
 *
 * What this decides is this distribution's: which runtime bundle the HTML carries, which digests
 * travel with it, the archive limits it states, and the bootstrap that installs extension loading
 * in the recipient's player.
 */



const packagerFailure = (code: string, message: string) => Object.assign(new Error(message), {code});
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Configure an actual TurboWarp Packager instance with a verified offline bundle.
 * The bootstrap is supplied by the trusted build, never by project metadata.
 */
export function configurePlusPackager(packager: any, prepared: any, {
    runtimeBundle, locale = 'ja', scaffoldingAssets, trustedDigests = [], embeddedProjectData = false, archiveOptions
}: PlusPackagerOptions) {
    if (!prepared?.offline || !(prepared.projectBytes instanceof Uint8Array) ||
        !prepared.manifest || !packager?.options || typeof packager.package !== 'function') {
        throw packagerFailure('INVALID_PACKAGE', 'A verified offline Plus bundle and Packager instance are required');
    }
    if (typeof runtimeBundle !== 'string' || !runtimeBundle.trim()) {
        throw packagerFailure('MISSING_BOOTSTRAP', 'The host must bundle the Loader, VM registrar and permission UI');
    }
    // Digests of catalog-listed extensions let the recipient run them without approval, as in the Editor.
    const digests = new Set(prepared.manifest.extensions.map((spec: {sha256: string}) => spec.sha256));
    if (!Array.isArray(trustedDigests) ||
        trustedDigests.some((digest: unknown) => typeof digest !== 'string' || !SHA256.test(digest) || !digests.has(digest))) {
        throw packagerFailure('INVALID_TRUSTED_DIGESTS', 'Trusted digests must be SHA-256 digests of the packaged extensions');
    }
    if (packager.used) throw packagerFailure('PACKAGE_BUSY', 'Packager was already used');
    if (packager.options.custom?.js?.trim()) {
        throw packagerFailure('UNREVIEWED_CUSTOM_CODE', 'Custom JavaScript must be reviewed separately from Plus extension packaging');
    }
    if (scaffoldingAssets) {
        const inlineAssets: Record<string, string> = {};
        for (const name of ['scaffolding', 'scaffolding-min', 'addons']) {
            if (typeof scaffoldingAssets[name] !== 'string' || !scaffoldingAssets[name]) {
                throw packagerFailure('MISSING_SCAFFOLDING', `Trusted patched scaffolding asset is missing: ${name}`);
            }
            // The upstream Packager rewrites raw closing tags assuming single-quoted
            // literals. Escape the slash first so double-quoted iframe bootstraps survive.
            inlineAssets[name] = scaffoldingAssets[name]!.replace(/<\/script/gi, '<\\/script');
        }
        packager.fetchLargeAsset = async (name: string) => {
            if (!Object.prototype.hasOwnProperty.call(scaffoldingAssets, name)) {
                throw packagerFailure('UNBUNDLED_DEPENDENCY', `Packager asset is not bundled: ${name}`);
            }
            return inlineAssets[name];
        };
    }
    const analysis = packager.project?.analysis || {
        stageVariables: [], stageComments: [], usesMusic: true, usesSteamworks: false, extensions: []
    };
    packager.project = {
        // Keeping the SB3 opaque allows the same Loader codec to validate its embedded entries.
        type: 'blob',
        arrayBuffer: prepared.projectBytes.slice().buffer,
        analysis: {...analysis, extensions: []}
    };
    const script = runtimeBundle.replace(/<\/script/gi, '<\\/script');
    // The limits travel with the HTML: the runtime bundle no longer holds a copy of them.
    const options = JSON.stringify({enabled: true, locale, trustedDigests,
        ...(embeddedProjectData ? {embeddedProjectData} : {}), archiveOptions}).replace(/</g, '\\u003c');
    packager.options.target = 'html';
    packager.options.cloudVariables = {...packager.options.cloudVariables, mode: 'none'};
    packager.options.custom = {...packager.options.custom, js: `
${script}
(function() {
    let ready = false;
    const originalLoad = vm.loadProject;
    vm.loadProject = function(...args) {
        if (!ready) return Promise.reject(new Error('Plus runtime bootstrap did not complete'));
        return originalLoad.apply(this, args);
    };
    const runtime = globalThis.TurboWarpPlusExtensionHost;
    if (!runtime || typeof runtime.installPlusExtensionHost !== 'function') {
        throw new Error('Trusted Plus runtime is missing');
    }
    const host = runtime.installPlusExtensionHost(vm, ${options});
    if (!host || host.enabled !== true) throw new Error('Plus runtime is disabled');
    globalThis.__TW_PLUS_PACKAGE_HOST__ = host;
    ready = true;
})();`};
    return packager;
}

/** Generate one HTML file; restrictive CSP prevents runtime remote resource dependencies. */
export async function packagePlusHTML(packager: any, prepared: any, options: PlusPackagerOptions) {
    configurePlusPackager(packager, prepared, options);
    const result = await packager.package();
    if (result.type !== 'text/html' || (typeof result.data !== 'string' && !(result.data instanceof Uint8Array))) {
        throw packagerFailure('INVALID_PACKAGE_OUTPUT', 'Packager did not return a single HTML document');
    }
    const html = typeof result.data === 'string' ? result.data : new TextDecoder('utf-8', {fatal: true}).decode(result.data);
    const restricted = restrictOfflineHTML(html);
    return {...result, data: typeof result.data === 'string' ? restricted : new TextEncoder().encode(restricted)};
}
