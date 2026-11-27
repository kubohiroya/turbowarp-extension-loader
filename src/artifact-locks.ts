import {validateExtensionArtifactLock, type ExtensionArtifactLock} from '@kubohiroya/sb3-toolchain/web-distribution';
import {LoaderError, type ExtensionSpec, type Manifest} from './index.js';

export const artifactLocksEntry = 'tw-plus/extension-locks.json';
const limit = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
type LockEntry = {id: string; artifactLock: ExtensionArtifactLock};
function fail(): never { throw new LoaderError('INVALID_ARTIFACT_LOCK', 'Unsupported or inconsistent extension artifact lock'); }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function read(bytes: Uint8Array | undefined): LockEntry[] {
    if (!bytes) return [];
    try {
        if (bytes.byteLength > limit) fail();
        const value: unknown = JSON.parse(decoder.decode(bytes));
        if (!object(value) || value.formatVersion !== 1 || Object.keys(value).some(key => !['formatVersion', 'extensions'].includes(key)) ||
            !Array.isArray(value.extensions) || value.extensions.length > 256) fail();
        const seen = new Set<string>();
        return value.extensions.map((entry: unknown) => {
            if (!object(entry) || Object.keys(entry).some(key => !['id', 'artifactLock'].includes(key)) ||
                typeof entry.id !== 'string' || seen.has(entry.id)) fail();
            seen.add(entry.id);
            validateExtensionArtifactLock(entry.artifactLock, entry.id);
            return {id: entry.id, artifactLock: entry.artifactLock};
        });
    } catch { return fail(); }
}

export function copyArtifactLock(value: unknown, id: string): ExtensionArtifactLock | undefined {
    if (value === undefined) return undefined;
    try {
        validateExtensionArtifactLock(value, id);
        return structuredClone(value);
    } catch { return fail(); }
}

/** The shared validator owns the versioned receipt schema; provenance never grants execution permission. */
export function validateArtifactLocks(files: ReadonlyMap<string, Uint8Array>, manifest: Manifest | null): void {
    if (!files.has(artifactLocksEntry)) {
        if (manifest?.extensions.some(spec => spec.artifactLockFormatVersion !== undefined)) fail();
        return;
    }
    if (!manifest) fail();
    const entries = read(files.get(artifactLocksEntry));
    if (manifest.extensions.some(spec => spec.artifactLockFormatVersion === 1 && !entries.some(entry => entry.id === spec.id))) fail();
    try {
        for (const {id, artifactLock} of entries) {
            const spec = manifest.extensions.find(item => item.id === id);
            if (!spec || spec.artifactLockFormatVersion !== 1 || spec.sha256 !== artifactLock.bundleSHA256) fail();
            const bytes = spec.source.type === 'embedded-file' ? files.get(spec.source.path) : undefined;
            if (spec.source.type === 'embedded-file' && !bytes) fail();
            validateExtensionArtifactLock(artifactLock, id, bytes);
            executionMatches(artifactLock, spec);
        }
    } catch { fail(); }
}

function write(files: Record<string, Uint8Array>, entries: LockEntry[]): void {
    if (!entries.length) { delete files[artifactLocksEntry]; return; }
    const bytes = encoder.encode(JSON.stringify({formatVersion: 1, extensions: entries}));
    if (bytes.byteLength > limit) fail();
    files[artifactLocksEntry] = bytes;
}

const execution = (lock: ExtensionArtifactLock) => lock.provenance.kind === 'build' ?
    lock.provenance.receipt.execution : lock.provenance.distribution.execution;
function executionMatches(lock: ExtensionArtifactLock, spec: ExtensionSpec): void {
    if (execution(lock) !== spec.execution) fail();
}

/** Replace only the explicitly edited candidate's record, after validating its real bytes. */
export function updateArtifactLock(files: Record<string, Uint8Array>, spec: ExtensionSpec, lock: unknown, bytes: Uint8Array): void {
    const entries = read(files[artifactLocksEntry]).filter(entry => entry.id !== spec.id);
    if (lock !== undefined) {
        try {
            validateExtensionArtifactLock(lock, spec.id, bytes);
            if (lock.bundleSHA256 !== spec.sha256) fail();
            executionMatches(lock, spec);
            entries.push({id: spec.id, artifactLock: structuredClone(lock)});
        } catch { fail(); }
    }
    write(files, entries);
}

/** Explicit catalog edits may remove an extension or select different bytes; stale provenance cannot follow it. */
export function reconcileArtifactLocks(files: Record<string, Uint8Array>, manifest: Manifest): void {
    const entries = read(files[artifactLocksEntry]).filter(({id, artifactLock}) =>
        manifest.extensions.some(spec => spec.id === id && spec.artifactLockFormatVersion === 1 &&
            spec.sha256 === artifactLock.bundleSHA256 && spec.execution === execution(artifactLock)));
    write(files, entries);
}
