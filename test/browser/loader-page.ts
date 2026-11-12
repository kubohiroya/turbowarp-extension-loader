import type {} from '@kubohiroya/turbowarp-plus-editor-test-runtime/page';
import {createExtensionLoader, createFetchPort, LoaderError} from '@kubohiroya/turbowarp-extension-loader';
import {createVMExtensionRegistrar, type ScratchVM} from '@kubohiroya/turbowarp-extension-loader/scratch-vm';

async function loadExtension(url: string, sha256: string) {
    const {vm}: {vm: ScratchVM} = await EditorRuntime.start(document.querySelector<HTMLElement>('#workspace')!);
    const registrar = createVMExtensionRegistrar(vm, {vmModules: EditorRuntime.vmModules});
    let authorized = 0;
    const loader = createExtensionLoader({
        registrar,
        fetcher: createFetchPort(),
        trustProvider: {async authorize(resolved) {
            authorized++;
            return {allowed: true, scope: 'digest', sha256: resolved.sha256};
        }}
    });
    let code: string | null = null;
    let cause: string | null = null;
    try {
        await loader.load({schemaVersion: 1, extensions: [{id: 'browserfixture',
            source: {type: 'remote-non-cacheable', url}, execution: 'unsandboxed', sha256}]});
    } catch (error) {
        if (!(error instanceof LoaderError)) throw error;
        code = error.code;
        cause = error.cause instanceof Error ? error.cause.name : null;
    }
    const primitive = vm.runtime.getOpcodeFunction('browserfixture_value');
    return {code, cause, authorized, executed: vm.browserFixtureExecutions ?? 0,
        registered: vm.extensionManager.isExtensionLoaded('browserfixture'), value: primitive?.({}, {}) ?? null};
}

declare global {
    interface Window { loadBrowserExtension: typeof loadExtension }
}
window.loadBrowserExtension = loadExtension;
