import type {ResolvedCode, AuthorizationDecision} from './index.js';
export function createSessionTrustProvider(options: {
    requestApproval(code: ResolvedCode, options: {signal?: AbortSignal}): Promise<boolean>;
    maxApprovals?: number;
    hostPolicy?: {
        canLoadExtensionFromProject?(url: string, options?: {signal?: AbortSignal}): boolean | Promise<boolean>;
        getSandboxMode?(url: string, options?: {signal?: AbortSignal}): string | Promise<string>;
    };
}): Readonly<{
    authorize(code: ResolvedCode, options?: {signal?: AbortSignal}): Promise<AuthorizationDecision>;
    revokeAll(): void;
    getApprovalCount(): number;
}>;
