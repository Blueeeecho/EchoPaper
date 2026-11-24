import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {openCatalog} from '../server/workspace/catalog.ts';
import {registerWorkspaceRoutes} from '../server/workspace/index.ts';

test('progress amendments retain history, serialize conflicts and persist chains',async()=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'echopaper-amend-'));await fs.mkdir(path.join(root,'papers'));
 const make=async()=>{const app=Fastify();app.setErrorHandler((e,_r,reply)=>reply.code((e as any).statusCode||500).send({error:(e as Error).message}));const service=await registerWorkspaceRoutes(app,root,{watch:false});await app.ready();return{app,close:async()=>{await service.close();await app.close();}};};
 let runtime=await make();
 try{
  let topic=(await runtime.app.inject({method:'POST',url:'/api/workspace/topics',payload:{title:'Isolated amendment'}})).json();const url=`/api/workspace/topics/${topic.id}/progress`;
  const append=await runtime.app.inject({method:'POST',url,payload:{expectedRevision:topic.revision,content:'original',nextStep:'original next'}});assert.equal(append.statusCode,201);topic=append.json();const original=structuredClone(topic.progressEntries[0]);
  const patch=(id:string,content:unknown,revision=topic.revision,nextStep:unknown='fixed next')=>runtime.app.inject({method:'PATCH',url:`${url}/${id}`,payload:{expectedRevision:revision,content,nextStep}});
  const snapshot=async()=>(await runtime.app.inject({method:'GET',url:'/api/workspace/topics'})).json().topics[0];
  for(const [id,content,next,status] of [[original.id,' ','',400],[original.id,'a'.repeat(10001),'',400],[original.id,'valid','n'.repeat(2001),400],['missing','valid','',404]] as const){assert.equal((await patch(id,content,topic.revision,next)).statusCode,status);assert.deepEqual(await snapshot(),topic);}
  assert.equal((await patch(original.id,'stale',topic.revision-1)).statusCode,409);assert.deepEqual(await snapshot(),topic);
  const replies=await Promise.all([patch(original.id,'correct A'),patch(original.id,'correct B')]);assert.deepEqual(replies.map(r=>r.statusCode).sort(),[200,409]);topic=replies.find(r=>r.statusCode===200)!.json();
  assert.equal(topic.progressEntries.length,2);const second=topic.progressEntries[1];assert.deepEqual(topic.progressEntries[0],{...original,supersededBy:second.id});assert.equal(second.amendsId,original.id);assert.ok(Date.parse(second.createdAt));assert.notEqual(second.id,original.id);
  assert.equal((await patch(original.id,'fork')).statusCode,409);assert.deepEqual(await snapshot(),topic);
  const chain=await patch(second.id,'latest');assert.equal(chain.statusCode,200);topic=chain.json();assert.equal(topic.progressEntries.length,3);assert.equal(topic.progressEntries[1].supersededBy,topic.progressEntries[2].id);assert.equal(topic.progressEntries[2].amendsId,second.id);
  await runtime.close();runtime=await make();assert.deepEqual(await snapshot(),topic);
  const regular=await runtime.app.inject({method:'POST',url,payload:{expectedRevision:topic.revision,content:'independent work'}});assert.equal(regular.statusCode,201);assert.equal(regular.json().progressEntries.length,4);assert.equal(regular.json().progressEntries[3].amendsId,undefined);
 }finally{await runtime.close();await fs.rm(root,{recursive:true,force:true});}
});

test('amendment respects total history limit without mutating records',async()=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'echopaper-amend-limit-'));await fs.mkdir(path.join(root,'papers'));
 const folder=path.join(root,'workspace');await fs.mkdir(folder);
 const entries=Array.from({length:5000},(_,i)=>({id:`entry-${i}`,content:'retained',nextStep:'',createdAt:'2020-01-01T00:00:00.000Z'}));
 const topic={id:'fixture',title:'limit',description:'',paperIds:[],presentationIds:[],resourceIds:[],archived:false,revision:1,createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-01-01T00:00:00.000Z',progressEntries:entries};
 const catalog=await openCatalog(root);catalog.state.topics.push(topic);await catalog.save();catalog.close();
 const app=Fastify();app.setErrorHandler((e,_r,reply)=>reply.code((e as any).statusCode||500).send({error:(e as Error).message}));const service=await registerWorkspaceRoutes(app,root,{watch:false});
 try{
 const r=await app.inject({method:'PATCH',url:'/api/workspace/topics/fixture/progress/entry-0',payload:{expectedRevision:1,content:'fixed'}});
 assert.equal(r.statusCode,413);assert.deepEqual((await app.inject({method:'GET',url:'/api/workspace/topics'})).json().topics[0],topic);
 }finally{await service.close();await app.close();await fs.rm(root,{recursive:true,force:true});}
});

test('failed amendment storage commit rolls back memory and permits a clean retry',async()=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'echopaper-amend-failure-'));await fs.mkdir(path.join(root,'papers'));
 const app=Fastify();app.setErrorHandler((e,_r,reply)=>reply.code((e as any).statusCode||500).send({error:(e as Error).message}));const service=await registerWorkspaceRoutes(app,root,{watch:false});
 let undo:()=>Promise<void>=async()=>{};
 try{
 let topic=(await app.inject({method:'POST',url:'/api/workspace/topics',payload:{title:'Failure fixture'}})).json();const url=`/api/workspace/topics/${topic.id}/progress`;
 topic=(await app.inject({method:'POST',url,payload:{expectedRevision:topic.revision,content:'original'}})).json();
 const sqlite=path.join(root,'workspace/catalog.sqlite');
 if(await fs.stat(sqlite).then(()=>true).catch(()=>false)){
 const {createRequire}=await import('node:module');const Database=createRequire(import.meta.url)('better-sqlite3');const db=new Database(sqlite);
 db.exec("CREATE TRIGGER reject_amend BEFORE UPDATE ON topics BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");undo=async()=>{db.exec('DROP TRIGGER reject_amend');db.close();};
 }else{
 const file=path.join(root,'workspace/catalog.json'),backup=file+'.saved';await fs.rename(file,backup);await fs.mkdir(file);undo=async()=>{await fs.rmdir(file);await fs.rename(backup,file);};
 }
 const request=()=>app.inject({method:'PATCH',url:`${url}/${topic.progressEntries[0].id}`,payload:{expectedRevision:topic.revision,content:'fixed'}});
 assert.ok((await request()).statusCode>=400);assert.deepEqual((await app.inject({method:'GET',url:'/api/workspace/topics'})).json().topics[0],topic);
 await undo();undo=async()=>{};assert.equal((await request()).statusCode,200);
 }finally{await undo();await service.close();await app.close();await fs.rm(root,{recursive:true,force:true});}
});
