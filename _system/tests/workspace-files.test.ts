import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import Fastify from 'fastify';
import {workspaceMaintenance} from '../server/agents/maintenance.ts';

async function fixture(){
  const directory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'workspace-files-')),root=path.join(directory,'app'),source=path.join(directory,'originals'),other=path.join(directory,'second');
  for(const folder of [root,source,other])await fs.mkdir(folder);
  const module=await import('../server/workspace/index.ts').catch(()=>undefined);assert.ok(module?.registerWorkspaceRoutes,'the workspace backend must be available');
  const app=Fastify();app.setErrorHandler((error,_request,reply)=>{const known=error as Error&{statusCode?:number};return reply.code(known.statusCode||500).send({error:known.message});});const service=await module.registerWorkspaceRoutes(app,root,{watch:false});
  async function call(method:'GET'|'POST'|'PATCH',url:string,payload?:unknown,expected=200){const response=await app.inject({method,url,payload:payload as any});assert.equal(response.statusCode,expected,response.body);return response.json();}
  async function settle(id:string){for(let i=0;i<300;i++){const item=(await call('GET','/api/workspace/roots')).roots.find((r:any)=>r.id===id);if(item.status!=='scanning')return item;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('scan did not finish');}
  async function connect(folder=source,permission='write'){const item=await call('POST','/api/workspace/roots',{path:folder,permission,label:path.basename(folder)},201);await settle(item.id);return item;}
  async function resource(name:string){const items=(await call('GET','/api/workspace/resources')).resources;const item=items.find((r:any)=>r.path===name);assert.ok(item,`missing indexed ${name}`);return await call('GET',`/api/workspace/resources/${item.id}`);}
  return {directory,root,source,other,app,service,call,settle,connect,resource,async close(){await service.close();await app.close();await fs.rm(directory,{recursive:true,force:true});}};
}

test('rename preserves resource identity, tags and topic links and supports undo',async()=>{
  const f=await fixture();try{
    await fs.writeFile(path.join(f.source,'before.md'),'original');const root=await f.connect();let item=await f.resource('before.md');item=await f.call('PATCH',`/api/workspace/resources/${item.id}`,{tags:['keep'],expectedRevision:item.revision});const topic=await f.call('POST','/api/workspace/topics',{title:'Test',resourceIds:[item.id]},201);
    const operation=await f.call('POST','/api/workspace/operations',{kind:'move',rootId:root.id,resourceId:item.id,destinationRootId:root.id,destinationPath:'after.md',expectedRevision:item.revision,expectedHash:item.hash},201);
    const moved=await f.resource('after.md');assert.equal(moved.id,item.id);assert.deepEqual(moved.tags,['keep']);assert.equal(await fs.readFile(path.join(f.source,'after.md'),'utf8'),'original');assert.deepEqual((await f.call('GET','/api/workspace/topics')).topics.find((t:any)=>t.id===topic.id).resourceIds,[item.id]);
    const undone=await f.call('POST',`/api/workspace/operations/${operation.id}/undo`,{});assert.equal(undone.status,'undone');assert.equal((await f.resource('before.md')).id,item.id);assert.equal(await fs.stat(path.join(f.source,'after.md')).catch(()=>null),null);
  }finally{await f.close();}
});

test('move CAS and undo conflicts preserve both author versions',async()=>{
  const f=await fixture();try{
    await fs.writeFile(path.join(f.source,'before.md'),'original');const root=await f.connect(),item=await f.resource('before.md');
    await fs.writeFile(path.join(f.source,'before.md'),'external edit');await f.call('POST','/api/workspace/operations',{kind:'move',rootId:root.id,resourceId:item.id,destinationPath:'after.md',destinationRootId:root.id,expectedRevision:item.revision,expectedHash:item.hash},409);
    const current=await f.resource('before.md');const operation=await f.call('POST','/api/workspace/operations',{kind:'move',rootId:root.id,resourceId:item.id,destinationPath:'after.md',destinationRootId:root.id,expectedRevision:current.revision,expectedHash:current.hash},201);
    await fs.writeFile(path.join(f.source,'before.md'),'replacement');await fs.writeFile(path.join(f.source,'after.md'),'new author edit');await f.call('POST',`/api/workspace/operations/${operation.id}/undo`,{},409);
    assert.equal(await fs.readFile(path.join(f.source,'before.md'),'utf8'),'replacement');assert.equal(await fs.readFile(path.join(f.source,'after.md'),'utf8'),'new author edit');
  }finally{await f.close();}
});

