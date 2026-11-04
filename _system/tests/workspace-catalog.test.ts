import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import {createHash} from 'node:crypto';

async function fixture(watch=false) {
  const directory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'workspace-catalog-'));
  const root=path.join(directory,'app'),source=path.join(directory,'originals');
  await fs.mkdir(root);await fs.mkdir(source);await fs.mkdir(path.join(root,'papers'));
  const module=await import('../server/workspace/index.ts').catch(()=>undefined);
  assert.ok(module?.registerWorkspaceRoutes,'the workspace backend must be available');
  const app=Fastify();app.setErrorHandler((error,_request,reply)=>{const known=error as Error&{statusCode?:number};return reply.code(known.statusCode||500).send({error:known.message});});
  const service=await module.registerWorkspaceRoutes(app,root,{watch});
  async function call(method:'GET'|'POST'|'PATCH',url:string,payload?:unknown,expected=200) {const response=await app.inject({method,url,payload:payload as any});assert.equal(response.statusCode,expected,response.body);return response.json();}
  async function settle(id:string) {for(let i=0;i<300;i++){const {roots}=await call('GET','/api/workspace/roots');const item=roots.find((r:any)=>r.id===id);if(item.status!=='scanning')return item;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('scan did not finish');}
  async function connect(directoryPath=source,permission='write') {const item=await call('POST','/api/workspace/roots',{path:directoryPath,label:'Originals',permission},201);await settle(item.id);return item;}
  return {directory,root,source,app,service,call,settle,connect,async close(){await service.close();await app.close();await fs.rm(directory,{recursive:true,force:true});}};
}

test('catalog starts empty and persists topic CAS edits without scanning the workspace',async()=>{
  const f=await fixture();try{
    assert.deepEqual((await f.call('GET','/api/workspace/overview')).roots,[]);
    const topic=await f.call('POST','/api/workspace/topics',{title:'Reasoning',description:'Evidence'},201);
    const edited=await f.call('PATCH',`/api/workspace/topics/${topic.id}`,{title:'Controlled reasoning',expectedRevision:topic.revision});
    assert.equal(edited.revision,topic.revision+1);
    await f.call('PATCH',`/api/workspace/topics/${topic.id}`,{title:'Stale edit',expectedRevision:topic.revision},409);
    await f.call('PATCH',`/api/workspace/topics/${topic.id}`,{resourceIds:['unknown'],expectedRevision:edited.revision},400);
    await f.service.checkpoint();assert.equal(f.service.busy(),false);
    assert.ok((await fs.readdir(path.join(f.root,'workspace'))).some(file=>file.startsWith('catalog.')));
    const {registerWorkspaceRoutes}=await import('../server/workspace/index.ts');
    const other=Fastify();const reopened=await registerWorkspaceRoutes(other,f.root,{watch:false});
    try{assert.equal((await reopened.overview()).topics[0].title,'Controlled reasoning');}finally{await reopened.close();await other.close();}
  }finally{await f.close();}
});

