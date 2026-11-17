import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {registerWorkspaceRoutes} from '../server/workspace/index.ts';
import {researchCalendar,validResearchDay} from '../shared/research-calendar.ts';
import {getProject,patchProject} from '../server/projects.ts';
import {STAGES,normalizeStage} from '../shared/types.ts';

test('calendar edits retain the chosen work date, history, task completion and conflict protection across restart',async()=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'calendar-edit-'));
 await fs.mkdir(path.join(root,'papers'));
 const start=async()=>{const app=Fastify();app.setErrorHandler((e,_r,reply)=>reply.code((e as any).statusCode||500).send({error:(e as Error).message}));const service=await registerWorkspaceRoutes(app,root,{watch:false});await app.ready();return{app,close:async()=>{await service.close();await app.close();}};};
 let runtime=await start();
 try{
  let topic=(await runtime.app.inject({method:'POST',url:'/api/workspace/topics',payload:{title:'Calendar fixture'}})).json();
  const url=`/api/workspace/topics/${topic.id}/progress`;
  const add=async(payload:object)=>runtime.app.inject({method:'POST',url,payload:{expectedRevision:topic.revision,...payload}});
  for(const day of ['2026-02-30','2026-13-01','2026-2-01','not-a-date'])assert.equal((await add({content:'invalid date',day})).statusCode,400);
  assert.equal((await add({content:'invalid kind',kind:'deployment'})).statusCode,400);
  let response=await add({content:'Measured a discrepancy.',day:'2026-10-30',kind:'progress',nextStep:'Check the metric.'});assert.equal(response.statusCode,201);topic=response.json();
  const initial=topic.progressEntries[0];let calendar=researchCalendar([topic]);assert.equal(calendar.records[0].day,'2026-10-30');assert.equal(calendar.tasks[0].day,'2026-10-31');
  response=await runtime.app.inject({method:'PATCH',url:`/api/workspace/topics/${topic.id}/daily-tasks/${initial.id}/0`,payload:{expectedRevision:topic.revision,done:true}});assert.equal(response.statusCode,200);topic=response.json();
  response=await runtime.app.inject({method:'PATCH',url:`${url}/${initial.id}`,payload:{expectedRevision:topic.revision,content:'Corrected the metric description.',nextStep:'Check the metric.'}});assert.equal(response.statusCode,200);topic=response.json();
  calendar=researchCalendar([topic]);assert.equal(calendar.records.length,1);assert.equal(calendar.records[0].day,'2026-10-30');assert.equal(calendar.tasks[0].done,true);assert.equal(topic.progressEntries[0].content,'Measured a discrepancy.');
  response=await add({content:'Read the baseline paper.',day:'2026-11-09',kind:'task'});assert.equal(response.statusCode,201);topic=response.json();const taskEntry=topic.progressEntries.at(-1);
  calendar=researchCalendar([topic]);assert.equal(calendar.records.length,1);assert.equal(calendar.tasks.find(t=>t.entryId===taskEntry.id)?.day,'2026-11-09');
  response=await runtime.app.inject({method:'PATCH',url:`/api/workspace/topics/${topic.id}/daily-tasks/${taskEntry.id}/0`,payload:{expectedRevision:topic.revision,done:true}});assert.equal(response.statusCode,200);topic=response.json();
  const priorRevision=topic.revision;
  response=await runtime.app.inject({method:'PATCH',url:`${url}/${taskEntry.id}`,payload:{expectedRevision:priorRevision,content:'Read and compare the baseline.',day:'2026-11-10',kind:'task',nextStep:''}});assert.equal(response.statusCode,200);topic=response.json();
  calendar=researchCalendar([topic]);const updated=calendar.tasks.find(t=>t.text==='Read and compare the baseline.');assert.equal(updated?.day,'2026-11-10');assert.equal(updated?.done,true);
  assert.equal((await runtime.app.inject({method:'PATCH',url:`${url}/${taskEntry.id}`,payload:{expectedRevision:priorRevision,content:'stale overwrite'}})).statusCode,409);
  await runtime.close();runtime=await start();const persisted=(await runtime.app.inject('/api/workspace/topics')).json().topics[0];assert.deepEqual(persisted,topic);assert.equal(researchCalendar([persisted]).tasks.find(t=>t.text==='Read and compare the baseline.')?.done,true);
  assert.equal(validResearchDay('2028-02-29'),true);assert.equal(validResearchDay('2027-02-29'),false);
 }finally{await runtime.close();await fs.rm(root,{recursive:true,force:true});}
});

test('writing stages stay compact and legacy stages remain readable without rewriting manuscripts',async()=>{
 assert.deepEqual(STAGES,['writing','rebuttal','accepted','published']);
 assert.equal(normalizeStage('revision'),'rebuttal');assert.equal(normalizeStage('polishing'),'writing');assert.equal(normalizeStage('submitted'),'writing');assert.equal(normalizeStage('__proto__'),'writing');
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'writing-stages-'));
 try{
  await fs.mkdir(path.join(root,'papers','Legacy'),{recursive:true});
  const project={schemaVersion:1,id:'Legacy',title:'A paper',stage:'revision',venue:'',deadline:'',targets:[{id:'main',label:'Main',main:'manuscript/main.tex'}],autoCompile:false,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'};
  const file=path.join(root,'papers','Legacy','project.json');await fs.writeFile(file,JSON.stringify(project));assert.equal((await getProject(root,'Legacy')).stage,'rebuttal');assert.equal(JSON.parse(await fs.readFile(file,'utf8')).stage,'revision');
  const changed=await patchProject(root,'Legacy',{stage:'published',expectedUpdatedAt:project.updatedAt});assert.equal(changed.stage,'published');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
