import type {Manifest, LoaderOptions, LoaderPorts} from './index.js';
import type {ArchiveLimits, ZipConstructor} from './project-codec.js';
export interface CatalogExtensionRequest {
    id: string;
    url: string;
    distribution: 'embedded' | 'remote';
    execution: 'sandboxed' | 'unsandboxed';
    dependencies?: string[];
    version?: string;
}
export interface CatalogOptions {
    zip: ZipConstructor;
    signal?: AbortSignal;
    loaderOptions?: LoaderOptions;
    archiveOptions?: ArchiveLimits;
}
export function readProjectAuthoringState(input: unknown, options: CatalogOptions): Promise<Manifest | null>;
export function prepareCatalogExtensionChanges(input: unknown, requests: CatalogExtensionRequest[],
    ports: Pick<LoaderPorts, 'fetcher' | 'trustProvider' | 'cache' | 'diagnostics'>,
    options: CatalogOptions): Promise<Readonly<{projectBytes: Uint8Array; manifest: Manifest}>>;
