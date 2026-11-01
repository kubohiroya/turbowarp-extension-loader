import {LoaderError, validateManifest, type ExecutionMode, type ExtensionSource, type FetchPort, type FetchResult,
    type LoaderOptions, type LoaderPorts, type Manifest} from './index.js';
import {createProjectIO, type ArchiveLimits, type ZipConstructor} from './project-codec.js';
import {readPreparedProject} from './project-data.js';
import {collectVerifiedCodes} from './verified-code.js';
import {DEFAULT_LOADER_LIMITS, DEFAULT_TOTAL_BYTES} from './limits.js';

export interface CatalogExtensionRequest {
    id: string;
    url: string;
    distribution: 'embedded' | 'remote' | 'cached';
    execution: ExecutionMode;
    dependencies?: string[];
    version?: string;
}
export interface CatalogOptions {
    zip: ZipConstructor;
    signal?: AbortSignal;
    loaderOptions?: LoaderOptions;
    archiveOptions?: ArchiveLimits;
}
export type CatalogPorts = Pick<LoaderPorts, 'fetcher' | 'trustProvider' | 'cache' | 'diagnostics'>;

const encoder = new TextEncoder();
const digest = async (bytes: BufferSource) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    value => value.toString(16).padStart(2, '0')).join('');
function fail(code: string, message: string, id?: string): never { throw new LoaderError(code, message, id); }

/** Read project-owned distribution requests; these records never grant execution permission. */
export function readProjectAuthoringState(input: unknown, options: CatalogOptions): Promise<Manifest | null>;
export async function readProjectAuthoringState(input: unknown, {zip, signal, archiveOptions}: Partial<CatalogOptions> = {}): Promise<Manifest | null> {
    const io = createProjectIO({zip, ...archiveOptions});
    const prepared = await io.prepare(input, {signal});
    return prepared.manifest;
}

/** Stage an entire catalog selection before the host changes its active project. */
export function prepareCatalogExtensionChanges(input: unknown, requests: CatalogExtensionRequest[],
    ports: CatalogPorts, options: CatalogOptions): Promise<Readonly<{projectBytes: Uint8Array; manifest: Manifest}>>;
