/**
 * The bridge that puts this loader in front of the VM's project lifecycle.
 *
 * It touches no GUI module: everything it needs about the VM arrives as `host.vm`, and marking a
 * failure as an extension failure — the host's own bookkeeping, read by its project-error paths —
 * arrives as `host.markFailure`. Moved here from the TurboWarp Plus Editor, which had it from the
 * fork's `src/lib/tw-plus-project-loader.js`.
 *
 * Whether opening again could end differently is asked of the Loader here, the one place that
 * holds the error, and travels on the `project-error` diagnostic as `retryable` for whatever
 * screen states the failure.
 */

import {isWorthAskingAgain, validateManifest, type Manifest, type OperationOptions} from '../index.js';
import type {ScratchVM} from './vm.js';

import {projectSerializationOptions} from './serialization-context.js';

const isScratch1Project = (input: unknown) => {
    const header = input instanceof ArrayBuffer ? new Uint8Array(input, 0, Math.min(10, input.byteLength)) :
        input instanceof Uint8Array ? input.subarray(0, 10) : null;
    return header && /^ScratchV0[12]$/.test(String.fromCharCode(...header));
};

// The host's own ports are passed through without being read here, so they keep the host's types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Port = any;
type Stage = 'archive' | 'payloads' | 'project' | 'extensions';
type Answer = {declineCaching?: ReadonlySet<string>; release(): void};

/** What the bridge needs from the host that bundles the VM. */
export interface ProjectLoaderHost {
    vm: ScratchVM;
    /** The Loader's project codec, from `createProjectIO`. */
    projectIO: Port;
    /** Must be true: only a transactional registrar can undo a failed load. */
    transactionalRegistration: true;
    payloads?: Port;
    projectArchives?: Port;
    onProjectURI?(uri: string | undefined): void;
    addressProject?(): string | null | undefined;
    captureProjectProgress?(): ((stage: Stage) => void) | undefined;
    onProjectLoadStart?(input: unknown): void;
    onProjectManifest?(manifest: Manifest | null): void;
    onDiagnostic?(event: {type: 'project-error'; code: string; message: string; retryable: boolean}): void;
    runProjectLoad?<T>(run: () => Promise<T>): Promise<T>;
    markFailure?(error: unknown): unknown;
    review?(manifest: Manifest, loadOthers: () => Promise<unknown>, signal: AbortSignal): Promise<Answer>;
}
/** What the bridge uses of the Loader (`createExtensionLoader`): loading a manifest, and unloading. */
export interface ProjectExtensionLoader {
    load(manifest: Manifest, options?: OperationOptions): Promise<{readonly ids: readonly string[]}>;
    unload(): Promise<unknown>;
}
interface Loading {
    manifest: Manifest | null;
    signal: AbortSignal;
    loaded: boolean;
    registration: Promise<{readonly ids: readonly string[]}> | null;
    progress?: (stage: Stage) => void;
}
const describe = (error: unknown) => error as {code?: string; message?: string};

/** An edit of the open project's address: its current value, and how to change it. */
export interface ProjectURIEdit {
    uri: string;
    apply(value: string): Promise<string | undefined>;
}
const installations = new WeakMap<object, () => ProjectURIEdit>();

/** Open a URI edit for the project currently in this VM. */
export const editProjectURI = (vm: ScratchVM) => installations.get(vm)?.();

const failure = (code: string, message: string) => Object.assign(new Error(message), {code});

/**
 * Stage a GUI bridge around a host with transactional extension registration.
 * Project decoding, validation, persistence and trust belong to the Loader core.
 * This is deliberately not installed automatically on an arbitrary Scratch VM.
 */
