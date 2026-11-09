/**
 * The Loader on a scratch-vm: the registrar port, the bridge in front of the VM's project lifecycle,
 * and the controller that adds, configures and removes a project's extensions.
 *
 * The Loader core knows nothing of Scratch. These adapters do, and drive the VM's internals on
 * purpose; whoever bundles the VM installs them and passes the VM's own module instances in. A host
 * that only plays projects imports `./scratch-vm/runtime` instead, which leaves authoring out.
 */
export * from './runtime.js';
export {createExtensionAuthoringController, setExtensionAuthoringHost, getExtensionAuthoringHost} from './authoring.js';
export {addressingOrigin, createProjectAddresser} from './project-address.js';
