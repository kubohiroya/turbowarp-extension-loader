import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSessionTrustProvider} from '../src/session-trust.js';
const code = {id: 'example', sha256: 'a'.repeat(64), actualSHA256: 'a'.repeat(64), execution: 'unsandboxed',
    source: {type: 'remote', url: 'https://example.org/a.js'}, capabilities: ['vm'], dependencies: []};

test('session reuse binds digest, ID, source, capabilities and claimed publisher', async () => {
    let prompts = 0;
    const provider = createSessionTrustProvider({async requestApproval() { prompts++; return true; }});
    assert.deepEqual(await provider.authorize(code), {allowed: true, scope: 'digest', sha256: code.sha256});
    await provider.authorize({...code});
    assert.equal(prompts, 1);
    for (const change of [{id: 'other'}, {source: {type: 'remote', url: 'https://elsewhere.org/a.js'}},
        {sha256: 'b'.repeat(64), actualSHA256: 'b'.repeat(64)}, {capabilities: ['network']}, {publisher: 'Someone'}]) {
        await provider.authorize({...code, ...change});
    }
    assert.equal(prompts, 6);
    provider.revokeAll();
    await provider.authorize(code);
    assert.equal(prompts, 7);
});

test('denial, unverified content and cancellation never create approval', async () => {
    const provider = createSessionTrustProvider({async requestApproval() { return false; }});
    assert.deepEqual(await provider.authorize(code), {allowed: false});
    assert.equal(provider.getApprovalCount(), 0);
    await assert.rejects(provider.authorize({...code, actualSHA256: 'b'.repeat(64)}), {code: 'INVALID_AUTHORIZATION'});
    await assert.rejects(provider.authorize(code, {signal: AbortSignal.abort()}), {code: 'CANCELLED'});
});

test('approval arriving after revocation or cancellation cannot be retained', async () => {
    let respond;
    const provider = createSessionTrustProvider({requestApproval: () => new Promise(resolve => { respond = resolve; })});
    const operation = provider.authorize(code);
    provider.revokeAll(); respond(true);
    assert.deepEqual(await operation, {allowed: false});
    const controller = new AbortController();
    const cancelled = provider.authorize(code, {signal: controller.signal});
    controller.abort(); respond(true);
    await assert.rejects(cancelled, {code: 'CANCELLED'});
    assert.equal(provider.getApprovalCount(), 0);
});

test('session approval storage remains bounded', async () => {
    const provider = createSessionTrustProvider({requestApproval: async () => true, maxApprovals: 1});
    await provider.authorize(code);
    await provider.authorize({...code, id: 'other'});
    assert.equal(provider.getApprovalCount(), 1);
});

test('custom host URL restrictions precede the permission UI and cached session approvals', async () => {
    let allowed = true, prompts = 0, policyChecks = 0;
    const provider = createSessionTrustProvider({requestApproval: async () => { prompts++; return true; },
        hostPolicy: {async canLoadExtensionFromProject(url) {
            assert.equal(url, code.source.url); policyChecks++; return allowed;
        }}});
    assert.equal((await provider.authorize(code)).allowed, true);
    allowed = false;
    assert.deepEqual(await provider.authorize(code), {allowed: false});
    assert.equal(prompts, 1);
    assert.equal(policyChecks, 2);
});

test('custom sandbox mode refuses privilege escalation before prompting', async () => {
    for (const mode of ['worker', 'iframe', undefined]) {
        const provider = createSessionTrustProvider({requestApproval: async () => { throw new Error('must not prompt'); },
            hostPolicy: {getSandboxMode: async () => mode}});
        assert.deepEqual(await provider.authorize(code), {allowed: false});
    }
});

test('URL-only custom host policies cannot implicitly authorize embedded code', async () => {
    const provider = createSessionTrustProvider({requestApproval: async () => { throw new Error('must not prompt'); },
        hostPolicy: {canLoadExtensionFromProject: async () => true, getSandboxMode: async () => 'unsandboxed'}});
    assert.deepEqual(await provider.authorize({...code, source: {type: 'embedded', path: 'extensions/example.js'}}), {allowed: false});
});
