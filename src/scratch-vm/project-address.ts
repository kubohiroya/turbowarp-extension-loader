/**
 * The default address an editor gives a project, and where it can give one at all.
 *
 * A project is addressed at two moments (issue #55): when its manifest is first written by adding
 * or configuring an extension (`authoring.ts`), and when a project whose manifest has no address is
 * first saved (`project-loader.ts`, through the host). Both make the same address from the same
 * origin under the same rule, so the rule lives here once.
 *
 * Kept apart from `authoring.ts` because only an editor wires the save-time path: a built single
 * HTML plays a project and never addresses one, so it need not bundle this module.
 */

import {createProjectUUID, defaultProjectURI} from '../project-authoring.js';

/**
 * The origin a project's default address is made from, or null when this one cannot make any.
 *
 * Project addresses are HTTPS only, so an editor opened over plain HTTP (the local preview and the
 * E2E server on `http://localhost`) or from a file names nothing: its projects stay unaddressed,
 * which files them in the shared bucket rather than under a name the editor cannot claim.
 * @param {string|undefined} origin Where the editor was opened, as `location.origin`.
 * @returns {string|null} The origin, when it can carry project addresses.
 */
export const addressingOrigin = (origin: string | undefined): string | null => {
    if (typeof origin !== 'string') return null;
    try {
        const url = new URL(origin);
        return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
    } catch {
        return null;
    }
};

/**
 * Make the function that names a new project's default address.
 * @param {string|undefined} origin Where the editor was opened, as `location.origin`.
 * @param {Function} [createUUID] Issues the project's identifier.
 * @returns {Function|null} `() => uri`, or null where no address can be made (not HTTPS).
 */
export const createProjectAddresser = (origin: string | undefined, createUUID = createProjectUUID): (() => string) | null => {
    const projectOrigin = addressingOrigin(origin);
    return projectOrigin ? () => defaultProjectURI(projectOrigin, createUUID()) : null;
};
