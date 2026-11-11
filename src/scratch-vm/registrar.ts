/**
 * Register a verified extension's code with the VM.
 *
 * This is the Loader's `registrar` port for a scratch-vm: the Loader core knows nothing about
 * Scratch, and whoever bundles a VM installs this. Moved here from the TurboWarp Plus Editor, which
 * had it from the fork's `src/lib/tw-plus-extension-registrar.js`.
 *
 * It reaches into VM internals on purpose — the registration tables, the extension manager and the
 * central dispatch service — and those have to be *the same module instances* the VM uses. So this
 * module imports none of them: they arrive as `vmModules` from the side that bundled the VM. In
 * an editor that is the GUI, which passes the instances it imported itself. In a distributed
 * single HTML the VM is a separate bundle, so the check below takes the service port it exposes.
 */

import {isAuthorizedCode, type AuthorizedCode} from '../index.js';
import type {ScratchVM, VMModules} from './vm.js';

// The VM modules this port needs, supplied by whoever bundles the VM. They are not imported here
// on purpose: `central-dispatch` is a singleton, and an import resolved from this repository would
// be a second copy of it, which is exactly the mismatch the service-port check below rejects. The
// editor's GUI passes its own instances through the integration; a built single HTML carries the
// ones its runtime bundle was built with.
const MODULES = ['ScratchCommon', 'createTranslate', 'staticFetch', 'dispatch'] as const;
interface RegistrarOptions {
    registrationTimeoutMs?: number;
    vmModules?: VMModules;
}
interface RegistrationRecord {
    id: string;
    object?: {getInfo(): {id: string}; dispose?(): void | Promise<void>};
    api?: ReturnType<typeof createScratchAPI>;
    worker?: number;
    service?: string;
    serviceOwned?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sandboxed?: any;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Provider = any;
type Task = () => unknown;

const error = (code: string, message: string) => Object.assign(new Error(message), {code});
const checkSignal = (signal?: AbortSignal) => {
    if (signal?.aborted) throw error('CANCELLED', 'Extension registration cancelled');
};

// These are the VM registration tables changed by _registerExtensionPrimitives.
const TABLES = ['_primitives', '_hats', '_flowing'];
const own = (object: object, name: string) => Object.prototype.hasOwnProperty.call(object, name);
// Do not nest an awaited cleanup catch inside a registration catch: Babel's
// webpack 4 lowering can rethrow the original error as a false cleanup failure.
const cleanupResult = (task: Task): Promise<{cause: unknown} | null> => Promise.resolve().then(task)
    .then(() => null, cause => ({cause}));

function extensionServicePort(vm: ScratchVM, dispatch: VMModules['dispatch']) {
    if (typeof vm.extensionManager.getExtensionServicePort === 'function') {
        const port = vm.extensionManager.getExtensionServicePort();
        if (port?.version !== 1 || ['set', 'get', 'remove'].some(name => typeof port[name] !== 'function')) {
            throw error('UNSUPPORTED_HOST', 'The VM extension service port is incompatible');
        }
        return port;
    }
    // An unmodified VM is supported only when it really shares this module cache.
    if (dispatch.services.runtime !== vm.runtime) {
        throw error('UNSUPPORTED_HOST', 'A separate VM bundle must expose its extension service port');
    }
    const owned = new Map();
    return Object.freeze({
        version: 1,
        set(name: string, provider: Provider) {
            if (own(dispatch.services, name)) throw error('ID_CONFLICT', 'Extension dispatch service is already in use');
            dispatch.setServiceSync(name, provider);
            owned.set(name, provider);
        },
        get(name: string) {
            if (!owned.has(name)) return undefined;
            if (dispatch.services[name] !== owned.get(name)) throw error('HOST_RECOVERY_REQUIRED', 'Owned dispatch service was replaced');
            return dispatch.services[name];
        },
        remove(name: string, provider: Provider) {
            if (!owned.has(name) || owned.get(name) !== provider ||
                (own(dispatch.services, name) && dispatch.services[name] !== provider)) {
                throw error('HOST_RECOVERY_REQUIRED', 'Owned dispatch service was replaced');
            }
            delete dispatch.services[name];
            owned.delete(name);
        }
    });
}

function assertHost(vm: ScratchVM) {
    const manager = vm?.extensionManager;
    const runtime = vm?.runtime;
    if (!manager || !runtime || !(manager._loadedExtensions instanceof Map) ||
        typeof manager._prepareExtensionInfo !== 'function' ||
        typeof manager.isBuiltinExtension !== 'function' ||
        typeof runtime._registerExtensionPrimitives !== 'function' ||
        typeof runtime.resetAllCaches !== 'function' ||
        !Array.isArray(runtime._blockInfo) || TABLES.some(name => !runtime[name])) {
        throw error('UNSUPPORTED_HOST', 'This VM does not expose the required registration lifecycle');
    }
}

/**
 * `self`, when given, is the extension object being registered: an extension may publish itself
 * at `runtime.ext_<id>` from its constructor (a deliberate handoff), which is not a conflict.
 */
function assertAvailable(vm: ScratchVM, id: string, self?: object) {
    const prefix = `${id}_`;
    if (vm.extensionManager.isBuiltinExtension(id) || vm.extensionManager._loadedExtensions.has(id) ||
        vm.runtime._blockInfo.some((category: {id: string}) => category.id === id) ||
        TABLES.some(name => Object.keys(vm.runtime[name]).some(key => key.startsWith(prefix))) ||
        (own(vm.runtime, `ext_${id}`) && (self === undefined || vm.runtime[`ext_${id}`] !== self))) {
        throw error('ID_CONFLICT', `Extension ID ${id} is already reserved or registered`);
    }
}

/** Preserve the VM runner's permission helpers without sharing global.Scratch. */
function createScratchAPI(vm: ScratchVM, register: (object: Provider) => void, {ScratchCommon, createTranslate, staticFetch}: VMModules) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Scratch: Record<string, any> = {...ScratchCommon, vm, renderer: vm.runtime.renderer,
        extensions: {unsandboxed: true, register}};
    const parseURL = (url: string) => {
        try { return new URL(url, typeof location === 'undefined' ? undefined : location.href); }
        catch { return null; }
    };
    Scratch.canFetch = async (url: string) => {
        const parsed = parseURL(url);
        if (!parsed) return false;
        if (parsed.protocol === 'blob:' || parsed.protocol === 'data:') return true;
        return vm.securityManager.canFetch(parsed.href);
    };
    for (const [name, method] of [['canOpenWindow', 'canOpenWindow'], ['canRedirect', 'canRedirect'],
        ['canEmbed', 'canEmbed']]) {
        Scratch[name] = async (url: string) => {
            const parsed = parseURL(url);
            if (!parsed || parsed.protocol === 'javascript:') return false;
            return vm.securityManager[method](parsed.href);
        };
    }
    for (const name of ['canRecordAudio', 'canRecordVideo', 'canReadClipboard', 'canNotify', 'canGeolocate']) {
        Scratch[name] = async () => vm.securityManager[name]();
    }
    Scratch.canDownload = async (url: string, name: string) => {
        const parsed = parseURL(url);
        if (!parsed || parsed.protocol === 'javascript:') return false;
        return vm.securityManager.canDownload(url, name);
    };
    Scratch.fetch = async (url: string | Request, options?: RequestInit) => {
        const actualURL = typeof Request !== 'undefined' && url instanceof Request ? url.url : url;
        const response = staticFetch(actualURL);
        if (response) return response;
        if (!await Scratch.canFetch(actualURL)) throw error('PERMISSION_DENIED', 'Extension fetch denied');
        return fetch(url, options);
    };
    Scratch.openWindow = async (url: string, features?: string) => {
        if (!await Scratch.canOpenWindow(url)) throw error('PERMISSION_DENIED', 'Extension window denied');
        return window.open(url, '_blank', features ? `noreferrer,${features}` : 'noreferrer');
    };
    Scratch.redirect = async (url: string) => {
        if (!await Scratch.canRedirect(url)) throw error('PERMISSION_DENIED', 'Extension redirect denied');
        location.href = url;
    };
    Scratch.download = async (url: string, name: string) => {
        if (!await Scratch.canDownload(url, name)) throw error('PERMISSION_DENIED', 'Extension download denied');
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
    };
    const before = new Set(vm.rawListeners('LOCALE_CHANGED'));
    Scratch.translate = createTranslate(vm);
    const added = vm.rawListeners('LOCALE_CHANGED').filter((listener: unknown) => !before.has(listener));
    // Preserve the host's existing Scratch.gui and other privileged API bridge.
    try { vm.emit('CREATE_UNSANDBOXED_EXTENSION_API', Scratch); }
    catch (cause) {
        for (const listener of added) vm.removeListener('LOCALE_CHANGED', listener);
        throw cause;
    }
    return {Scratch, dispose() {
        for (const listener of added) vm.removeListener('LOCALE_CHANGED', listener);
    }};
}

