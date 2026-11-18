// SPDX-License-Identifier: MPL-2.0
/**
 * Ask before a project over the standard limits is expanded (issue #428).
 *
 * The project IO is made with the ceiling limits, so it can read a project the person agreed to.
 * The gate stands in front of its `prepare` and measures the input with the standard limits
 * first, without expanding anything: a ZIP by its central directory, JSON by its length. A
 * project within them goes through unasked. One that the ceiling limits accept is shown to the
 * person with its size; one they also refuse, including one over the compression ratio, is
 * left to `prepare`, which refuses it as before.
 */

import {LoaderError} from '../index.js';
import {createProjectIO, inspectZip} from '../project-codec.js';
import type {ArchiveLimits} from '../project-codec.js';

type Limits = ArchiveLimits & Required<Pick<ArchiveLimits, 'maxProjectBytes' | 'maxArchiveBytes'>>;

type ProjectIO = ReturnType<typeof createProjectIO>;

export interface OversizedProject {
    /** The bytes the project expands to, as the archive declares them, or the JSON's length. */
    bytes: number;
    /** The standard limit the project is over. */
    limit: number;
}

const DEFAULT_ARCHIVE_BYTES = 64 * 1024 * 1024;

const byteView = (input: unknown): Uint8Array | null => {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return null;
};

const passes = (run: () => unknown) => {
    try {
        run();
        return true;
    } catch {
        return false;
    }
};

/**
 * Measure a project input against the standard and ceiling limits.
 * @param input What `prepare` is given.
 * @param standard The limits a project is opened within unasked.
 * @param ceiling The limits no answer raises.
 * @returns The size to put to the person, or null when there is nothing to ask.
 */
export async function measureOversizedProject(input: unknown, standard: Limits, ceiling: Limits):
    Promise<OversizedProject | null> {
    const projectLimit = standard.maxProjectBytes;
    const archiveLimit = standard.maxArchiveBytes ?? DEFAULT_ARCHIVE_BYTES;
    if (typeof input === 'string') {
        if (!(input.length > projectLimit) || input.length > ceiling.maxProjectBytes) return null;
        return {bytes: input.length, limit: projectLimit};
    }
    let bytes = byteView(input);
    if (!bytes && typeof Blob === 'function' && input instanceof Blob) {
        if (input.size > ceiling.maxArchiveBytes) return null;
        bytes = new Uint8Array(await input.arrayBuffer());
    }
    if (!bytes) return null;
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        if (!(bytes.length > projectLimit) || bytes.length > ceiling.maxProjectBytes) return null;
        return {bytes: bytes.length, limit: projectLimit};
    }
    // The central directory says what each entry expands to; nothing is inflated to read it.
    const entries = (limits: Limits) => {
        const scanned = inspectZip(bytes, limits);
        const json = scanned.get('project.json');
        if (json && json.size > limits.maxProjectBytes) throw new RangeError('project.json is over its limit');
        return scanned;
    };
    if (passes(() => entries(standard))) return null;
    let scanned: ReturnType<typeof inspectZip>;
    try {
        scanned = entries(ceiling);
    } catch {
        return null;
    }
    let total = 0;
    for (const entry of scanned.values()) total += entry.size;
    return {bytes: Math.max(total, bytes.length), limit: Math.min(archiveLimit, standard.maxEntryBytes ?? archiveLimit)};
}

/**
 * Put a project IO behind the question.
 * @param io A project IO made with the ceiling limits.
 * @param options The standard and ceiling limits, and how to ask the person.
 * @returns The same IO, whose `prepare` asks first.
 */
export function gateProjectSize(io: ProjectIO, {standard, ceiling, confirm}: {
    standard: Limits;
    ceiling: Limits;
    confirm: (project: OversizedProject, signal?: AbortSignal) => Promise<boolean>;
}): ProjectIO {
    const prepare: ProjectIO['prepare'] = async (input, options = {}) => {
        const oversized = await measureOversizedProject(input, standard, ceiling);
        if (oversized) {
            let agreed = false;
            try {
                agreed = !options.signal?.aborted && await confirm(oversized, options.signal) === true;
            } catch {
                agreed = false;
            }
            if (options.signal?.aborted) throw new LoaderError('CANCELLED', 'Project preparation cancelled');
            if (!agreed) throw new LoaderError('INVALID_ARCHIVE', 'Project exceeds the standard size limit');
        }
        return io.prepare(input, options);
    };
    return Object.freeze({...io, prepare});
}
