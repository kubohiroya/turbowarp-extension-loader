import {isRemoteSource, LoaderError, type AuthorizationDecision, type ResolvedCode} from './index.js';

export interface SessionTrustOptions {
    requestApproval(code: ResolvedCode, options: {signal?: AbortSignal}): Promise<boolean>;
    maxApprovals?: number;
    hostPolicy?: {
        canLoadExtensionFromProject?(url: string, options?: {signal?: AbortSignal}): boolean | Promise<boolean>;
        getSandboxMode?(url: string, options?: {signal?: AbortSignal}): string | Promise<string>;
    };
}
export type SessionTrustProvider = Readonly<{
    authorize(code: ResolvedCode, options?: {signal?: AbortSignal}): Promise<AuthorizationDecision>;
    revokeAll(): void;
    getApprovalCount(): number;
}>;

/** Host-owned approvals bind an exact verified request for this session only. */
export function createSessionTrustProvider(options: SessionTrustOptions): SessionTrustProvider;
export function createSessionTrustProvider({requestApproval, maxApprovals = 128, hostPolicy}: Partial<SessionTrustOptions> = {}): SessionTrustProvider {
    if (typeof requestApproval !== 'function' || !Number.isSafeInteger(maxApprovals) || maxApprovals < 1) {
        throw new TypeError('A host approval prompt and bounded approval capacity are required');
    }
    const approvals = new Map<string, true>();
    const policy = Object.freeze({
        canLoad: hostPolicy && hostPolicy.canLoadExtensionFromProject,
        mode: hostPolicy && hostPolicy.getSandboxMode
    });
    for (const port of Object.values(policy)) {
        if (port !== undefined && typeof port !== 'function') throw new TypeError('Host policy ports must be functions');
    }
    let generation = 0;
    const check = (signal?: AbortSignal) => {
        if (signal?.aborted) throw new LoaderError('CANCELLED', 'Permission request was cancelled');
    };
    return Object.freeze({
        async authorize(code: ResolvedCode, {signal}: {signal?: AbortSignal} = {}): Promise<AuthorizationDecision> {
            check(signal);
            if (code.actualSHA256 !== code.sha256) throw new LoaderError('INVALID_AUTHORIZATION', 'Only verified extension requests may be reviewed');
            // An existing URL-only host policy cannot authorize an archive path.
            // Recheck before cached consent so later host restrictions take precedence.
            if (policy.canLoad || policy.mode) {
                if (!isRemoteSource(code.source)) return Object.freeze({allowed: false});
                if (policy.canLoad) {
                    const allowed = await policy.canLoad(code.source.url, {signal});
                    check(signal);
                    if (allowed !== true) return Object.freeze({allowed: false});
                }
                if (policy.mode) {
                    const mode = await policy.mode(code.source.url, {signal});
                    check(signal);
                    const compatible = code.execution === 'unsandboxed' ? mode === 'unsandboxed' :
                        code.execution === 'sandboxed' && ['sandboxed', 'iframe', 'worker'].includes(mode);
                    if (!compatible) return Object.freeze({allowed: false});
                }
            }
            const location: {url?: string; path?: string} = code.source;
            const key = JSON.stringify([code.id, code.sha256, code.execution, code.source.type,
                location.url ?? location.path, code.version ?? null, code.publisher ?? null,
                [...code.capabilities].sort(), [...code.dependencies].sort()]);
            if (!approvals.has(key)) {
                const started = generation;
                const approved = await requestApproval(code, {signal});
                check(signal);
                if (approved !== true || started !== generation) return Object.freeze({allowed: false});
                approvals.set(key, true);
                if (approvals.size > maxApprovals) approvals.delete(approvals.keys().next().value!);
            }
            return Object.freeze({allowed: true, scope: 'digest', sha256: code.sha256});
        },
        revokeAll() { generation++; approvals.clear(); },
        getApprovalCount() { return approvals.size; }
    });
}