/**
 * Bind a verified Loader transaction to this VM. Only core-issued authorization
 * records reach evaluation. This boundary does not decide trust or fetch code.
 * Registration rollback cannot undo arbitrary privileged JavaScript side effects.
 */
export function createVMExtensionRegistrar(vm: ScratchVM, {registrationTimeoutMs = 30000, vmModules}: RegistrarOptions = {}) {
    assertHost(vm);
    if (!Number.isSafeInteger(registrationTimeoutMs) || registrationTimeoutMs < 1) {
        throw new TypeError('registrationTimeoutMs must be a positive integer');
    }
    // Say which one is missing rather than failing later inside an extension's own registration.
    const missing = MODULES.filter(name => !vmModules?.[name]);
    if (missing.length) {
        throw error('UNSUPPORTED_HOST', `The VM modules this registrar needs were not supplied: ${missing.join(', ')}`);
    }
    // Checked just above: every module is present.
    const modules = vmModules as VMModules;
    const manager = vm.extensionManager;
    const runtime = vm.runtime;
    const services = extensionServicePort(vm, modules.dispatch);
    const committed = new Map<string, RegistrationRecord>();
    let transaction: object | null = null;
    let poisoned = false;

    const release = async (record: RegistrationRecord) => {
        const failures: unknown[] = [];
        // Compiled/running threads may retain a reference to an extension method.
        try { runtime.stopAll(); } catch (cause) { failures.push(cause); }
        try { if (typeof record.object?.dispose === 'function') await record.object.dispose(); }
        catch (cause) { failures.push(cause); }
        record.api?.dispose();
        for (const name of TABLES) {
            for (const key of Object.keys(runtime[name])) {
                if (key.startsWith(`${record.id}_`)) delete runtime[name][key];
            }
        }
        runtime._blockInfo = runtime._blockInfo.filter((category: {id: string}) => category.id !== record.id);
        if (manager._loadedExtensions.get(record.id) === record.service) manager._loadedExtensions.delete(record.id);
        if (record.serviceOwned) {
            try { services.remove(record.service, record.object); }
            catch (cause) { failures.push(cause); }
        }
        if (record.sandboxed) {
            try { record.sandboxed.dispose(); }
            catch (cause) { failures.push(cause); }
        }
        if (runtime[`ext_${record.id}`] === record.object) delete runtime[`ext_${record.id}`];
        if (record.worker !== undefined && !record.sandboxed) delete manager.workerURLs[record.worker];
        if (runtime._monitorState && typeof runtime._monitorState.valueSeq === 'function') {
            for (const monitor of runtime._monitorState.valueSeq()) {
                if (String(monitor.opcode || '').startsWith(`${record.id}_`)) runtime.requestRemoveMonitor(monitor.id);
            }
        }
        runtime.resetAllCaches();
        if (failures.length) throw new AggregateError(failures, 'Extension cleanup failed');
    };

    async function evaluate(authorized: AuthorizedCode, signal?: AbortSignal): Promise<RegistrationRecord> {
        if (!isAuthorizedCode(authorized)) throw error('INVALID_AUTHORIZATION', 'Only Loader-issued authorization records may execute');
        checkSignal(signal);
        assertAvailable(vm, authorized.id);
        if (authorized.execution === 'sandboxed') {
            if (typeof services.loadSandboxed !== 'function') {
                throw error('UNSUPPORTED_HOST', 'This VM does not expose owned sandboxed registration');
            }
            const sandboxed = await services.loadSandboxed({id: authorized.id, code: authorized.code,
                signal, timeoutMs: registrationTimeoutMs});
            const record = {id: authorized.id, service: sandboxed.service, worker: sandboxed.workerId, sandboxed};
            try {
                checkSignal(signal);
                if (sandboxed.id !== authorized.id || sandboxed.info?.id !== authorized.id) {
                    throw error('REGISTRATION_ID_MISMATCH', 'Sandbox service ID differs from its Manifest');
                }
                assertAvailable(vm, authorized.id);
                const prepared = manager._prepareExtensionInfo(record.service, sandboxed.info);
                runtime._registerExtensionPrimitives(prepared);
                manager._loadedExtensions.set(record.id, record.service);
                runtime.resetAllCaches();
                return record;
            } catch (cause) {
                const cleanup = await cleanupResult(() => release(record));
                if (cleanup) {
                    poisoned = true;
                    throw new AggregateError([cause, cleanup.cause], 'Sandboxed registration and cleanup failed');
                }
                throw cause;
            }
        }
        if (authorized.execution !== 'unsandboxed') throw error('INVALID_EXECUTION', 'Unsupported execution mode');
        let settled = false;
        let count = 0;
        let resolveRegistered: (object: Provider) => void = () => {};
        let rejectRegistered: (cause: unknown) => void = () => {};
        let registrationError: unknown;
        const registered = new Promise((resolve, reject) => {
            resolveRegistered = resolve;
            rejectRegistered = reject;
        });
        // Synchronous throws can occur before this promise is awaited.
        registered.catch(() => {});
        const record: RegistrationRecord = {id: authorized.id};
        const register = (object: Provider) => {
            if (settled) throw error('REGISTRATION_CLOSED', 'Extension registration has ended');
            count++;
            if (count !== 1 || !object || typeof object.getInfo !== 'function') {
                registrationError = error('REGISTRATION_FAILED', 'Exactly one extension object must register');
                rejectRegistered(registrationError);
                return;
            }
            record.object = object;
            resolveRegistered(object);
        };
        record.api = createScratchAPI(vm, register, modules);
        const abort = () => rejectRegistered(error('CANCELLED', 'Extension registration cancelled'));
        const timer = setTimeout(() => rejectRegistered(error('REGISTRATION_TIMEOUT', 'Extension did not register')), registrationTimeoutMs);
        signal?.addEventListener('abort', abort, {once: true});
        try {
            // Lexical Scratch avoids the global runner's mutable shared API.
            const execute = new Function('Scratch', `"use strict";\n${authorized.code}`);
            execute(record.api.Scratch);
            await registered;
            if (registrationError) throw registrationError;
            checkSignal(signal);
            const info = record.object!.getInfo();
            if (info?.id !== authorized.id) throw error('REGISTRATION_ID_MISMATCH', 'Extension getInfo().id differs from its Manifest');
            // The pre-execute check guaranteed ext_<id> was absent, so only this object may hold it now.
            assertAvailable(vm, authorized.id, record.object);
            record.worker = manager.nextExtensionWorker++;
            record.service = `unsandboxed.${record.worker}.${record.id}`;
            services.set(record.service, record.object);
            record.serviceOwned = true;
            const prepared = manager._prepareExtensionInfo(record.service, info);
            runtime._registerExtensionPrimitives(prepared);
            manager._loadedExtensions.set(record.id, record.service);
            // Keep custom extension compiler behavior aligned with the VM runner.
            runtime.resetAllCaches();
            return record;
        } catch (cause) {
            const cleanup = await cleanupResult(async () => {
                if (record.service) await release(record);
                else {
                    try { if (typeof record.object?.dispose === 'function') await record.object.dispose(); }
                    finally {
                        record.api?.dispose();
                        // ext_<id> was absent before execute; remove it only if it is still this object.
                        if (record.object && runtime[`ext_${record.id}`] === record.object) delete runtime[`ext_${record.id}`];
                    }
                }
            });
            if (cleanup) {
                poisoned = true;
                throw new AggregateError([cause, cleanup.cause], 'Extension registration and cleanup failed');
            }
            throw cause;
        } finally {
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    }

    return Object.freeze({
        prepareLegacyReplacement(ids: readonly string[]) {
            if (typeof services.prepareLegacyReplacement !== 'function') {
                throw error('UNSUPPORTED_HOST', 'This VM cannot replace legacy extension registrations');
            }
            return services.prepareLegacyReplacement(ids);
        },
        async begin({signal}: {signal?: AbortSignal} = {}) {
            checkSignal(signal);
            if (poisoned) throw error('HOST_RECOVERY_REQUIRED', 'Recreate this VM after failed extension cleanup');
            if (transaction) throw error('BUSY', 'An extension registration transaction is already open');
            const records: RegistrationRecord[] = [];
            let closed = false;
            let registering = false;
            const current = {
                async register(authorized: AuthorizedCode, {signal: registrationSignal = signal}: {signal?: AbortSignal} = {}) {
                    if (closed || transaction !== current) throw error('REGISTRATION_CLOSED', 'Registration transaction has ended');
                    if (registering) throw error('BUSY', 'Extension registrations must be sequential');
                    registering = true;
                    try {
                        const record = await evaluate(authorized, registrationSignal);
                        records.push(record);
                        return {id: record.id};
                    } catch (cause) {
                        // The Loader reports registration failures without the ID; name it for the user, and
                        // keep why the registration was aborted (such as the Loader timing out).
                        if (cause !== null && typeof cause === 'object' && Object.isExtensible(cause)) {
                            const named = cause as {extensionId?: string; cause?: unknown};
                            if (!('extensionId' in named)) named.extensionId = authorized.id;
                            const aborted = registrationSignal?.aborted;
                            if (aborted && typeof named.cause === 'undefined') named.cause = registrationSignal!.reason;
                        }
                        throw cause;
                    } finally { registering = false; }
                },
                async commit({signal: commitSignal = signal}: {signal?: AbortSignal} = {}) {
                    checkSignal(commitSignal);
                    if (registering) throw error('BUSY', 'Wait for extension registration before commit');
                    if (closed || transaction !== current) throw error('REGISTRATION_CLOSED', 'Registration transaction has ended');
                    for (const record of records) committed.set(record.id, record);
                    closed = true;
                    transaction = null;
                },
                async rollback() {
                    if (registering) throw error('BUSY', 'Wait for extension registration before rollback');
                    const failures: unknown[] = [];
                    for (const record of [...records].reverse()) {
                        try { await release(record); committed.delete(record.id); }
                        catch (cause) { failures.push(cause); }
                    }
                    closed = true;
                    if (transaction === current) transaction = null;
                    if (failures.length) {
                        poisoned = true;
                        throw new AggregateError(failures, 'VM extension rollback failed');
                    }
                }
            };
            transaction = current;
            return current;
        },
        async unload(ids: readonly string[]) {
            if (transaction) throw error('BUSY', 'Cannot unload during an extension registration transaction');
            const failures: unknown[] = [];
            for (const id of ids) {
                const record = committed.get(id);
                if (!record) continue;
                try { await release(record); committed.delete(id); }
                catch (cause) { failures.push(cause); }
            }
            if (failures.length) {
                poisoned = true;
                throw new AggregateError(failures, 'VM extension unload failed');
            }
        }
    });
}
