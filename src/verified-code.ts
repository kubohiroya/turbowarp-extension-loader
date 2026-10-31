import {createExtensionLoader, type AuthorizedCode, type LoaderOptions, type LoaderPorts, type Manifest} from './index.js';

/** Review bytes through the runtime's policy without evaluating JavaScript. */
export async function collectVerifiedCodes(manifest: Manifest, ports: Omit<LoaderPorts, 'registrar'>,
    options: LoaderOptions | undefined, signal: AbortSignal | undefined): Promise<AuthorizedCode[]> {
    const result: AuthorizedCode[] = [];
    const loader = createExtensionLoader({...ports, registrar: {
        async begin() {
            const staged: AuthorizedCode[] = [];
            return {
                async register(code) { staged.push(code); return {id: code.id}; },
                async commit() { result.push(...staged); },
                async rollback() { staged.length = 0; result.length = 0; }
            };
        },
        async unload() {}
    }}, options);
    await loader.load(manifest, {signal});
    await loader.unload();
    return result;
}
