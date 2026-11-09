/**
 * Adding, configuring and removing a project's extensions, serialized against the VM.
 *
 * The host that installs the Loader on a VM makes one of these and keeps it in the map below; the
 * host's extension screens read it back through `getExtensionAuthoringHost`. Moved here from the
 * TurboWarp Plus Editor, which had it from the fork's `src/lib/tw-plus-extension-authoring.js`.
 */

/* global AggregateError */
import {createProjectUUID, prepareExtensionAddition} from '../project-authoring.js';
import {
    prepareCatalogExtensionChanges, readProjectAuthoringState
} from '../project-catalog.js';

import {withProjectSerialization} from './serialization-context.js';
import {createProjectAddresser} from './project-address.js';

import type {AuthoringPorts} from '../project-authoring.js';
import type {LoaderOptions, DiagnosticEvent} from '../index.js';
import type {ZipConstructor} from '../project-codec.js';
import type {ScratchVM} from './vm.js';

// The preparation functions and their results belong to the Loader's authoring and catalog modules,
// which this controller hands through without reading their insides.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Port = any;
type Operation = {controller: AbortController};
type ApplyOptions = {signal?: AbortSignal; onPrepared?: (preview: unknown) => void};
const describe = (error: unknown) => (error ?? {}) as {code?: string; message?: string; extensionId?: string; committed?: boolean};

const hosts = new WeakMap<object, ReturnType<typeof createExtensionAuthoringController>>();
const failure = (code: string, message: string) => Object.assign(new Error(message), {code});

/**
 * Keep project mutations outside the presentation layer and inside the active host.
 * @param {object} vm The VM owned by this host.
 * @returns {object} The serialized authoring lifecycle.
 */
