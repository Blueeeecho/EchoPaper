import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type {EditorBarrier,WorkspaceEvent} from '../shared/types';
import {prepareEditorCommit,registerEditorSessionRoutes} from '../server/agents/editor-barrier';

const file='manuscript/main.tex';
async function fixture(t:TestContext){
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-editor-barrier-'));
 const root=path.join(workspace,'papers/Test');
 await fs.mkdir(path.join(root,'manuscript'),{recursive:true});
 await fs.writeFile(path.join(root,'project.json'),'{}');
 const app=Fastify(),events:WorkspaceEvent[]=[];
 registerEditorSessionRoutes(app,workspace,event=>events.push(event));
 t.after(async()=>{await app.close();await fs.rm(workspace,{recursive:true,force:true});});
 const post=(id:string,dirty=false,bufferVersion=0,currentFile=file)=>app.inject({method:'POST',url:'/api/projects/Test/editor-sessions',payload:{id,path:currentFile,dirty,bufferVersion}});
 const close=(id:string,state?:{path:string;dirty:boolean;bufferVersion:number})=>app.inject({method:'DELETE',url:'/api/projects/Test/editor-sessions/'+id,...(state?{payload:state}:{})});
 const ack=(id:string,barrier:EditorBarrier,clean:boolean,bufferVersion:number)=>app.inject({method:'POST',url:'/api/projects/Test/editor-sessions/'+id+'/ack',payload:{barrierId:barrier.id,clean,bufferVersion}});
 function begin(paths=[file]){
  const controller=new AbortController(),before=events.length;
  const waiting=prepareEditorCommit(root,paths,controller.signal);
  // Attach rejection handling immediately; abort cleanup also releases a granted lease.
  void waiting.catch(()=>{});
  t.after(async()=>{controller.abort();await waiting.then(release=>release(),()=>{});});
  const barrier=events.slice(before).find(e=>e.type==='editor.barrier')?.barrier;
  return{waiting,barrier,controller};
 }
 return{app,root,events,post,close,ack,begin};
}
async function soon<T>(promise:Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>timer=setTimeout(()=>reject(new Error('Editor barrier did not settle after unregistering the clean document.')),500))]);}
 finally{clearTimeout(timer);}
}
async function stillWaiting(promise:Promise<unknown>){
 let settled=false;void promise.then(()=>settled=true,()=>settled=true);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(settled,false,'an unacknowledged active editor must still block the commit');
}

test('hard refresh revokes the old clean document during a barrier without waiting for its lease',async t=>{
 const f=await fixture(t);
 assert.equal((await f.post('old-document')).statusCode,200);
 const {waiting,barrier}=f.begin();assert.ok(barrier);
 // The replacement document joins the same handshake instead of inheriting its ID.
 assert.equal((await f.post('new-document')).statusCode,200);
 assert.equal((await f.close('old-document',{path:file,dirty:false,bufferVersion:0})).statusCode,200);
 await stillWaiting(waiting);
 assert.equal((await f.ack('new-document',barrier,true,0)).statusCode,200);
 const release=await soon(waiting);release.assertActive();release();
 // No 20-second old-document lease remains in the next handshake.
 const next=f.begin();assert.ok(next.barrier);
 assert.equal((await f.ack('new-document',next.barrier,true,0)).statusCode,200);
 (await soon(next.waiting))();
});

test('closing the sole clean document resolves an already pending handshake',async t=>{
 const f=await fixture(t);await f.post('clean-document');
 const {waiting,barrier}=f.begin();assert.ok(barrier);
 assert.equal((await f.close('clean-document',{path:file,dirty:false,bufferVersion:0})).json().closed,true);
 const release=await soon(waiting);release.assertActive();release();
 const before=f.events.length,next=f.begin();
 (await soon(next.waiting))();
 assert.equal(f.events.length,before,'a revoked clean document must not require another acknowledgement');
});

test('a clean close before its in-flight registration prevents late POST resurrection',async t=>{
 const f=await fixture(t);
 assert.equal((await f.close('not-yet-registered',{path:file,dirty:false,bufferVersion:1})).json().closed,true);
 for(const bufferVersion of [0,1,100]){
  const response=await f.post('not-yet-registered',true,bufferVersion);
  assert.equal(response.statusCode,200);assert.equal(response.json().closed,true);
 }
 const before=f.events.length,{waiting,barrier}=f.begin();assert.equal(barrier,undefined);
 (await soon(waiting))();assert.equal(f.events.length,before);
 // Tombstones cover only that document ID, so a fresh random ID can participate.
 await f.post('fresh-document',false,0);const next=f.begin();assert.ok(next.barrier);
 await f.ack('fresh-document',next.barrier,true,0);(await soon(next.waiting))();
});