test('resource index searches file names, text and tags, lists parents and validates topic associations',async()=>{
  const f=await fixture();try{
    await fs.mkdir(path.join(f.source,'folder'));await fs.writeFile(path.join(f.source,'folder','evidence.md'),'A falsifiable probability tree');await fs.writeFile(path.join(f.source,'top.txt'),'root document');
    const root=await f.connect();const all=await f.call('GET',`/api/workspace/resources?rootId=${root.id}`);assert.equal(all.total,3);
    const nested=all.resources.find((r:any)=>r.name==='evidence.md');assert.ok(nested.hash);
    assert.equal((await f.call('GET',`/api/workspace/resources?rootId=${root.id}&path=`)).total,2);
    assert.equal((await f.call('GET',`/api/workspace/resources?rootId=${root.id}&path=folder`)).resources[0].id,nested.id);
    assert.equal((await f.call('GET','/api/workspace/resources?q=probability')).resources[0].id,nested.id);
    const tagged=await f.call('PATCH',`/api/workspace/resources/${nested.id}`,{tags:['baseline'],expectedRevision:nested.revision});
    await f.call('PATCH',`/api/workspace/resources/${nested.id}`,{tags:['stale'],expectedRevision:nested.revision},409);
    assert.equal((await f.call('GET','/api/workspace/resources?q=baseline')).resources[0].id,nested.id);
    const topic=await f.call('POST','/api/workspace/topics',{title:'Sampling',resourceIds:[nested.id]},201);
    assert.equal((await f.call('GET',`/api/workspace/resources?topicId=${topic.id}`)).resources[0].id,nested.id);
    assert.equal((await f.call('GET',`/api/workspace/resources/${nested.id}/text`)).content,'A falsifiable probability tree');
    assert.equal((await f.service.resourceFile(nested.id)).resource.revision,tagged.revision);
  }finally{await f.close();}
});

test('offline roots retain resource metadata and recover on explicit rescan',async()=>{
  const f=await fixture();try{
    await fs.writeFile(path.join(f.source,'keep.md'),'not deleted');const root=await f.connect();const before=(await f.call('GET','/api/workspace/resources')).resources[0];
    await fs.rename(f.source,f.source+'-offline');await f.call('POST',`/api/workspace/roots/${root.id}/scan`,{},202);
    assert.equal((await f.settle(root.id)).status,'offline');const after=(await f.call('GET','/api/workspace/resources')).resources[0];assert.equal(after.id,before.id);assert.equal(after.missing,false);
    await fs.rename(f.source+'-offline',f.source);await f.call('POST',`/api/workspace/roots/${root.id}/scan`,{},202);assert.equal((await f.settle(root.id)).status,'ready');
    await fs.unlink(path.join(f.source,'keep.md'));await f.call('POST',`/api/workspace/roots/${root.id}/scan`,{},202);await f.settle(root.id);assert.equal((await f.call('GET','/api/workspace/resources')).resources[0].missing,true);
  }finally{await f.close();}
});

test('root registration rejects duplicates, overlaps, symlinks and managed subtrees',async()=>{
  const f=await fixture();try{
    await fs.mkdir(path.join(f.source,'child'));const root=await f.connect();
    for(const candidate of [f.source,path.join(f.source,'child')])await f.call('POST','/api/workspace/roots',{path:candidate,label:'Overlap',permission:'write'},409);
    for(const candidate of [path.join(f.root,'papers'),f.root,f.directory])await f.call('POST','/api/workspace/roots',{path:candidate,label:'Managed',permission:'write'},403);
    await fs.symlink(f.source,path.join(f.directory,'alias'));await f.call('POST','/api/workspace/roots',{path:path.join(f.directory,'alias'),permission:'read'},403);
    const changed=await f.call('PATCH',`/api/workspace/roots/${root.id}`,{permission:'read',expectedRevision:(await f.settle(root.id)).revision});assert.equal(changed.permission,'read');
    await f.call('PATCH',`/api/workspace/roots/${root.id}`,{label:'stale',expectedRevision:root.revision},409);
  }finally{await f.close();}
});

test('raw responses download active formats and never follow indexed symlinks',async()=>{
  const f=await fixture();try{
    await fs.writeFile(path.join(f.source,'page.html'),'<script>unsafe()</script>');await fs.symlink(path.join(f.source,'page.html'),path.join(f.source,'linked.txt'));await f.connect();
    const items=(await f.call('GET','/api/workspace/resources')).resources;assert.equal(items.length,1);
    const raw=await f.app.inject(`/api/workspace/resources/${items[0].id}/raw`);assert.equal(raw.statusCode,200);assert.match(raw.headers['content-disposition']||'',/^attachment/);assert.match(raw.headers['content-type']||'',/application\/octet-stream/);assert.equal(raw.headers['x-content-type-options'],'nosniff');
    await fs.unlink(path.join(f.source,'page.html'));await fs.symlink('/etc/passwd',path.join(f.source,'page.html'));await f.call('GET',`/api/workspace/resources/${items[0].id}/text`,undefined,403);
  }finally{await f.close();}
});

