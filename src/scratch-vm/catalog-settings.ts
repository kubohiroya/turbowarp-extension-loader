// SPDX-License-Identifier: MPL-2.0
/**
 * What the library reads and writes about a project's extensions.
 *
 * Moved from the fork's `src/lib/tw-plus-catalog-authoring.js`. It reaches the authoring
 * controller the installed host made, which is now on this side too.
 *
 * The review screen, the Loader's manifest and the SB3 save format spell the four loading forms
 * the same way, so a decision passes from the screen to the Loader as it is, with no table between.
 */

import type {Manifest} from '../index.js';
import {getExtensionAuthoringHost} from './authoring.js';

export interface CatalogEntry {id: string; url: string; dependencies?: readonly string[]; metadata?: {version?: string}}
export interface ReviewDecision {
    execution: 'deny' | 'sandboxed' | 'unsandboxed';
    loading?: 'remote-non-cacheable' | 'remote-cacheable' | 'embedded-file' | 'embedded-data';
}
export interface CatalogVM {
    extensionManager: {isExtensionLoaded(id: string): boolean; _loadedExtensions: {get(id: string): unknown}};
}
const authoringHost = (vm: CatalogVM) => getExtensionAuthoringHost(vm as Parameters<typeof getExtensionAuthoringHost>[0]);
const EXECUTIONS = ['sandboxed', 'unsandboxed'];
const LOADINGS = ['remote-non-cacheable', 'remote-cacheable', 'embedded-file', 'embedded-data'];

/**
 * Read what the project already says about each catalog entry, as the screen's starting decisions.
 *
 * How an entry runs is read off the VM, which is what is actually running; how it loads is read
 * off the project's manifest, which is the author's record. An entry the project does not name
 * yet has no starting decision, and the screen offers its own defaults.
 * @param {object} vm Owning VM.
 * @param {Array<object>} entries Catalog entries.
 * @returns {Promise<object>} `decisions`: a `ReviewDecision` by extension ID.
 */
export const readPlusCatalogSettings = async (vm: CatalogVM, entries: readonly CatalogEntry[]) => {
    const authoring = authoringHost(vm);
    const manifest = authoring ? await authoring.inspect() : null;
    const saved = new Map<string, Manifest['extensions'][number]>((manifest?.extensions || []).map(spec => [spec.id, spec]));
    const decisions = new Map<string, ReviewDecision>();
    for (const entry of entries) {
        const spec = saved.get(entry.id);
        let execution = spec?.execution;
        if (vm.extensionManager.isExtensionLoaded(entry.id)) {
            // The VM adapter owns this service-name interpretation; UI state never decides privilege.
            const service = vm.extensionManager._loadedExtensions.get(entry.id);
            const mode = typeof service === 'string' ? service.startsWith('unsandboxed.') ? 'unsandboxed' :
                service.startsWith('extension.') ? 'sandboxed' : null : null;
            if (mode) execution = mode;
        }
        if (!execution && !spec) continue;
        decisions.set(entry.id, {execution: execution || 'unsandboxed',
            ...(spec ? {loading: spec.source.type} : {})});
    }
    return {decisions};
};

/**
 * Apply a dependency-ordered selection in one host transaction.
 * @param {object} vm Owning VM.
 * @param {object} selection `entries`, the chosen catalog entries in dependency order, and
 *     `decisions`, the screen's `ReviewDecision` for each by extension ID.
 * @returns {Promise<Array<string>>} Available extension IDs.
 */
export const applyPlusCatalogSettings = async (vm: CatalogVM, {entries, decisions}: {entries: CatalogEntry[]; decisions: Map<string, ReviewDecision>}, {signal}: {signal?: AbortSignal} = {}) => {
    const authoring = authoringHost(vm);
    if (!authoring) {
        throw Object.assign(new Error('Enable the Plus extension Loader before changing distribution'),
            {code: 'LOADER_DISABLED'});
    }
    const requests = [];
    for (const entry of entries) {
        const {execution, loading} = decisions.get(entry.id) || {};
        if (!EXECUTIONS.includes(execution ?? '')) {
            throw Object.assign(new Error(`Choose an execution mode for ${entry.id}`), {code: 'MISSING_EXECUTION'});
        }
        // A form the screen did not give is refused rather than defaulted: the author chooses it.
        if (!LOADINGS.includes(loading ?? '')) {
            throw Object.assign(new Error(`Choose how ${entry.id} loads`), {code: 'MISSING_LOADING'});
        }
        requests.push({id: entry.id,
            url: entry.url,
            execution,
            distribution: loading,
            dependencies: entry.dependencies || [],
            version: entry.metadata?.version});
    }
    if (!requests.length) return [];
    await authoring.configure(requests, {signal});
    return requests.map(request => request.id);
};
