import type {ExtensionSpec, LoaderOptions, LoaderPorts, Manifest} from './index.js';
import type {ArchiveLimits, ZipConstructor} from './project-codec.js';

export type ExtensionAdditionRequest = {
    id: string;
    execution?: 'sandboxed' | 'unsandboxed';
    source: {type: 'embedded'; path?: string};
    bytes: Uint8Array | Blob;
} | {
    id: string;
    execution?: 'sandboxed' | 'unsandboxed';
    source: {type: 'remote'; url: string};
    bytes?: never;
};
export type AuthoringPorts = Pick<LoaderPorts, 'fetcher' | 'trustProvider' | 'cache' | 'diagnostics'>;
export interface ExtensionAdditionOptions {
    zip: ZipConstructor;
    signal?: AbortSignal;
    loaderOptions?: LoaderOptions;
    archiveOptions?: ArchiveLimits;
}
export interface PreparedExtensionAddition {
    readonly projectBytes: Uint8Array;
    readonly spec: ExtensionSpec;
    readonly manifest: Manifest;
}
/** Computes SHA-256 and reviews the candidate without executing code or changing the input. */
export function prepareExtensionAddition(input: unknown, request: ExtensionAdditionRequest,
    ports: AuthoringPorts, options: ExtensionAdditionOptions): Promise<PreparedExtensionAddition>;