test('dirty close records the latest state even before registration and survives stale clean requests',async t=>{
 const f=await fixture(t);
 const response=await f.close('dirty-document',{path:file,dirty:true,bufferVersion:4});
 assert.equal(response.statusCode,200);assert.equal(response.json().preserved,true);
 for(const bufferVersion of [1,4]){
  assert.equal((await f.post('dirty-document',false,bufferVersion)).json().ignored,true);
  assert.equal((await f.close('dirty-document',{path:file,dirty:false,bufferVersion})).json().ignored,true);
 }
 assert.equal((await f.close('dirty-document')).json().preserved,true,'legacy bodyless DELETE cannot discard dirty state');
 const {waiting,barrier}=f.begin();assert.ok(barrier);await stillWaiting(waiting);
 assert.equal((await f.ack('dirty-document',barrier,true,3)).statusCode,409);
 assert.equal((await f.ack('dirty-document',barrier,false,4)).statusCode,200);
 await assert.rejects(soon(waiting),{statusCode:409});
 // A genuine later save has a higher protocol version and may then be revoked.
 assert.equal((await f.post('dirty-document',false,5)).json().ignored,undefined);
 assert.equal((await f.close('dirty-document',{path:file,dirty:false,bufferVersion:5})).json().closed,true);
 const next=f.begin();assert.equal(next.barrier,undefined);(await soon(next.waiting))();
});

test('unregistering one window cannot release another dirty window or an unrelated file',async t=>{
 const f=await fixture(t);await f.post('clean-window');await f.post('dirty-window',true,2);
 await f.post('other-file',true,1,'manuscript/other.tex');
 const {waiting,barrier}=f.begin();assert.ok(barrier);
 await f.close('clean-window',{path:file,dirty:false,bufferVersion:0});
 await f.close('dirty-window',{path:file,dirty:true,bufferVersion:2});
 await stillWaiting(waiting);
 assert.equal((await f.ack('other-file',barrier,true,2)).statusCode,409,'unrelated buffers do not acknowledge this file');
 assert.equal((await f.ack('dirty-window',barrier,false,2)).statusCode,200);
 await assert.rejects(soon(waiting),{statusCode:409});
 const next=f.begin();assert.ok(next.barrier);
 assert.equal((await f.ack('dirty-window',next.barrier,true,3)).statusCode,200);
 const release=await soon(next.waiting);release.assertActive();release();
});

test('a new dirty close invalidates a prior acknowledgement while another window is pending',async t=>{
 const f=await fixture(t);await f.post('first-window');await f.post('second-window');
 const {waiting,barrier}=f.begin();assert.ok(barrier);
 await f.ack('first-window',barrier,true,0);
 await f.close('first-window',{path:file,dirty:true,bufferVersion:1});
 await f.close('second-window',{path:file,dirty:false,bufferVersion:0});
 await stillWaiting(waiting);
 await f.ack('first-window',barrier,false,1);
 await assert.rejects(soon(waiting),{statusCode:409});
});

test('a granted editor lease rejects a later dirty state before the next file write',async t=>{
 const f=await fixture(t);await f.post('live-window');
 const {waiting,barrier}=f.begin();assert.ok(barrier);
 await f.ack('live-window',barrier,true,0);
 const release=await soon(waiting);release.assertActive();
 await f.close('live-window',{path:file,dirty:true,bufferVersion:1});
 assert.throws(()=>release.assertActive(),{statusCode:409});release();
});

test('dirty close protection outlives the clean-session lease',async t=>{
 const f=await fixture(t);let now=Date.now();t.mock.method(Date,'now',()=>now);
 await f.close('detached-dirty',{path:file,dirty:true,bufferVersion:1});
 now+=21000;
 const {waiting,barrier}=f.begin();assert.ok(barrier,'an unloaded dirty buffer must still be protected after 20 seconds');
 await f.ack('detached-dirty',barrier,false,1);
 await assert.rejects(soon(waiting),{statusCode:409});
 await f.post('detached-dirty',false,2);
 now+=21000;
 const next=f.begin();assert.equal(next.barrier,undefined,'a clean inactive editor may expire normally');
 (await soon(next.waiting))();
});
