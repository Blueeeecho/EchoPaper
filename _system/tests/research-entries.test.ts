import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {registerWorkspaceRoutes} from '../server/workspace/index';
import {entryPath} from '../shared/research-entries';
import {academicPath,academicRoute} from '../src/academic/navigation';
import {workTargetPath} from '../shared/research-targets';
test('research object/version links preserve explicit kind, topic and version safely',()=>{
 for(const kind of ['experiment','evidence'] as const){const e={id:'entry-one',kind};for(const version of [undefined,1,3]){const p=entryPath('topic-b',e,version);assert.equal(academicPath(academicRoute(p)),p);}const p=workTargetPath('topic-b',{kind:'research-entry',entryId:e.id,entryKind:kind})!;assert.equal(p,entryPath('topic-b',e));}
 for(const param of ['entry=../x','entry=%2Fetc','entry=%E0%A4%A'])assert.equal(academicRoute('/results?'+param).researchEntryId,undefined);
 assert.equal(academicRoute('/results?entry=e&revision=-1').entryRevision,undefined);assert.equal(academicRoute('/progress?entry=e').researchEntryId,undefined);
});
test('research entries retain legacy notes and immutable versions, CAS and exact source fingerprints',async()=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'research-entries-'));
 await fs.mkdir(path.join(root,'papers/p/manuscript'),{recursive:true});
 const file=path.join(root,'papers/p/manuscript/main.tex');await fs.writeFile(file,'original fixture content');
 await fs.writeFile(path.join(root,'papers/p/project.json'),JSON.stringify({schemaVersion:1,id:'p',title:'Fixture',stage:'writing',venue:'',deadline:'',targets:[],createdAt:'2026-01-01',updatedAt:'2026-01-01',autoCompile:false}));
 const start=async()=>{const app=Fastify();app.setErrorHandler((e,_r,reply)=>reply.code((e as any).statusCode||((e as any).code==='ENOENT'?404:500)).send({error:(e as Error).message}));
 const service=await registerWorkspaceRoutes(app,root,{watch:false});await app.ready();return{app,close:async()=>{await service.close();await app.close();}};};
 let run=await start();try{
  let t=(await run.app.inject({method:'POST',url:'/api/workspace/topics',payload:{title:'Fixture topic',paperIds:['p'],experimentPlan:'Original long plan',resultSummary:'Original long evidence'}})).json();
  const base=`/api/workspace/topics/${t.id}/entries`,source={kind:'paper-file',paperId:'p',path:'manuscript/main.tex'};
  const add=(body:object)=>run.app.inject({method:'POST',url:base,payload:{expectedRevision:t.revision,kind:'experiment',title:'Fixture test',...body}});
  for(const body of [{title:''},{state:'supports'},{state:'completed'},{sources:[{kind:'paper-file',paperId:'p',path:'../private'}]},{sources:[source,source]}])assert.equal((await add(body)).statusCode,400);
  let r=await add({question:'Does the fixture preserve the source?',sources:[source]});assert.equal(r.statusCode,201);let exp=r.json().entry;t=r.json().topic;
  assert.equal((await run.app.inject(`${base}/${exp.id}/edit-context`)).json().revision,t.revision);assert.equal(exp.state,'planned');assert.equal(exp.observation,'');assert.equal(exp.history.length,0);assert.match(exp.sources[0].fingerprint,/^[a-f0-9]{64}$/);assert.equal(exp.sources[0].fingerprint,createHash('sha256').update('original fixture content').digest('hex'));const firstHash=exp.sources[0].fingerprint,firstSource=structuredClone(exp.sources[0]);
  const edit=(e:any,body:object)=>run.app.inject({method:'PATCH',url:`${base}/${e.id}`,payload:{expectedRevision:t.revision,expectedEntryRevision:e.revision,...body}});
  assert.equal((await edit(exp,{expectedEntryRevision:0,title:'stale'})).statusCode,409);
  assert.equal((await edit(exp,{sources:[{kind:'research-entry',entryId:exp.id,entryKind:'experiment'}]})).statusCode,400);
  r=await edit(exp,{state:'completed',observation:'Fixture operation completed; no scientific result.'});assert.equal(r.statusCode,200);exp=r.json().entry;t=r.json().topic;assert.equal(exp.history.length,1);assert.equal(exp.history[0].observation,'');assert.deepEqual(exp.sources[0],firstSource);
  await fs.writeFile(file,'changed fixture content');let statuses=(await run.app.inject(`${base}/${exp.id}/source-status`)).json().statuses;assert.equal(statuses[0].state,'changed');
  r=await edit(exp,{limitations:'Source changed; review needed.'});exp=r.json().entry;t=r.json().topic;assert.equal(exp.sources[0].fingerprint,firstHash);
  r=await edit(exp,{refreshSources:true});exp=r.json().entry;t=r.json().topic;assert.notEqual(exp.sources[0].fingerprint,firstHash);assert.equal(exp.history[0].sources[0].fingerprint,firstHash);assert.equal((await run.app.inject(`${base}/${exp.id}/source-status`)).json().statuses[0].state,'current');
  assert.equal((await run.app.inject(`${base}/${exp.id}/source-status?revision=1`)).json().statuses[0].state,'changed');
  assert.equal((await add({kind:'evidence',state:'supports'})).statusCode,400);
  r=await add({kind:'evidence',title:'Fixture evidence',state:'mixed',observation:'A fixture-only observation.',conclusion:'Fixture-only judgment.',sources:[{kind:'research-entry',entryId:exp.id,entryKind:'experiment'}]});assert.equal(r.statusCode,201);const ev=r.json().entry;t=r.json().topic;
  assert.equal((await run.app.inject(`${base}/${ev.id}/source-status`)).json().statuses[0].state,'current');
  r=await edit(exp,{limitations:'Another revision.'});exp=r.json().entry;t=r.json().topic;assert.equal((await run.app.inject(`${base}/${ev.id}/source-status`)).json().statuses[0].state,'changed');
  t=(await run.app.inject({method:'POST',url:`/api/workspace/topics/${t.id}/progress`,payload:{expectedRevision:t.revision,kind:'task',day:'2026-11-06',content:'Open fixture evidence'}})).json();const task=t.progressEntries[0];
  const taskUrl=`/api/workspace/topics/${t.id}/daily-tasks/${task.id}/0`;
  t=(await run.app.inject({method:'PATCH',url:taskUrl,payload:{expectedRevision:t.revision,target:{kind:'research-entry',entryId:ev.id,entryKind:'evidence'}}})).json();assert.match((await run.app.inject(taskUrl+'/target')).json().path,/^\/results\?topic=.*&entry=/);
  r=await edit(exp,{archived:true});exp=r.json().entry;t=r.json().topic;assert.equal((await run.app.inject(`${base}/${ev.id}/source-status`)).json().statuses[0].state,'unavailable');
  const opts=(await run.app.inject(`/api/workspace/topics/${t.id}/work-targets`)).json().options;assert.equal(opts.some((o:any)=>o.target.entryId===exp.id),false);assert.ok(opts.some((o:any)=>o.target.entryId===ev.id));
  const other=(await run.app.inject({method:'POST',url:'/api/workspace/topics',payload:{title:'Other'}})).json();assert.equal((await run.app.inject(`/api/workspace/topics/${other.id}/entries/${exp.id}`)).statusCode,404);
  assert.equal(t.experimentPlan,'Original long plan');assert.equal(t.resultSummary,'Original long evidence');
  const saved=structuredClone(t);await run.close();run=await start();assert.deepEqual((await run.app.inject('/api/workspace/topics')).json().topics.find((v:any)=>v.id===t.id),saved);
 }finally{await run.close();await fs.rm(root,{recursive:true,force:true});}
});