export const createExtensionAuthoringController = (vm: ScratchVM, {
    ports, diagnostics = () => {}, prepareAddition = prepareExtensionAddition, zip, loaderOptions,
    // What the host accepts when reading a project's embedded extensions. The limits belong to the
    // distribution, so the host that installs this controller passes them in.
    archiveOptions = {},
    // Where the editor was opened (`location.origin`, no path). A project that gets its first
    // manifest here is given its default address under this origin; the editor entry reads it
    // from the page and passes it in, so nothing in here looks at `location`.
    origin, createUUID = createProjectUUID
}: {
    ports?: AuthoringPorts & {registrar?: ReturnType<typeof import('./registrar.js').createVMExtensionRegistrar>};
    diagnostics?: (event: DiagnosticEvent & {message?: string}) => void;
    prepareAddition?: Port;
    /** The JSZip the host bundles. */
    zip: ZipConstructor;
    loaderOptions?: LoaderOptions;
    archiveOptions?: object;
    origin?: string;
    createUUID?: () => string;
}) => {
    // Null where no address can be made: the origin is not HTTPS (see `project-address.ts`).
    const addressProject = createProjectAddresser(origin, createUUID);
    let revision = 0;
    let pending: Operation | null = null;
    let ownLoad = false;
    const ownInputs = new Set<unknown>();
    let disposed = false;
    const disposalListeners = new Set<() => void>();
    const changed = () => {
        revision++;
        if (pending && !ownLoad) pending.controller.abort();
    };
    vm.on('PROJECT_CHANGED', changed);
    const load = (bytes: unknown) => {
        // The diagnostics/metadata wrapper can defer the host's load-start callback. Claim this
        // input now so a delayed callback neither cancels this operation nor changes its revision.
        revision++;
        ownInputs.add(bytes);
        ownLoad = true;
        try {
            return Promise.resolve(vm.loadProject(bytes)).finally(() => ownInputs.delete(bytes));
        } catch (error) {
            ownInputs.delete(bytes);
            throw error;
        } finally {
            ownLoad = false;
        }
    };
    return Object.freeze({
        projectLoadStarted (input: unknown) {
            if (!ownInputs.has(input)) changed();
        },
        onDispose (callback: () => void) {
            disposalListeners.add(callback);
            return () => disposalListeners.delete(callback);
        },
        async apply (request: Port, {signal, onPrepared = () => {}}: ApplyOptions = {}, prepare: Port = prepareAddition): Promise<Port> {
            if (disposed) throw failure('LOADER_DISPOSED', 'The extension host was disposed');
            if (pending) throw failure('PROJECT_BUSY', 'Another extension is being added');
            if (signal?.aborted) throw failure('CANCELLED', 'Extension addition cancelled');
            const operation: Operation = {controller: new AbortController()};
            pending = operation;
            const abort = () => operation.controller.abort();
            signal?.addEventListener('abort', abort, {once: true});
            const originalRevision = revision;
            let original: unknown;
            let appliedRevision: number | null = null;
            let legacy: Port;
            try {
                original = await vm.saveProjectSb3('arraybuffer');
                const assertCurrent = () => {
                    if (disposed || operation.controller.signal.aborted || revision !== originalRevision) {
                        throw failure('PROJECT_CHANGED', 'The project changed or extension addition was cancelled');
                    }
                };
                assertCurrent();
                let state: Port;
                const readState = async () => {
                    if (state === undefined) state = await readProjectAuthoringState(original, {zip, archiveOptions});
                    return state;
                };
                // A project is addressed when its manifest is first written: adding an extension,
                // or a catalog selection that keeps at least one. One that already has an address
                // keeps it, because the Loader keeps the current one when it is given none. A
                // selection that leaves nothing never introduces an address.
                const writesManifest = Array.isArray(request) ? request.length > 0 : true;
                let uri: string | undefined;
                if (addressProject && writesManifest) {
                    const current = await readState();
                    assertCurrent();
                    if (typeof current?.uri !== 'string') uri = addressProject();
                }
                // The Loader reports a failure of its own `load()`, but not one of preparing a
                // change, so the end of a fetch it was still retrying would go unsaid and the
                // waiting indicator would stay up. Say it here, in the event shape `load()` uses.
                let prepared: Port;
                try {
                    prepared = await prepare(original, request, ports,
                        {zip, signal: operation.controller.signal, loaderOptions,
                            archiveOptions, ...(uri === undefined ? {} : {uri})});
                } catch (error) {
                    try {
                        diagnostics({type: 'error', code: describe(error).code || 'LOAD_FAILED',
                            id: describe(error).extensionId, message: describe(error).message} as DiagnosticEvent);
                    } catch {
                        // A presentation failure must not change the operation's outcome.
                    }
                    throw error;
                }
                assertCurrent();
                onPrepared(prepared.spec || prepared.manifest);
                const oldManifest = prepared.manifest ? await readState() : null;
                assertCurrent();
                const priorIds = new Set((oldManifest?.extensions || []).map((spec: {id: string}) => spec.id));
                const legacyIds = (prepared.manifest?.extensions || []).map((spec: {id: string}) => spec.id)
                    .filter((id: string) => !priorIds.has(id) && vm.extensionManager.isExtensionLoaded(id));
                if (legacyIds.length) {
                    if (typeof ports?.registrar?.prepareLegacyReplacement !== 'function') {
                        throw failure('UNSUPPORTED_HOST', 'This VM cannot transfer existing extension ownership');
                    }
                    legacy = ports.registrar.prepareLegacyReplacement(legacyIds);
                }
                // The core has already obtained the host's approval for these exact bytes.
                const loading = load(prepared.projectBytes);
                appliedRevision = revision;
                await loading;
                if (disposed || operation.controller.signal.aborted || revision !== appliedRevision) {
                    throw failure('PROJECT_CHANGED', 'A different project was opened while adding the extension');
                }
                await legacy?.commit();
                // Only this serialized operation owns the legacy stage reference.
                // eslint-disable-next-line require-atomic-updates
                legacy = null;
                if (disposed || operation.controller.signal.aborted || revision !== appliedRevision) {
                    throw failure('PROJECT_CHANGED', 'The project changed while completing the extension update');
                }
                vm.emit('PROJECT_CHANGED');
                return prepared.spec || prepared.manifest;
            } catch (error) {
                if (describe(error).committed === true) {
                    // eslint-disable-next-line require-atomic-updates
                    legacy = null;
                    diagnostics({type: 'project-error', code: 'PROJECT_RECOVERY_REQUIRED', message: describe(error).message} as DiagnosticEvent);
                    throw Object.assign(error as Error, {code: 'PROJECT_RECOVERY_REQUIRED', originalProject: original});
                }
                // Never restore a stale snapshot over a newer project loaded by another caller.
                if (appliedRevision !== null && revision === appliedRevision && !disposed) {
                    const recovery = await Promise.resolve().then(async () => {
                        legacy?.rollback();
                        legacy = null;
                        await load(original);
                    })
                        .then(() => null, (cause: unknown) => ({cause}));
                    if (recovery) {
                        diagnostics({type: 'project-error',
                            code: 'PROJECT_RECOVERY_REQUIRED',
                            message: describe(recovery.cause).message} as DiagnosticEvent);
                        throw Object.assign(new AggregateError([error, recovery.cause],
                            'The original project could not be restored'), {code: 'PROJECT_RECOVERY_REQUIRED',
                            originalProject: original});
                    }
                } else if (legacy) {
                    await legacy.commit({allowMissingReplacement: true});
                    // eslint-disable-next-line require-atomic-updates
                    legacy = null;
                }
                throw error;
            } finally {
                signal?.removeEventListener('abort', abort);
                if (pending === operation) pending = null;
            }
        },
        add (request: Port, options?: ApplyOptions) {
            return this.apply(request, options);
        },
        configure (requests: Port, options?: ApplyOptions) {
            return this.apply(requests, options, prepareCatalogExtensionChanges);
        },
        async inspect () {
            if (disposed || pending) throw failure('PROJECT_BUSY', 'Wait for the active project operation');
            const current = revision;
            const input = await withProjectSerialization(vm, {preview: true}, () => vm.saveProjectSb3('arraybuffer'));
            const manifest = await readProjectAuthoringState(input, {zip, archiveOptions});
            if (current !== revision || disposed) {
                throw failure('PROJECT_CHANGED', 'The project changed during inspection');
            }
            return manifest;
        },
        dispose () {
            disposed = true;
            pending?.controller.abort();
            vm.off('PROJECT_CHANGED', changed);
            for (const callback of disposalListeners) callback();
            disposalListeners.clear();
        }
    });
};

export const setExtensionAuthoringHost = (vm: ScratchVM, authoring: ReturnType<typeof createExtensionAuthoringController> | null | undefined) => {
    if (authoring) hosts.set(vm, authoring);
    else hosts.delete(vm);
};

export const getExtensionAuthoringHost = (vm: ScratchVM) => hosts.get(vm);
