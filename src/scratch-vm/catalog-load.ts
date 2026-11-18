// SPDX-License-Identifier: MPL-2.0
/**
 * Load a reviewed dependency order through the VM without persisting trust.
 *
 * Moved from the fork's `src/lib/tw-plus-extension-loader.js`. What stays there is the review
 * bookkeeping: a WeakMap on the VM's security manager that its own `getSandboxMode` reads back, so
 * the two functions that write it arrive from the fork rather than being reimplemented here.
 *
 * Refused dependencies also prevent their dependents from loading.
 * @param {object} vm The editor VM.
 * @param {Array<object>} entries Dependency-first catalog entries.
 * @param {Map<string, string>} choices Explicit security review decisions.
 * @param {object} permissions The fork's review bookkeeping: `beginReview` and `canLoad`.
 * @returns {Promise<Array<string>>} IDs successfully available in the VM.
 */
export interface CatalogLoadEntry {id: string; url: string; dependencies: readonly string[]}
export interface CatalogLoadVM {
    extensionManager: {
        securityManager: object;
        isExtensionLoaded(id: string): boolean;
        loadExtensionURL(url: string): Promise<unknown>;
    };
}
export interface CatalogLoadPermissions {
    beginReview(security: object, modes: Map<string, string>): () => void;
    canLoad(security: object, url: string): boolean | Promise<boolean>;
}
const loadPlusExtensions = async (vm: CatalogLoadVM, entries: readonly CatalogLoadEntry[], choices: ReadonlyMap<string, string>, {beginReview, canLoad}: CatalogLoadPermissions) => {
    const manager = vm.extensionManager;
    const security = manager.securityManager;
    const modes = new Map<string, string>();
    const loaded: string[] = [];
    const refused = new Set<string>();
    for (const entry of entries) {
        if (!['deny', 'sandboxed', 'unsandboxed'].includes(choices.get(entry.url) ?? '')) {
            throw new Error(`Missing permission decision: ${entry.id}`);
        }
    }
    const releaseReview = beginReview(security, modes);
    try {
        for (const entry of entries) {
            if (manager.isExtensionLoaded(entry.id)) {
                loaded.push(entry.id);
                continue;
            }
            if (choices.get(entry.url) === 'deny' || entry.dependencies.some(id => refused.has(id))) {
                refused.add(entry.id);
                continue;
            }
            if (entry.dependencies.some(id => !manager.isExtensionLoaded(id))) {
                throw new Error(`An extension dependency was not loaded: ${entry.id}`);
            }
            if (!await canLoad(security, entry.url)) {
                refused.add(entry.id);
                continue;
            }
            modes.set(entry.url, choices.get(entry.url) === 'unsandboxed' ? 'unsandboxed' : 'iframe');
            await manager.loadExtensionURL(entry.url);
            modes.delete(entry.url);
            if (!manager.isExtensionLoaded(entry.id)) {
                throw new Error(`The extension did not register its catalog ID: ${entry.id}`);
            }
            loaded.push(entry.id);
        }
    } finally {
        releaseReview();
    }
    return loaded;
};

export default loadPlusExtensions;
