import {DEFAULT_LOADER_LIMITS} from './limits.js';

/**
 * Where one extension's bytes live.
 *
 * `cached` names both locations at once: the canonical one is `url`, and a verified copy is
 * retained at `path` inside the project so the extension also resolves offline. The copy is not a
 * weaker source — the Manifest pins the SHA-256, so a retained copy either is exactly the pinned
 * code or the load fails, which is why it may be read before the network.
 */
/**
 * Where a project keeps an extension.
 *
 * `embedded` is the project carrying the bytes; `remote` is the project carrying only a
 * reference. An embedded source may also record the URL the bytes came from, which is what makes
 * falling back possible when a retained copy is missing — and is the only difference between the
 * two forms this used to spell as separate types.
 *
 * A manifest written before 0.4.0 spells that same embedded source `cached`. It is refused, not
 * translated: this family does not promise to read what older versions wrote, and a refusal
 * names the problem where a silent translation would hide it.
 */
/**
 * Where one extension's bytes live, as the author of the project decided.
 *
 * Four names, used unchanged by the SB3 save format and by the screen that offers the choice, so
 * nothing has to be translated between layers. Two hold a reference and two hold the bytes:
 *
 * - `remote-non-cacheable` — a URL, fetched every time. Nothing is kept anywhere.
 * - `remote-cacheable` — a URL, and a verified copy may be kept in this browser.
 * - `embedded-file` — the bytes are a file inside the archive.
 * - `embedded-data` — the bytes are a `data:` value in the project document, which is also what
 *   lets a standard TurboWarp host open the project without knowing this manifest.
 *
 * The two embedded forms are siblings: both make a project that runs offline, anywhere, on its
 * own. They differ in the carrier, and the carrier is what decides who else can read it.
 *
 * `url` on an embedded source records where the bytes came from, which is what keeps a path back
 * to a reference open. Bytes nobody fetched — written here, or authored locally — have no origin
 * to record, so it is optional.
 */
export type RemoteExtensionSource = Readonly<{type: 'remote-non-cacheable' | 'remote-cacheable'; url: string}>;
export type ExtensionSource = Readonly<
    | {type: 'remote-non-cacheable'; url: string}
    | {type: 'remote-cacheable'; url: string}
    | {type: 'embedded-file'; path: string; url?: string}
    | {type: 'embedded-data'; url?: string}>;
/** Whether the project holds a reference the loader has to fetch, rather than the bytes. */
export const isRemoteSource = (source: ExtensionSource): source is RemoteExtensionSource =>
    source.type === 'remote-non-cacheable' || source.type === 'remote-cacheable';
