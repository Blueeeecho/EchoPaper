import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {registerWorkspaceRoutes} from '../server/workspace/index.ts';
import {canonicalRoot,protectedPath} from '../server/workspace/paths.ts';
import {hash} from '../server/storage.ts';

async function fixture(){
 const directory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'research-notes-'));
 const root=path.join(directory,'app');await fs.mkdir(path.join(root,'papers'),{recursive:true});
 const app=Fastify();
 app.setErrorHandler((error,_request,reply)=>{const known=error as Error&{statusCode?:number;extra?:Record<string,unknown>};return reply.code(known.statusCode||500).send({error:known.message,...known.extra});});
 const service=await registerWorkspaceRoutes(app,root,{watch:false});
 async function call(method:'GET'|'POST'|'PATCH'|'PUT'|'DELETE',url:string,payload?:unknown,status=200){
  const response=await app.inject({method,url,payload:payload as any});assert.equal(response.statusCode,status,response.body);return response.json();
 }
 const topic=await call('POST','/api/workspace/topics',{title:'Research records'},201);
 const url=(section='experiments',noteId='')=>`/api/workspace/topics/${topic.id}/notes/${section}${noteId?`/${noteId}`:''}`;
 const create=(requestId:string=randomUUID(),section='experiments',day='2026-11-13')=>call('POST',url(section),{expectedHash:null,requestId,day},201);
 return {directory,root,app,service,topic,call,url,create,async close(){await service.close();await app.close();await fs.rm(directory,{recursive:true,force:true});}};
}

test('independent blank Markdown records have stable date names, topic links and library content',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await f.call('GET',f.url()),{notes:[]});
  const first=await f.create(),second=await f.create(),result=await f.create(randomUUID(),'results');
  assert.equal(first.name,'26_11_13.md');assert.equal(first.content,'');assert.equal(first.hash,hash(''));
  assert.equal(first.legacy,false);assert.equal(second.filename,'26_11_13_02.md');assert.notEqual(first.id,second.id);
  assert.equal(result.filename,'26_11_13.md');assert.match(first.path,/^workspace\/research-notes\/.+\/方案与实验\/26_11_13\.md$/);
  assert.equal(await fs.readFile(path.join(f.root,first.path),'utf8'),'');
  const saved=await f.call('PUT',f.url('experiments',first.id),{expectedHash:first.hash,content:'# 假设\n\n保留数据与分析。'});
  assert.equal(saved.hash,hash(saved.content));
  assert.equal((await f.call('GET',f.url('experiments',first.id))).content,saved.content);
  const notes=(await f.call('GET',f.url())).notes;assert.deepEqual(notes.map((n:any)=>n.id),[second.id,first.id]);
  const resources=await f.call('GET',`/api/workspace/resources?topicId=${f.topic.id}`);
  assert.equal(resources.total,3);assert.ok(resources.resources.some((item:any)=>item.id===first.id&&item.hash===saved.hash));
  assert.equal((await f.call('GET',`/api/workspace/resources/${first.id}/text`)).content,saved.content);
  const raw=await f.app.inject(`/api/workspace/resources/${first.id}/raw`);assert.equal(raw.statusCode,200);assert.equal(raw.body,saved.content);
  assert.equal((await f.call('GET',f.url('results'))).notes.length,1);
 }finally{await f.close();}
});

test('legacy fields remain separate virtual records and use hash compare-and-swap',async()=>{
 const f=await fixture();try{
  const original=await f.call('PATCH',`/api/workspace/topics/${f.topic.id}`,{expectedRevision:f.topic.revision,experimentPlan:'已有方案',resultSummary:'已有证据'});
  const note=await f.call('GET',f.url('experiments','overview'));
  assert.equal(note.content,'已有方案');assert.equal(note.path,null);assert.equal(note.name,'原有记录');assert.equal(note.legacy,true);
  assert.deepEqual((await f.call('GET',f.url())).notes.map((n:any)=>n.id),['overview']);
  const edited=await f.call('PUT',f.url('experiments','overview'),{expectedHash:note.hash,content:'更新方案'});
  assert.equal(edited.content,'更新方案');
  const stale=await f.call('PUT',f.url('experiments','overview'),{expectedHash:note.hash,content:'过时覆盖'},409);assert.equal(stale.current.content,'更新方案');
  const overview=await f.call('GET','/api/workspace/overview'),topic=overview.topics.find((item:any)=>item.id===f.topic.id);
  assert.equal(topic.resultSummary,'已有证据');assert.equal(topic.revision,original.revision+1);
  await f.call('PUT',f.url('experiments','overview'),{expectedHash:edited.hash,content:''});
  assert.deepEqual((await f.call('GET',f.url())).notes,[]);
 }finally{await f.close();}
});

