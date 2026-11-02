import {isRemoteSource, LoaderError, validateManifest, type ExecutionMode, type ExtensionSource, type FetchPort, type FetchResult,
    type LoaderOptions, type LoaderPorts, type Manifest} from './index.js';
import {createProjectIO, DATA_CARRIER_PREFIX, type ArchiveLimits, type ZipConstructor} from './project-codec.js';
import {readPreparedProject} from './project-data.js';
import {collectVerifiedCodes} from './verified-code.js';
import {DEFAULT_LOADER_LIMITS, DEFAULT_TOTAL_BYTES} from './limits.js';

export interface CatalogExtensionRequest {
    id: string;
    url: string;
    /**
     * Which of the four forms the project keeps it in, as the author decided.
     *
     * The same four names the manifest and the SB3 save format use, so this is the author's
     * decision written once. Either reference form records the address; either embedded form
     * records it too, beside the bytes, which is what keeps a path back to a reference open.
     *
     * Whether the person opening the project actually keeps a copy of a `remote-cacheable`
     * extension is theirs to decline, through `declineCaching` on `load()`.
     */
    distribution: ExtensionSource['type'];
    execution: ExecutionMode;
    dependencies?: string[];
    version?: string;
}
export interface CatalogOptions {
    zip: ZipConstructor;
    signal?: AbortSignal;
    loaderOptions?: LoaderOptions;
    archiveOptions?: ArchiveLimits;
    /**
     * The address to give this project, or nothing to keep the one it has.
     *
     * Whether to assign one is the host's call, not this function's: only the host knows whether
     * the author chose an address or whether this is a first save that needs a default. So this
     * sets what it is given and leaves the existing address alone when it is given nothing —
     * `readProjectAuthoringState` reports what a project already carries, so the host can tell
     * the two apart before deciding.
     */
    uri?: string;
}
export type CatalogPorts = Pick<LoaderPorts, 'fetcher' | 'trustProvider' | 'cache' | 'diagnostics'>;

const encoder = new TextEncoder();
// A standard TurboWarp host looks for a URL in the project document and knows nothing of this
// manifest, so for that carrier the bytes have to be the address itself.
const dataCarrier = (bytes: Uint8Array) => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `${DATA_CARRIER_PREFIX}${btoa(binary)}`;
};
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
    zip: Zip, signal: externalSignal, loaderOptions = {}, archiveOptions, uri
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
            if (!request || !['remote-non-cacheable', 'remote-cacheable', 'embedded-file', 'embedded-data']
                .includes(request.distribution) || seen.has(request.id)) {
                fail('INVALID_ADDITION', 'Invalid or duplicate catalog selection', request?.id);
            }
            seen.add(request.id);
            const execution = request.execution;
            const spec = validateManifest({schemaVersion: 1, extensions: [{id: request.id,
                // Validated as a reference whatever the request asks for: this is only here to
                // put the URL and the execution mode through the schema before anything is read.
                source: {type: 'remote-cacheable', url: request.url}, execution, sha256: '0'.repeat(64),
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
        // Bytes for a data carrier, kept until the project document is written.
        const carriers = new Map<string, Uint8Array>();
        for (const choice of choices) {
            const replaced = prepared.manifest?.extensions.find(spec => spec.id === choice.id)?.source;
            if (replaced?.type === 'embedded-file') replacedPaths.add(replaced.path);
            const old = previous.get(choice.id);
            // Validated as a reference above, so it has an address to fetch and to record.
            if (!isRemoteSource(choice.source)) fail('INVALID_ADDITION', 'A catalog request is a reference', choice.id);
            const origin = choice.source.url;
            const bytes = old ? encoder.encode(old.code) : await fetchBytes(origin);
            const sha256 = await wait(() => digest(bytes));
            if (old && old.sha256 !== sha256) fail('CONVERSION_INTEGRITY', 'Source conversion changed bytes', choice.id);
            const retainedPath = `extensions/${choice.id}-${sha256}.js`;
            // A catalog extension was fetched from an address, so either embedded form keeps that
            // address beside the bytes rather than discarding what is already known. Bytes nobody
            // fetched — a costume, a sound, an extension written here — have no address to record,
            // which is why a url is optional on an embedded source.
            const source: ExtensionSource =
                choice.distribution === 'embedded-file' ? {type: 'embedded-file', path: retainedPath, url: origin} :
                    choice.distribution === 'embedded-data' ? {type: 'embedded-data', url: origin} :
                        {type: choice.distribution, url: origin};
            // A recorded URL is a promise about what it serves, so it must still serve exactly
            // the pinned bytes — whether it is the only place they live or sits beside a copy.
            if (source.url !== undefined) {
                const remoteBytes = old ? await fetchBytes(source.url) : bytes;
                if (await wait(() => digest(remoteBytes)) !== sha256) {
                    fail('DIGEST_MISMATCH', 'Remote source does not serve the currently pinned bytes', choice.id);
                }
            }
            // Only the file carrier has an archive entry; the data carrier is written below,
            // into the project document, because that is where a standard host looks for it.
            if (source.type === 'embedded-file') {
                if (Object.hasOwn(files, source.path) && await wait(() => digest(files[source.path])) !== sha256) {
                    fail('SOURCE_PATH_COLLISION', 'The embedded path belongs to different content', choice.id);
                }
                files[source.path] = new Uint8Array(bytes);
            }
            if (source.type === 'embedded-data') carriers.set(choice.id, new Uint8Array(bytes));
            extensions.set(choice.id, {id: choice.id, source, execution: choice.execution, sha256,
                ...((old?.version || choice.version) ? {version: old?.version || choice.version} : {}),
                ...(old?.publisher ? {publisher: old.publisher} : {}),
                capabilities: old?.capabilities || [], dependencies: choice.dependencies});
        }
        // The project's own address survives a change to its extensions. Rebuilding the manifest
        // without it would file the same work under a new name the next time it was saved, which
        // is the one thing an address is for.
        const address = uri ?? prepared.manifest?.uri;
        const manifest = validateManifest({schemaVersion: 1,
            ...(address === undefined ? {} : {uri: address}),
            extensions: [...extensions.values()]}, loaderOptions);
        for (const spec of manifest.extensions) if (spec.source.type === 'embedded-file') replacedPaths.delete(spec.source.path);
        for (const path of replacedPaths) delete files[path];
        project.turboWarpPlus = manifest;
        project.extensions = [...new Set([...(project.extensions || []), ...manifest.extensions.map(spec => spec.id)])];
        const urls = {...(project.extensionURLs || {})};
        for (const spec of manifest.extensions) {
            if (spec.source.type === 'embedded-data') urls[spec.id] = dataCarrier(carriers.get(spec.id)!);
            else delete urls[spec.id];
        }
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
