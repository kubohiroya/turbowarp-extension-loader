import type {ExtensionSource, ExtensionSpec, Manifest, LoaderPorts, LoaderOptions} from './index.js';
import type {ArchiveLimits, ZipConstructor} from './project-codec.js';
export interface DistributionMetadata {license?: string; copyright?: string; provenance?: string}
export interface ConversionOptions {
    zip: ZipConstructor;
    targets?: Record<string, ExtensionSource>;
    metadata?: Record<string, DistributionMetadata>;
    signal?: AbortSignal;
    loaderOptions?: LoaderOptions;
    archiveOptions?: ArchiveLimits;
}
export interface PackageLockEntry {
    readonly id: string; readonly sha256: string; readonly byteLength: number;
    readonly originalSource: ExtensionSource; readonly source: ExtensionSource;
    readonly version: string | null; readonly publisher: string | null;
    readonly metadata: DistributionMetadata | null;
}
export interface ConvertedProject {
    readonly manifest: Manifest;
    readonly lock: Readonly<{schemaVersion: 1; previousLock: unknown; extensions: readonly PackageLockEntry[]}>;
    readonly project: Record<string, unknown>;
    readonly projectBytes: Uint8Array;
    readonly artifacts: Readonly<Record<string, Uint8Array>>;
}
export type PackagingPorts = Pick<LoaderPorts, 'fetcher' | 'trustProvider' | 'cache' | 'diagnostics'>;
export function convertProjectSources(input: unknown, ports: PackagingPorts, options: ConversionOptions): Promise<ConvertedProject>;
export function prepareOfflinePackage(input: unknown, ports: PackagingPorts, options: ConversionOptions & {resourceDependencies: Record<string, readonly never[]>}): Promise<ConvertedProject & {readonly offline: true}>;
export function migrateLegacyDataURL(input: {id: string; url: string; sha256: string; metadata?: DistributionMetadata}, ports: PackagingPorts, options?: {signal?: AbortSignal; loaderOptions?: LoaderOptions}): Promise<Readonly<{spec: ExtensionSpec; bytes: Uint8Array; metadata: DistributionMetadata | null}>>;
export function restrictOfflineHTML(html: string): string;