test('concurrent creation and persisted request replay produce one file without resetting saved content',async()=>{
 const f=await fixture();try{
  const requestId=randomUUID(),records=await Promise.all(Array.from({length:5},()=>f.create(requestId)));
  assert.equal(new Set(records.map(note=>note.id)).size,1);
  const note=records[0];await f.call('PUT',f.url('experiments',note.id),{expectedHash:note.hash,content:'already edited'});
  assert.equal((await f.create(requestId)).content,'already edited');
  await f.call('POST',f.url(),{expectedHash:null,requestId,day:'2026-11-14'},409);
  for(const special of ['constructor','__proto__'])assert.equal((await f.create(special)).legacy,false);
  const other=Fastify(),reopened=await registerWorkspaceRoutes(other,f.root,{watch:false});try{
   const response=await other.inject({method:'POST',url:f.url(),payload:{expectedHash:null,requestId,day:'2026-11-13'}});
   assert.equal(response.statusCode,201,response.body);assert.equal(response.json().id,note.id);assert.equal(response.json().content,'already edited');
  }finally{await reopened.close();await other.close();}
  assert.equal((await f.call('GET',f.url())).notes.length,3);
 }finally{await f.close();}
});

test('external edits are indexed and stale saves retain the current file and dated-name collisions',async()=>{
 const f=await fixture();try{
  const folder=path.join(f.root,'workspace','research-notes',f.topic.id,'方案与实验');await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(path.join(folder,'26_11_13.md'),'external dated note');
  const note=await f.create();assert.equal(note.filename,'26_11_13_02.md');
  await fs.writeFile(path.join(f.root,note.path),'external change');
  const conflict=await f.call('PUT',f.url('experiments',note.id),{expectedHash:note.hash,content:'stale overwrite'},409);
  assert.equal(conflict.current.content,'external change');assert.equal(await fs.readFile(path.join(f.root,note.path),'utf8'),'external change');
  await fs.writeFile(path.join(folder,'new-experiment.md'),'fresh external record');
  const notes=(await f.call('GET',f.url())).notes;assert.equal(notes.length,3);
  const external=notes.find((item:any)=>item.name==='new-experiment.md');assert.ok(external?.id);
  const search=await f.call('GET',`/api/workspace/resources?topicId=${f.topic.id}&q=fresh`);assert.equal(search.resources[0].id,external.id);
  await fs.unlink(path.join(folder,'new-experiment.md'));await f.call('GET',f.url());
  assert.equal((await f.call('GET',`/api/workspace/resources/${external.id}`)).missing,true);
 }finally{await f.close();}
});

test('unfinished hard-link creation resumes with its planned identity and catalog-committed retries preserve text',async()=>{
 const f=await fixture();try{
  const requestId=randomUUID(),id=randomUUID(),folder=path.join(f.root,'workspace','research-notes',f.topic.id,'方案与实验');
  await fs.mkdir(folder,{recursive:true});const staged=path.join(folder,`.create-${requestId}.md`),filename='26_11_13.md';
  await fs.writeFile(staged,'');await fs.link(staged,path.join(folder,filename));
  const journal=path.join(path.dirname(folder),'experiments.requests.json');
  await fs.writeFile(journal,JSON.stringify({version:1,requests:{[requestId]:{id,filename,day:'2026-11-13',complete:false}}}));
  const note=await f.create(requestId);assert.equal(note.id,id);assert.equal(note.filename,filename);
  await f.call('PUT',f.url('experiments',id),{expectedHash:note.hash,content:'surviving text'});
  const log=JSON.parse(await fs.readFile(journal,'utf8'));log.requests[requestId].complete=false;await fs.writeFile(journal,JSON.stringify(log));
  const replay=await f.create(requestId);assert.equal(replay.id,id);assert.equal(replay.content,'surviving text');
  assert.equal((await f.call('GET',f.url())).notes.length,1);
 }finally{await f.close();}
});

