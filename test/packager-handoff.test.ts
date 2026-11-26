import test from 'node:test';
import assert from 'node:assert/strict';
import Zip from '@turbowarp/jszip';
import {createProjectPackager} from '../dist/packager-handoff.js';
function fixture(readProject = async () => true) {
    const transfers: unknown[] = [];
    const popup = {closed: false, location: {href: ''}, close() {this.closed=true;}, postMessage(...args: unknown[]) {transfers.push(args);}};
    const bytes = new ArrayBuffer(3);
    const errors: unknown[]=[];
    const options = {enabled: true, zip: Zip, readProject, page: () => 'https://editor.test/plus-packager.html', origin: () => 'https://editor.test',
        serialize: async () => bytes, withBusy: async <T>(operation: () => Promise<T>) => operation(), reportError: (error: unknown) => {errors.push(error);}};
    return {popup,transfers,bytes,errors,options,packager:createProjectPackager(options)!};
}
test('handoff accepts only its own popup and origin, and transfers the project once', async () => {
    const f=fixture(); let title='First';
    await f.packager.open({popup:f.popup,vm:{},name:()=>title,fallbackURL:'https://packager.test'});
    const event={data:{twPlusPackage:{type:'ready'}},origin:'https://editor.test',source:f.popup};
    assert.equal(f.packager.handleMessage({...event,origin:'https://evil.test'}),false);
    assert.equal(f.packager.handleMessage({...event,source:{...f.popup}}),false);
    title='Latest'; assert.equal(f.packager.handleMessage(event),true);
    assert.deepEqual(f.transfers,[[{twPlusPackage:{type:'project',bytes:f.bytes,name:'Latest'}},'https://editor.test',[f.bytes]]]);
    assert.equal(f.packager.handleMessage(event),false);
});
test('ordinary projects retain the upstream route and a closed popup is never serialized', async () => {
    const f=fixture(async () => false);
    await f.packager.open({popup:f.popup,vm:{},name:()=>'',fallbackURL:'https://packager.test'});
    assert.equal(f.popup.location.href,'https://packager.test');
    f.popup.closed=true;
    const p=createProjectPackager({...f.options,serialize:async () => {assert.fail('closed popup was serialized');}})!;
    await p.open({popup:f.popup,vm:{},name:()=>'',fallbackURL:''});
    assert.equal(createProjectPackager({...f.options,enabled:false}),null);
});
test('claim cancels the upstream import before navigation; serialization errors close the popup', async () => {
    const f=fixture();
    assert.equal(await f.packager.claim({source:f.popup,buffer:f.bytes,name:()=>'',cancelImport:()=>assert.equal(f.popup.location.href,'')}),true);
    assert.equal(f.popup.location.href,f.options.page());
    const failure=new Error('save failed');
    const broken=createProjectPackager({...f.options,serialize:async()=>{throw failure;}})!;
    await broken.open({popup:f.popup,vm:{},name:()=>'',fallbackURL:''});
    assert.equal(f.popup.closed,true); assert.deepEqual(f.errors,[failure]);
});
