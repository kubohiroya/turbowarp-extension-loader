import {LoaderError} from './index.js';

/** Host-owned approvals bind an exact verified request for this session only. */
export function createSessionTrustProvider({requestApproval, maxApprovals = 128, hostPolicy} = {}) {
    if (typeof requestApproval !== 'function' || !Number.isSafeInteger(maxApprovals) || maxApprovals < 1) {
        throw new TypeError('A host approval prompt and bounded approval capacity are required');
    }
    const approvals = new Map();
    const policy = Object.freeze({
        canLoad: hostPolicy && hostPolicy.canLoadExtensionFromProject,
        mode: hostPolicy && hostPolicy.getSandboxMode
    });
    for (const port of Object.values(policy)) {
        if (port !== undefined && typeof port !== 'function') throw new TypeError('Host policy ports must be functions');
    }
    let generation = 0;
    const check = signal => {
        if (signal?.aborted) throw new LoaderError('CANCELLED', 'Permission request was cancelled');
    };
    return Object.freeze({
        async authorize(code, {signal} = {}) {
            check(signal);
            if (code.actualSHA256 !== code.sha256) throw new LoaderError('INVALID_AUTHORIZATION', 'Only verified extension requests may be reviewed');
            // An existing URL-only host policy cannot authorize an archive path.
            // Recheck before cached consent so later host restrictions take precedence.
            if (policy.canLoad || policy.mode) {
                if (code.source.type !== 'remote') return Object.freeze({allowed: false});
                if (policy.canLoad) {
                    const allowed = await policy.canLoad(code.source.url, {signal});
                    check(signal);
                    if (allowed !== true) return Object.freeze({allowed: false});
                }
                if (policy.mode) {
                    const mode = await policy.mode(code.source.url, {signal});
                    check(signal);
                    if (mode !== 'unsandboxed') return Object.freeze({allowed: false});
                }
            }
            const key = JSON.stringify([code.id, code.sha256, code.execution, code.source.type,
                code.source.url ?? code.source.path, code.version ?? null, code.publisher ?? null,
                [...code.capabilities].sort(), [...code.dependencies].sort()]);
            if (!approvals.has(key)) {
                const started = generation;
                const approved = await requestApproval(code, {signal});
                check(signal);
                if (approved !== true || started !== generation) return Object.freeze({allowed: false});
                approvals.set(key, true);
                if (approvals.size > maxApprovals) approvals.delete(approvals.keys().next().value);
            }
            return Object.freeze({allowed: true, scope: 'digest', sha256: code.sha256});
        },
        revokeAll() { generation++; approvals.clear(); },
        getApprovalCount() { return approvals.size; }
    });
}
