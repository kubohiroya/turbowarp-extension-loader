/**
 * What a host that only plays projects needs of `./scratch-vm`: the registrar and the bridge in
 * front of the VM's project lifecycle, without authoring or the default project address.
 *
 * A built single HTML plays a project and never adds extensions or addresses one, so it imports
 * this entry and its bundle carries neither. An editor imports `./scratch-vm`, which has all of it.
 */
export {createVMExtensionRegistrar} from './registrar.js';
export {installExtensionLoader, editProjectURI} from './project-loader.js';
export type {ProjectExtensionLoader, ProjectLoaderHost, ProjectURIEdit} from './project-loader.js';
export {projectSerializationOptions, withProjectSerialization} from './serialization-context.js';
export type {ScratchVM, VMModules} from './vm.js';