test('note API rejects malformed inputs, invalid logs, archived writes and cross-section identities',async()=>{
 const f=await fixture();try{
  await f.call('GET',f.url('unknown'),undefined,400);
  for(const payload of [{expectedHash:'',requestId:'one'},{expectedHash:null,requestId:'../escape'},{expectedHash:null,requestId:'two',day:'2026-02-30'}])await f.call('POST',f.url(),payload,400);
  const note=await f.create();await f.call('GET',f.url('results',note.id),undefined,404);
  await f.call('PUT',f.url('experiments',note.id),{content:'missing hash'},400);
  const journal=path.join(f.root,'workspace','research-notes',f.topic.id,'experiments.requests.json');
  await fs.writeFile(journal,JSON.stringify({version:1,requests:{broken:{id:'safe',filename:'../../escape.md',day:'2026-11-13',complete:false}}}));
  await f.call('POST',f.url(),{expectedHash:null,requestId:'broken',day:'2026-11-13'},409);
  const topic=(await f.call('GET','/api/workspace/overview')).topics.find((item:any)=>item.id===f.topic.id);
  await f.call('PATCH',`/api/workspace/topics/${f.topic.id}`,{expectedRevision:topic.revision,archived:true});
  await f.call('PUT',f.url('experiments',note.id),{expectedHash:note.hash,content:'archived'},409);
 }finally{await f.close();}
});

test('managed-root exception remains narrow and note reads never follow symbolic links',async()=>{
 const f=await fixture();try{
  const note=await f.create(),folder=path.dirname(path.join(f.root,note.path));
  assert.equal(await canonicalRoot(f.root,folder),folder);
  await fs.mkdir(path.join(folder,'safe'));assert.equal(await canonicalRoot(f.root,path.join(folder,'safe')),path.join(folder,'safe'));
  for(const relative of ['workspace','workspace/research-notes',`workspace/research-notes/${f.topic.id}`,`workspace/research-notes/${f.topic.id}/其他`,`workspace/research-notes/${f.topic.id}/方案与实验/.hidden`,'workspace/chat'])assert.equal(protectedPath(f.root,path.join(f.root,relative)),true);
  const outside=path.join(f.directory,'outside.md');await fs.writeFile(outside,'outside source');
  await fs.unlink(path.join(f.root,note.path));await fs.symlink(outside,path.join(f.root,note.path));
  await f.call('GET',f.url('experiments',note.id),undefined,403);
  await f.call('PUT',f.url('experiments',note.id),{expectedHash:note.hash,content:'overwrite outside'},403);
  assert.equal(await fs.readFile(outside,'utf8'),'outside source');
  const results=path.join(path.dirname(folder),'结果与证据');await fs.symlink(f.directory,results);
  await f.call('POST',f.url('results'),{expectedHash:null,requestId:'safe-create',day:'2026-11-13'},403);
  const alias=path.join(folder,'alias');await fs.symlink(f.directory,alias);await assert.rejects(canonicalRoot(f.root,alias));
 }finally{await f.close();}
});