export type ExecutionMode = 'sandboxed' | 'unsandboxed';
export interface ExtensionSpec {
    readonly id: string;
    readonly source: ExtensionSource;
    readonly execution: ExecutionMode;
    readonly sha256: string;
    readonly version?: string;
    readonly publisher?: string;
    readonly capabilities: readonly string[];
    readonly dependencies: readonly string[];
}
export interface Manifest {
    readonly schemaVersion: 1;
    /**
     * The address this project can be downloaded from, which is also what identifies it.
     *
     * One work, one URI, across every edit: it is what the browser's caches and the opener's
     * recorded decisions are filed under, so a fingerprint would not do — that changes on every
     * save and would file one work under a new name each time. An address does not.
     *
     * It is the project's own claim and is not verified. Nothing is served from it until the
     * author actually publishes there, so a URI that does not resolve says nothing: a work saved
     * but never published and a published work whose address rotted look exactly alike. Never
     * decide anything, least of all what to delete, by whether it resolves.
     */
    readonly uri?: string;
    readonly extensions: readonly ExtensionSpec[];
}
export interface ResolvedCode extends ExtensionSpec {
    readonly code: string;
    readonly byteLength: number;
    readonly actualSHA256: string;
    readonly cached: boolean;
}
export interface AuthorizationDecision {readonly allowed: boolean; readonly scope?: 'digest'; readonly sha256?: string}
export interface AuthorizedCode extends ResolvedCode {
    readonly authorization: Readonly<{allowed: true; scope: 'digest'; sha256: string}>;
}
export interface OperationOptions {
    signal?: AbortSignal;
    /**
     * Extension IDs the person opening the project will not keep a copy of in this browser.
     *
     * The author sets the ceiling and the opener may come in under it, so this can only ever
     * refuse. A set says that in the type: there is no way to write "cache this anyway" for a
     * source the author marked `remote-non-cacheable`, and declining is always safe — the worst
     * it costs is a fetch. Naming anything else has no effect: `remote-non-cacheable` keeps
     * nothing already, and embedded bytes travel with the project.
     */
    declineCaching?: ReadonlySet<string>;
}
export interface ReadOptions {signal: AbortSignal; maxBytes: number}
export interface FetchResult {bytes: Uint8Array; finalURL: string; redirects: readonly string[]}
export interface FetchPort {fetch(url: string, options: ReadOptions): Promise<FetchResult>}
export interface FetchRetryOptions {
    /** Attempts after the first one; 0 turns retrying off. */
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    /** Wall clock since the first attempt; no further attempt starts once it is spent. */
    budgetMs?: number;
    onRetry?: (attempt: Readonly<{url: string; attempt: number; delayMs: number; error: unknown}>) => void;
}
export interface RegistrationTransaction {
    register(code: AuthorizedCode, options: {signal: AbortSignal}): Promise<{id: string}>;
    commit(options: {signal: AbortSignal}): Promise<void>;
    rollback(): Promise<void>;
}
export type DiagnosticEvent = Readonly<{type: string; id?: string; ids?: readonly string[]; sha256?: string; cached?: boolean; code?: string}>;
export interface LoaderPorts {
    /**
     * The two embedded carriers, each reached the way it is addressed: a file by its path, a
     * `data:` value by the extension's ID, because the manifest entry already carries one and
     * writing the value into the manifest as well would put the bytes in the project twice.
     * A host implements the carriers it can reach; a source needing the other one fails.
     */
    embeddedReader?: {
        read?(path: string, options: ReadOptions): Promise<Uint8Array>;
        readData?(id: string, options: ReadOptions): Promise<Uint8Array>;
    };
    fetcher?: FetchPort;
    trustProvider: {authorize(code: ResolvedCode, options: {signal: AbortSignal}): Promise<AuthorizationDecision>};
    registrar: {
        begin(options: {signal: AbortSignal}): Promise<RegistrationTransaction>;
        unload(ids: string[]): Promise<void>;
    };
    cache?: {
        get(sha256: string, options: {signal: AbortSignal}): Promise<Uint8Array | null | undefined>;
        put(sha256: string, bytes: Uint8Array, options: {signal: AbortSignal}): Promise<void>;
    };
    diagnostics?: (event: DiagnosticEvent) => void;
}
export interface LoaderOptions {maxExtensions?: number; maxBytes?: number; maxTotalBytes?: number; timeoutMs?: number}
export interface LoadResult {readonly ids: readonly string[]; readonly manifest: Manifest | null}
export type LoaderStatus = 'idle' | 'loading' | 'loaded' | 'unloading' | 'failed';
export interface ExtensionLoader {
    load(manifest: unknown, options?: OperationOptions): Promise<LoadResult>;
    loadProject(project: unknown, options?: OperationOptions): Promise<LoadResult>;
    unload(): Promise<void>;
    getState(): Readonly<{status: LoaderStatus; ids: readonly string[]}>;
}

type Mutable<T> = {-readonly [K in keyof T]: T[K]};

const DEFAULTS = DEFAULT_LOADER_LIMITS;
const RESERVED_IDS = new Set(['pen', 'music', 'videoSensing', 'text2speech', 'translate', 'microbit', 'ev3', 'boost', 'wedo2', 'gdxfor', 'makeymakey']);
const ID = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const authorizations = new WeakSet<AuthorizedCode>();

/** Host adapters accept only immutable records issued after core authorization. */
export const isAuthorizedCode = (value: unknown): value is AuthorizedCode => authorizations.has(value as AuthorizedCode);

export class LoaderError extends Error {
    // Declared, not initialized: an absent extensionId must not become an own property.
    declare readonly code: string;
    declare readonly extensionId?: string;
    constructor(code: string, message: string, extensionId?: string, cause?: unknown) {
        super(message, {cause});
        this.name = 'LoaderError';
        this.code = code;
        if (extensionId !== undefined) this.extensionId = extensionId;
    }
}