test('trash a directory and restore all descendant identities and contents',async()=>{
  const f=await fixture();try{
    await fs.mkdir(path.join(f.source,'folder'));await fs.writeFile(path.join(f.source,'folder','paper.txt'),'retained');const root=await f.connect(),folder=await f.resource('folder'),child=await f.resource('folder/paper.txt');
    const operation=await f.call('POST','/api/workspace/operations',{kind:'trash',rootId:root.id,resourceId:folder.id,expectedRevision:folder.revision,expectedHash:folder.hash},201);
    assert.equal(await fs.stat(path.join(f.source,'folder')).catch(()=>null),null);assert.equal((await f.call('GET',`/api/workspace/resources/${child.id}`)).missing,true);
    await f.call('POST',`/api/workspace/operations/${operation.id}/undo`,{});assert.equal((await f.resource('folder/paper.txt')).id,child.id);assert.equal(await fs.readFile(path.join(f.source,'folder','paper.txt'),'utf8'),'retained');
  }finally{await f.close();}
});

test('cross-root directory moves keep IDs and never overwrite occupied destinations',async()=>{
  const f=await fixture();try{
    await fs.mkdir(path.join(f.source,'folder'));await fs.writeFile(path.join(f.source,'folder','paper.txt'),'original');const a=await f.connect(),b=await f.connect(f.other),folder=await f.resource('folder'),child=await f.resource('folder/paper.txt');
    await fs.mkdir(path.join(f.other,'occupied'));await fs.writeFile(path.join(f.other,'occupied','unrelated.txt'),'keep');await f.call('POST','/api/workspace/operations',{kind:'move',rootId:a.id,resourceId:folder.id,destinationRootId:b.id,destinationPath:'occupied',expectedRevision:folder.revision,expectedHash:folder.hash},409);
    const operation=await f.call('POST','/api/workspace/operations',{kind:'move',rootId:a.id,resourceId:folder.id,destinationRootId:b.id,destinationPath:'moved',expectedRevision:folder.revision,expectedHash:folder.hash},201);
    const moved=await f.resource('moved/paper.txt');assert.equal(moved.id,child.id);assert.equal(moved.rootId,b.id);assert.equal(await fs.readFile(path.join(f.other,'occupied','unrelated.txt'),'utf8'),'keep');
    await f.call('POST',`/api/workspace/operations/${operation.id}/undo`,{});assert.equal((await f.resource('folder/paper.txt')).rootId,a.id);
  }finally{await f.close();}
});

test('mkdir, source permissions, symlinks, traversal and backup barriers are enforced',async()=>{
  const f=await fixture();try{
    const root=await f.connect();for(const name of ['../escape','/absolute','.echopaper-trash/bad','a/../../bad'])await f.call('POST','/api/workspace/operations',{kind:'mkdir',rootId:root.id,path:name},name.startsWith('.echopaper')?403:400);
    const operation=await f.call('POST','/api/workspace/operations',{kind:'mkdir',rootId:root.id,path:'new'},201);assert.ok(await fs.stat(path.join(f.source,'new')));await f.call('POST',`/api/workspace/operations/${operation.id}/undo`,{});assert.equal(await fs.stat(path.join(f.source,'new')).catch(()=>null),null);
    await fs.symlink(f.other,path.join(f.source,'alias'));await f.call('POST','/api/workspace/operations',{kind:'mkdir',rootId:root.id,path:'alias/escape'},403);
    await workspaceMaintenance(f.root).withMaintenance(async()=>{await f.call('POST','/api/workspace/operations',{kind:'mkdir',rootId:root.id,path:'blocked'},503);});
    const readonly=await f.connect(f.other,'read');await f.call('POST','/api/workspace/operations',{kind:'mkdir',rootId:readonly.id,path:'blocked'},403);
  }finally{await f.close();}
});

