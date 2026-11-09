/**
 * The pinned scratch-vm these tests drive, and the VM modules the registrar needs from it.
 *
 * The registrar must use the VM's own module instances (central dispatch is a singleton), so they
 * come from the same install as the VM. The revision in package.json follows the one the TurboWarp
 * Plus Editor's pinned scratch-gui uses.
 */
import {createRequire} from 'node:module';

export const vmRequire = createRequire(import.meta.url);

export const vmModules = {
    ScratchCommon: vmRequire('scratch-vm/src/extension-support/tw-extension-api-common.js'),
    createTranslate: vmRequire('scratch-vm/src/extension-support/tw-l10n.js'),
    staticFetch: vmRequire('scratch-vm/src/util/tw-static-fetch.js'),
    dispatch: vmRequire('scratch-vm/src/dispatch/central-dispatch.js')
};
