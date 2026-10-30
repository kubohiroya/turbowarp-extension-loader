export type ExtensionSource = Readonly<{type: 'embedded'; path: string} | {type: 'remote'; url: string}>;
export interface ExtensionSpec {
    readonly id: string;
    readonly source: ExtensionSource;
    readonly execution: 'sandboxed' | 'unsandboxed';
    readonly sha256: string;
    readonly version?: string;
    readonly publisher?: string;
    readonly capabilities: readonly string[];
    readonly dependencies: readonly string[];
}
export interface Manifest {readonly schemaVersion: 1; readonly extensions: readonly ExtensionSpec[]}
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
export function isAuthorizedCode(value: unknown): value is AuthorizedCode;
export interface OperationOptions {signal?: AbortSignal}
export interface ReadOptions {signal: AbortSignal; maxBytes: number}
export interface FetchResult {bytes: Uint8Array; finalURL: string; redirects: readonly string[]}
export interface FetchPort {fetch(url: string, options: ReadOptions): Promise<FetchResult>}
export interface RegistrationTransaction {
    register(code: AuthorizedCode, options: {signal: AbortSignal}): Promise<{id: string}>;
    commit(options: {signal: AbortSignal}): Promise<void>;
    rollback(): Promise<void>;
}
export interface LoaderPorts {
    embeddedReader?: {read(path: string, options: ReadOptions): Promise<Uint8Array>};
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
    diagnostics?: (event: Readonly<{type: string; id?: string; ids?: readonly string[]; sha256?: string; cached?: boolean; code?: string}>) => void;
}
export interface LoaderOptions {maxExtensions?: number; maxBytes?: number; maxTotalBytes?: number; timeoutMs?: number}
export interface LoadResult {readonly ids: readonly string[]; readonly manifest: Manifest | null}
export interface ExtensionLoader {
    load(manifest: unknown, options?: OperationOptions): Promise<LoadResult>;
    loadProject(project: unknown, options?: OperationOptions): Promise<LoadResult>;
    unload(): Promise<void>;
    getState(): Readonly<{status: 'idle' | 'loading' | 'loaded' | 'unloading' | 'failed'; ids: readonly string[]}>;
}
export class LoaderError extends Error {readonly code: string; readonly extensionId?: string; constructor(code: string, message: string, extensionId?: string, cause?: unknown)}
export function validateManifest(input: unknown, options?: Pick<LoaderOptions, 'maxExtensions'>): Manifest;
export const parseManifest: typeof validateManifest;
export function discoverManifest(project: unknown, options?: Pick<LoaderOptions, 'maxExtensions'>): Manifest | null;
export function createExtensionLoader(ports: LoaderPorts, options?: LoaderOptions): ExtensionLoader;
export function createFetchPort(fetchImpl?: typeof fetch): FetchPort;