function fail(code: string, message: string, id?: string): never { throw new LoaderError(code, message, id); }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function keys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
    if (!object(value)) fail('INVALID_MANIFEST', `${label} must be an object`);
    if (Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_MANIFEST', `${label} has unknown fields`);
}
const validId = (id: unknown): id is string => typeof id === 'string' && ID.test(id) && !RESERVED_IDS.has(id);
const executionMode = (value: unknown): value is ExecutionMode => value === 'sandboxed' || value === 'unsandboxed';
const string = (value: unknown, label: string, max = 256): string => {
    if (typeof value !== 'string' || value.length < 1 || value.length > max) fail('INVALID_MANIFEST', `Invalid ${label}`);
    return value;
};

// One rule for every address this family records. The code says which address was wrong, since
// a project's own URI is not one of its sources and should not be reported as one.
function address(value: unknown, code: string, what: string): string {
    let url: URL;
    // Reported under the caller's code throughout, including a value that is not a string at
    // all, so one wrong address is one error a reader can place.
    if (typeof value !== 'string' || value.length > 4096) fail(code, `${what} must be an absolute HTTPS URL`);
    try { url = new URL(value); } catch { fail(code, `${what} must be an absolute HTTPS URL`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail(code, `${what} requires HTTPS without credentials or fragment`);
    return url.href;
}
const remoteURL = (value: string): string => address(value, 'INVALID_SOURCE', 'Remote source');

function embeddedPath(value: unknown): string {
    const path = string(value, 'embedded path', 256);
    if (!/^extensions\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.js$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) fail('INVALID_SOURCE', 'Unsafe embedded path');
    return path;
}

function sourceOf(source: unknown): ExtensionSource {
    if (!object(source)) fail('INVALID_SOURCE', 'Missing extension source');
    const origin = (value: unknown) => remoteURL(string(value, 'URL', 4096));
    if (source.type === 'remote-non-cacheable' || source.type === 'remote-cacheable') {
        keys(source, ['type', 'url'], 'source');
        return Object.freeze({type: source.type, url: origin(source.url)});
    }
    if (source.type === 'embedded-file') {
        keys(source, ['type', 'path', 'url'], 'source');
        const path = embeddedPath(source.path);
        if (source.url === undefined) return Object.freeze({type: 'embedded-file', path});
        return Object.freeze({type: 'embedded-file', path, url: origin(source.url)});
    }
    if (source.type === 'embedded-data') {
        keys(source, ['type', 'url'], 'source');
        if (source.url === undefined) return Object.freeze({type: 'embedded-data'});
        return Object.freeze({type: 'embedded-data', url: origin(source.url)});
    }
    // Name each retired spelling and what replaces it. A project written by an older version
    // fails with something a reader can act on rather than "unsupported", and the reader has to
    // make the choice the old name left implicit rather than have one picked for them.
    if (source.type === 'remote') fail('INVALID_SOURCE', 'A remote source is now remote-cacheable or remote-non-cacheable');
    if (source.type === 'cached') fail('INVALID_SOURCE', 'A cached source is now embedded-file with a url');
    if (source.type === 'embedded') fail('INVALID_SOURCE', 'An embedded source is now embedded-file or embedded-data');
    fail('INVALID_SOURCE', 'Unsupported source type');
}

/** Validate and snapshot untrusted data; execution is only a request. */
export function validateManifest(input: unknown, options: Pick<LoaderOptions, 'maxExtensions'> = {}): Manifest {
    keys(input, ['schemaVersion', 'uri', 'extensions'], 'manifest');
    if (input.schemaVersion !== 1) fail('UNSUPPORTED_SCHEMA', 'Only schemaVersion 1 is supported');
    // The same rule as every other address this family records, so there is one to learn.
    const uri = input.uri === undefined ? undefined : address(input.uri, 'INVALID_PROJECT_URI', 'A project URI');
    const maxExtensions = options.maxExtensions ?? DEFAULTS.maxExtensions;
    if (!Array.isArray(input.extensions) || input.extensions.length > maxExtensions) fail('INVALID_MANIFEST', 'Invalid extension list');
    const ids = new Set<string>();
    const extensions = input.extensions.map((spec: unknown): ExtensionSpec => {
        keys(spec, ['id', 'source', 'execution', 'sha256', 'version', 'publisher', 'capabilities', 'dependencies'], 'extension');
        // A rejected ID is reported as supplied, even when it is not a string.
        if (!validId(spec.id) || ids.has(spec.id)) fail('INVALID_ID', 'Invalid, reserved, or duplicate extension ID', spec.id as string);
        ids.add(spec.id);
        if (!executionMode(spec.execution)) fail('INVALID_EXECUTION', 'An explicit sandboxed or unsandboxed request is required', spec.id);
        if (typeof spec.sha256 !== 'string' || !SHA256.test(spec.sha256)) fail('INVALID_DIGEST', 'A lowercase SHA-256 pin is required', spec.id);
        const result: Partial<Mutable<ExtensionSpec>> = {id: spec.id, source: sourceOf(spec.source), execution: spec.execution, sha256: spec.sha256};
        for (const key of ['version', 'publisher'] as const) if (spec[key] !== undefined) result[key] = string(spec[key], key);
        for (const key of ['capabilities', 'dependencies'] as const) {
            const values = spec[key] ?? [];
            if (!Array.isArray(values) || values.length > 64 || values.some(value => typeof value !== 'string' || !ID.test(value)) || new Set(values).size !== values.length) fail('INVALID_MANIFEST', `Invalid ${key}`, spec.id);
            result[key] = Object.freeze([...values]);
        }
        return Object.freeze(result as ExtensionSpec);
    });
    const ordered: ExtensionSpec[] = [];
    const visited = new Set<string>();
    const active = new Set<string>();
    const byId = new Map(extensions.map(spec => [spec.id, spec] as const));
    const visit = (spec: ExtensionSpec): void => {
        if (visited.has(spec.id)) return;
        if (active.has(spec.id)) fail('DEPENDENCY_CYCLE', 'Cyclic extension dependency', spec.id);
        active.add(spec.id);
        for (const dependency of spec.dependencies) {
            if (!byId.has(dependency)) fail('MISSING_DEPENDENCY', 'Dependency is absent from the manifest', spec.id);
            visit(byId.get(dependency)!);
        }
        active.delete(spec.id);
        visited.add(spec.id);
        ordered.push(spec);
    };
    extensions.forEach(visit);
    return Object.freeze({schemaVersion: 1, ...(uri === undefined ? {} : {uri}),
        extensions: Object.freeze(ordered)});
}

export function discoverManifest(project: unknown, options?: Pick<LoaderOptions, 'maxExtensions'>): Manifest | null {
    if (!object(project)) fail('INVALID_PROJECT', 'Project must be a parsed object');
    if (!Object.hasOwn(project, 'turboWarpPlus')) return null;
    return validateManifest(project.turboWarpPlus, options);
}

export const parseManifest = validateManifest;

function snapshotBytes(input: unknown, maxBytes: number, id: string): Uint8Array<ArrayBuffer> {
    if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > maxBytes) fail('INVALID_BYTES', 'Extension bytes are empty, oversized, or invalid', id);
    return new Uint8Array(input);
}

async function digest(bytes: BufferSource): Promise<string> {
    const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

function checkSignal(signal: AbortSignal): void {
    if (signal.aborted) throw new LoaderError(signal.reason?.code === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED', 'Extension load interrupted', undefined, signal.reason);
}

async function guarded<T>(task: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
    checkSignal(signal);
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => {
            try { checkSignal(signal); } catch (error) { reject(error); }
        };
        signal.addEventListener('abort', abort, {once: true});
    });
    try { return await Promise.race([Promise.resolve().then(task), cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
}

/** A backoff wait the signal interrupts, so a cancelled load never sits out its remaining delay. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
    checkSignal(signal);
    return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const abort = (): void => {
            clearTimeout(timer);
            try { checkSignal(signal); } catch (error) { reject(error); }
        };
        timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
        signal.addEventListener('abort', abort, {once: true});
    });
}

/**
 * The bounded retry the default fetch port applies.
 *
 * A load already has one deadline (`timeoutMs`, 30 seconds by default) covering every extension's
 * fetch, authorization and registration, so retrying can never extend the wait a person already
 * faces. This budget is the separate, tighter ceiling on how long retrying one URL may go on:
 * 400 ms then 800 ms of backoff, and no attempt begins more than 5 seconds after the first one.
 */
export const DEFAULT_FETCH_RETRY = Object.freeze({retries: 2, baseDelayMs: 400, maxDelayMs: 2000, budgetMs: 5000});

const transientStatus = (status: number): boolean => status === 408 || status === 425 || status === 429 || status >= 500;

/**
 * Whether asking again could plausibly answer differently.
 *
 * A `FETCH_FAILED` carrying an HTTP status is an answer from the server, and only a request
 * timeout, a too-early retry, a rate limit and a server-side error are worth repeating; 404 is the
 * answer that it is not there. Every other `LoaderError` is a policy or validation refusal — a
 * redirect, a byte limit, a rejected URL, a cancellation — and repeating it returns the refusal.
 *
 * A rejection that is not a `LoaderError` is a transport failure with no response at all. In a
 * browser one `TypeError` covers a connection that could not be made, DNS failure and being
 * offline, but also a CORS or CSP refusal: fetch deliberately makes them indistinguishable, so a
 * permanent refusal is retried along with the connection failure this was written for. That is
 * affordable only because the budget is small, and it is why the budget is small.
 */
export function isTransientFetchFailure(error: unknown): boolean {
    if (error instanceof LoaderError) {
        const status = (error.cause as {status?: unknown} | null | undefined)?.status;
        return error.code === 'FETCH_FAILED' && typeof status === 'number' && transientStatus(status);
    }
    // An abort is the host's own decision or the deadline's, never something to ask again.
    return !(error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
}

/**
 * Retry a transient Remote failure a bounded number of times, then give the failure up.
 *
 * Retrying belongs to the fetch port and not to the loader's own loop: it is a transport policy,
 * while the loop's other failures — a digest mismatch, a corrupt cache entry, a trust refusal —
 * must never be repeated, and the core cannot classify what an arbitrary port throws. So the core
 * cannot impose this on an injected port: a host that implements its own port keeps full control
 * and gets no retry unless it asks, either by wrapping its port in this helper or by retrying
 * inside it. `createFetchPort()` wraps itself, so a host on the default port needs no change.
 *
 * Giving up is final here. One entry that finally fails ends the whole operation, because
 * registration starts only once every entry is verified and authorized; the person waiting is the
 * retry mechanism from that point on, and the host asks them to try again.
 */
export function withFetchRetry(port: FetchPort, options: FetchRetryOptions = {}): FetchPort {
    if (typeof port?.fetch !== 'function') fail('INVALID_PORT', 'A fetch port is required to retry');
    const {retries, baseDelayMs, maxDelayMs, budgetMs} = {...DEFAULT_FETCH_RETRY, ...options};
    for (const [key, value] of Object.entries({retries, baseDelayMs, maxDelayMs, budgetMs})) {
        if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_OPTIONS', `Invalid ${key}`);
    }
    return Object.freeze({
        async fetch(url: string, readOptions: ReadOptions): Promise<FetchResult> {
            const started = Date.now();
            for (let attempt = 0; ; attempt++) {
                try { return await port.fetch(url, readOptions); }
                catch (error) {
                    const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
                    // The budget covers the waiting too, so no attempt starts once it is spent.
                    if (attempt >= retries || Date.now() - started + delayMs > budgetMs || !isTransientFetchFailure(error)) throw error;
                    try { options.onRetry?.(Object.freeze({url, attempt: attempt + 1, delayMs, error})); }
                    catch { /* Progress reporting must not change the outcome. */ }
                    await delay(delayMs, readOptions.signal);
                }
            }
        }
    });
}

/**
 * Browser fetch port rejects redirects and streams with a byte limit, and retries a transient
 * failure within `DEFAULT_FETCH_RETRY`. Pass `{retries: 0}` for a single attempt.
 */
export function createFetchPort(fetchImpl: typeof fetch = globalThis.fetch, retry: FetchRetryOptions = {}): FetchPort {
    return withFetchRetry(Object.freeze({
        async fetch(url: string, {signal, maxBytes}: ReadOptions): Promise<FetchResult> {
            const response = await fetchImpl(remoteURL(url), {signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer'});
            if (response.redirected || response.type === 'opaque' || response.url !== remoteURL(url)) fail('FETCH_FAILED', 'Remote response is unavailable or redirected');
            // The status is kept on the cause so a wrapper can tell a rate limit or a server-side
            // error from an answer such as 404, which repeating would only ask for again.
            if (!response.ok) throw new LoaderError('FETCH_FAILED', `Remote response is unavailable (HTTP ${response.status})`, undefined, Object.freeze({status: response.status}));
            const declared = response.headers.get('content-length');
            if (declared !== null && Number(declared) > maxBytes) fail('INVALID_BYTES', 'Remote extension exceeds byte limit');
            if (!response.body) fail('FETCH_FAILED', 'Remote response has no readable body');
            const reader = response.body.getReader();
            const parts: Uint8Array[] = [];
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
    }), retry);
}

/** The host owns all ports, especially trust decisions and privileged execution. */
export function createExtensionLoader(ports: LoaderPorts, options: LoaderOptions = {}): ExtensionLoader {
    const limits = {...DEFAULTS, ...options};
    for (const key of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) fail('INVALID_OPTIONS', `Invalid ${key}`);
    if (typeof ports?.trustProvider?.authorize !== 'function' || typeof ports?.registrar?.begin !== 'function' || typeof ports?.registrar?.unload !== 'function') fail('INVALID_PORT', 'Explicit host trust and transactional registrar ports are required');
    let state: LoaderStatus = 'idle';
    let loaded: string[] = [];
    const report = (event: DiagnosticEvent) => { try { ports.diagnostics?.(Object.freeze({...event})); } catch { /* Diagnostics must not alter authorization. */ } };

    async function resolve(spec: ExtensionSpec, signal: AbortSignal, budget: {bytes: number}, declineCaching?: ReadonlySet<string>): Promise<ResolvedCode> {
        let bytes: Uint8Array<ArrayBuffer> | undefined;
        let cached = false;
        // The manifest is frozen, so the narrowed source stays valid inside the port callbacks.
        const source = spec.source;
        // One form permits a copy, and only the person can come in under that. The author's
        // `remote-non-cacheable` is a prohibition nothing here can undo, and embedded bytes
        // already travel with the project, so a second copy would buy nothing. The decision
        // holds in both directions: not read for this extension, and not written either.
        const mayCache = source.type === 'remote-cacheable' && !declineCaching?.has(spec.id);
        if (mayCache && ports.cache) {
            const entry = await guarded(() => ports.cache!.get(spec.sha256, {signal}), signal);
            if (entry !== undefined && entry !== null) {
                const candidate = snapshotBytes(entry, limits.maxBytes, spec.id);
                if (await guarded(() => digest(candidate), signal) !== spec.sha256) fail('CACHE_INTEGRITY', 'Cached bytes do not match the digest', spec.id);
                bytes = candidate;
                cached = true;
            }
        }
        if (!bytes) {
            if (source.type === 'embedded-file' || source.type === 'embedded-data') {
                const reader = source.type === 'embedded-file' ?
                    () => ports.embeddedReader!.read!(source.path, {signal, maxBytes: limits.maxBytes}) :
                    () => ports.embeddedReader!.readData!(spec.id, {signal, maxBytes: limits.maxBytes});
                const available = source.type === 'embedded-file' ?
                    typeof ports.embeddedReader?.read === 'function' :
                    typeof ports.embeddedReader?.readData === 'function';
                if (!available) fail('INVALID_PORT', `Reader for ${source.type} is unavailable`, spec.id);
                try {
                    bytes = snapshotBytes(await guarded(reader, signal), limits.maxBytes, spec.id);
                } catch (cause) {
                    // Falling back is only possible where the project recorded where the bytes
                    // came from; without that, a missing retained copy is the end of it.
                    if (source.url === undefined || signal.aborted) throw cause;
                    report({type: 'retained-copy-unavailable', id: spec.id});
                }
            }
            const url = source.url;
            if (!bytes && url !== undefined) {
                if (typeof ports.fetcher?.fetch !== 'function') fail('INVALID_PORT', 'Remote fetch port is unavailable', spec.id);
                const response = await guarded(() => ports.fetcher!.fetch(url, {signal, maxBytes: limits.maxBytes}), signal);
                if (!response || !Array.isArray(response.redirects) || response.redirects.length || response.finalURL !== url) fail('REDIRECT_DENIED', 'Unproven or redirected remote source', spec.id);
                bytes = snapshotBytes(response.bytes, limits.maxBytes, spec.id);
            }
            if (!bytes) fail('SOURCE_UNAVAILABLE', 'Extension bytes could not be read', spec.id);
        }
        budget.bytes += bytes.byteLength;
        if (budget.bytes > limits.maxTotalBytes) fail('TOTAL_SIZE_LIMIT', 'Project extension bytes exceed total limit', spec.id);
        const actual = await guarded(() => digest(bytes), signal);
        if (actual !== spec.sha256) fail('DIGEST_MISMATCH', 'Extension bytes do not match the digest', spec.id);
        let code: string;
        try { code = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
        catch (cause) { throw new LoaderError('INVALID_ENCODING', 'Extension must contain valid UTF-8', spec.id, cause); }
        if (!cached && mayCache && ports.cache) await guarded(() => ports.cache!.put(spec.sha256, new Uint8Array(bytes), {signal}), signal);
        const result: ResolvedCode = Object.freeze({...spec, code, byteLength: bytes.byteLength, actualSHA256: actual, cached});
        report({type: 'verified', id: spec.id, sha256: actual, cached});
        return result;
    }

    async function load(input: unknown, {signal: externalSignal, declineCaching}: OperationOptions = {}): Promise<LoadResult> {
        if (state !== 'idle') fail('BUSY', 'Unload the previous project before another load');
        const manifest = validateManifest(input, limits);
        const controller = new AbortController();
        const abort = () => controller.abort(externalSignal!.reason);
        if (externalSignal?.aborted) abort();
        else externalSignal?.addEventListener('abort', abort, {once: true});
        const timer = setTimeout(() => controller.abort(new LoaderError('TIMEOUT', 'Extension load timed out')), limits.timeoutMs);
        const signal = controller.signal;
        let transaction: RegistrationTransaction | undefined;
        const authorized: AuthorizedCode[] = [];
        state = 'loading';
        try {
            const budget = {bytes: 0};
            for (const spec of manifest.extensions) {
                const code = await resolve(spec, signal, budget, declineCaching);
                const decision = await guarded(() => ports.trustProvider.authorize(code, {signal}), signal);
                if (decision?.allowed !== true || decision.scope !== 'digest' || decision.sha256 !== code.sha256) fail('TRUST_DENIED', 'Host did not approve this exact extension digest', spec.id);
                const approved: AuthorizedCode = Object.freeze({...code, authorization: Object.freeze({allowed: true, scope: 'digest', sha256: code.sha256})});
                authorizations.add(approved);
                authorized.push(approved);
                report({type: 'authorized', id: spec.id, sha256: code.sha256});
            }
            checkSignal(signal);
            if (authorized.length) {
                // Registrar calls are awaited even after cancellation so rollback cannot race a late registration.
                transaction = await ports.registrar.begin({signal});
                if (!transaction || (['register', 'commit', 'rollback'] as const).some(key => typeof transaction![key] !== 'function')) fail('INVALID_PORT', 'Registrar must support register, commit, and rollback');
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
                // Keep rejection handling outside a nested async catch: webpack 4's Babel
                // lowering otherwise mistakes the original load error for a rollback error.
                const rollback = await Promise.resolve().then(() => transaction!.rollback())
                    .then(() => ({ok: true as const}), (rollbackError: unknown) => ({ok: false as const, rollbackError}));
                if (!rollback.ok) {
                    state = 'failed';
                    error = new LoaderError('ROLLBACK_FAILED', 'Host could not restore registration state', undefined,
                        new AggregateError([error, rollback.rollbackError]));
                }
            }
            if (state !== 'failed') state = 'idle';
            // Rollback is done, so nothing of this operation should still be running on its signal:
            // stop the port work the core has already stopped waiting for, retries included.
            controller.abort(error);
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
        async loadProject(project: unknown, options?: OperationOptions): Promise<LoadResult> {
            if (state !== 'idle') fail('BUSY', 'Unload the previous project before another load');
            const manifest = discoverManifest(project, limits);
            return manifest === null ? Object.freeze({ids: Object.freeze([]), manifest: null}) : load(manifest, options);
        },
        async unload(): Promise<void> {
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