export async function prepareCatalogExtensionChanges(input: unknown, requests: CatalogExtensionRequest[], ports: CatalogPorts, {
    zip: Zip, signal: externalSignal, loaderOptions = {}, archiveOptions
}: Partial<CatalogOptions> = {}): Promise<Readonly<{projectBytes: Uint8Array; manifest: Manifest}>> {
    const limits = {...DEFAULT_LOADER_LIMITS, ...loaderOptions};
    for (const key of ['maxExtensions', 'maxBytes', 'maxTotalBytes', 'timeoutMs'] as const) {
        if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) fail('INVALID_OPTIONS', `Invalid ${key}`);
    }
    if (!Array.isArray(requests) || requests.length > limits.maxExtensions) {
        fail('INVALID_ADDITION', 'A bounded catalog selection is required');
    }
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
        if (input.byteLength > (archiveOptions?.maxArchiveBytes ?? DEFAULT_TOTAL_BYTES)) {
            fail('ARCHIVE_SIZE_LIMIT', 'Project exceeds the archive byte limit');
        }
        input = input.slice(0);
    } else if (typeof input !== 'string' && !(input instanceof Blob)) input = JSON.stringify(input);
    const controller = new AbortController();
    const abort = () => controller.abort(externalSignal!.reason);
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener('abort', abort, {once: true});
    const signal = controller.signal;
    const check = () => {
        if (signal.aborted) fail(signal.reason?.code === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED', 'Catalog changes interrupted');
    };
    const wait = async <T>(task: () => T | PromiseLike<T>): Promise<T> => {
        check();
        let cancel!: () => void;
        const cancelled = new Promise<never>((_resolve, reject) => {
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
        const seen = new Set<string>();
        const choices = requests.map(request => {
            if (!request || !['remote', 'embedded', 'cached'].includes(request.distribution) || seen.has(request.id)) {
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
        // Like the JavaScript API, a missing ZIP implementation fails where it is first needed.
        const {project, files} = await wait(() => readPreparedProject(prepared, io, Zip!));
        if (project.extensions !== undefined && (!Array.isArray(project.extensions) ||
            project.extensions.some(id => typeof id !== 'string'))) fail('INVALID_PROJECT', 'Project extensions must be an ID array');
        // Inspect fixed existing bytes without evaluating them or granting host execution consent.
        const oldRecords = prepared.manifest ? await wait(() => collectVerifiedCodes(prepared.manifest!,
            {...ports, diagnostics: undefined, embeddedReader: io.embeddedReader,
                trustProvider: {async authorize(code) { return {allowed: true, scope: 'digest', sha256: code.sha256}; }}},
            loaderOptions, signal)) : [];
        const previous = new Map(oldRecords.map(record => [record.id, record] as const));
        const extensions = new Map<string, unknown>((prepared.manifest?.extensions || []).map(spec => [spec.id, spec] as const));
        const fetched = new Map<string, Uint8Array<ArrayBuffer>>();
        async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
            if (fetched.has(url)) return fetched.get(url)!;
            if (typeof ports.fetcher?.fetch !== 'function') fail('INVALID_PORT', 'A catalog fetch port is required');
            let response: FetchResult;
            try { response = await wait(() => ports.fetcher!.fetch(url, {signal, maxBytes})); }
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
        // Copies the replaced entries kept; released below unless a final entry still names them.
        const replacedPaths = new Set<string>();
        for (const choice of choices) {
            const replaced = prepared.manifest?.extensions.find(spec => spec.id === choice.id)?.source;
            if (replaced && replaced.type !== 'remote') replacedPaths.add(replaced.path);
            const old = previous.get(choice.id);
            // Every catalog request was validated as a Remote source above.
            const bytes = old ? encoder.encode(old.code) : await fetchBytes((choice.source as {url: string}).url);
            const sha256 = await wait(() => digest(bytes));
            if (old && old.sha256 !== sha256) fail('CONVERSION_INTEGRITY', 'Source conversion changed bytes', choice.id);
            const retainedPath = `extensions/${choice.id}-${sha256}.js`;
            const source: ExtensionSource = choice.distribution === 'embedded' ?
                {type: 'embedded', path: retainedPath} : choice.distribution === 'cached' ?
                {type: 'cached', url: (choice.source as {url: string}).url, path: retainedPath} : choice.source;
            // A URL stays canonical for remote and cached, so it must still serve the pinned bytes.
            if (source.type !== 'embedded') {
                const remoteBytes = old ? await fetchBytes(source.url) : bytes;
                if (await wait(() => digest(remoteBytes)) !== sha256) {
                    fail('DIGEST_MISMATCH', 'Remote source does not serve the currently pinned bytes', choice.id);
                }
            }
            // Embedded and cached both retain a copy in the project.
            if (source.type !== 'remote') {
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
        for (const spec of manifest.extensions) if (spec.source.type !== 'remote') replacedPaths.delete(spec.source.path);
        for (const path of replacedPaths) delete files[path];
        project.turboWarpPlus = manifest;
        project.extensions = [...new Set([...(project.extensions || []), ...manifest.extensions.map(spec => spec.id)])];
        const urls = {...(project.extensionURLs || {})};
        for (const spec of manifest.extensions) delete urls[spec.id];
        project.extensionURLs = urls;
        files['project.json'] = encoder.encode(JSON.stringify(project));
        const archive = new Zip!();
        for (const [name, content] of Object.entries(files)) archive.file(name, content, {dir: name.endsWith('/'), createFolders: false});
        const projectBytes: Uint8Array = await wait(() => archive.generateAsync({type: 'uint8array', compression: 'STORE'}));
        const candidate = await wait(() => io.prepare(projectBytes, {signal}));
        io.activate(candidate.context);
        const fetcher: FetchPort = {fetch(url, options) {
            return fetched.has(url) ? Promise.resolve({bytes: new Uint8Array(fetched.get(url)!), finalURL: url, redirects: []}) :
                ports.fetcher!.fetch(url, options);
        }};
        // The common Loader validates the full dependency graph and asks the host about every final request.
        await wait(() => collectVerifiedCodes(manifest, {...ports, fetcher, embeddedReader: io.embeddedReader}, loaderOptions, signal));
        check();
        return Object.freeze({projectBytes, manifest});
    } catch (error) {
        // The selection is one operation: once an entry finally fails, nothing else about it is
        // wanted, so stop the port work it started instead of leaving it running unobserved.
        controller.abort(error instanceof LoaderError ? error :
            new LoaderError('LOAD_FAILED', 'Catalog changes failed', undefined, error));
        throw error;
    } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', abort);
    }
}
