type Options = {title?: string; preview?: boolean; deferCommit?: (commit: () => void) => void};
const optionsByVM = new WeakMap<object, Options>();
export const projectSerializationOptions = (vm: object) => optionsByVM.get(vm);

export function withProjectSerialization<T>(vm: object, options: Options, run: () => T): T {
    const previous = optionsByVM.get(vm);
    optionsByVM.set(vm, {...previous, ...options});
    try {
        // VM archive and stream creation serialize synchronously before compression begins.
        return run();
    } finally {
        if (previous) optionsByVM.set(vm, previous);
        else optionsByVM.delete(vm);
    }
}