test('ideation notes are independent Markdown documents with heading names and topic-level identity',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await f.call('GET',f.url('ideation')),{notes:[]});
  await f.call('GET',f.url('ideation','overview'),undefined,404);
  const note=await f.create('independent-topic-note','ideation');
  assert.equal(note.content,'');assert.equal(note.name,'26_11_13.md');assert.equal(note.legacy,false);
  assert.match(note.path,/\/课题笔记\/26_11_13\.md$/);
  const content='起始思路\n\n## 背景\n\n# 跨文献研究笔记 ###\n\n可以持续整理多篇文章的思路。';
  const saved=await f.call('PUT',f.url('ideation',note.id),{expectedHash:note.hash,content});
  assert.equal(saved.name,'跨文献研究笔记');assert.equal(saved.filename,note.filename);assert.equal(saved.path,note.path);
  assert.equal((await f.call('GET',f.url('ideation'))).notes[0].name,'跨文献研究笔记');
  const replay=await f.create('independent-topic-note','ideation');assert.equal(replay.id,note.id);assert.equal(replay.content,content);
  const resource=await f.call('GET',`/api/workspace/resources/${note.id}`);assert.equal(resource.title,'跨文献研究笔记');assert.equal(resource.name,note.filename);
  const search=await f.call('GET',`/api/workspace/resources?topicId=${f.topic.id}&q=持续整理`);assert.equal(search.resources[0].id,note.id);
  const renamed=await f.call('PUT',f.url('ideation',note.id),{expectedHash:saved.hash,content:'# 关于 C#\n\n新的思路'});
  assert.equal(renamed.name,'关于 C#');
  const unnamed=await f.call('PUT',f.url('ideation',note.id),{expectedHash:renamed.hash,content:'正文没有一级标题'});
  assert.equal(unnamed.name,note.filename);assert.equal((await f.call('GET',`/api/workspace/resources/${note.id}`)).title,undefined);
 }finally{await f.close();}
});

test('ideation uses its own section, retains stale drafts on conflict and rejects archived writes',async()=>{
 const f=await fixture();try{
  const topic=await f.call('PATCH',`/api/workspace/topics/${f.topic.id}`,{expectedRevision:f.topic.revision,experimentPlan:'方案原文',resultSummary:'结果原文'});
  const note=await f.create('shared-request','ideation'),experiment=await f.create('shared-request','experiments');
  assert.notEqual(note.id,experiment.id);assert.equal(note.filename,experiment.filename);
  await f.call('GET',f.url('experiments',note.id),undefined,404);await f.call('GET',f.url('ideation',experiment.id),undefined,404);
  await fs.writeFile(path.join(f.root,note.path),'# 外部修改\n\n保留外部正文');
  const conflict=await f.call('PUT',f.url('ideation',note.id),{expectedHash:note.hash,content:'# 旧稿'},409);
  assert.equal(conflict.current.name,'外部修改');assert.equal(conflict.current.content,'# 外部修改\n\n保留外部正文');
  assert.equal((await f.call('GET',f.url('experiments','overview'))).content,'方案原文');
  assert.equal((await f.call('GET',f.url('results','overview'))).content,'结果原文');
  const current=(await f.call('GET','/api/workspace/topics')).topics.find((item:any)=>item.id===f.topic.id);
  await f.call('PATCH',`/api/workspace/topics/${f.topic.id}`,{expectedRevision:current.revision,archived:true});
  await f.call('PUT',f.url('ideation',note.id),{expectedHash:conflict.current.hash,content:'# archived'},409);
  await f.call('POST',f.url('ideation'),{expectedHash:null,requestId:'archived-create'},409);
 }finally{await f.close();}
});

test('ideation managed directory remains scoped and blocks symbolic-link reads',async()=>{
 const f=await fixture();try{
  const note=await f.create('safe-ideation','ideation'),folder=path.dirname(path.join(f.root,note.path));
  assert.equal(await canonicalRoot(f.root,folder),folder);
  assert.equal(protectedPath(f.root,path.dirname(folder)),true);
  assert.equal(protectedPath(f.root,path.join(folder,'.hidden')),true);
  const outside=path.join(f.directory,'outside-topic-note.md');await fs.writeFile(outside,'private external text');
  await fs.unlink(path.join(f.root,note.path));await fs.symlink(outside,path.join(f.root,note.path));
  await f.call('GET',f.url('ideation',note.id),undefined,403);
  await f.call('PUT',f.url('ideation',note.id),{expectedHash:note.hash,content:'overwrite'},403);
  assert.equal(await fs.readFile(outside,'utf8'),'private external text');
 }finally{await f.close();}
});