test('simultaneous moves never replace the first destination',async()=>{
  const f=await fixture();try{
    await fs.writeFile(path.join(f.source,'first.txt'),'first');await fs.writeFile(path.join(f.source,'second.txt'),'second');const root=await f.connect(),a=await f.resource('first.txt'),b=await f.resource('second.txt');
    const responses=await Promise.all([a,b].map(item=>f.app.inject({method:'POST',url:'/api/workspace/operations',payload:{kind:'move',rootId:root.id,resourceId:item.id,destinationRootId:root.id,destinationPath:'target.txt',expectedHash:item.hash,expectedRevision:item.revision}})));
    assert.deepEqual(responses.map(r=>r.statusCode).sort(),[201,409]);const content=await fs.readFile(path.join(f.source,'target.txt'),'utf8');assert.ok(['first','second'].includes(content));const retained=content==='first'?'second.txt':'first.txt';assert.equal(await fs.readFile(path.join(f.source,retained),'utf8'),content==='first'?'second':'first');
  }finally{await f.close();}
});

test('undo refuses content and metadata changes, and nonempty mkdir',async()=>{
  const f=await fixture();try{
    await fs.writeFile(path.join(f.source,'a.txt'),'original');const root=await f.connect(),item=await f.resource('a.txt');const move=await f.call('POST','/api/workspace/operations',{kind:'move',rootId:root.id,resourceId:item.id,destinationPath:'b.txt',expectedRevision:item.revision,expectedHash:item.hash},201);
    await fs.writeFile(path.join(f.source,'b.txt'),'author changed');await f.call('POST',`/api/workspace/operations/${move.id}/undo`,{},409);assert.equal(await fs.readFile(path.join(f.source,'b.txt'),'utf8'),'author changed');
    const mkdir=await f.call('POST','/api/workspace/operations',{kind:'mkdir',rootId:root.id,path:'folder'},201);await fs.writeFile(path.join(f.source,'folder','author.txt'),'keep');await f.call('POST',`/api/workspace/operations/${mkdir.id}/undo`,{},409);assert.equal(await fs.readFile(path.join(f.source,'folder','author.txt'),'utf8'),'keep');
  }finally{await f.close();}
});

test('startup completes metadata after a verified move lost its final journal update',async()=>{
  const f=await fixture();try{
    await fs.writeFile(path.join(f.source,'before.txt'),'recoverable');const root=await f.connect(),item=await f.resource('before.txt');const operation=await f.call('POST','/api/workspace/operations',{kind:'move',rootId:root.id,resourceId:item.id,destinationPath:'after.txt',expectedRevision:item.revision,expectedHash:item.hash},201);await f.service.close();
    const Database=createRequire(import.meta.url)('better-sqlite3'),database=new Database(path.join(f.root,'workspace/catalog.sqlite'));const state=JSON.parse(database.prepare('SELECT payload FROM catalog WHERE id=1').get().payload),journal=state.operations.find((o:any)=>o.id===operation.id);state.resources=structuredClone(journal.records);journal.status='interrupted';journal.phase='copied';journal.undoable=false;delete journal.appliedRevisions;database.prepare('UPDATE catalog SET payload=? WHERE id=1').run(JSON.stringify(state));database.close();
    const {registerWorkspaceRoutes}=await import('../server/workspace/index.ts'),app=Fastify(),service=await registerWorkspaceRoutes(app,f.root,{watch:false});try{const overview=await service.overview();assert.equal(overview.operations[0].status,'applied');assert.equal(overview.resources[0].id,item.id);assert.equal(overview.resources[0].path,'after.txt');assert.equal(await fs.readFile(path.join(f.source,'after.txt'),'utf8'),'recoverable');}finally{await service.close();await app.close();}
  }finally{await f.close();}
});

