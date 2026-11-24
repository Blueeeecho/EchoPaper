import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {LightMyRequestResponse} from 'fastify';
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
test('the current app entry is uncached and missing browser bundles return 404',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-workbench-entry-'));
  const dist=path.join(root,'_system','dist');
  let app:Awaited<ReturnType<typeof createApp>>|undefined;
  try {
    await fs.mkdir(path.join(dist,'assets'),{recursive:true});
    await fs.writeFile(path.join(dist,'index.html'),'<title>EchoPaper</title>');
    await fs.writeFile(path.join(dist,'assets','current.js'),'export {};');
    app=await createApp({workspaceRoot:root,buildService:fakeBuilds,watch:false});
    for(const url of ['/','/index.html','/workbench']) {
      const entry:LightMyRequestResponse=await app.inject(url);
      assert.equal(entry.statusCode,200,entry.body);
      assert.equal(entry.headers['cache-control'],'no-store');
      assert.equal(entry.body,'<title>EchoPaper</title>');
    }
    assert.equal((await app.inject('/assets/current.js')).body,'export {};');
    assert.equal((await app.inject('/assets/previous.js')).statusCode,404);
    assert.equal((await app.inject('/pdfjs/missing.mjs')).statusCode,404);
    assert.equal((await app.inject('/api/absent')).statusCode,404);
  } finally {await app?.close();await fs.rm(root,{recursive:true,force:true});}
});
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
    const update=await app.inject({method:'PUT',url:`/api/projects/Alpha/reviews/${round.id}`,payload:{expectedHash:round.hash,items:[{id:'R1-Q1',reviewer:'Reviewer 1',comment:'Explain A & B.',response:'Thank you. $100 and 50% are literal text.',location:'manuscript/main.tex:3',status:'addressed'}]}});assert.equal(update.statusCode,200,update.body);
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

test('a paths-limited checkpoint only commits the named files and skips empty after-commits',async()=>{
  const {root,app,create,cleanup}=await fixture();
  try {
    await create('Alpha');
    const project=path.join(root,'papers/Alpha');
    const main=(await app.inject('/api/projects/Alpha/file?path=manuscript/main.tex')).json();
    const {execFile}=await import('node:child_process');
    const {promisify}=await import('node:util');
    const run=promisify(execFile);
    const git=async (...args:string[]) => (await run('/usr/bin/git',['-C',project,...args],{encoding:'utf8'})).stdout;
    await fs.writeFile(path.join(project,'notes/scratch.md'),'staged version\n');
    await git('add','--','notes/scratch.md');
    await fs.writeFile(path.join(project,'notes/scratch.md'),'residual note\n');
    await fs.writeFile(path.join(project,'notes/selected.md'),'New selected file\n');
    await app.inject({method:'PUT',url:'/api/projects/Alpha/file',payload:{path:main.path,content:'AI body\n',expectedHash:main.hash}});
    const rejected=await app.inject({method:'POST',url:'/api/projects/Alpha/checkpoints',payload:{message:'bad',paths:'manuscript/main.tex'}});
    assert.equal(rejected.statusCode,400);
    const after=await app.inject({method:'POST',url:'/api/projects/Alpha/checkpoints',payload:{message:'AI 修改后：应用 AI 建议 · manuscript/main.tex',paths:['manuscript/main.tex','notes/selected.md']}});
    assert.equal(after.statusCode,200,after.body);
    assert.equal(after.json().message,'AI 修改后：应用 AI 建议 · manuscript/main.tex');
    assert.equal(after.json().committed,true);
    const files=(await git('show','--pretty=format:','--name-only','HEAD')).split('\n').filter(Boolean);
    assert.deepEqual(files,['manuscript/main.tex','notes/selected.md']);
    assert.equal(await git('show',':notes/scratch.md'),'staged version\n');
    await fs.unlink(path.join(project,'notes/selected.md'));
    const deleted=await app.inject({method:'POST',url:'/api/projects/Alpha/checkpoints',payload:{message:'选中文件删除',paths:['notes/selected.md']}});
    assert.equal(deleted.statusCode,200,deleted.body);
    assert.equal(await git('show','--pretty=format:','--name-status','HEAD'),'D\tnotes/selected.md\n');
    assert.equal(await git('show',':notes/scratch.md'),'staged version\n');
    const empty=await app.inject({method:'POST',url:'/api/projects/Alpha/checkpoints',payload:{message:'AI 修改后：空提交',paths:['manuscript/main.tex']}});
    assert.equal(empty.statusCode,200,empty.body);
    assert.equal(empty.json().message,'选中文件删除');
    assert.equal(empty.json().committed,false);
    assert.equal(await fs.readFile(path.join(project,'notes/scratch.md'),'utf8'),'residual note\n');
    const dirty=(await run('/usr/bin/git',['--no-pager','-C',project,'status','--porcelain','--','notes/scratch.md'],{encoding:'utf8'})).stdout.trim();
    assert.ok(dirty);
  }finally{await cleanup();}
});

