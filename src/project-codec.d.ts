import type {Manifest} from './index.js';
export interface ArchiveLimits {
    maxArchiveBytes?: number;
    maxTotalBytes?: number;
    maxEntryBytes?: number;
    maxProjectBytes?: number;
    maxEntries?: number;
    maxRatio?: number;
}
export interface ZipEntryMetadata {
    readonly name: string;
    readonly size: number;
    readonly crc: number;
    readonly directory: boolean;
}
export interface ZipArchive {
    file(name: string): unknown;
    file(name: string, bytes: Uint8Array, options?: {dir?: boolean; createFolders?: boolean}): unknown;
}
export interface ZipConstructor {
    new(): any;
    loadAsync(bytes: Uint8Array, options: {checkCRC32: boolean; createFolders: boolean}): Promise<any>;
}
export interface ProjectContext { readonly __projectContext?: never; }
export interface PreparedProject {
    readonly manifest: Manifest | null;
    readonly input: unknown;
    readonly context: ProjectContext | null;
}
export interface ProjectIO {
    prepare(input: unknown, options?: {signal?: AbortSignal}): Promise<PreparedProject>;
    activate(context: ProjectContext | null): void;
    readonly embeddedReader: {read(path: string, options?: {signal?: AbortSignal; maxBytes?: number}): Promise<Uint8Array>};
    restoreJSON<T extends string | Record<string, unknown>>(json: T, context: ProjectContext | null): T;
    restoreFiles(files: Record<string, Uint8Array>, context: ProjectContext | null): Record<string, Uint8Array>;
    restoreArchive<T extends ZipArchive>(archive: T, context: ProjectContext | null): T;
}
export function inspectZip(bytes: Uint8Array, options?: ArchiveLimits): Map<string, ZipEntryMetadata>;
export function createProjectIO(options?: ArchiveLimits & {zip?: ZipConstructor}): ProjectIO;