test('startup preserves both copies when an interrupted move has no unambiguous completion',async()=>{
  const f=await fixture();try{
    await fs.writeFile(path.join(f.source,'before.txt'),'recoverable');const root=await f.connect(),item=await f.resource('before.txt');const operation=await f.call('POST','/api/workspace/operations',{kind:'move',rootId:root.id,resourceId:item.id,destinationPath:'after.txt',expectedRevision:item.revision,expectedHash:item.hash},201);await f.service.close();await fs.writeFile(path.join(f.source,'before.txt'),'author after interruption');
    const Database=createRequire(import.meta.url)('better-sqlite3'),database=new Database(path.join(f.root,'workspace/catalog.sqlite'));const state=JSON.parse(database.prepare('SELECT payload FROM catalog WHERE id=1').get().payload),journal=state.operations.find((o:any)=>o.id===operation.id);state.resources=structuredClone(journal.records);journal.status='interrupted';journal.phase='copied';journal.undoable=false;delete journal.appliedRevisions;database.prepare('UPDATE catalog SET payload=? WHERE id=1').run(JSON.stringify(state));database.close();
    const {registerWorkspaceRoutes}=await import('../server/workspace/index.ts'),app=Fastify(),service=await registerWorkspaceRoutes(app,f.root,{watch:false});try{assert.equal((await service.overview()).operations[0].status,'interrupted');assert.equal(await fs.readFile(path.join(f.source,'before.txt'),'utf8'),'author after interruption');assert.equal(await fs.readFile(path.join(f.source,'after.txt'),'utf8'),'recoverable');}finally{await service.close();await app.close();}
  }finally{await f.close();}
});

test('undoing a new directory retains topic references as a missing resource',async()=>{
  const f=await fixture();try{
    const root=await f.connect(),operation=await f.call('POST','/api/workspace/operations',{kind:'mkdir',rootId:root.id,path:'linked'},201),item=await f.resource('linked');await f.call('POST','/api/workspace/topics',{title:'Linked folder',resourceIds:[item.id]},201);await f.call('POST',`/api/workspace/operations/${operation.id}/undo`,{});const retained=await f.call('GET',`/api/workspace/resources/${item.id}`);assert.equal(retained.missing,true);assert.equal((await f.call('GET','/api/workspace/topics')).topics[0].resourceIds[0],item.id);
  }finally{await f.close();}
});

test('create-file writes exact UTF-8 including empty files and indexes a stable resource',async()=>{
  const f=await fixture();try{
    const root=await f.connect(),content='中文新建文件\nEnglish evidence\n',created=await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:root.id,path:'new.md',content,expectedHash:null},201);assert.equal(created.kind,'create-file');assert.equal(await fs.readFile(path.join(f.source,'new.md'),'utf8'),content);const item=await f.resource('new.md');assert.equal(item.id,created.resourceId);assert.equal(item.kind,'file');assert.equal((await f.call('GET',`/api/workspace/resources/${item.id}/text`)).content,content);
    await f.call('POST',`/api/workspace/roots/${root.id}/scan`,{},202);await f.settle(root.id);assert.equal((await f.resource('new.md')).id,item.id);const empty=await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:root.id,path:'empty.txt',content:'',expectedHash:null},201);assert.equal((await fs.stat(path.join(f.source,'empty.txt'))).size,0);assert.equal((await f.resource('empty.txt')).id,empty.resourceId);
  }finally{await f.close();}
});

test('create-file requires null CAS, rejects conflicts, unsafe paths and invalid content without overwriting',async()=>{
  const f=await fixture();try{
    const root=await f.connect();await fs.writeFile(path.join(f.source,'existing.txt'),'author original');
    for(const expectedHash of [undefined,'a'.repeat(64)])await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:root.id,path:'new.txt',content:'new',...(expectedHash!==undefined?{expectedHash}:{})},400);
    await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:root.id,path:'existing.txt',content:'replacement',expectedHash:null},409);assert.equal(await fs.readFile(path.join(f.source,'existing.txt'),'utf8'),'author original');
    await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:root.id,path:'../escape.txt',content:'new',expectedHash:null},400);await fs.symlink(f.other,path.join(f.source,'alias'));await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:root.id,path:'alias/outside.txt',content:'new',expectedHash:null},403);
    await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:root.id,path:'bad.txt',content:'\ud800',expectedHash:null},400);const readonly=await f.connect(f.other,'read');await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:readonly.id,path:'new.txt',content:'new',expectedHash:null},403);
  }finally{await f.close();}
});

