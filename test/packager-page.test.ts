import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
import Zip from '@turbowarp/jszip';
import {mountPackagerPage} from '@kubohiroya/turbowarp-extension-loader/packager-page';
const {Packager}=createRequire(import.meta.url)('@turbowarp/packager');
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
function fixture() {
    const dom=new JSDOM('',{url:'https://editor.test/plus-packager.html'});
    const view=dom.window;view.fetch=fetch;
    let created=0;const revoked:string[]=[];
    view.URL.createObjectURL=()=>`blob:generated-${++created}`;
    view.URL.revokeObjectURL=url=>{revoked.push(url);};
    const opener={postMessage(){}};Object.defineProperty(view,'opener',{value:opener});
    const page=mountPackagerPage({document:view.document,editorURL:'editor.html',zip:Zip,archiveOptions:{},
        createPackager:()=>new Packager(), runtimeBundle:'globalThis.TurboWarpPlusExtensionHost={installPlusExtensionHost:()=>({enabled:true})};',
        scaffoldingAssets:{scaffolding:'/* fixture */', 'scaffolding-min':'/* fixture */',addons:'/* fixture */'},
        ui:{requestApproval:async()=>true,diagnostics(){}},trusted:{catalog:{isTrustedCode:async()=>true},listDigests:async()=>[]},
        embedProjectData:async bytes=>bytes,withBusy:async operation=>operation(),withoutBusy:async operation=>operation()});
    const send=(bytes: ArrayBuffer, changes: MessageEventInit = {})=>view.dispatchEvent(new view.MessageEvent('message',{origin:view.location.origin,source:opener as unknown as Window,
        data:{twPlusPackage:{type:'project',bytes,name:'Project.sb3'}},...changes}));
    return {dom,view,page,send,revoked,created:()=>created,button:()=>view.document.querySelector<HTMLButtonElement>('[data-testid="plus-package-generate"]')!};
}
test('the package creates the form and ignores project messages from other origins or windows', t=>{
    const f=fixture();t.after(()=>f.dom.window.close());
    assert.match(f.view.document.title,/単一HTML/);assert.equal(f.button().disabled,true);
    f.send(new ArrayBuffer(1),{origin:'https://evil.test'});assert.equal(f.button().disabled,true);
    f.send(new ArrayBuffer(1),{source:null});assert.equal(f.button().disabled,true);
    f.send(new ArrayBuffer(1));assert.equal(f.button().disabled,false);
    f.page.dispose();f.send(new ArrayBuffer(1));assert.equal(f.view.document.querySelector('main'),null);
});
test('a project without a manifest is refused without creating a download URL', async t=>{
    const f=fixture();t.after(()=>f.dom.window.close());
    const zip=new Zip();zip.file('project.json',JSON.stringify({targets:[]}));
    f.send(await zip.generateAsync({type:'arraybuffer'}));
    f.view.document.querySelector<HTMLInputElement>('[data-testid="plus-package-resources"]')!.checked=true;
    f.button().click();await tick();await tick();
    assert.match(f.view.document.querySelector('[role="status"]')!.textContent,/Plus Manifest/);
    assert.equal(f.created(),0);assert.equal(f.button().disabled,false);
});

test('generation suppresses duplicate clicks, replaces the download URL and revokes it on disposal', async t => {
    const f=fixture();t.after(()=>f.dom.window.close());
    const zip=new Zip();
    zip.file('project.json',JSON.stringify({targets:[{isStage:true,name:'Stage',variables:{},lists:{},broadcasts:{},blocks:{},comments:{},
        costumes:[],sounds:[],currentCostume:0,volume:100,layerOrder:0,tempo:60,videoTransparency:50,videoState:'on',textToSpeechLanguage:null}],
        monitors:[],extensions:[],extensionURLs:{},meta:{semver:'3.0.0',vm:'2.0.0',agent:'fixture'},turboWarpPlus:{schemaVersion:1,extensions:[]}}));
    const archive=await zip.generateAsync({type:'arraybuffer'});
    const waitForDownload=async () => {
        for(let i=0;i<100;i++) {
            if (!f.view.document.querySelector<HTMLAnchorElement>('[data-testid="plus-package-download"]')!.hidden) return;
            await tick();
        }
        assert.fail(f.view.document.querySelector('[role="status"]')!.textContent ?? 'download missing');
    };
    f.send(archive);
    f.view.document.querySelector<HTMLInputElement>('[data-testid="plus-package-resources"]')!.checked=true;
    f.button().click();f.button().click();
    await waitForDownload();
    assert.equal(f.created(),1);
    const download=f.view.document.querySelector<HTMLAnchorElement>('[data-testid="plus-package-download"]')!;
    assert.equal(download.download,'Project.html');
    f.button().click();await waitForDownload();
    assert.equal(f.created(),2);assert.deepEqual(f.revoked,['blob:generated-1']);
    f.page.dispose();assert.deepEqual(f.revoked,['blob:generated-1','blob:generated-2']);
});