test('checkpoints report committed true or false, and omit-paths responses stay compatible',async()=>{
  const {root,app,create,cleanup}=await fixture();
  try {
    await create('Alpha');
    const project=path.join(root,'papers/Alpha');
    await fs.writeFile(path.join(project,'notes/scratch.md'),'residual note\n');
    const saved=await app.inject({method:'POST',url:'/api/projects/Alpha/checkpoints',payload:{message:'手工保存残留'}});
    assert.equal(saved.statusCode,200,saved.body);
    const savedBody=saved.json();
    assert.equal(typeof savedBody.hash,'string');
    assert.ok(savedBody.hash);
    assert.equal(typeof savedBody.date,'string');
    assert.equal(savedBody.message,'手工保存残留');
    assert.equal(savedBody.committed,true);
    const noop=await app.inject({method:'POST',url:'/api/projects/Alpha/checkpoints',payload:{message:'没有新改动'}});
    assert.equal(noop.statusCode,200,noop.body);
    const noopBody=noop.json();
    assert.equal(typeof noopBody.hash,'string');
    assert.equal(typeof noopBody.date,'string');
    assert.equal(noopBody.hash,savedBody.hash);
    assert.equal(noopBody.message,'手工保存残留');
    assert.equal(noopBody.committed,false);
    const emptyPaths=await app.inject({method:'POST',url:'/api/projects/Alpha/checkpoints',payload:{message:'带路径但无变更',paths:['notes/scratch.md']}});
    assert.equal(emptyPaths.statusCode,200,emptyPaths.body);
    assert.equal(emptyPaths.json().committed,false);
    assert.equal(emptyPaths.json().hash,savedBody.hash);
  }finally{await cleanup();}
});

test('review saves compare round hashes and can regenerate a failed source write',async()=>{
  const {root,app,create,cleanup}=await fixture();
  try {
    await create('Alpha');
    const base='/api/projects/Alpha/reviews';
    const round=(await app.inject({method:'POST',url:base,payload:{label:'Fixture'}})).json();
    const url=base+'/'+round.id;
    const put=(expectedHash:string,items:unknown)=>app.inject({method:'PUT',url,payload:{expectedHash,items}});
    const initial=(await put(round.hash,[{id:'A',response:'old A'},{id:'B',response:'old B'}])).json();
    const a=await put(initial.hash,[{id:'A',response:'new A'},{id:'B',response:'old B'}]);
    assert.equal(a.statusCode,200,a.body);
    const b=await put(initial.hash,[{id:'A',response:'old A'},{id:'B',response:'new B'}]);
    assert.equal(b.statusCode,409,b.body);
    assert.deepEqual(b.json().current.items.map((item:{response:string})=>item.response),['new A','old B']);
    const tex=path.join(root,'papers/Alpha/reviews',round.id,'response/responses.tex');
    await fs.unlink(tex);
    await fs.mkdir(tex);
    const saved=await put(a.json().hash,[{id:'A',response:'new A'},{id:'B',response:'new B'}]);
    assert.equal(saved.statusCode,200,saved.body);
    assert.equal(saved.json().needsSourceSync,true);
    assert.equal((await app.inject(base)).json().rounds[0].needsSourceSync,true);
    await fs.rmdir(tex);
    const regenerated=await put(saved.json().hash,saved.json().items);
    assert.equal(regenerated.statusCode,200,regenerated.body);
    assert.equal(regenerated.json().hash,saved.json().hash);
    assert.equal(regenerated.json().needsSourceSync,undefined);
    assert.match(await fs.readFile(tex,'utf8'),/new A[\s\S]*new B/);
  } finally {await cleanup();}
});

