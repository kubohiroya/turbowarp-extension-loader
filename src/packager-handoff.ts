// SPDX-License-Identifier: MPL-2.0
import {createProjectIO, type ZipConstructor, type ArchiveLimits} from './project-codec.js';
export interface PackagerHandoffOptions<VM> {
    enabled: boolean;
    readProject?(buffer: ArrayBuffer): Promise<boolean>;
    zip: ZipConstructor;
    archiveOptions?: ArchiveLimits;
    page(): string;
    origin(): string;
    serialize(vm: VM): Promise<ArrayBuffer>;
    withBusy<T>(operation: () => Promise<T>): Promise<T>;
    reportError(error: unknown): void;
}
export type PackageWindow = {closed?: boolean; location: {href: string}; close(): void;
    postMessage(message: unknown, origin: string, transfer: Transferable[]): void};
export const createProjectPackager = <VM>({enabled, readProject, page, origin, serialize, withBusy, reportError, zip, archiveOptions}: PackagerHandoffOptions<VM>) => {
    if (!enabled) return null;
    readProject ??= async buffer => (await createProjectIO({zip, ...archiveOptions}).prepare(buffer)).manifest !== null;
    // The window being handed to, the bytes it has not asked for yet, and how to name them. The
    // name is read when the page asks, so it is the project's title at that moment.
    let pending: {window: PackageWindow; buffer: ArrayBuffer | null; name(): string} | null = null;
    return Object.freeze({
        /**
         * Take over a window the editor opened for the Packager button.
         *
         * The window is opened by the GUI during the user's gesture, before anything is serialized,
         * because a popup opened later would be blocked. A project that is not ours goes on to the
         * upstream Packager through the same window.
         * @param {object} context `popup`, `vm`, `name()` and `fallbackURL` from the GUI.
         * @returns {Promise<void>} Resolves once the window has been sent somewhere.
         */
        async open ({popup, vm, name, fallbackURL}: {popup: PackageWindow; vm: VM; name(): string; fallbackURL: string}) {
            try {
                await withBusy(async () => {
                    if (popup.closed) return;
                    const buffer = await serialize(vm);
                    if (popup.closed) return;
                    if (!await readProject(buffer)) {
                        popup.location.href = fallbackURL;
                        return;
                    }
                    pending = {window: popup, buffer, name};
                    popup.location.href = page();
                });
            } catch (error) {
                popup.close();
                reportError(error);
            }
        },
        /**
         * Claim a window that is already talking to the upstream Packager, when the project it
         * asked to import turns out to be ours.
         * @param {object} context `source`, `buffer`, `name()` and `cancelImport()` from the GUI.
         * @returns {Promise<boolean>} True when this window was taken over.
         */
        async claim ({source, buffer, name, cancelImport}: {source: PackageWindow; buffer: ArrayBuffer; name(): string; cancelImport(): void}) {
            if (!await withBusy(() => readProject(buffer))) return false;
            // Tell the upstream Packager first: it is showing a loading screen for an import that
            // is not going to arrive.
            cancelImport();
            pending = {window: source, buffer, name};
            source.location.href = page();
            return true;
        },
        /**
         * Answer the builder page when it says it is ready for the project.
         * @param {object} event The message event the GUI received.
         * @returns {boolean} True when this was the builder page's message and it was answered.
         */
        handleMessage (event: {data: any; origin: string; source: PackageWindow | null}) {
            const message = event.data && event.data.twPlusPackage;
            if (event.origin !== origin() || !pending || event.source !== pending.window) return false;
            if (!message || message.type !== 'ready' || !pending.buffer) return false;
            const {buffer, name} = pending;
            // The bytes are transferred, so they are no longer ours to send again.
            pending = {...pending, buffer: null};
            pending.window.postMessage({twPlusPackage: {type: 'project', bytes: buffer, name: name()}},
                origin(), [buffer]);
            return true;
        }
    });
};


/** Connect the native Packager socket to live VM and title getters. */
export function connectProjectPackager<VM>(packager: ReturnType<typeof createProjectPackager<VM>> | undefined,
    getVM: () => VM, getTitle: () => string) {
    if (!packager) return null;
    const name = () => `${getTitle()}.sb3`;
    return {
        open: (popup: PackageWindow, fallbackURL: string) => packager.open({popup, fallbackURL, vm: getVM(), name}),
        claim: (source: PackageWindow, buffer: ArrayBuffer, cancelImport: () => void) =>
            packager.claim({source, buffer, cancelImport, name}),
        handleMessage: (event: Parameters<typeof packager.handleMessage>[0]) => packager.handleMessage(event)
    };
}
