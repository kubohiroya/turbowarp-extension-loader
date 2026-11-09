/**
 * The scratch-vm these adapters drive. scratch-vm publishes no types, and the adapters reach into its
 * internals (the extension manager, the registration tables, the serializer) on purpose, so it is
 * typed as what it is: any. Everything the adapters rely on is checked at run time instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ScratchVM = any;

/**
 * The VM modules the registrar needs, as the instances the VM itself uses. `dispatch` is a
 * singleton, so a copy resolved from elsewhere would not be the VM's own.
 */
export interface VMModules {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ScratchCommon: Record<string, any>;
    createTranslate(vm: ScratchVM): unknown;
    staticFetch(url: unknown): Response | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dispatch: {services: Record<string, any>; setServiceSync(name: string, provider: unknown): void};
}
