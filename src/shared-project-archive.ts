/**
 * Lets a Loader build share its verified SB3 read with the rest of the host, so the VM and the
 * project tools do not parse the same archive again. Moved from the Plus Editor's
 * `site/extension-host/shared-project-archive.ts` (kubohiroya/turbowarp-plus-editor#741).
 */
// Optional port supplied by Loader builds that can share their verified SB3 read.
export interface ProjectArchive {
    readonly project: Record<string, unknown>;
    readonly projectBytes: number;
    readonly parserText?: string;
    openZip(): import('@turbowarp/jszip');
}

interface ArchiveRead {
    original?: ProjectArchive;
}

const originalReads = new WeakMap<object, ArchiveRead>();
const vmReads = new WeakMap<object, ProjectArchive>();

const zipView = (input: unknown) => {
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    return bytes instanceof Uint8Array && bytes[0] === 0x50 && bytes[1] === 0x4b ?
        new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : undefined;
};

export function beginProjectArchiveRead(vm: object, input: unknown) {
    if (typeof structuredClone !== 'function' || !zipView(input)) return;
    const read: ArchiveRead = {};
    return {
        read,
        invoke<T>(run: () => T): T {
            // The Loader captures the read synchronously before it queues the load.
            const previous = originalReads.get(vm);
            originalReads.set(vm, read);
            try { return run(); }
            finally {
                if (previous) originalReads.set(vm, previous);
                else originalReads.delete(vm);
            }
        }
    };
}

export const editorProjectArchives = {
    capture(vm: object) { return originalReads.get(vm); },
    async load<T>(input: unknown, archive: ProjectArchive | undefined, run: (input: unknown) => Promise<T>) {
        const view = archive && zipView(input);
        if (!view) return run(input);
        vmReads.set(view, archive);
        try { return await run(view); }
        finally { vmReads.delete(view); }
    }
};

export const reviewedProjectArchive = (input: unknown) => vmReads.get(input as object);

export function readPreparedVMProject(input: unknown) {
    const archive = reviewedProjectArchive(input);
    if (!archive) return;
    // Scratch validation and deserialization mutate the document they receive.
    const project = archive.parserText === undefined ? structuredClone(archive.project) : undefined;
    return {project, text: archive.parserText, zip: archive.openZip()};
}