test('create-file undo retains a recovery copy and refuses changed or replaced original content',async()=>{
  const f=await fixture();try{
    const root=await f.connect(),created=await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:root.id,path:'new.txt',content:'recoverable bytes',expectedHash:null},201),undone=await f.call('POST',`/api/workspace/operations/${created.id}/undo`,{});assert.equal(undone.status,'undone');assert.ok(undone.recovery?.path);assert.equal(await fs.readFile(path.join(f.source,undone.recovery.path),'utf8'),'recoverable bytes');assert.equal(await fs.stat(path.join(f.source,'new.txt')).catch(()=>null),null);assert.equal((await f.call('GET',`/api/workspace/resources/${created.resourceId}`)).missing,true);
    const changed=await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:root.id,path:'changed.txt',content:'initial',expectedHash:null},201);await fs.writeFile(path.join(f.source,'changed.txt'),'author changed');await f.call('POST',`/api/workspace/operations/${changed.id}/undo`,{},409);assert.equal(await fs.readFile(path.join(f.source,'changed.txt'),'utf8'),'author changed');
    const replaced=await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:root.id,path:'replaced.txt',content:'same bytes',expectedHash:null},201);await fs.rename(path.join(f.source,'replaced.txt'),path.join(f.source,'preserved-original.txt'));await fs.writeFile(path.join(f.source,'replaced.txt'),'same bytes');await f.call('POST',`/api/workspace/operations/${replaced.id}/undo`,{},409);assert.equal(await fs.readFile(path.join(f.source,'replaced.txt'),'utf8'),'same bytes');
  }finally{await f.close();}
});

test('create-file recovery finalizes a persisted creation and an interrupted undo without deleting its copy',async()=>{
  const f=await fixture();try{
    const root=await f.connect(),created=await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:root.id,path:'recovered.txt',content:'durable creation',expectedHash:null},201);await f.service.close();const Database=createRequire(import.meta.url)('better-sqlite3'),db=new Database(path.join(f.root,'workspace/catalog.sqlite'));let state=JSON.parse(db.prepare('SELECT payload FROM catalog WHERE id=1').get().payload),journal=state.operations.find((o:any)=>o.id===created.id);state.resources=state.resources.filter((r:any)=>r.id!==created.resourceId);journal.status='interrupted';journal.phase='copied';journal.undoable=false;delete journal.appliedRevisions;db.prepare('UPDATE catalog SET payload=? WHERE id=1').run(JSON.stringify(state));db.close();
    const {registerWorkspaceRoutes}=await import('../server/workspace/index.ts'),app=Fastify(),service=await registerWorkspaceRoutes(app,f.root,{watch:false});let undo:any;try{assert.equal((await service.overview()).operations[0].status,'applied');const response=await app.inject({method:'POST',url:`/api/workspace/operations/${created.id}/undo`,payload:{}});assert.equal(response.statusCode,200,response.body);undo=response.json();}finally{await service.close();await app.close();}
    const next=new Database(path.join(f.root,'workspace/catalog.sqlite'));state=JSON.parse(next.prepare('SELECT payload FROM catalog WHERE id=1').get().payload);journal=state.operations.find((o:any)=>o.id===created.id);journal.status='applied';journal.phase='undoing';journal.undoable=true;state.resources=structuredClone(journal.records);next.prepare('UPDATE catalog SET payload=? WHERE id=1').run(JSON.stringify(state));next.close();const app2=Fastify(),service2=await registerWorkspaceRoutes(app2,f.root,{watch:false});try{const overview=await service2.overview();assert.equal(overview.operations[0].status,'undone');assert.equal(overview.resources[0].id,created.resourceId);assert.equal(overview.resources[0].missing,true);assert.equal(await fs.readFile(path.join(f.source,undo.recovery.path),'utf8'),'durable creation');}finally{await service2.close();await app2.close();}
  }finally{await f.close();}
});

