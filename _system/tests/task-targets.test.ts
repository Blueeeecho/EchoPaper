import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {registerWorkspaceRoutes} from '../server/workspace/index';
import {academicPath,academicRoute} from '../src/academic/navigation';
import {normalizeWorkTarget,workTargetPath,previousTaskIndex} from '../shared/research-targets';
import {researchCalendar} from '../shared/research-calendar';
test('object links preserve file, review and resource scope; reject unsafe paths',()=>{
 for(const t of [{kind:'paper-file',paperId:'p',path:'manuscript/中文 intro.tex'},{kind:'review',paperId:'p',reviewId:'r2'},{kind:'resource',resourceId:'res-one'},{kind:'topic-note',field:'experimentPlan'}] as const){const url=workTargetPath('topic-one',t)!;assert.equal(academicPath(academicRoute(url)),url);}
 for(const value of ['../private','/etc/passwd','a\\b','C:/private','build/log','submissions/main.tex','.secret','a/.hidden','a//b','a/./b','a\0b','project.json']){assert.equal(normalizeWorkTarget({kind:'paper-file',paperId:'p',path:value}),undefined);assert.equal(academicRoute('/papers/p/writing?file='+encodeURIComponent(value)).paperFile,undefined);}
 assert.equal(normalizeWorkTarget({kind:'url',url:'https://example.org'}),undefined);
 assert.equal(academicRoute('/papers/p/reviews?review=../../x').reviewId,undefined);
 assert.equal(academicRoute('/papers/p/settings?file=notes/a.md').paperFile,undefined);
});
test('task identity survives reorder and unambiguous edits',()=>{
 assert.equal(previousTaskIndex(['A','B'],['B','A'],0),1);assert.equal(previousTaskIndex(['A','B'],['Edited A','B'],0),0);assert.equal(previousTaskIndex(['A','B'],['C'],0),-1);
});
test('targets enforce CAS, membership, file safety, history and stale links across restart',async()=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'task-targets-'));
 const project={schemaVersion:1,title:'Fixture paper',stage:'writing',venue:'',deadline:'',targets:[{id:'main',label:'Main',main:'manuscript/main.tex'}],createdAt:'2026-01-01',updatedAt:'2026-01-01',autoCompile:false};
 for(const id of ['p','outside']){await fs.mkdir(path.join(root,'papers',id,'manuscript'),{recursive:true});await fs.writeFile(path.join(root,'papers',id,'project.json'),JSON.stringify({...project,id}));await fs.writeFile(path.join(root,'papers',id,'manuscript/main.tex'),'fixture');}
 await fs.mkdir(path.join(root,'papers/p/reviews/r2'),{recursive:true});await fs.writeFile(path.join(root,'papers/p/reviews/r2/round.json'),JSON.stringify({id:'r2',label:'Second review',items:[]}));
 await fs.symlink(path.join(root,'papers/outside/manuscript/main.tex'),path.join(root,'papers/p/manuscript/link.tex'));
 const source=path.join(root,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'paper.md'),'source fixture');
 const start=async()=>{const app=Fastify();app.setErrorHandler((e,_r,r)=>r.code((e as any).statusCode||500).send({error:(e as Error).message}));const service=await registerWorkspaceRoutes(app,root,{watch:false});await app.ready();return{app,close:async()=>{await service.close();await app.close();}};};
 let run=await start();
 try{
  let t=(await run.app.inject({method:'POST',url:'/api/workspace/topics',payload:{title:'Fixture',paperIds:['p'],experimentPlan:'Existing plan'}})).json();
  await run.app.inject({method:'POST',url:'/api/workspace/roots',payload:{path:source,permission:'read'}});await run.close();run=await start();
  const res=(await run.app.inject('/api/workspace/resources')).json().resources.find((r:any)=>r.name==='paper.md');assert.ok(res);
  t=(await run.app.inject({method:'PATCH',url:`/api/workspace/topics/${t.id}`,payload:{expectedRevision:t.revision,resourceIds:[res.id]}})).json();
  t=(await run.app.inject({method:'POST',url:`/api/workspace/topics/${t.id}/progress`,payload:{expectedRevision:t.revision,content:'Old source',nextStep:'First\nSecond',day:'2026-11-05'}})).json();
  let entry=t.progressEntries[0];const endpoint=()=>`/api/workspace/topics/${t.id}/daily-tasks/${entry.id}/0`;
  const choices=(await run.app.inject(endpoint()+'/target-options')).json();assert.equal(choices.revision,t.revision);assert.equal(choices.taskText,'First');assert.deepEqual(new Set(choices.options.map((o:any)=>o.target.kind)),new Set(['paper-file','review','resource','topic-note']));assert.equal(choices.options.some((o:any)=>o.target.path==='manuscript/link.tex'),false);
  const patch=(payload:object)=>run.app.inject({method:'PATCH',url:endpoint(),payload:{expectedRevision:t.revision,...payload}});
  for(const target of [{kind:'paper-file',paperId:'outside',path:'manuscript/main.tex'},{kind:'resource',resourceId:'missing'},{kind:'paper-file',paperId:'p',path:'../outside'},{kind:'paper-file',paperId:'p',path:'manuscript/link.tex'}])assert.ok((await patch({target})).statusCode>=400);
  const target={kind:'paper-file',paperId:'p',path:'manuscript/main.tex'},prior=t.revision;
  let r=await patch({target});assert.equal(r.statusCode,200);t=r.json();assert.equal(t.progressEntries[0].content,'Old source');assert.deepEqual(researchCalendar([t]).tasks[0].target,target);
  assert.equal((await patch({expectedRevision:prior,target:null})).statusCode,409);
  t=(await patch({done:true})).json();assert.deepEqual(t.dailyTaskStates[`${entry.id}:0`].target,target);assert.match((await run.app.inject(endpoint()+'/target')).json().path,/file=manuscript%2Fmain.tex/);
  const old=entry;t=(await run.app.inject({method:'PATCH',url:`/api/workspace/topics/${t.id}/progress/${entry.id}`,payload:{expectedRevision:t.revision,content:'Amended source',nextStep:'Second\nFirst'}})).json();entry=t.progressEntries.at(-1);
  assert.equal((await run.app.inject(`/api/workspace/topics/${t.id}/daily-tasks/${old.id}/0/target`)).statusCode,409);assert.deepEqual(t.dailyTaskStates[`${entry.id}:1`].target,target);assert.equal(t.dailyTaskStates[`${entry.id}:1`].done,true);assert.equal(t.dailyTaskStates[`${entry.id}:0`]?.target,undefined);
  t=(await patch({target:{kind:'review',paperId:'p',reviewId:'r2'}})).json();assert.match((await run.app.inject(endpoint()+'/target')).json().path,/reviews\?review=r2$/);
  t=(await patch({target:{kind:'resource',resourceId:res.id}})).json();assert.match((await run.app.inject(endpoint()+'/target')).json().path,/resource=/);
  await fs.rm(path.join(source,'paper.md'));assert.ok((await run.app.inject(endpoint()+'/target')).statusCode>=400);assert.ok(t.dailyTaskStates[`${entry.id}:0`].target);
  t=(await patch({target:null})).json();assert.equal((await run.app.inject(endpoint()+'/target')).statusCode,404);
  t=(await patch({target})).json();await fs.rm(path.join(root,'papers/p/manuscript/main.tex'));assert.equal((await run.app.inject(endpoint()+'/target')).statusCode,404);await fs.writeFile(path.join(root,'papers/p/manuscript/main.tex'),'same fixture');
  t=(await run.app.inject({method:'PATCH',url:`/api/workspace/topics/${t.id}`,payload:{expectedRevision:t.revision,paperIds:[]}})).json();assert.equal((await run.app.inject(endpoint()+'/target')).statusCode,409);
  await run.close();run=await start();assert.deepEqual((await run.app.inject('/api/workspace/topics')).json().topics[0],t);
 }finally{await run.close();await fs.rm(root,{recursive:true,force:true});}
});
