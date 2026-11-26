// SPDX-License-Identifier: MPL-2.0
import {createFetchPort, type ResolvedCode, type Manifest} from './index.js';
import {packagePlusHTML, packagerPageMessages, prepareOfflinePackage} from './packager.js';
import {createProjectIO, type ArchiveLimits, type ZipConstructor} from './project-codec.js';
import {createSessionTrustProvider, type SessionTrustOptions} from './session-trust.js';
import {createPackagerPageView} from './packager-page-view.js';

export interface PackagerPageOptions {
    document: Document;
    editorURL: string;
    zip: ZipConstructor;
    archiveOptions: ArchiveLimits & Record<string, number>;
    createPackager(): any;
    runtimeBundle: string;
    scaffoldingAssets: Record<string, string>;
    ui: {requestApproval: SessionTrustOptions['requestApproval']; diagnostics: (event: {type: string; [key: string]: unknown}) => void};
    trusted: {catalog: {isTrustedCode(code: ResolvedCode): Promise<boolean>}; listDigests(manifest: Manifest): Promise<string[]>};
    embedProjectData(bytes: Uint8Array, project: Record<string, unknown>): Promise<Uint8Array>;
    withBusy<T>(operation: () => Promise<T>): Promise<T>;
    withoutBusy<T>(operation: () => Promise<T>): Promise<T>;
}