test('create-file exclusive open preserves a file appearing after preflight and an occupied undo copy',async()=>{
  const f=await fixture(),open=fs.open;try{
    const root=await f.connect(),raced=path.join(f.source,'race.txt');let injected=false;fs.open=async(filename,flags,mode)=>{if(String(filename)===raced&&typeof flags==='number'&&(flags&constants.O_CREAT)){injected=true;await fs.writeFile(raced,'External winner',{flag:'wx'});}return open(filename,flags,mode);};await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:root.id,path:'race.txt',content:'Our text',expectedHash:null},409);fs.open=open;assert.equal(injected,true);assert.equal(await fs.readFile(raced,'utf8'),'External winner');
    const created=await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:root.id,path:'occupied-copy.txt',content:'Keep original',expectedHash:null},201),bin=path.join(f.source,'.echopaper-trash',created.id);await fs.mkdir(bin,{recursive:true});await fs.writeFile(path.join(bin,'created-file'),'Unrelated recovery file');await f.call('POST',`/api/workspace/operations/${created.id}/undo`,{},409);assert.equal(await fs.readFile(path.join(f.source,'occupied-copy.txt'),'utf8'),'Keep original');assert.equal(await fs.readFile(path.join(bin,'created-file'),'utf8'),'Unrelated recovery file');
  }finally{fs.open=open;await f.close();}
});

test('create-file undo recovery downloads exact verified bytes as an attachment and rejects edited copies',async()=>{
  const f=await fixture();try{
    const root=await f.connect(),content='可恢复的作者笔记\nEnglish evidence\n',created=await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:root.id,path:'作者笔记.md',content,expectedHash:null},201);await f.call('GET',`/api/workspace/operations/${created.id}/recovery`,undefined,404);const undone=await f.call('POST',`/api/workspace/operations/${created.id}/undo`,{}),download=await f.app.inject(`/api/workspace/operations/${created.id}/recovery`);assert.equal(download.statusCode,200,download.body);assert.deepEqual(download.rawPayload,Buffer.from(content));assert.match(download.headers['content-disposition']||'',/^attachment/);assert.ok((download.headers['content-disposition']||'').includes(encodeURIComponent('作者笔记.md')));assert.equal(download.headers['x-content-type-options'],'nosniff');assert.match(download.headers['content-type']||'',/application\/octet-stream/);
    await fs.writeFile(path.join(f.source,undone.recovery.path),'External edited recovery copy');await f.call('GET',`/api/workspace/operations/${created.id}/recovery`,undefined,409);assert.equal(await fs.readFile(path.join(f.source,undone.recovery.path),'utf8'),'External edited recovery copy');
  }finally{await f.close();}
});

test('recovery download refuses unknown or unrelated operations and replaced or symlinked copies',async()=>{
  const f=await fixture();try{
    const root=await f.connect();await f.call('GET','/api/workspace/operations/unknown-operation/recovery',undefined,404);const directory=await f.call('POST','/api/workspace/operations',{kind:'mkdir',rootId:root.id,path:'directory'},201);await f.call('POST',`/api/workspace/operations/${directory.id}/undo`,{});await f.call('GET',`/api/workspace/operations/${directory.id}/recovery`,undefined,404);
    const created=await f.call('POST','/api/workspace/operations',{kind:'create-file',rootId:root.id,path:'text.txt',content:'Verified original',expectedHash:null},201),undone=await f.call('POST',`/api/workspace/operations/${created.id}/undo`,{}),filename=path.join(f.source,undone.recovery.path);await fs.rename(filename,filename+'.retained');await fs.writeFile(filename,'Verified original');await f.call('GET',`/api/workspace/operations/${created.id}/recovery`,undefined,409);await fs.unlink(filename);await fs.symlink(filename+'.retained',filename);await f.call('GET',`/api/workspace/operations/${created.id}/recovery`,undefined,403);assert.equal(await fs.readFile(filename+'.retained','utf8'),'Verified original');
  }finally{await f.close();}
});