test('relink restores a missing identity after an external move and refuses active identities',async()=>{
  const f=await fixture();try{
    await fs.writeFile(path.join(f.source,'old.md'),'stable evidence');const root=await f.connect();const original=(await f.call('GET','/api/workspace/resources')).resources[0];
    const tagged=await f.call('PATCH',`/api/workspace/resources/${original.id}`,{tags:['retained'],expectedRevision:original.revision});const topic=await f.call('POST','/api/workspace/topics',{title:'Kept topic',resourceIds:[original.id]},201);
    await f.call('POST',`/api/workspace/resources/${original.id}/relink`,{rootId:root.id,path:'old.md',expectedRevision:tagged.revision},409);
    await fs.rename(path.join(f.source,'old.md'),path.join(f.source,'new.md'));await f.call('POST',`/api/workspace/roots/${root.id}/scan`,{},202);await f.settle(root.id);
    const missing=await f.call('GET',`/api/workspace/resources/${original.id}`);assert.equal(missing.missing,true);
    const linked=await f.call('POST',`/api/workspace/resources/${original.id}/relink`,{rootId:root.id,path:'new.md',expectedRevision:missing.revision});assert.equal(linked.id,original.id);assert.equal(linked.path,'new.md');assert.deepEqual(linked.tags,['retained']);
    assert.equal((await f.call('GET',`/api/workspace/resources?topicId=${topic.id}`)).resources[0].id,original.id);assert.equal((await f.call('GET','/api/workspace/resources')).resources.filter((r:any)=>r.path==='new.md').length,1);
  }finally{await f.close();}
});

test('relink rejects a differently edited or independently tagged target',async()=>{
  const f=await fixture();try{
    await fs.writeFile(path.join(f.source,'old.txt'),'original');const root=await f.connect(),original=(await f.call('GET','/api/workspace/resources')).resources[0];await fs.rename(path.join(f.source,'old.txt'),path.join(f.source,'new.txt'));await fs.writeFile(path.join(f.source,'new.txt'),'different');
    await f.call('POST',`/api/workspace/roots/${root.id}/scan`,{},202);await f.settle(root.id);let missing=await f.call('GET',`/api/workspace/resources/${original.id}`);await f.call('POST',`/api/workspace/resources/${original.id}/relink`,{rootId:root.id,path:'new.txt',expectedRevision:missing.revision},409);
    await fs.writeFile(path.join(f.source,'new.txt'),'original');await f.call('POST',`/api/workspace/roots/${root.id}/scan`,{},202);await f.settle(root.id);const target=(await f.call('GET','/api/workspace/resources')).resources.find((r:any)=>r.path==='new.txt');await f.call('PATCH',`/api/workspace/resources/${target.id}`,{tags:['independent'],expectedRevision:target.revision});missing=await f.call('GET',`/api/workspace/resources/${original.id}`);await f.call('POST',`/api/workspace/resources/${original.id}/relink`,{rootId:root.id,path:'new.txt',expectedRevision:missing.revision},409);assert.equal((await f.call('GET',`/api/workspace/resources/${target.id}`)).id,target.id);
  }finally{await f.close();}
});

