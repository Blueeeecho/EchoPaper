import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/index.ts';
import type { BuildService } from '../shared/types.ts';

const fakeBuilds: BuildService = {
  async request(projectId,targetId) { return {id:'test-build',projectId,targetId,status:'queued',createdAt:new Date().toISOString(),log:'',diagnostics:[]}; },
  async cancel(id) { return {id,projectId:'Alpha',targetId:'main',status:'cancelled',createdAt:new Date().toISOString(),log:'',diagnostics:[]}; },
  async list() {return [];}, async get() {throw new Error('not implemented');}, async artifact() {throw new Error('not implemented');}, async createSubmission() {throw new Error('not implemented');}, async listSubmissions() {return [];}, async submissionArtifact() {throw new Error('not implemented');}, async close() {},
};
async function fixture(watch=false) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-workbench-core-'));
  for(const template of ['english','chinese','response']) { await fs.mkdir(path.join(root,'shared','templates',template),{recursive:true}); await fs.writeFile(path.join(root,'shared','templates',template,'main.tex'),'\\documentclass{article}\n\\begin{document}\nOriginal content.\n\\end{document}\n'); }
  await fs.mkdir(path.join(root,'papers'));
  const app=await createApp({workspaceRoot:root,buildService:fakeBuilds,watch});
  const create=async(id:string)=>{const result=await app.inject({method:'POST',url:'/api/projects',payload:{id,title:`Paper ${id}`,template:'english'}}); assert.equal(result.statusCode,201,result.body); return result.json();};
  const cleanup=async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});};
  return {root,app,create,cleanup};
}
test('optimistic saves reject stale clients and simultaneous writers preserve one complete version',async()=>{
  const {app,create,cleanup}=await fixture();
  try {
    await create('Alpha');
    const initial=(await app.inject('/api/projects/Alpha/file?path=manuscript/main.tex')).json();
    const results=await Promise.all(['first writer','second writer'].map(content=>app.inject({method:'PUT',url:'/api/projects/Alpha/file',payload:{path:initial.path,content,expectedHash:initial.hash}})));
    assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
    const winner=results.find(r=>r.statusCode===200)!.json(); const conflict=results.find(r=>r.statusCode===409)!.json();
    assert.equal(conflict.current.content,winner.content);
    const disk=(await app.inject('/api/projects/Alpha/file?path=manuscript/main.tex')).json(); assert.equal(disk.content,winner.content);
  } finally {await cleanup();}
});
test('external changes produce a conflict containing current disk contents',async()=>{
  const {root,app,create,cleanup}=await fixture();
  try {await create('Alpha');const initial=(await app.inject('/api/projects/Alpha/file?path=manuscript/main.tex')).json();await fs.writeFile(path.join(root,'papers/Alpha/manuscript/main.tex'),'Changed by Codex');const response=await app.inject({method:'PUT',url:'/api/projects/Alpha/file',payload:{path:initial.path,content:'Browser draft',expectedHash:initial.hash}});assert.equal(response.statusCode,409);assert.equal(response.json().current.content,'Changed by Codex');assert.equal(await fs.readFile(path.join(root,'papers/Alpha/manuscript/main.tex'),'utf8'),'Changed by Codex');}finally{await cleanup();}
});
test('path traversal, symlinks, reserved folders and foreign web origins are rejected',async()=>{
  const {root,app,create,cleanup}=await fixture();
  try {
    await create('Alpha'); await fs.writeFile(path.join(root,'secret.txt'),'secret'); await fs.symlink(path.join(root,'secret.txt'),path.join(root,'papers/Alpha/manuscript/leak.tex'));
    for(const filename of ['../../secret.txt','/etc/passwd','.git/config','build/fake.log','manuscript/leak.tex']) {
      const result=await app.inject('/api/projects/Alpha/file?path='+encodeURIComponent(filename)); assert.ok([400,403].includes(result.statusCode),`${filename}: ${result.statusCode}`);assert.ok(!result.body.includes('secret'));
    }
    const foreign=await app.inject({method:'POST',url:'/api/projects/Alpha/checkpoints',headers:{origin:'https://hostile.example'},payload:{message:'foreign'}});assert.equal(foreign.statusCode,403);
    const rebound=await app.inject({url:'/api/health',headers:{host:'attacker.example:4173'}});assert.equal(rebound.statusCode,403);
    const escaped=await app.inject({method:'PATCH',url:'/api/projects/Alpha',payload:{targets:[{id:'main',label:'bad',main:'../secret.tex'}]}});assert.equal(escaped.statusCode,400);
    for(const main of ['notes/main.tex','literature/main.tex','reviews/round-01/original/main.tex','reviews/round-01/main.tex']) { const unsafeTarget=await app.inject({method:'PATCH',url:'/api/projects/Alpha',payload:{targets:[{id:'main',label:'private',main}]}});assert.equal(unsafeTarget.statusCode,400,main); }
    const tree=(await app.inject('/api/projects/Alpha/files')).json().files;assert.ok(!tree.some((file:{path:string})=>file.path.includes('.git')||file.path.endsWith('leak.tex')));
    await fs.mkdir(path.join(root,'outside-reviews'));await fs.rm(path.join(root,'papers/Alpha/reviews'),{recursive:true});await fs.symlink(path.join(root,'outside-reviews'),path.join(root,'papers/Alpha/reviews'));
    const unsafeReview=await app.inject({method:'POST',url:'/api/projects/Alpha/reviews',payload:{label:'Do not write outside'}});assert.equal(unsafeReview.statusCode,403);assert.deepEqual(await fs.readdir(path.join(root,'outside-reviews')),[]);
  }finally{await cleanup();}
});
test('projects remain isolated and binary uploads never overwrite existing files',async()=>{
  const {root,app,create,cleanup}=await fixture();
  try {
    await create('Alpha');await create('Beta');
    const projectRefreshes=await Promise.all(Array.from({length:6},()=>app.inject('/api/projects')));assert.ok(projectRefreshes.every(response=>response.statusCode===200),'Concurrent project refreshes must not race Git configuration locks');
    const created=await app.inject({method:'PUT',url:'/api/projects/Alpha/file',payload:{path:'notes/only-alpha.md',content:'Only Alpha',expectedHash:null}});assert.equal(created.statusCode,200);
    const missing=await app.inject('/api/projects/Beta/file?path=notes/only-alpha.md');assert.equal(missing.statusCode,404);
    const multipart=(filename:string,content:string)=>Buffer.from(`--wb-boundary\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--wb-boundary--\r\n`);
    const upload=await app.inject({method:'POST',url:'/api/projects/Alpha/upload?directory=manuscript',headers:{'content-type':'multipart/form-data; boundary=wb-boundary'},payload:multipart('figure.bin','binary-asset')});assert.equal(upload.statusCode,200,upload.body);
    const duplicate=await app.inject({method:'POST',url:'/api/projects/Alpha/upload?directory=manuscript',headers:{'content-type':'multipart/form-data; boundary=wb-boundary'},payload:multipart('figure.bin','replaced')});assert.equal(duplicate.statusCode,409);
    assert.equal(await fs.readFile(path.join(root,'papers/Alpha/manuscript/figure.bin'),'utf8'),'binary-asset');
  }finally{await cleanup();}
});
test('history restoration checkpoints current work and creates a recovery copy',async()=>{
  const {root,app,create,cleanup}=await fixture();
  try {
    await create('Alpha');const initial=(await app.inject('/api/projects/Alpha/file?path=manuscript/main.tex')).json();const revisions=(await app.inject('/api/projects/Alpha/history')).json().history;const originalHash=revisions[0].hash;
    const changed=await app.inject({method:'PUT',url:'/api/projects/Alpha/file',payload:{path:initial.path,content:'Uncommitted newer draft',expectedHash:initial.hash}});assert.equal(changed.statusCode,200);
    const difference=await app.inject('/api/projects/Alpha/diff?path=manuscript/main.tex&ref='+originalHash);assert.ok(difference.json().diff.includes('Uncommitted newer draft'));
    const restored=await app.inject({method:'POST',url:'/api/projects/Alpha/restore',payload:{path:initial.path,ref:originalHash}});assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().content,initial.content);
    const after=(await app.inject('/api/projects/Alpha/history')).json().history;assert.ok(after.some((entry:{message:string})=>entry.message.startsWith('恢复前自动保存')));
    const backups=await fs.readdir(path.join(root,'papers/Alpha/.workbench/recovery'));const recovered=await Promise.all(backups.map(name=>fs.readFile(path.join(root,'papers/Alpha/.workbench/recovery',name),'utf8')));assert.ok(recovered.includes('Uncommitted newer draft'));
  }finally{await cleanup();}
});
test('review rounds persist original comments and generate isolated compilable reply targets',async()=>{
  const {root,app,create,cleanup}=await fixture();
  try {
    await create('Alpha');const roundResponse=await app.inject({method:'POST',url:'/api/projects/Alpha/reviews',payload:{label:'First revision'}});assert.equal(roundResponse.statusCode,200,roundResponse.body);const round=roundResponse.json();
    const original=path.join(root,'papers/Alpha/reviews',round.id,'original/original.md');await fs.writeFile(original,'Verbatim reviewer message.');
    const main=path.join(root,'papers/Alpha/reviews',round.id,'response/main.tex');const before=await fs.readFile(main,'utf8');
    const update=await app.inject({method:'PUT',url:`/api/projects/Alpha/reviews/${round.id}`,payload:{items:[{id:'R1-Q1',reviewer:'Reviewer 1',comment:'Explain A & B.',response:'Thank you. $100 and 50% are literal text.',location:'manuscript/main.tex:3',status:'addressed'}]}});assert.equal(update.statusCode,200,update.body);
    assert.equal(await fs.readFile(original,'utf8'),'Verbatim reviewer message.');assert.equal(await fs.readFile(main,'utf8'),before);
    const generated=await fs.readFile(path.join(root,'papers/Alpha/reviews',round.id,'response/responses.tex'),'utf8');assert.ok(generated.includes('A \\& B.'));assert.ok(generated.includes('\\$100'));assert.ok(generated.includes('50\\%'));
    const project=(await app.inject('/api/projects')).json().projects[0];assert.ok(project.targets.some((target:{id:string})=>target.id===round.targetId));
    const rounds=(await app.inject('/api/projects/Alpha/reviews')).json().rounds;assert.equal(rounds[0].items[0].status,'addressed');
  }finally{await cleanup();}
});
test('directory import copies source while keeping original intact and excludes nested Git',async()=>{
  const {root,app,cleanup}=await fixture();
  try {
    const source=path.join(root,'incoming/source');await fs.mkdir(path.join(source,'.git'),{recursive:true});await fs.writeFile(path.join(source,'main.tex'),'Imported source');await fs.writeFile(path.join(source,'.git/config'),'untrusted configuration');
    const imported=await app.inject({method:'POST',url:'/api/projects',payload:{id:'Imported',title:'Imported paper',importPath:'incoming/source'}});assert.equal(imported.statusCode,201,imported.body);
    assert.equal(await fs.readFile(path.join(source,'main.tex'),'utf8'),'Imported source');assert.equal(await fs.readFile(path.join(root,'papers/Imported/manuscript/main.tex'),'utf8'),'Imported source');
    await assert.rejects(fs.stat(path.join(root,'papers/Imported/manuscript/.git')));
  }finally{await cleanup();}
});
test('filesystem watcher streams external Codex edits over SSE',async()=>{
  const {root,app,create,cleanup}=await fixture(true);let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;const controller=new AbortController();
  try {
    await create('Alpha');const address=await app.listen({host:'127.0.0.1',port:0});const stream=await fetch(address+'/api/events',{signal:controller.signal});reader=stream.body!.getReader();await reader.read();
    await new Promise(resolve=>setTimeout(resolve,500));await fs.writeFile(path.join(root,'papers/Alpha/manuscript/main.tex'),'Changed externally');
    const event=await Promise.race([(async()=>{let text='';for(let count=0;count<30;count++){const chunk=await reader!.read();text+=new TextDecoder().decode(chunk.value);if(text.includes('manuscript/main.tex'))return text;}throw new Error('No matching event');})(),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('SSE timeout')),7000).unref())]);
    assert.ok(event.includes('file.changed'));assert.ok(event.includes('Alpha'));
  }finally{controller.abort();await reader?.cancel().catch(()=>undefined);await cleanup();}
});
