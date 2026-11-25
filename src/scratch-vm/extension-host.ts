// SPDX-License-Identifier: MPL-2.0
import {createExtensionLoader, createFetchPort} from '../index.js';
import type {DiagnosticEvent, FetchRetryOptions, LoaderOptions, LoaderPorts, Manifest, ResolvedCode} from '../index.js';
import {createMemoryContentCache} from '../memory-cache.js';
import {createProjectIO} from '../project-codec.js';
import type {ZipConstructor} from '../project-codec.js';
import {createSessionTrustProvider} from '../session-trust.js';
import type {SessionTrustOptions} from '../session-trust.js';
import type {createExtensionAuthoringController, createProjectAddresser, setExtensionAuthoringHost} from './index.js';
import {createVMExtensionRegistrar, installExtensionLoader} from './runtime.js';
import type {ProjectLoaderHost, ScratchVM, VMModules} from './runtime.js';

export interface HostDiagnostic extends DiagnosticEvent {
    message?: string; delayMs?: number; attempt?: number; attempts?: number;
    execution?: string; source?: {url?: string; path?: string};
}
interface PayloadHost {dispose(): void}
interface ReviewChannelPort {
    decisions: ReadonlyMap<string, {execution: string; loading?: string}> | null;
}
interface PermissionUI {
    requestApproval: SessionTrustOptions['requestApproval'];
    diagnostics(event: HostDiagnostic): void;
    dispose(): void;
}
interface HostConnections<Channel extends ReviewChannelPort> {
    zip: ZipConstructor;
    createPermissionUI(document: Document, locale: string, options: {
        showDiagnostics: boolean; onDiagnostic?: (event: HostDiagnostic) => void;
    }): PermissionUI;
    openReview(vm: object, manifest: Manifest, read: (path: string) => Promise<Uint8Array>): Channel;
    closeReview(vm: object, channel: Channel): void;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * What a distributed single HTML trusts: only code whose actual bytes match a digest its build
 * embedded. It cannot read the catalog, because its own CSP forbids the connection, so the
 * decision this build already made travels with it as these digests.
 * @param {string[]} digests The digests embedded when the HTML was built.
 * @returns {object} Trust checks of the shape the Loader expects.
 */
const digestTrustedCatalog = (digests: string[] | undefined) => {
    const listed = new Set((Array.isArray(digests) ? digests : []).filter(digest => SHA256.test(digest)));
    return Object.freeze({
        isTrustedURL: () => Promise.resolve(false),
        isTrustedCode: (code: ResolvedCode) => Promise.resolve(listed.has(code.actualSHA256))
    });
};

interface TrustCatalog {
    isTrustedURL(url: string): Promise<boolean>;
    isTrustedCode(code: ResolvedCode): Promise<boolean>;
}
export interface ExtensionHostOptions {
    enabled?: boolean;
    document?: Document;
    locale?: string;
    getLocale?: () => string | undefined;
    fetchImpl?: typeof fetch;
    cache?: LoaderPorts['cache'];
    requestApproval?: SessionTrustOptions['requestApproval'];
    canLoadVerifiedCode?: SessionTrustOptions['canLoadVerifiedCode'];
    diagnostics?: (event: HostDiagnostic) => void;
    loaderOptions?: LoaderOptions;
    hostPolicy?: Parameters<typeof createSessionTrustProvider>[0]['hostPolicy'];
    trustedCatalog?: TrustCatalog | null;
    trustedDigests?: string[];
    fetchRetry?: FetchRetryOptions;
    markLoadFailure?: (error: unknown) => unknown;
    archiveOptions?: Parameters<typeof createProjectIO>[0];
    /** Puts the project IO behind a question before it reads a project (the Editor's size check). */
    gateProjectIO?: (io: ReturnType<typeof createProjectIO>) => ReturnType<typeof createProjectIO>;
    vmModules?: VMModules;
    createAuthoring?: typeof createExtensionAuthoringController;
    setAuthoringHost?: typeof setExtensionAuthoringHost;
    onProjectURI?: (uri: string | undefined) => void;
    addressProject?: ReturnType<typeof createProjectAddresser>;
    onProjectManifest?: (manifest: unknown) => void;
    captureProjectProgress?: ProjectLoaderHost['captureProjectProgress'];
    projectArchives?: ProjectLoaderHost['projectArchives'];
    runProjectLoad?: <T>(run: () => Promise<T>) => Promise<T>;
    waitForUser?: <T>(ask: () => T) => Promise<Awaited<T>>;
    createPayloads?: (ports: {fetch: typeof fetch; cache: LoaderPorts['cache'];
        validate: ReturnType<typeof createProjectIO>['prepare']}) => PayloadHost;
    showDiagnostics?: boolean;
}

/** Own the VM host lifecycle while the distribution supplies its UI and review connections. */
export function createScratchVMExtensionHost<Channel extends ReviewChannelPort>({zip: JSZip,
    createPermissionUI, openReview, closeReview}: HostConnections<Channel>) {
    /** Host-controlled wiring shared by the Editor and the bundled HTML runtime. */
    function installPlusExtensionHost (vm: ScratchVM, {
        enabled = false, document = globalThis.document, locale = 'ja', getLocale, fetchImpl = globalThis.fetch,
        cache, requestApproval, canLoadVerifiedCode, diagnostics: report, loaderOptions, hostPolicy,
        trustedCatalog = null, trustedDigests,
        fetchRetry, markLoadFailure, archiveOptions = {}, gateProjectIO, vmModules, createAuthoring, setAuthoringHost,
        onProjectURI, addressProject, onProjectManifest, captureProjectProgress, projectArchives, runProjectLoad, waitForUser,
        createPayloads, showDiagnostics = true
    }: ExtensionHostOptions = {}) {
        if (enabled !== true) return Object.freeze({enabled: false, dispose: async () => {}});
        // A single HTML has no catalog to read; its build embeds the digests the catalog listed.
        const trusted = trustedCatalog === null && Array.isArray(trustedDigests) ?
            digestTrustedCatalog(trustedDigests) : trustedCatalog;
        const createUI = (language: string) => createPermissionUI(document, language, {showDiagnostics, onDiagnostic: report});
        let uiLocale = getLocale?.() ?? locale;
        let ui = createUI(uiLocale);
        let uiDisposed = false;
        const disposeUI = () => {
            uiDisposed = true;
            ui.dispose();
        };
        const permissionUI = () => {
            const nextLocale = getLocale?.() ?? locale;
            if (!uiDisposed && nextLocale !== uiLocale) {
                ui.dispose();
                uiLocale = nextLocale;
                ui = createUI(uiLocale);
            }
            return ui;
        };
        const diagnostics = (event: HostDiagnostic) => {
            permissionUI().diagnostics(event);
        };
        // The Loader reports the retry it is about to wait for, and how many attempts this fetch can
        // make in all; the attempt the wait leads to is the next one. Counting them here from the retry
        // settings is what this used to do, and it was wrong whenever a caller passed its own.
        const onRetry: NonNullable<FetchRetryOptions['onRetry']> = ({url, attempt, attempts, delayMs}) => diagnostics({
            type: 'retry',
            attempt: attempt + 1,
            attempts,
            delayMs,
            message: url
        });
        const readerIO = createProjectIO({zip: JSZip, ...archiveOptions});
        const projectIO = gateProjectIO ? gateProjectIO(readerIO) : readerIO;
        const request: SessionTrustOptions['requestApproval'] = requestApproval ||
            ((code, options) => permissionUI().requestApproval(code, options));
        const approve: typeof request = (code, options) =>
            waitForUser ? waitForUser(() => request(code, options)) : request(code, options);
        // What the open review answered for the load in progress. The Loader asks about each row only
        // after the review has, so its approval is read from here instead of being put to the person a
        // second time; a row the review did not answer still gets the dialog.
        let reviewed: Channel['decisions'] = null;
        const answered = (code: ResolvedCode) => {
            const decision = reviewed && reviewed.get(code.id);
            if (!decision) return undefined;
            if (decision.execution === 'deny') return false;
            // The Loader runs a row the way its author asked. In the sandbox is within either answer;
            // outside it only within an answer that allows that, so a person who chose the sandbox for
            // a row its author runs outside does not have it run there.
            return code.execution === 'sandboxed' || decision.execution === 'unsandboxed';
        };
        const sessionTrust = createSessionTrustProvider({hostPolicy, canLoadVerifiedCode,
            // Catalog-listed code is trusted like TurboWarp's official gallery and needs no separate approval.
            requestApproval: async (code, options) => {
                if (trusted !== null && await trusted.isTrustedCode(code)) return true;
                const answer = answered(code);
                return answer === undefined ? approve(code, options) : answer;
            }});
        // The session remembers an approval for the rest of the visit, but what the person answers on
        // this load's review is newer than anything it remembers: a refusal there is a refusal now,
        // even for code an earlier load was allowed to run.
        let authoring: ReturnType<typeof createExtensionAuthoringController> | null = null;
        const hasURLPolicy = Boolean(hostPolicy?.canLoadExtensionFromProject || hostPolicy?.getSandboxMode);
        const locallyApproved = (spec: Manifest['extensions'][number] | ResolvedCode) =>
            !hasURLPolicy && authoring?.isDevelopmentBuildApproved(spec) === true;
        const trustProvider: typeof sessionTrust = Object.freeze({
            ...sessionTrust,
            async authorize (code: ResolvedCode, options?: {signal?: AbortSignal}) {
                if (answered(code) === false) return {allowed: false};
                if (locallyApproved(code)) {
                    options?.signal?.throwIfAborted();
                    if (canLoadVerifiedCode && !(await canLoadVerifiedCode(code, options ?? {}))) return {allowed: false};
                    options?.signal?.throwIfAborted();
                    if (locallyApproved(code)) return {allowed: true, scope: 'digest' as const, sha256: code.actualSHA256};
                }
                return sessionTrust.authorize(code, options);
            }
        });
        /**
         * Put a load's Plus rows in front of the person on the review that asks about its other
         * extensions, and turn the answer into what the Loader takes.
         * @param {object} manifest The project's Plus manifest.
         * @param {Function} run Loads the project's other extensions, which is when the review asks.
         * @param {AbortSignal} signal The current project load's cancellation signal.
         * @returns {Promise<object>} `declineCaching` for `load()`, and `release` once it settles.
         */
        const review = async (manifest: Manifest, run: () => Promise<unknown>, signal: AbortSignal) => {
            const channel = openReview(vm, {...manifest, extensions: manifest.extensions.filter(spec => !locallyApproved(spec))}, path =>
                projectIO.embeddedReader.read(path, {signal, maxBytes: loaderOptions?.maxBytes}));
            try {
                await run();
            } finally {
                closeReview(vm, channel);
            }
            const decisions = channel.decisions;
            reviewed = decisions;
            // The opener can only decline a copy the author allowed; any other form stays as written.
            const declineCaching = new Set<string>(decisions ? manifest.extensions
                .filter(spec => spec.source.type === 'remote-cacheable' &&
                    decisions.get(spec.id)?.loading === 'remote-non-cacheable')
                .map(spec => spec.id) : []);
            return {declineCaching, release: () => { if (reviewed === decisions) reviewed = null; }};
        };
        const ports = {
            embeddedReader: projectIO.embeddedReader,
            fetcher: createFetchPort(fetchImpl, {...fetchRetry, onRetry}),
            cache: cache || createMemoryContentCache(),
            trustProvider,
            registrar: createVMExtensionRegistrar(vm, {vmModules, checkSandboxedInterface: createAuthoring ?
                (code, signature) => authoring?.checkDevelopmentInterface(code, signature) : undefined}),
            diagnostics
        };
        const loader = createExtensionLoader(ports, loaderOptions);
        const payloads = createPayloads?.({fetch: fetchImpl, cache: ports.cache, validate: projectIO.prepare});
        // A player built as a single HTML has no library to add an extension from, so its entry
        // supplies no controller: passing the factory in rather than importing it here is what keeps
        // the controller, and everything it pulls in, out of that bundle.
        authoring = typeof createAuthoring === 'function' ?
            createAuthoring(vm, {ports, diagnostics, loaderOptions, archiveOptions, zip: JSZip}) : null;
        let uninstall: ReturnType<typeof installExtensionLoader>;
        try {
            uninstall = installExtensionLoader({vm, projectIO, transactionalRegistration: true,
                onDiagnostic: diagnostics, markFailure: markLoadFailure, review, onProjectURI,
                addressProject: addressProject ?? undefined, onProjectManifest,
                captureProjectProgress, projectArchives, payloads, runProjectLoad,
                onProjectLoadStart: authoring ? authoring.projectLoadStarted : undefined}, loader);
        } catch (error) {
            authoring?.dispose();
            payloads?.dispose();
            disposeUI();
            trustProvider.revokeAll();
            throw error;
        }
        if (authoring) setAuthoringHost!(vm, authoring);
        let disposal: Promise<unknown> | undefined;
        return Object.freeze({
            enabled: true, loader, projectIO, authoring, payloads,
            dispose () {
                if (!disposal) {
                    if (authoring) setAuthoringHost!(vm, null);
                    authoring?.dispose();
                    payloads?.dispose();
                    disposeUI();
                    trustProvider.revokeAll();
                    disposal = Promise.resolve(uninstall()).then(() => loader.unload());
                }
                return disposal;
            }
        });
    }

    return installPlusExtensionHost;
}