for(const section of ['ideation','experiments','results'])test(`${section} notes delete and restore with stable identity, retained content and cross-view indexing`,async()=>{
 const f=await fixture();try{
  const note=await f.create(`create-${section}`,section),saved=await f.call('PUT',f.url(section,note.id),{expectedHash:note.hash,content:'# 可恢复的思路\n\n记录原始证据与结论。'});
  const payload={expectedHash:saved.hash,requestId:`delete-${section}`};
  const result=await f.call('DELETE',f.url(section,note.id),payload);assert.equal(result.deletion.status,'applied');assert.equal(result.deletion.noteId,note.id);
  assert.deepEqual((await f.call('GET',f.url(section))).notes,[]);
  assert.equal((await f.call('GET',`/api/workspace/resources?topicId=${f.topic.id}&group=note`)).total,0);
  assert.ok(!(await f.call('GET','/api/workspace/overview')).resources.some((item:any)=>item.id===note.id));
  assert.equal((await f.call('GET',`/api/workspace/resources/${note.id}`)).missing,true);
  assert.ok((await f.call('GET','/api/workspace/topics')).topics[0].resourceIds.includes(note.id));
  const recycled=(await f.call('GET',f.url(section)+'/trash')).entries;assert.equal(recycled.length,1);assert.equal(recycled[0].id,payload.requestId);assert.equal(recycled[0].hash,saved.hash);
  assert.equal((await f.call('GET',f.url(section)+'/trash/'+payload.requestId)).content,saved.content);
  assert.deepEqual((await f.call('DELETE',f.url(section,note.id),payload)).deletion,result.deletion);
  assert.equal((await f.call('GET','/api/workspace/operations')).operations.length,1);
  const restored=await f.call('POST',f.url(section)+'/trash/'+payload.requestId+'/restore',{expectedHash:saved.hash});assert.equal(restored.id,note.id);assert.equal(restored.content,saved.content);
  const again=await f.call('POST',f.url(section)+'/trash/'+payload.requestId+'/restore',{expectedHash:saved.hash});assert.equal(again.id,note.id);
  assert.equal((await f.call('GET',`/api/workspace/resources?topicId=${f.topic.id}&group=note`)).total,1);
  assert.equal((await f.create(`create-${section}`,section)).id,note.id);
  const replay=await f.call('DELETE',f.url(section,note.id),payload,409);assert.equal(replay.deletion.status,'undone');
 }finally{await f.close();}
});

test('note deletion is hash guarded and restores never replace an occupied original',async()=>{
 const f=await fixture();try{
  const note=await f.create('hash-delete','ideation');const saved=await f.call('PUT',f.url('ideation',note.id),{expectedHash:note.hash,content:'current bytes'});
  const stale=await f.call('DELETE',f.url('ideation',note.id),{expectedHash:note.hash,requestId:'stale-delete'},409);assert.equal(stale.current.content,'current bytes');assert.equal((await f.call('GET','/api/workspace/operations')).operations.length,0);
  await f.call('DELETE',f.url('ideation',note.id),{expectedHash:saved.hash,requestId:'valid-delete'});
  await fs.writeFile(path.join(f.root,note.path),'new external bytes');
  await f.call('POST',f.url('ideation')+'/trash/valid-delete/restore',{expectedHash:saved.hash},409);
  assert.equal(await fs.readFile(path.join(f.root,note.path),'utf8'),'new external bytes');assert.equal((await f.call('GET',f.url('ideation')+'/trash/valid-delete')).content,'current bytes');
  await fs.unlink(path.join(f.root,note.path));await f.call('POST',f.url('ideation')+'/trash/valid-delete/restore',{expectedHash:saved.hash});
  assert.equal(await fs.readFile(path.join(f.root,note.path),'utf8'),'current bytes');
 }finally{await f.close();}
});

