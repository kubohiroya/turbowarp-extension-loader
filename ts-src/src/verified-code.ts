import {createExtensionLoader} from './index.js';

/** Review bytes through the runtime's policy without evaluating JavaScript. */
export async function collectVerifiedCodes(manifest, ports, options, signal) {
    const result = [];
    const loader = createExtensionLoader({...ports, registrar: {
        async begin() {
            const staged = [];
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
