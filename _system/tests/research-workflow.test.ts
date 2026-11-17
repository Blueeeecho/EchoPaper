import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {registerWorkspaceRoutes} from '../server/workspace/index.ts';
import {academicRoute,academicPath} from '../src/academic/navigation.ts';

test('research notes and append-only progress persist with revision conflict protection',async()=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'echopaper-research-'));
 await fs.mkdir(path.join(root,'papers'));
 const make=async()=>{const app=Fastify();app.setErrorHandler((e,_req,reply)=>reply.code((e as Error&{statusCode?:number}).statusCode||500).send({error:(e as Error).message}));const service=await registerWorkspaceRoutes(app,root,{watch:false});await app.ready();return{app,async close(){await service.close();await app.close();}};};
 let runtime=await make();
 try{
  const created=await runtime.app.inject({method:'POST',url:'/api/workspace/topics',payload:{title:'Isolated validation fixture',description:'Question retained',stage:'ideation'}});assert.equal(created.statusCode,201);let topic=created.json();const url=`/api/workspace/topics/${topic.id}`;
  const notes=await runtime.app.inject({method:'PATCH',url,payload:{expectedRevision:topic.revision,stage:'experiments',experimentPlan:'Control and treatment; no results claimed.'}});assert.equal(notes.statusCode,200);topic=notes.json();
  const invalid=await runtime.app.inject({method:'PATCH',url,payload:{expectedRevision:topic.revision,stage:'invented',resultSummary:'must not save'}});assert.equal(invalid.statusCode,400);
  const stale=await runtime.app.inject({method:'PATCH',url,payload:{expectedRevision:1,experimentPlan:'must not overwrite'}});assert.equal(stale.statusCode,409);
  const results=await runtime.app.inject({method:'PATCH',url,payload:{expectedRevision:topic.revision,resultSummary:'Pending evidence; numerical fields left blank.'}});topic=results.json();assert.equal(results.statusCode,200);assert.equal(topic.stage,'experiments');assert.ok(topic.experimentPlan.includes('Control'));
  const revision=topic.revision;
  const concurrent=await Promise.all(['Entry A','Entry B'].map(content=>runtime.app.inject({method:'POST',url:url+'/progress',payload:{expectedRevision:revision,content,nextStep:'Collect evidence'}})));
  assert.deepEqual(concurrent.map(r=>r.statusCode).sort(),[201,409]);topic=concurrent.find(r=>r.statusCode===201)!.json();assert.equal(topic.progressEntries.length,1);assert.ok(topic.progressEntries[0].id);assert.ok(Date.parse(topic.progressEntries[0].createdAt));
  const empty=await runtime.app.inject({method:'POST',url:url+'/progress',payload:{expectedRevision:topic.revision,content:' '}});assert.equal(empty.statusCode,400);
  const rename=await runtime.app.inject({method:'PATCH',url,payload:{expectedRevision:topic.revision,title:'Renamed fixture',progressEntries:[]}});topic=rename.json();assert.equal(topic.progressEntries.length,1);assert.equal(topic.description,'Question retained');
  await runtime.close();runtime=await make();const stored=(await runtime.app.inject({method:'GET',url:'/api/workspace/topics'})).json().topics[0];assert.equal(stored.title,'Renamed fixture');assert.equal(stored.progressEntries.length,1);assert.equal(stored.resultSummary,topic.resultSummary);assert.equal(stored.experimentPlan,topic.experimentPlan);
 }finally{await runtime.close();await fs.rm(root,{recursive:true,force:true});}
});

test('research stage links preserve topic context and reject malformed paths',()=>{
 for(const section of ['topics','experiments','results','progress']){const value=`/${section}?topic=research-01`;assert.equal(academicPath(academicRoute(value)),value);}
 assert.equal(academicRoute('/experiments/../../secret').section,'home');
 assert.equal(academicRoute('/progress?topic=../secret').topicId,undefined);
});