test('legacy note deletion and generic undo preserve both topic fields and recover conflicting content',async()=>{
 const f=await fixture();try{
  await f.call('PATCH',`/api/workspace/topics/${f.topic.id}`,{expectedRevision:f.topic.revision,experimentPlan:'原有方案',resultSummary:'原有结果'});
  const note=await f.call('GET',f.url('experiments','overview'));
  const deleted=await f.call('DELETE',f.url('experiments','overview'),{expectedHash:note.hash,requestId:'legacy-delete'});assert.equal(deleted.deletion.legacy,true);
  let topic=(await f.call('GET','/api/workspace/topics')).topics[0];assert.equal(topic.experimentPlan,'');assert.equal(topic.resultSummary,'原有结果');
  const copy=await f.call('GET',f.url('experiments')+'/trash/legacy-delete');assert.equal(copy.content,'原有方案');
  topic=await f.call('PATCH',`/api/workspace/topics/${topic.id}`,{expectedRevision:topic.revision,experimentPlan:'新的方案'});
  await f.call('POST',f.url('experiments')+'/trash/legacy-delete/restore',{expectedHash:note.hash},409);
  assert.equal((await f.call('GET','/api/workspace/topics')).topics[0].experimentPlan,'新的方案');
  await f.call('PATCH',`/api/workspace/topics/${topic.id}`,{expectedRevision:topic.revision,experimentPlan:''});
  await f.call('POST','/api/workspace/operations/legacy-delete/undo',{});
  const restored=await f.call('POST',f.url('experiments')+'/trash/legacy-delete/restore',{expectedHash:note.hash});assert.equal(restored.content,'原有方案');
  assert.equal((await f.call('GET','/api/workspace/topics')).topics[0].resultSummary,'原有结果');
 }finally{await f.close();}
});

test('note recycle endpoints keep topic and section identities scoped and reject archived writes',async()=>{
 const f=await fixture();try{
  const note=await f.create('scoped-note','ideation');
  await f.call('DELETE',f.url('ideation',note.id),{expectedHash:note.hash,requestId:'scoped-delete'});
  await f.call('GET',f.url('results')+'/trash/scoped-delete',undefined,404);
  await f.call('POST',f.url('results')+'/trash/scoped-delete/restore',{expectedHash:note.hash},404);
  const other=await f.call('POST','/api/workspace/topics',{title:'Other scope'},201);
  await f.call('POST',`/api/workspace/topics/${other.id}/notes/ideation/trash/scoped-delete/restore`,{expectedHash:note.hash},404);
  const topic=(await f.call('GET','/api/workspace/topics')).topics[0];await f.call('PATCH',`/api/workspace/topics/${topic.id}`,{expectedRevision:topic.revision,archived:true});
  await f.call('POST',f.url('ideation')+'/trash/scoped-delete/restore',{expectedHash:note.hash},409);
  await f.call('POST','/api/workspace/operations/scoped-delete/undo',{},409);
  const replay=await f.call('DELETE',f.url('ideation',note.id),{expectedHash:note.hash,requestId:'scoped-delete'});assert.equal(replay.deletion.status,'applied');
 }finally{await f.close();}
});

test('note recycling remains available after service restart and includes generic library deletions',async()=>{
 const f=await fixture();try{
  const note=await f.create('restart-delete','results'),resource=await f.call('GET',`/api/workspace/resources/${note.id}`);
  const operation=await f.call('POST','/api/workspace/operations',{kind:'trash',rootId:resource.rootId,resourceId:resource.id,expectedRevision:resource.revision,expectedHash:note.hash},201);
  assert.equal((await f.call('GET',f.url('results')+'/trash')).entries[0].id,operation.id);
  const other=Fastify(),service=await registerWorkspaceRoutes(other,f.root,{watch:false});try{
   const result=await other.inject({method:'POST',url:f.url('results')+`/trash/${operation.id}/restore`,payload:{expectedHash:note.hash}});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().id,note.id);
  }finally{await service.close();await other.close();}
 }finally{await f.close();}
});

test('simultaneous deletion retries create one recoverable operation and stale creation cannot resurrect it',async()=>{
 const f=await fixture();try{
  const note=await f.create('original-create','ideation'),payload={expectedHash:note.hash,requestId:'concurrent-delete'};
  const results=await Promise.all(Array.from({length:4},()=>f.call('DELETE',f.url('ideation',note.id),payload)));
  assert.equal(new Set(results.map(result=>result.deletion.id)).size,1);assert.equal((await f.call('GET',f.url('ideation')+'/trash')).entries.length,1);
  await f.call('POST',f.url('ideation'),{expectedHash:null,requestId:'original-create',day:'2026-11-13'},404);
  assert.deepEqual((await f.call('GET',f.url('ideation'))).notes,[]);
  const next=await f.create('next-create','ideation');assert.notEqual(next.filename,note.filename);
 }finally{await f.close();}
});
