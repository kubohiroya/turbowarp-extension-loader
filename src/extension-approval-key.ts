// SPDX-License-Identifier: MPL-2.0
import type {ExtensionSpec} from './index.js';

export function extensionApprovalKey (spec: ExtensionSpec): string {
    const source: {url?: string; path?: string} = spec.source;
    return JSON.stringify([spec.id, spec.sha256, spec.execution, spec.source.type, source.url, source.path,
        spec.version ?? null, spec.publisher ?? null, [...spec.capabilities].sort(), [...spec.dependencies].sort()]);
}