export function installExtensionLoader(host: ProjectLoaderHost, loader: ProjectExtensionLoader) {
    const vm = host?.vm;
    const io = host?.projectIO;
    const payloads = host?.payloads;
    if (host?.transactionalRegistration !== true || !vm || !io ||
        ['loadProject', '_loadExtensions', 'toJSON', '_saveProjectZip', 'saveProjectSb3DontZip']
            .some(name => typeof vm[name] !== 'function') ||
        ['prepare', 'restoreJSON', 'restoreFiles', 'restoreArchive'].some(name => typeof io[name] !== 'function') ||
        !loader || typeof loader.load !== 'function' || typeof loader.unload !== 'function') {
        throw failure('UNSUPPORTED_HOST', 'A transactional registrar and Loader project codec are required');
    }
    if (installations.has(vm)) throw failure('ALREADY_INSTALLED', 'The Loader bridge is already installed');

    const originals: Record<string, Port> = Object.fromEntries(
        ['loadProject', '_loadExtensions', 'toJSON', '_saveProjectZip', 'saveProjectSb3DontZip']
            .map(name => [name, vm[name]])
    );
    const descriptors = Object.fromEntries(Object.keys(originals).map(name => [name,
        Object.getOwnPropertyDescriptor(vm, name)]));
    for (const descriptor of Object.values(descriptors)) {
        if (descriptor && (!Object.hasOwn(descriptor, 'value') || !descriptor.writable)) {
            throw failure('UNSUPPORTED_HOST', 'VM lifecycle hooks must be writable data properties');
        }
        if (!descriptor && !Object.isExtensible(vm)) {
            throw failure('UNSUPPORTED_HOST', 'VM lifecycle hooks cannot be installed on this host');
        }
    }
    let disposed = false;
    let pending = 0;
    let queue = Promise.resolve();
    let loading: Loading | null = null;
    let savedContext: Port = null;
    // The address of the project open now, as its manifest names it, or undefined: none, or no
    // manifest. The host is told each time it changes, which is how the cache knows whose bucket
    // a fetched extension is filed under.
    let projectURI: string | undefined;
    let activeController: AbortController | null = null;
    let hasLoaded = false;
    let drain: Promise<void> | null = null;

    const checkActive = () => {
        if (disposed) throw failure('LOADER_DISPOSED', 'The Loader bridge was disposed');
    };
    const canSave = () => {
        checkActive();
        if (pending) throw failure('PROJECT_BUSY', 'Wait for project loading to finish before saving');
    };
    const tellProjectURI = (uri: string | undefined) => {
        projectURI = uri;
        if (typeof host.onProjectURI === 'function') {
            try {
                host.onProjectURI(uri);
            } catch {
                // Bookkeeping must not change the loading or saving decision.
            }
        }
    };
    const editURI = (): ProjectURIEdit => {
        const projectLoad = queue;
        const assertSameProject = () => {
            canSave();
            if (projectLoad !== queue) throw failure('PROJECT_CHANGED', 'The project changed while editing its URI');
        };
        return {
            uri: projectURI ?? '',
            async apply(value: string) {
                assertSameProject();
                const manifest = validateManifest({schemaVersion: 1, uri: value.trim(), extensions: []});
                const {uri} = manifest;
                if (uri === projectURI) return uri;
                const previous = savedContext;
                // Explicitly identifying a regular project gives it an empty Plus manifest.
                // The codec merges it with the live project when the VM serializes it.
                const next = previous === null ? (await io.prepare({turboWarpPlus: manifest})).context :
                    io.assignProjectURI(previous, uri, {replace: true});
                assertSameProject();
                if (savedContext !== previous) throw failure('PROJECT_CHANGED', 'The project URI changed while editing');
                savedContext = next;
                tellProjectURI(uri);
                vm.runtime?.emitProjectChanged?.();
                return uri;
            }
        };
    };
    /**
     * The context a whole-project save restores, given its address first if it has none yet.
     *
     * A project opened with a manifest but no address gets one on its first serialization, kept in
     * `savedContext` so every later save carries the same one. One that has an address keeps it,
     * a project without a manifest gets nothing, and neither does a host that makes no address
     * (an editor not opened over HTTPS, or a built HTML, which supplies no `addressProject`).
     * @returns {object|null} The context to restore with.
     */
    const contextForSave = () => {
        if (projectSerializationOptions(vm)?.preview || savedContext === null || projectURI !== undefined || typeof host.addressProject !== 'function' ||
            typeof io.assignProjectURI !== 'function') return savedContext;
        const uri = host.addressProject();
        if (typeof uri !== 'string') return savedContext;
        savedContext = io.assignProjectURI(savedContext, uri);
        tellProjectURI(uri);
        return savedContext;
    };
    const restored = (value: Port) => {
        if (value === null || value === undefined || typeof value.then === 'function') {
            throw failure('INVALID_PROJECT_CODEC', 'Project persistence must return a synchronous result');
        }
        return value;
    };
    const loadProject = function(input: unknown, ...args: unknown[]) {
        checkActive();
        const progress = host.captureProjectProgress?.();
        const archive = host.projectArchives?.capture(vm);
        if (host.onProjectLoadStart) host.onProjectLoadStart(input);
        payloads?.loadStarted();
        pending++;
        const run = async () => {
            checkActive();
            const controller = new AbortController();
            activeController = controller;
            let touchedHost = false;
            try {
                if (archive) progress?.('archive');
                const options = {signal: controller.signal, shareArchive: Boolean(archive)};
                // Scratch 1 is a binary project format handled by the VM's native converter.
                let prepared: Port = isScratch1Project(input) ?
                    {input, manifest: null, context: null, originalArchive: undefined, vmArchive: undefined} :
                    archive ? await io.prepare(input, options) : null;
                if (archive) archive.original = prepared.originalArchive;
                if (payloads) progress?.('payloads');
                const restoredPayloads = payloads ? await payloads.read(input, controller.signal, archive?.original) : null;
                const restoredInput = restoredPayloads?.input ?? input;
                if (!prepared || restoredInput !== input) {
                    progress?.('archive');
                    prepared = await io.prepare(restoredInput, options);
                }
                checkActive();
                if (!prepared || !Object.hasOwn(prepared, 'manifest') || !Object.hasOwn(prepared, 'input')) {
                    throw failure('INVALID_PROJECT_CODEC', 'The Loader project codec returned no project');
                }
                // Optional presentation receives the manifest; it makes no authorization decision.
                try { host.onProjectManifest?.(prepared.manifest); } catch { /* Keep loading independent of diagnostics. */ }
                touchedHost = true;
                savedContext = null;
                // Known before the VM loads, so what the Loader fetches for it is filed under it.
                tellProjectURI(typeof prepared.manifest?.uri === 'string' ? prepared.manifest.uri : undefined);
                if (hasLoaded) {
                    await loader.unload();
                    hasLoaded = false;
                }
                checkActive();
                const context = prepared.context ?? null;
                if (io.activate) io.activate(context);
                loading = {manifest: prepared.manifest, signal: controller.signal, loaded: false, registration: null, progress};
                progress?.('project');
                const runVM = (projectInput: unknown) => originals.loadProject.call(vm, projectInput, ...args);
                const result = await (archive ? host.projectArchives.load(prepared.input, prepared.vmArchive, runVM) :
                    runVM(prepared.input));
                checkActive();
                // A VM that never invokes the extension hook cannot load Plus projects.
                if (prepared.manifest !== null && !loading!.loaded) {
                    throw failure('UNSUPPORTED_HOST', 'The VM did not invoke its extension loading hook');
                }
                savedContext = context;
                if (restoredPayloads) {
                    await payloads.loaded(restoredPayloads, controller.signal);
                    checkActive();
                }
                return result;
            } catch (error) {
                if (typeof host.onDiagnostic === 'function') {
                    try {
                        host.onDiagnostic({type: 'project-error', code: describe(error).code || 'LOAD_FAILED',
                            message: String(describe(error).message), retryable: isWorthAskingAgain(error)});
                    } catch {
                        // A presentation failure must not change the loading decision.
                    }
                }
                if (touchedHost) {
                    savedContext = null;
                    payloads?.clear();
                }
                if (touchedHost && hasLoaded) {
                    await loader.unload();
                    hasLoaded = false;
                }
                throw error;
            } finally {
                loading = null;
                activeController = null;
            }
        };
        const result = queue.then(() => host.runProjectLoad ? host.runProjectLoad(run) : run());
        queue = result.catch(() => {});
        return result.finally(() => { pending--; });
    };

    // An editor reports extension failures instead of treating them as a broken editor. Marking is
    // the host's bookkeeping, so it is the host that hands the marker in; with none, the error still
    // propagates unchanged and is reported as an ordinary project failure.
    const markFailure = typeof host.markFailure === 'function' ? host.markFailure : (error: unknown) => error;
    const extensionStep = async <T>(step: () => T | Promise<T>): Promise<T> => {
        try {
            return await step();
        } catch (error) {
            throw markFailure(error);
        }
    };
    const loadExtensions = async function(ids: Iterable<string>, urls: Map<string, string> = new Map(), ...args: unknown[]) {
        checkActive();
        if (loading?.progress && [...ids].length) loading.progress('extensions');
        if (!loading || loading.manifest === null) {
            return extensionStep(() => originals._loadExtensions.call(vm, ids, urls, ...args));
        }
        const context = loading;
        const listed = new Set(context.manifest!.extensions.map(spec => spec.id));
        let othersLoaded = false;
        if (!context.registration && typeof host.review === 'function') {
            // Ask first, about everything: the review sees the Plus rows beside the project's other
            // extensions and answers once, before the Loader fetches or registers anything. The other
            // extensions load as that review's own step, so they are not loaded a second time below.
            const others = [...ids].filter(id => !listed.has(id));
            const otherURLs = new Map([...urls].filter(([id]) => !listed.has(id)));
            const answer = await extensionStep(() => host.review!(context.manifest!,
                () => originals._loadExtensions.call(vm, others, otherURLs, ...args), context.signal));
            checkActive();
            othersLoaded = true;
            context.registration = loader.load(context.manifest!,
                {signal: context.signal, declineCaching: answer.declineCaching});
            context.registration.then(answer.release, answer.release);
        }
        const registration = context.registration ??= loader.load(context.manifest!, {signal: context.signal});
        const result = await extensionStep(() => registration);
        hasLoaded = true;
        checkActive();
        if (!result || !Array.isArray(result.ids)) {
            throw failure('INVALID_LOADER_RESULT', 'The Loader returned no registered extension IDs');
        }
        context.loaded = true;
        if (othersLoaded) return undefined;
        const handled = new Set(result.ids);
        const remaining = [...ids].filter(id => !handled.has(id));
        const remainingURLs = new Map([...urls].filter(([id]) => !handled.has(id)));
        return extensionStep(() => originals._loadExtensions.call(vm, remaining, remainingURLs, ...args));
    };
    const toJSON = function(...args: unknown[]) {
        canSave();
        const json = originals.toJSON.apply(vm, args);
        // Standalone sprite export must not acquire a whole-project manifest, nor an address.
        if (savedContext === null || args[0]) return json;
        return restored(io.restoreJSON(json, contextForSave()));
    };
    const saveZip = function(...args: unknown[]) {
        canSave();
        const zip = originals._saveProjectZip.apply(vm, args);
        const archive = savedContext === null ? zip : restored(io.restoreArchive(zip, contextForSave()));
        return payloads?.active ? payloads.writeZip(archive) : archive;
    };
    const saveFiles = function(...args: unknown[]) {
        canSave();
        const files = originals.saveProjectSb3DontZip.apply(vm, args);
        return savedContext === null ? files : restored(io.restoreFiles(files, contextForSave()));
    };

    const wrappers = {loadProject, _loadExtensions: loadExtensions, toJSON,
        _saveProjectZip: saveZip, saveProjectSb3DontZip: saveFiles};
    const installed: string[] = [];
    try {
        for (const [name, wrapper] of Object.entries(wrappers)) {
            Object.defineProperty(vm, name, descriptors[name] ? {...descriptors[name], value: wrapper} :
                {value: wrapper, writable: true, configurable: true, enumerable: true});
            installed.push(name);
        }
    } catch (error) {
        disposed = true;
        for (const name of installed.reverse()) {
            if (descriptors[name]) Object.defineProperty(vm, name, descriptors[name]);
            else delete vm[name];
        }
        throw failure('UNSUPPORTED_HOST', `VM lifecycle hook installation failed: ${describe(error).message}`);
    }
    installations.set(vm, editURI);

    return () => {
        if (disposed) return drain;
        disposed = true;
        activeController?.abort();
        // Keep the guarded extension hook until in-flight VM loading has ended.
        drain = queue.then(async () => {
            // Removing persistence hooks while registrations remain would lose project data.
            if (hasLoaded) {
                await loader.unload();
                hasLoaded = false;
            }
            for (const [name, wrapper] of Object.entries(wrappers)) {
                if (vm[name] === wrapper) {
                    if (descriptors[name]) Object.defineProperty(vm, name, descriptors[name]);
                    else delete vm[name];
                }
            }
            installations.delete(vm);
        });
        return drain;
    };
}
