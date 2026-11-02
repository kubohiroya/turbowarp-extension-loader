/**
 * Which rejections came out of a fetch port.
 *
 * A browser reports a transport failure as a bare `TypeError`, and so does any host code with a
 * bug in it. Only where the rejection came from tells them apart, so every place the Loader calls a
 * fetch port records what that port rejected with. Internal: not part of the package exports.
 */
const rejections = new WeakSet<object>();

/** Record that a fetch port rejected with this value; a primitive cannot be recorded. */
export function markFetchRejection(error: unknown): void {
    if (error !== null && typeof error === 'object') rejections.add(error);
}

export const isFetchRejection = (error: unknown): boolean =>
    error !== null && typeof error === 'object' && rejections.has(error);