test('text editing rejects invalid UTF-8 and restores binary revisions by byte',async()=>{
  const {root,app,create,cleanup}=await fixture();
  try {
    await create('Alpha');
    const base='/api/projects/Alpha';
    const p=path.join(root,'papers/Alpha');
    const invalid='notes/legacy.tex', asset='manuscript/asset.bin';
    const legacy=Buffer.from([0x61,0xe9,0x62,10]), binary=Buffer.from([0x89,0x50,0,0xff]);
    await fs.writeFile(path.join(p,invalid),legacy);
    await fs.writeFile(path.join(p,asset),binary);
    const doc=(file:string)=>app.inject(base+'/file?path='+encodeURIComponent(file));
    assert.equal((await doc(invalid)).statusCode,415);
    const overwrite=await app.inject({method:'PUT',url:base+'/file',payload:{path:invalid,content:'test',expectedHash:'0'.repeat(64)}});
    assert.equal(overwrite.statusCode,415);
    assert.deepEqual(await fs.readFile(path.join(p,invalid)),legacy);
    const bom='notes/valid.md', bomBytes=Buffer.from('\uFEFF中文\n');
    await fs.writeFile(path.join(p,bom),bomBytes);
    const shown=(await doc(bom)).json();
    assert.equal((await app.inject({method:'PUT',url:base+'/file',payload:{path:bom,content:shown.content,expectedHash:shown.hash}})).statusCode,200);
    assert.deepEqual(await fs.readFile(path.join(p,bom)),bomBytes);
    const saved=await app.inject({method:'POST',url:base+'/checkpoints',payload:{message:'Binary baseline'}});
    assert.equal(saved.statusCode,200,saved.body);
    const replacement=Buffer.from([1,0,0x80]);
    await fs.writeFile(path.join(p,asset),replacement);
    const restored=await app.inject({method:'POST',url:base+'/restore',payload:{path:asset,ref:saved.json().hash}});
    assert.equal(restored.statusCode,200,restored.body);
    assert.deepEqual(restored.json(),{path:asset,restored:true});
    assert.deepEqual(await fs.readFile(path.join(p,asset)),binary);
    const recovery=path.join(p,'.workbench/recovery');
    const copies=await Promise.all((await fs.readdir(recovery)).map(name=>fs.readFile(path.join(recovery,name))));
    assert.ok(copies.some(copy=>copy.equals(replacement)));
  } finally {await cleanup();}
});

test('invalid presentation and OCR queue data do not stop the workbench or overwrite original bytes',async()=>{
  const {root,app,create,cleanup}=await fixture();
  let reopened:Awaited<ReturnType<typeof createApp>>|undefined;
  try {
    await create('Alpha');
    await app.close();
    const malformed='{interrupted';
    const presentation=path.join(root,'workspace/presentations/bad/presentation.json');
    const queue=path.join(root,'workspace/reading-layout/_processing.json');
    await fs.mkdir(path.dirname(presentation),{recursive:true});
    await fs.writeFile(presentation,malformed);
    await fs.writeFile(queue,malformed);
    reopened=await createApp({workspaceRoot:root,watch:false,buildService:fakeBuilds});
    assert.equal((await reopened.inject('/api/projects')).json().projects[0].id,'Alpha');
    assert.deepEqual((await reopened.inject('/api/presentations')).json(),{presentations:[],unavailable:['bad']});
    assert.equal((await reopened.inject('/api/presentations/bad')).statusCode,409);
    assert.equal((await reopened.inject('/api/workspace/bilingual/processing')).statusCode,503);
    assert.equal((await reopened.inject('/api/workspace/overview')).statusCode,200);
    assert.equal((await reopened.inject('/api/backups')).statusCode,200);
    await reopened.close();
    reopened=undefined;
    assert.equal(await fs.readFile(presentation,'utf8'),malformed);
    assert.equal(await fs.readFile(queue,'utf8'),malformed);
  }finally{await reopened?.close();await cleanup();}
});