test('repeated checkpoints and close preserve an unchanged catalog byte for byte',async()=>{
  const f=await fixture();try{
    await f.call('POST','/api/workspace/topics',{title:'Stable backup'},201);await f.service.checkpoint();const files=(await fs.readdir(path.join(f.root,'workspace'))).filter(name=>name.startsWith('catalog.'));
    const fingerprint=async()=>{const digest=createHash('sha256');for(const name of files){digest.update(name);digest.update(await fs.readFile(path.join(f.root,'workspace',name)));}return digest.digest('hex');};
    const before=await fingerprint(),statBefore=await fs.stat(path.join(f.root,'workspace',files[0]),{bigint:true});await f.service.checkpoint();await f.service.checkpoint();assert.equal(await fingerprint(),before);assert.equal((await fs.stat(path.join(f.root,'workspace',files[0]),{bigint:true})).mtimeNs,statBefore.mtimeNs);await f.service.close();assert.equal(await fingerprint(),before);
  }finally{await f.close();}
});

test('relink protects an otherwise untagged resource already used by a presentation',async()=>{
  const f=await fixture();try{
    await fs.writeFile(path.join(f.source,'old.txt'),'original');const root=await f.connect(),original=(await f.call('GET','/api/workspace/resources')).resources[0];await fs.rename(path.join(f.source,'old.txt'),path.join(f.source,'new.txt'));await f.call('POST',`/api/workspace/roots/${root.id}/scan`,{},202);await f.settle(root.id);
    const target=(await f.call('GET','/api/workspace/resources')).resources.find((r:any)=>r.path==='new.txt'),missing=await f.call('GET',`/api/workspace/resources/${original.id}`),folder=path.join(f.root,'workspace/presentations/test-deck');await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'presentation.json'),JSON.stringify({sources:[{resourceId:target.id}]}));
    await f.call('POST',`/api/workspace/resources/${original.id}/relink`,{rootId:root.id,path:'new.txt',expectedRevision:missing.revision},409);assert.equal((await f.call('GET',`/api/workspace/resources/${target.id}`)).id,target.id);
  }finally{await f.close();}
});

test('PDF resources expose extracted text and an inline PDF stream',async()=>{
  const f=await fixture();try{
    const{PDFDocument,StandardFonts}=await import('pdf-lib'),document=await PDFDocument.create(),page=document.addPage(),font=await document.embedFont(StandardFonts.Helvetica);page.drawText('Verified probability tree',{font,size:16});await fs.writeFile(path.join(f.source,'evidence.pdf'),await document.save());await f.connect();
    const item=(await f.call('GET','/api/workspace/resources?q=probability')).resources[0];assert.equal(item.name,'evidence.pdf');assert.match((await f.call('GET',`/api/workspace/resources/${item.id}/text`)).content,/Verified probability tree/);const raw=await f.app.inject(`/api/workspace/resources/${item.id}/raw`);assert.equal(raw.statusCode,200);assert.match(raw.headers['content-type']||'',/application\/pdf/);assert.match(raw.headers['content-disposition']||'',/^inline/);
  }finally{await f.close();}
});

test('an explicitly connected root indexes later external edits through its watcher',async()=>{
  const f=await fixture(true);try{
    await fs.writeFile(path.join(f.source,'before.txt'),'initial');await f.connect();await fs.writeFile(path.join(f.source,'later.txt'),'watcher evidence');let found=false;
    for(let i=0;i<200;i++){if((await f.call('GET','/api/workspace/resources?q=watcher')).total===1){found=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}assert.equal(found,true,'a later external file should be indexed without an explicit scan');
  }finally{await f.close();}
});

test('overview recent resources are ordered by actual modification time',async()=>{
  const f=await fixture();try{await fs.writeFile(path.join(f.source,'a-old.txt'),'old');await fs.writeFile(path.join(f.source,'z-recent.txt'),'recent');await fs.utimes(path.join(f.source,'a-old.txt'),new Date('2020-01-01T00:00:00Z'),new Date('2020-01-01T00:00:00Z'));await fs.utimes(path.join(f.source,'z-recent.txt'),new Date('2026-01-01T00:00:00Z'),new Date('2026-01-01T00:00:00Z'));await f.connect();assert.equal((await f.service.overview()).resources[0].name,'z-recent.txt');}finally{await f.close();}
});