export function mountPackagerPage(options: PackagerPageOptions) {
    const {document, zip: JSZip, archiveOptions: extensionProjectArchiveOptions, ui,
        trusted: plusTrustedExtensions, runtimeBundle: bundledRuntime, scaffoldingAssets: bundledAssets,
        embedProjectData: embedPackagedProjectData} = options;
    const window = document.defaultView!;
    const location = window.location;
    const URL = window.URL;
    const content = createPackagerPageView(document, options.editorURL);
    const text = packagerPageMessages('ja');
    const withWaitCursor = (_documents: Document[], operation: () => Promise<unknown>) => options.withBusy(operation);
    const withoutWaitCursor = (_document: Document, operation: () => Promise<boolean>) => options.withoutBusy(operation);
    let disposed = false;
    const status = document.querySelector<HTMLElement>('[data-testid="plus-package-status"]')!;
    const file = document.querySelector<HTMLInputElement>('[data-testid="plus-package-file"]')!;
    const generate = document.querySelector<HTMLButtonElement>('[data-testid="plus-package-generate"]')!;
    const storage = document.querySelector<HTMLSelectElement>('[data-testid="plus-package-storage"]')!;
    const resources = document.querySelector<HTMLInputElement>('[data-testid="plus-package-resources"]')!;
    const download = document.querySelector<HTMLAnchorElement>('[data-testid="plus-package-download"]')!;
    let input: unknown;
    let title = 'TurboWarp-Plus';
    let currentURL: string | undefined;
    let pending = false;
    const setInput = (bytes: unknown, name: unknown) => {
        if (pending || disposed) return;
        input = bytes;
        title = String(name || 'TurboWarp-Plus').replace(/\.sb3$/i, '');
        status.textContent = text.selected(title);
        generate.disabled = false;
        download.hidden = true;
    };
    const onFile = async () => {
        const selected = file.files?.[0];
        if (!selected || pending) return;
        generate.disabled = true;
        download.hidden = true;
        try {
            // The core checks Blob.size before reading or inflating the selected file.
            await withWaitCursor([document], () => createProjectIO({zip: JSZip, ...extensionProjectArchiveOptions}).prepare(selected));
            if (!disposed && file.files?.[0] === selected) setInput(selected, selected.name);
        } catch (caught) {
            const error = caught as Error & {code?: string};
            if (disposed || file.files?.[0] !== selected) return;
            input = null;
            status.textContent = text.readFailed(error);
        }
    };
    const onMessage = (event: MessageEvent) => {
        if (event.origin !== location.origin || event.source !== window.opener) return;
        const data = event.data && event.data.twPlusPackage;
        if (!data || data.type !== 'project' || !(data.bytes instanceof ArrayBuffer)) return;
        setInput(new Uint8Array(data.bytes), data.name);
    };
    if (window.opener) window.opener.postMessage({twPlusPackage: {type: 'ready'}}, location.origin);

    const onGenerate = async () => {
        if (disposed || pending) return;
        if (!input || !resources.checked) {
            status.textContent = text.chooseProject;
            return;
        }
        pending = true;
        generate.disabled = true;
        storage.disabled = true;
        download.hidden = true;
        try {
            await withWaitCursor([document], generateHTML);
        } finally {
            pending = false;
            storage.disabled = false;
            generate.disabled = false;
        }
    };

    async function generateHTML() {
        // What the host's catalog lists is trusted like TurboWarp's official gallery, as in the Editor.
        const trusted = plusTrustedExtensions.catalog;
        const trustProvider = createSessionTrustProvider({requestApproval: async (code, options) =>
            await trusted.isTrustedCode(code) || withoutWaitCursor(document, () => ui.requestApproval(code, options))});
        try {
            status.textContent = text.verifying;
            const io = createProjectIO({zip: JSZip, ...extensionProjectArchiveOptions});
            const prepared = await io.prepare(input);
            if (!prepared.manifest) throw new Error(text.noManifest);
            const resourceDependencies = Object.fromEntries(prepared.manifest.extensions.map(spec => [spec.id, [] as never[]]));
            // A transient failure is retried for a few seconds; say so instead of looking stuck. How
            // many attempts there are in all comes from the Loader, so this page does not have to know
            // the retry settings to say "2 of 3".
            const onRetry = ({url, attempt, attempts, delayMs}: {url: string; attempt: number; attempts: number; delayMs: number}) => {
                status.textContent = text.retrying(url, attempt + 1, attempts);
                ui.diagnostics({
                    type: 'retry',
                    attempt: attempt + 1,
                    attempts,
                    delayMs,
                    message: url
                });
            };
            const compiled = await prepareOfflinePackage(input, {
                fetcher: createFetchPort(window.fetch.bind(window), {onRetry}), trustProvider, diagnostics: ui.diagnostics
            }, {zip: JSZip, archiveOptions: extensionProjectArchiveOptions, resourceDependencies});
            const embeddedProjectData = storage.value === 'embedded-data';
            const projectBytes = embeddedProjectData ?
                await embedPackagedProjectData(compiled.projectBytes, compiled.project) : compiled.projectBytes;
            const runtimeBundle = bundledRuntime;
            const trustedDigests = await plusTrustedExtensions.listDigests(compiled.manifest);
            const packager = options.createPackager();
            packager.options.app.windowTitle = title;
            const result = await packagePlusHTML(packager, {...compiled, projectBytes},
                {runtimeBundle, scaffoldingAssets: bundledAssets, trustedDigests, embeddedProjectData,
                    archiveOptions: extensionProjectArchiveOptions});
            if (disposed) return;
            if (currentURL) URL.revokeObjectURL(currentURL);
            currentURL = URL.createObjectURL(new Blob([result.data], {type: 'text/html'}));
            download.href = currentURL;
            download.download = `${title}.html`;
            download.hidden = false;
            status.textContent = text.generated(trustedDigests.length === compiled.manifest.extensions.length);
        } catch (caught) {
            const error = caught as Error & {code?: string};
            status.textContent = text.refused(error);
            ui.diagnostics({type: 'error', code: error.code, message: error.message});
        } finally {
            trustProvider.revokeAll();
        }
    }

    file.addEventListener('change', onFile);
    window.addEventListener('message', onMessage);
    generate.addEventListener('click', onGenerate);
    const dispose = () => {
        disposed = true;
        file.removeEventListener('change', onFile);
        window.removeEventListener('message', onMessage);
        generate.removeEventListener('click', onGenerate);
        window.removeEventListener('pagehide', dispose);
        if (currentURL) URL.revokeObjectURL(currentURL);
        content.dispose();
    };
    window.addEventListener('pagehide', dispose, {once: true});
    return {dispose};
}
