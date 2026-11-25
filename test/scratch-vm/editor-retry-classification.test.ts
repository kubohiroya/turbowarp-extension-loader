// SPDX-License-Identifier: GPL-3.0-or-later
// From turbowarp-plus-editor/test/extension-host/retry-classification.test.ts at 52cc9fc.
// The original test license is retained; see ../LICENSE.GPL-3.0.
/**
 * What the authoring path actually fails with, and what the Loader says about asking again.
 *
 * The retry affordance (kubohiroya/turbowarp-plus-editor#88) is only allowed to ask one question —
 * `isWorthAskingAgain(error)` — because the first attempt at it wrote a table of 29 error codes
 * into the host and had to be removed (kubohiroya/scratch-gui#108). This pins the answer for every
 * failure the library's own path can produce, so the screen that grows a button can rely on the
 * judgement instead of reading codes.
 *
 * `LOAD_FAILED` appears twice below with opposite answers: an offline fetch and a registration that
 * declared the wrong ID both carry it, and only the first is worth asking about. That is the case
 * that makes branching on the code wrong.
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Zip from '@turbowarp/jszip';
import {isWorthAskingAgain} from '@kubohiroya/turbowarp-extension-loader';
import {createScratchVMExtensionHost} from '@kubohiroya/turbowarp-extension-loader/scratch-vm/extension-host';
import {createExtensionAuthoringController, setExtensionAuthoringHost} from '@kubohiroya/turbowarp-extension-loader/scratch-vm';

import {vmRequire, vmModules} from './vm.ts';

const VM = vmRequire('scratch-vm');
const Storage = vmRequire('@turbowarp/scratch-storage');

// Only UI and review ports are supplied here; the real Loader owns the host and authoring path.
const installHost = createScratchVMExtensionHost({zip: Zip,
    createPermissionUI: () => ({
        requestApproval: async () => {throw new Error('The fixture supplies requestApproval explicitly');},
        diagnostics: () => {}, dispose: () => {}
    }),
    openReview: () => ({decisions: null}), closeReview: () => {}
});
const installEditorExtensionHost = (vm, options) => installHost(vm, {
    ...options, createAuthoring: createExtensionAuthoringController, setAuthoringHost: setExtensionAuthoringHost
});

const URL_UNDER_TEST = 'https://example.test/code.js';
const register = id => `Scratch.extensions.register({getInfo(){return {id:"${id}",name:"Sample",blocks:[]}}});`;
// The fetch port refuses a response whose URL is not the one it asked for, which is how it rejects
// a redirect. A constructed Response has no URL at all, so every response that is meant to be
// *read* has to carry the asked URL — including the error statuses, or they are refused as
// redirects before their status is ever looked at, and the status is what decides the answer here.
const respond = (url, body, status = 200) => Object.defineProperty(
    new Response(body, {status, headers: {'content-type': 'text/javascript'}}), 'url', {value: url});
const served = async url => respond(url, register('sample'));

const emptyProject = async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"></svg>';
    const assetId = createHash('md5').update(svg).digest('hex');
    const project = {targets: [{isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {},
        blocks: {}, comments: {}, currentCostume: 0, sounds: [], volume: 100, layerOrder: 0, tempo: 60,
        costumes: [{name: 'Blank', assetId, dataFormat: 'svg', md5ext: `${assetId}.svg`,
            rotationCenterX: 240, rotationCenterY: 180}],
        videoTransparency: 50, videoState: 'off', textToSpeechLanguage: null}],
    monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '2.0.0', agent: 'Retry classification fixture'}};
    return await new Zip().file('project.json', JSON.stringify(project)).file(`${assetId}.svg`, svg)
        .generateAsync({type: 'uint8array'});
};

/**
 * Run one catalog change against a real VM and a real host, and report how it ended.
 * @param {object} host How this attempt fails: the fetch, the approval, the signal, the settings.
 * @param {Uint8Array} project The project to change.
 * @returns {Promise<object>} `{code, worth}`, or `{resolved: true}`.
 */
async function configure ({fetchImpl, requestApproval = async () => true, loaderOptions, retries = 0,
    aborted = false}: {
    fetchImpl: typeof fetch;
    requestApproval?: () => Promise<boolean>;
    loaderOptions?: import('@kubohiroya/turbowarp-extension-loader').LoaderOptions;
    retries?: number;
    aborted?: boolean;
}, project: Uint8Array) {
    const vm = new VM();
    vm.attachStorage(new Storage());
    const host = installEditorExtensionHost(vm, {enabled: true, document: undefined, vmModules,
        fetchImpl, fetchRetry: {retries}, loaderOptions, requestApproval});
    assert.equal(host.enabled, true);
    try {
        await vm.loadProject(project);
        const controller = new AbortController();
        if (aborted) controller.abort();
        await host.authoring.configure([{id: 'sample', url: URL_UNDER_TEST, execution: 'unsandboxed',
            distribution: 'remote-cacheable', dependencies: []}], {signal: controller.signal});
        return {resolved: true};
    } catch (error) {
        return {code: error.code, worth: isWorthAskingAgain(error)};
    } finally {
        await host.dispose();
        vm.runtime.dispose();
    }
}

test('the library\'s own failures split into the ones a person could answer differently', async () => {
    const project = await emptyProject();
    assert.deepEqual(await configure({fetchImpl: served}, project), {resolved: true});
    const cases: [string, Parameters<typeof configure>[0], {code: string; worth: boolean}][] = [
        // Offline, CORS and CSP all reach the page as a bare TypeError from fetch.
        ['offline', {fetchImpl: async () => { throw new TypeError('Failed to fetch'); }},
            {code: 'LOAD_FAILED', worth: true}],
        ['timed out', {fetchImpl: () => new Promise<Response>(() => {}), loaderOptions: {timeoutMs: 60}},
            {code: 'TIMEOUT', worth: true}],
        ['missing', {fetchImpl: async url => respond(url, 'nope', 404)},
            {code: 'FETCH_FAILED', worth: false}],
        // The port keeps the status on the cause, so a server that is down reads as transient even
        // after the port retried it and gave up: asking again really can answer differently.
        ['server error', {fetchImpl: async url => respond(url, 'busy', 503), retries: 2},
            {code: 'FETCH_FAILED', worth: true}],
        ['rate limited', {fetchImpl: async url => respond(url, 'slow down', 429)},
            {code: 'FETCH_FAILED', worth: true}],
        // A denied redirect is not its own code, and carries no status: the port refuses a response
        // whose URL is not the one it asked for, which is also what `redirect: 'error'` produces.
        ['redirected', {fetchImpl: async () => new Response(null,
            {status: 302, headers: {location: 'https://elsewhere.test/code.js'}})},
        {code: 'FETCH_FAILED', worth: false}],
        ['not approved', {fetchImpl: served, requestApproval: async () => false},
            {code: 'TRUST_DENIED', worth: false}],
        ['cancelled', {fetchImpl: served, aborted: true}, {code: 'CANCELLED', worth: false}],
        // Same code as being offline, opposite answer: the cause is a permanent rejection.
        ['wrong ID', {fetchImpl: async url => respond(url, register('other'))},
            {code: 'LOAD_FAILED', worth: false}]
    ];
    for (const [name, attempt, expected] of cases) {
        assert.deepEqual(await configure(attempt, project), expected, name);
    }
});
