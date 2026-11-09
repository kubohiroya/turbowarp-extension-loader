import assert from 'node:assert/strict';

interface HostError extends Error {
    code?: string;
    extensionId?: string;
    cause?: HostError;
}

export function hostError(value: unknown): HostError {
    assert.ok(value instanceof Error);
    return value as HostError;
}
